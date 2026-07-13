import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PNG } from 'pngjs';

import type { GameCommandService } from '../game-command-service.js';
import { createErrorResponse, normalizeParameters, PathSecurity, type ToolArguments, type ToolResponse } from '../utils.js';

interface Capture {
  png: Buffer;
  width: number;
  height: number;
  renderer: Record<string, unknown>;
}

/** Captures deterministic screenshots and persists bounded visual evidence. */
export class VisualRegressionService {
  private static readonly maxPixels = 16_777_216;

  constructor(
    private readonly commands: GameCommandService,
    private readonly pathSecurity = new PathSecurity(),
  ) {}

  async execute(rawArgs: ToolArguments): Promise<ToolResponse> {
    const args = normalizeParameters(rawArgs || {});
    if (!args.action || typeof args.baselinePath !== 'string') return createErrorResponse('action and baselinePath are required.');
    const projectPath = this.commands.connectedProjectPath();
    if (!projectPath) return createErrorResponse('No connected Godot project. Use run_project first.');
    const baselinePath = this.pathSecurity.resolveProjectPath(projectPath, args.baselinePath);
    if (!baselinePath || !/\.png$/i.test(baselinePath)) return createErrorResponse('baselinePath must be a project-relative PNG path.');
    const capture = await this.capture();
    if ('error' in capture) return createErrorResponse(capture.error);
    if (capture.width * capture.height > VisualRegressionService.maxPixels) {
      return createErrorResponse(`Screenshot exceeds ${VisualRegressionService.maxPixels} pixels.`);
    }
    if (args.action === 'capture_baseline') {
      mkdirSync(dirname(baselinePath), { recursive: true });
      writeFileSync(baselinePath, capture.png);
      return this.response({ action: args.action, passed: true, baseline_path: args.baselinePath,
        width: capture.width, height: capture.height, sha256: this.digest(capture.png), renderer: capture.renderer });
    }
    if (args.action !== 'compare') return createErrorResponse('action must be capture_baseline or compare.');
    if (!existsSync(baselinePath)) return createErrorResponse(`Baseline does not exist: ${args.baselinePath}`);
    try {
      const baselineBytes = readFileSync(baselinePath);
      const baseline = PNG.sync.read(baselineBytes);
      const actual = PNG.sync.read(capture.png);
      if (baseline.width !== actual.width || baseline.height !== actual.height) {
        return this.response({ action: args.action, passed: false, reason: 'dimension_mismatch',
          expected: [baseline.width, baseline.height], actual: [actual.width, actual.height], renderer: capture.renderer }, true);
      }
      const mask = this.readMask(projectPath, args.maskPath, actual.width, actual.height);
      if ('error' in mask) return createErrorResponse(mask.error);
      const tolerance = typeof args.channelTolerance === 'number' ? args.channelTolerance : 0;
      const allowedRatio = typeof args.maxDifferentPixelRatio === 'number' ? args.maxDifferentPixelRatio : 0;
      const diff = new PNG({ width: actual.width, height: actual.height });
      let compared = 0; let different = 0; let maximumDelta = 0;
      for (let pixel = 0; pixel < actual.width * actual.height; pixel++) {
        const offset = pixel * 4;
        if (mask.png && mask.png.data[offset + 3] === 0) {
          actual.data.copy(diff.data, offset, offset, offset + 4);
          diff.data[offset + 3] = 64;
          continue;
        }
        compared++;
        let mismatch = false;
        for (let channel = 0; channel < 4; channel++) {
          const delta = Math.abs(actual.data[offset + channel] - baseline.data[offset + channel]);
          maximumDelta = Math.max(maximumDelta, delta);
          if (delta > tolerance) mismatch = true;
        }
        if (mismatch) { different++; diff.data.set([255, 0, 0, 255], offset); }
        else actual.data.copy(diff.data, offset, offset, offset + 4);
      }
      const ratio = compared === 0 ? 0 : different / compared;
      const passed = ratio <= allowedRatio;
      const artifactPath = typeof args.diffArtifactPath === 'string'
        ? this.pathSecurity.resolveProjectPath(projectPath, args.diffArtifactPath) : null;
      if (args.diffArtifactPath && (!artifactPath || !/\.png$/i.test(artifactPath))) {
        return createErrorResponse('diffArtifactPath must be a project-relative PNG path.');
      }
      if (artifactPath) { mkdirSync(dirname(artifactPath), { recursive: true }); writeFileSync(artifactPath, PNG.sync.write(diff)); }
      return this.response({ action: args.action, passed, baseline_path: args.baselinePath,
        diff_artifact_path: args.diffArtifactPath ?? null, width: actual.width, height: actual.height,
        compared_pixels: compared, different_pixels: different, different_pixel_ratio: ratio,
        maximum_channel_delta: maximumDelta, channel_tolerance: tolerance,
        max_different_pixel_ratio: allowedRatio, baseline_sha256: this.digest(baselineBytes),
        actual_sha256: this.digest(capture.png), renderer: capture.renderer }, !passed);
    } catch (error: unknown) {
      return createErrorResponse(`Visual comparison failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async capture(): Promise<Capture | { error: string }> {
    if (!this.commands.hasActiveProcess()) return { error: 'No active Godot process. Use run_project first.' };
    if (!this.commands.isConnected()) return { error: 'Not connected to game interaction server.' };
    const screenshot = await this.commands.send('screenshot');
    if ('error' in screenshot) return { error: `Screenshot failed: ${screenshot.error.message}` };
    const value = screenshot.result as { data?: string; width?: number; height?: number };
    if (!value.data || !value.width || !value.height) return { error: 'Screenshot returned incomplete PNG evidence.' };
    const osInfo = await this.commands.send('os_info');
    return { png: Buffer.from(value.data, 'base64'), width: value.width, height: value.height,
      renderer: 'error' in osInfo ? { unavailable: osInfo.error.message } : osInfo.result as Record<string, unknown> };
  }

  private readMask(projectPath: string, maskPath: unknown, width: number, height: number): { png: PNG | null } | { error: string } {
    if (!maskPath) return { png: null };
    if (typeof maskPath !== 'string') return { error: 'maskPath must be a string.' };
    const fullPath = this.pathSecurity.resolveProjectPath(projectPath, maskPath);
    if (!fullPath || !existsSync(fullPath) || !/\.png$/i.test(fullPath)) return { error: `Mask does not exist or is not a PNG: ${maskPath}` };
    try {
      const png = PNG.sync.read(readFileSync(fullPath));
      if (png.width !== width || png.height !== height) return { error: 'Mask dimensions must match the screenshot.' };
      return { png };
    } catch (error: unknown) { return { error: `Could not decode mask: ${error instanceof Error ? error.message : String(error)}` }; }
  }

  private digest(value: Buffer): string { return createHash('sha256').update(value).digest('hex'); }

  private response(value: Record<string, unknown>, isError = false): ToolResponse {
    return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
  }
}
