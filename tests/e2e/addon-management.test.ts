// @test-kind: e2e
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type E2EServer } from './helpers/harness.js';

let server: E2EServer | null = null;

afterEach(async () => {
  if (!server) return;
  const active = server;
  server = null;
  await active.close();
});

function payload(text: string): Record<string, any> {
  return JSON.parse(text) as Record<string, any>;
}

function writeAddon(root: string, version: string, marker: string, script?: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'plugin.cfg'), [
    '[plugin]', '', 'name="Pinned Agent Add-on"', 'description="E2E fixture"',
    'author="Godot MCP"', `version="${version}"`, 'script="plugin.gd"',
    'minimum_godot_version="4.4"', '',
  ].join('\n'));
  writeFileSync(join(root, 'plugin.gd'), script ?? [
    '@tool', 'extends EditorPlugin', '',
    'func _enter_tree() -> void:', `\tprint("${marker}_ENTER")`, '',
    'func _exit_tree() -> void:', `\tprint("${marker}_EXIT")`, '',
  ].join('\n'));
}

function treeHash(root: string): string {
  const files: { relativePath: string; fullPath: string }[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (!entry.name.endsWith('.uid') && entry.isFile() && !lstatSync(fullPath).isSymbolicLink()) {
        files.push({ relativePath: relative(root, fullPath).replaceAll('\\', '/'), fullPath });
      }
    }
  };
  walk(root);
  const hash = createHash('sha256');
  for (const file of files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    hash.update(file.relativePath).update('\0').update(readFileSync(file.fullPath)).update('\0');
  }
  return hash.digest('hex');
}

describe('pinned add-on management through MCP', () => {
  it('installs, inspects, updates, toggles, rolls back, and removes a real EditorPlugin', async () => {
    server = await startServer();
    const sourceV1 = join(server.root, 'sources', 'v1');
    const sourceV2 = join(server.root, 'sources', 'v2');
    const sourceBroken = join(server.root, 'sources', 'broken');
    writeAddon(sourceV1, '1.0.0', 'ADDON_V1');
    writeAddon(sourceV2, '2.0.0', 'ADDON_V2');
    writeAddon(sourceBroken, '3.0.0', 'BROKEN', '@tool\nextends EditorPlugin\nthis is invalid GDScript\n');

    const absent = await server.call('manage_addon', {
      projectPath: server.projectPath, action: 'inspect', pluginName: 'pinned_agent',
    });
    expect(absent.isError, absent.text).toBe(false);
    expect(payload(absent.text)).toMatchObject({ installed: false, enabled: false });

    const wrongPin = await server.call('manage_addon', {
      projectPath: server.projectPath, action: 'install', pluginName: 'pinned_agent',
      sourcePath: sourceV1, expectedSha256: '0'.repeat(64), enable: false,
    });
    expect(wrongPin.isError).toBe(true);
    expect(payload(wrongPin.text)).toMatchObject({ category: 'hash_mismatch' });
    expect(existsSync(join(server.projectPath, 'addons', 'pinned_agent'))).toBe(false);

    const installed = await server.call('manage_addon', {
      projectPath: server.projectPath, action: 'install', pluginName: 'pinned_agent',
      sourcePath: sourceV1, expectedSha256: treeHash(sourceV1), enable: true,
      expectedOutput: 'ADDON_V1_ENTER',
    });
    expect(installed.isError, installed.text).toBe(false);
    expect(payload(installed.text)).toMatchObject({
      installed: true, enabled: true, metadata: { version: '1.0.0' },
      compatibility: { compatible: true, minimum_godot_version: '4.4' },
    });
    expect(readFileSync(join(server.projectPath, 'project.godot'), 'utf8'))
      .toContain('enabled=PackedStringArray("res://addons/pinned_agent/plugin.cfg")');

    const inspected = await server.call('manage_addon', {
      projectPath: server.projectPath, action: 'inspect', pluginName: 'pinned_agent',
    });
    expect(payload(inspected.text)).toMatchObject({
      installed: true, enabled: true, valid: true, pin: { sha256: treeHash(sourceV1), files: 2 },
      metadata: { name: 'Pinned Agent Add-on', version: '1.0.0', script: 'plugin.gd' },
    });

    const updated = await server.call('manage_addon', {
      projectPath: server.projectPath, action: 'update', pluginName: 'pinned_agent',
      sourcePath: sourceV2, expectedSha256: treeHash(sourceV2), expectedOutput: 'ADDON_V2_ENTER',
    });
    expect(updated.isError, updated.text).toBe(false);
    expect(payload(updated.text)).toMatchObject({ action: 'update', metadata: { version: '2.0.0' }, enabled: true });

    const broken = await server.call('manage_addon', {
      projectPath: server.projectPath, action: 'update', pluginName: 'pinned_agent',
      sourcePath: sourceBroken, expectedSha256: treeHash(sourceBroken),
    });
    expect(broken.isError).toBe(true);
    expect(payload(broken.text)).toMatchObject({ category: 'reload_failed', rolled_back: true });
    expect(readFileSync(join(server.projectPath, 'addons', 'pinned_agent', 'plugin.cfg'), 'utf8'))
      .toContain('version="2.0.0"');

    const disabled = await server.call('manage_addon', {
      projectPath: server.projectPath, action: 'disable', pluginName: 'pinned_agent',
    });
    expect(disabled.isError, disabled.text).toBe(false);
    expect(payload(disabled.text)).toMatchObject({ enabled: false });

    const enabled = await server.call('manage_addon', {
      projectPath: server.projectPath, action: 'enable', pluginName: 'pinned_agent',
      expectedOutput: 'ADDON_V2_ENTER',
    });
    expect(enabled.isError, enabled.text).toBe(false);
    expect(payload(enabled.text)).toMatchObject({ enabled: true, reload: { output_matched: true } });

    const removed = await server.call('manage_addon', {
      projectPath: server.projectPath, action: 'remove', pluginName: 'pinned_agent',
    });
    expect(removed.isError, removed.text).toBe(false);
    expect(payload(removed.text)).toMatchObject({ removed: true, enabled: false });
    expect(existsSync(join(server.projectPath, 'addons', 'pinned_agent'))).toBe(false);
  });

  it('rejects incompatible metadata and traversal before writing files', async () => {
    server = await startServer();
    const future = join(server.root, 'sources', 'future');
    writeAddon(future, '9.0.0', 'FUTURE');
    writeFileSync(join(future, 'plugin.cfg'), readFileSync(join(future, 'plugin.cfg'), 'utf8')
      .replace('minimum_godot_version="4.4"', 'minimum_godot_version="99.0"'));
    const incompatible = await server.call('manage_addon', {
      projectPath: server.projectPath, action: 'install', pluginName: 'future_plugin',
      sourcePath: future, expectedSha256: treeHash(future),
    });
    expect(incompatible.isError).toBe(true);
    expect(payload(incompatible.text)).toMatchObject({
      category: 'incompatible_plugin', compatibility: { compatible: false, reason: 'minimum_version_not_met' },
    });

    await expect(server.call('manage_addon', {
      projectPath: server.projectPath, action: 'inspect', pluginName: '../escape',
    })).rejects.toThrow(/pluginName must match/i);
    expect(existsSync(join(server.projectPath, 'escape'))).toBe(false);
  });
});
