// @test-kind: contract
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { repoRoot } from './e2e/helpers/harness.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('AssetLib archive', () => {
  it('contains only the complete, byte-identical addon tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'godot-agent-loop-assetlib-'));
    roots.push(root);
    const archive = join(root, 'addon.zip');
    execFileSync(process.execPath, [join(repoRoot, 'scripts/build-assetlib-archive.js'), archive]);

    const entries = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' })
      .trim().split('\n').sort();
    expect(entries).toEqual([
      'addons/godot_agent_loop/LICENSE',
      'addons/godot_agent_loop/README.md',
      'addons/godot_agent_loop/plugin.cfg',
      'addons/godot_agent_loop/plugin.gd',
    ]);
    for (const entry of entries) {
      const archived = execFileSync('unzip', ['-p', archive, entry]);
      expect(archived, entry).toEqual(readFileSync(join(repoRoot, entry)));
    }
  });

  it('is byte-deterministic across release timezones', () => {
    const root = mkdtempSync(join(tmpdir(), 'godot-agent-loop-assetlib-'));
    roots.push(root);
    const first = join(root, 'first.zip');
    const second = join(root, 'second.zip');
    execFileSync(process.execPath, [join(repoRoot, 'scripts/build-assetlib-archive.js'), first], {
      env: { ...process.env, TZ: 'UTC' },
    });
    execFileSync(process.execPath, [join(repoRoot, 'scripts/build-assetlib-archive.js'), second], {
      env: { ...process.env, TZ: 'Australia/Perth' },
    });
    expect(readFileSync(first)).toEqual(readFileSync(second));
  });
});
