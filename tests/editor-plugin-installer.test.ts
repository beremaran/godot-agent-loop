// @test-kind: unit
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EditorPluginInstaller,
  PERSISTENT_EDITOR_ADDON_DIR,
  TRANSIENT_EDITOR_ADDON_DIR,
} from '../src/editor-plugin-installer.js';

const roots: string[] = [];

function fixture(projectSource = '[application]\nconfig/name="Fixture"\n'): {
  root: string; projectPath: string; installer: EditorPluginInstaller;
} {
  const root = mkdtempSync(join(tmpdir(), 'godot-agent-loop-addon-'));
  roots.push(root);
  const projectPath = join(root, 'project');
  mkdirSync(projectPath);
  writeFileSync(join(projectPath, 'project.godot'), projectSource);
  const scriptPath = join(root, 'plugin.gd');
  writeFileSync(scriptPath, '@tool\nextends EditorPlugin\n');
  return { root, projectPath, installer: new EditorPluginInstaller(scriptPath) };
}

function addPersistentAddon(projectPath: string, protocol = '1'): void {
  const addon = join(projectPath, PERSISTENT_EDITOR_ADDON_DIR);
  mkdirSync(addon, { recursive: true });
  writeFileSync(join(addon, 'plugin.gd'), 'persistent-content\n');
  writeFileSync(join(addon, 'plugin.cfg'), [
    '[plugin]',
    'name="Godot Agent Loop Bridge"',
    'script="plugin.gd"',
    `protocol_version="${protocol}"`,
    '',
  ].join('\n'));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('EditorPluginInstaller', () => {
  it('installs and byte-exactly removes a server-owned transient bridge', () => {
    const original = '[application]\nconfig/name="Fixture"\n';
    const { projectPath, installer } = fixture(original);

    const installed = installer.install(projectPath);
    expect(installed).toMatchObject({
      distribution: 'transient', pluginName: 'godot_agent_loop_transient',
      protocolVersion: '1', owned: true, enabledByServer: true,
    });
    expect(readFileSync(join(projectPath, 'project.godot'), 'utf8'))
      .toContain('enabled=PackedStringArray("godot_agent_loop_transient")');
    expect(readFileSync(join(projectPath, TRANSIENT_EDITOR_ADDON_DIR, 'plugin.gd'), 'utf8'))
      .toBe('@tool\nextends EditorPlugin\n');

    expect(installer.remove(projectPath, installed)).toEqual({ filesRemoved: true, filesPreserved: false });
    expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).toBe(original);
  });

  it('preserves unrelated enabled plugins through install and cleanup', () => {
    const original = '[application]\nconfig/name="Fixture"\n\n[editor_plugins]\n\nenabled=PackedStringArray("other", "second")\n';
    const { projectPath, installer } = fixture(original);
    const installed = installer.install(projectPath);
    const during = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    expect(during).toContain('PackedStringArray("other", "second", "godot_agent_loop_transient")');
    installer.remove(projectPath, installed);
    expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).toBe(original);
  });

  it('uses, enables, and never overwrites or removes the persistent addon', () => {
    const original = '[application]\nconfig/name="Fixture"\n';
    const { projectPath, installer } = fixture(original);
    addPersistentAddon(projectPath);

    const installed = installer.install(projectPath);
    expect(installed).toMatchObject({
      distribution: 'persistent', pluginName: 'godot_agent_loop', owned: false, enabledByServer: true,
    });
    expect(readFileSync(join(projectPath, PERSISTENT_EDITOR_ADDON_DIR, 'plugin.gd'), 'utf8'))
      .toBe('persistent-content\n');
    expect(installer.remove(projectPath, installed)).toEqual({ filesRemoved: false, filesPreserved: true });
    expect(readFileSync(join(projectPath, PERSISTENT_EDITOR_ADDON_DIR, 'plugin.gd'), 'utf8'))
      .toBe('persistent-content\n');
    expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).toBe(original);
  });

  it('leaves an already-enabled persistent addon setting untouched', () => {
    const original = '[editor_plugins]\n\nenabled=PackedStringArray("godot_agent_loop")\n';
    const { projectPath, installer } = fixture(original);
    addPersistentAddon(projectPath);
    const installed = installer.install(projectPath);
    expect(installed.enabledByServer).toBe(false);
    installer.remove(projectPath, installed);
    expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).toBe(original);
  });

  it('rejects incomplete and protocol-incompatible persistent addons', () => {
    const missing = fixture();
    addPersistentAddon(missing.projectPath);
    rmSync(join(missing.projectPath, PERSISTENT_EDITOR_ADDON_DIR, 'plugin.gd'));
    expect(() => missing.installer.install(missing.projectPath)).toThrow(/script is missing/);

    const incompatible = fixture();
    addPersistentAddon(incompatible.projectPath, '999');
    expect(() => incompatible.installer.install(incompatible.projectPath))
      .toThrow(/protocol is incompatible: server 1, addon 999/);
  });

  it('refuses to overwrite a foreign or modified transient addon', () => {
    const foreign = fixture();
    const foreignAddon = join(foreign.projectPath, TRANSIENT_EDITOR_ADDON_DIR);
    mkdirSync(foreignAddon, { recursive: true });
    writeFileSync(join(foreignAddon, 'plugin.gd'), 'user content');
    expect(() => foreign.installer.install(foreign.projectPath)).toThrow(/Refusing to overwrite/);

    const modified = fixture();
    const installed = modified.installer.install(modified.projectPath);
    writeFileSync(join(modified.projectPath, TRANSIENT_EDITOR_ADDON_DIR, 'plugin.gd'), 'modified');
    expect(modified.installer.remove(modified.projectPath, installed))
      .toEqual({ filesRemoved: false, filesPreserved: true });
  });

  it('replaces an unmodified stale owned transient addon idempotently', () => {
    const original = '[application]\nconfig/name="Fixture"\n';
    const { projectPath, installer } = fixture(original);
    const first = installer.install(projectPath);
    const second = installer.install(projectPath);
    expect(second).toMatchObject({ distribution: 'transient', owned: true, enabledByServer: true });
    expect(installer.remove(projectPath, second)).toEqual({ filesRemoved: true, filesPreserved: false });
    expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).toBe(original);
    installer.remove(projectPath, first);
  });

  it('reclaims an owned transient bridge when a persistent addon appears', () => {
    const original = '[application]\nconfig/name="Fixture"\n';
    const { projectPath, installer } = fixture(original);
    installer.install(projectPath);
    addPersistentAddon(projectPath);

    const persistent = installer.install(projectPath);
    expect(persistent).toMatchObject({ distribution: 'persistent', owned: false, enabledByServer: true });
    expect(existsSync(join(projectPath, TRANSIENT_EDITOR_ADDON_DIR))).toBe(false);
    const enabled = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    expect(enabled).toContain('"godot_agent_loop"');
    expect(enabled).not.toContain('godot_agent_loop_transient');
    installer.remove(projectPath, persistent);
    expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).toBe(original);
  });

  it('preserves concurrent project edits while removing only its enabled entry', () => {
    const { projectPath, installer } = fixture();
    const installed = installer.install(projectPath);
    const changed = `${readFileSync(join(projectPath, 'project.godot'), 'utf8')}\n[display]\nwindow/size/viewport_width=1280\n`;
    writeFileSync(join(projectPath, 'project.godot'), changed);
    installer.remove(projectPath, installed);
    const restored = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    expect(restored).toContain('viewport_width=1280');
    expect(restored).not.toContain('godot_agent_loop_transient');
  });

  it('removes a partially created transient addon when script copying fails', () => {
    const { projectPath } = fixture();
    const installer = new EditorPluginInstaller(projectPath);
    expect(() => installer.install(projectPath)).toThrow();
    expect(existsSync(join(projectPath, TRANSIENT_EDITOR_ADDON_DIR))).toBe(false);
  });
});
