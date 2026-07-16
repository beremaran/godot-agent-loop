// @test-kind: contract
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { toolDefinitions } from '../src/tool-definitions.js';
import { repoRoot } from './e2e/helpers/harness.js';

interface Mp4Box {
  type: string;
  start: number;
  dataStart: number;
  end: number;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function boxes(buffer: Buffer, start = 0, end = buffer.length): Mp4Box[] {
  const result: Mp4Box[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) break;
      size = Number(buffer.readBigUInt64BE(offset + 8));
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header || offset + size > end) break;
    result.push({ type, start: offset, dataStart: offset + header, end: offset + size });
    offset += size;
  }
  return result;
}

function child(buffer: Buffer, parent: Mp4Box, type: string): Mp4Box {
  const found = boxes(buffer, parent.dataStart, parent.end).find(box => box.type === type);
  if (!found) throw new Error(`MP4 box ${type} not found in ${parent.type}`);
  return found;
}

describe('launch evidence', () => {
  const evidencePath = join(repoRoot, 'docs/coverage/launch-agent-run.json');
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as {
    task: { prompt: string; promptSha256: string };
    result: {
      outcome: string; durationMs: number; mcpToolCalls: number;
      uniqueMcpTools: number; nonMcpToolCalls: number; verifiedStates: string[];
      compoundVerification: { passed: boolean; stopped: boolean; teardown: boolean };
      serverExit: { runtimeProcesses: number; transientAddonResidue: boolean; overrideResidue: boolean };
    };
    toolUsage: Record<string, number>;
    artifacts: {
      project: { root: string; files: Record<string, string> };
      screenshots: Record<string, string>;
      video: string;
      videoSha256: string;
      poster: string;
      posterSha256: string;
    };
  };

  it('pins the literal prompt, successful MCP-only result, project bytes, and screenshots', () => {
    const promptPath = join(repoRoot, evidence.task.prompt);
    expect(sha256(promptPath)).toBe(evidence.task.promptSha256);
    expect(readFileSync(promptPath, 'utf8')).toContain('Starting from the empty allowed directory');
    expect(evidence.result).toMatchObject({
      outcome: 'success', durationMs: 391795, mcpToolCalls: 103,
      uniqueMcpTools: 25, nonMcpToolCalls: 0,
      verifiedStates: ['PLAYING', 'WIN', 'LOSE'],
      compoundVerification: { passed: true, stopped: true, teardown: true },
      serverExit: { runtimeProcesses: 0, transientAddonResidue: false, overrideResidue: false },
    });
    expect(Object.values(evidence.toolUsage).reduce((sum, count) => sum + count, 0)).toBe(103);

    for (const [relativePath, hash] of Object.entries(evidence.artifacts.project.files)) {
      expect(sha256(join(repoRoot, evidence.artifacts.project.root, relativePath)), relativePath).toBe(hash);
    }
    for (const [state, relativePath] of Object.entries(evidence.artifacts.screenshots)) {
      const png = PNG.sync.read(readFileSync(join(repoRoot, relativePath)));
      expect({ width: png.width, height: png.height }, state).toEqual({ width: 1152, height: 648 });
    }
  });

  it('ships a 60–90 second 1080p H.264 proof and matching first-screen poster', () => {
    const videoPath = join(repoRoot, evidence.artifacts.video);
    const video = readFileSync(videoPath);
    expect(sha256(videoPath)).toBe(evidence.artifacts.videoSha256);
    expect(statSync(videoPath).size).toBeGreaterThan(1_000_000);
    expect(video.includes(Buffer.from('avc1'))).toBe(true);

    const moov = boxes(video).find(box => box.type === 'moov');
    if (!moov) throw new Error('MP4 moov box not found');
    const mvhd = child(video, moov, 'mvhd');
    expect(video[mvhd.dataStart]).toBe(0);
    const timescale = video.readUInt32BE(mvhd.dataStart + 12);
    const duration = video.readUInt32BE(mvhd.dataStart + 16) / timescale;
    expect(duration).toBeGreaterThanOrEqual(60);
    expect(duration).toBeLessThanOrEqual(90);

    const trak = child(video, moov, 'trak');
    const tkhd = child(video, trak, 'tkhd');
    expect(video.readUInt32BE(tkhd.end - 8) / 65536).toBe(1920);
    expect(video.readUInt32BE(tkhd.end - 4) / 65536).toBe(1080);

    const posterPath = join(repoRoot, evidence.artifacts.poster);
    expect(sha256(posterPath)).toBe(evidence.artifacts.posterSha256);
    const poster = PNG.sync.read(readFileSync(posterPath));
    expect({ width: poster.width, height: poster.height }).toEqual({ width: 1920, height: 1080 });
    const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
    expect(readme).toContain('assets/demo/godot-agent-loop-launch-poster.png');
    expect(readme).toContain('assets/demo/godot-agent-loop-launch.mp4');
    expect(readme).toContain(`E2E tools: ${toolDefinitions.length}/${toolDefinitions.length}`);
  });
});
