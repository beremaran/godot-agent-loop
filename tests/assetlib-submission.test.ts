// @test-kind: contract
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { repoRoot } from './e2e/helpers/harness.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('AssetLib submission payload', () => {
  it('is commit-pinned, direct-linked, and aligned with product metadata', () => {
    const root = mkdtempSync(join(tmpdir(), 'godot-agent-loop-assetlib-submission-'));
    roots.push(root);
    const output = join(root, 'submission.json');
    const commit = '0123456789abcdef0123456789abcdef01234567';
    execFileSync(process.execPath, [
      join(repoRoot, 'scripts/build-assetlib-submission.js'), commit, output,
    ]);
    const payload = JSON.parse(readFileSync(output, 'utf8')) as Record<string, unknown>;
    expect(payload).toMatchObject({
      status: 'prepared-not-submitted',
      assetName: 'Godot Agent Loop Bridge',
      category: 'Addons/Tools',
      godotVersion: '4.4',
      testedThroughGodotVersion: '4.7',
      version: '1.1.0',
      repositoryUrl: 'https://github.com/beremaran/godot-agent-loop',
      issuesUrl: 'https://github.com/beremaran/godot-agent-loop/issues',
      downloadCommit: commit,
      license: 'MIT',
      protocolVersion: '2',
    });
    expect(payload.iconUrl).toMatch(new RegExp(`^https://raw\\.githubusercontent\\.com/.+/${commit}/.+\\.png$`));
    expect(payload.previews).toHaveLength(2);
  });

  it('refuses mutable branches and abbreviated commit ids', () => {
    const result = spawnSync(process.execPath, [
      join(repoRoot, 'scripts/build-assetlib-submission.js'), 'main', join(tmpdir(), 'ignored.json'),
    ]);
    expect(result.status).not.toBe(0);
  });

  it('ships valid AssetLib media and keeps it out of Godot imports', () => {
    const icon = PNG.sync.read(readFileSync(join(repoRoot, 'assets/previews/assetlib-icon.png')));
    expect(icon.width).toBe(icon.height);
    expect(icon.width).toBeGreaterThanOrEqual(128);
    for (const name of ['assetlib-editor-overview.png', 'assetlib-editor-dock.png']) {
      const preview = PNG.sync.read(readFileSync(join(repoRoot, 'assets/previews', name)));
      expect(preview.width).toBeGreaterThanOrEqual(640);
      expect(preview.height).toBeGreaterThanOrEqual(480);
    }
    expect(readFileSync(join(repoRoot, 'assets/previews/.gdignore'), 'utf8')).toBe('');
  });
});
