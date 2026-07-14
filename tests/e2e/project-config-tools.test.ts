// @test-kind: e2e
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { importProjectResources, startServer, type E2EServer } from './helpers/harness.js';

/**
 * Full-path E2E coverage for the 19 project settings/files/scripts/editor
 * configuration tools. These tools have a `local` backend (they edit
 * project.godot and project files directly), so the independent observation
 * TODO.md requires is to *reopen the resulting configuration through Godot*:
 * the project is launched and the live engine is asked whether it actually
 * sees the autoload, input action, layer name, main scene, or translation.
 * Filesystem-only assertions would only echo the handler back at itself.
 */

let server: E2EServer | null = null;

afterEach(async () => {
  if (server) {
    const active = server;
    server = null;
    await active.close();
  }
});

function payload(text: string): unknown {
  return JSON.parse(text) as unknown;
}

/** Server only; no engine started (fast path for filesystem-observable tools). */
async function startedServer(): Promise<E2EServer> {
  server = await startServer({ allowPrivileged: true });
  return server;
}

/** Launch the configured project and wait for the live runtime connection. */
async function launch(active: E2EServer): Promise<void> {
  const started = await active.call('run_project', { projectPath: active.projectPath });
  expect(started.isError, started.text).toBe(false);
  await active.waitForGameConnection();
}

/** Ask the running engine a question; the answer never passes through the tool under test. */
async function engineEval(active: E2EServer, code: string): Promise<unknown> {
  const result = await active.call('game_eval', { code });
  expect(result.isError, result.text).toBe(false);
  return (payload(result.text) as { result: unknown }).result;
}

describe('project settings and configuration tools through MCP', () => {
  it('exposes every configuration tool through MCP discovery', async () => {
    const active = await startedServer();
    const { tools } = await active.client.listTools();
    const names = new Set(tools.map(tool => tool.name));
    for (const name of [
      'read_project_settings', 'modify_project_settings', 'list_project_files',
      'read_file', 'write_file', 'delete_file', 'create_directory', 'rename_file',
      'validate_script', 'validate_scripts', 'create_script', 'manage_autoloads',
      'manage_input_map', 'manage_export_presets', 'manage_layers', 'manage_plugins',
      'manage_shader', 'set_main_scene', 'manage_translations',
    ]) {
      expect(names, `${name} must be discoverable`).toContain(name);
    }
    const writeFile = tools.find(tool => tool.name === 'write_file');
    expect(writeFile?.inputSchema.required).toEqual(['projectPath', 'filePath', 'content']);
  });

  it('read_project_settings parses the real project.godot and modify_project_settings is seen by the engine', async () => {
    const active = await startedServer();

    const initial = await active.call('read_project_settings', { projectPath: active.projectPath });
    expect(initial.isError, initial.text).toBe(false);
    const settings = payload(initial.text) as Record<string, Record<string, string>>;
    expect(settings.application['config/name']).toBe('"godot-agent-loop-e2e-fixture"');

    // A setting the engine exposes verbatim at runtime, so the round trip is observable.
    const modified = await active.call('modify_project_settings', {
      projectPath: active.projectPath,
      section: 'application',
      key: 'config/description',
      value: '"set-by-e2e"',
    });
    expect(modified.isError, modified.text).toBe(false);

    // Overwrite (not duplicate) an existing key.
    const overwritten = await active.call('modify_project_settings', {
      projectPath: active.projectPath,
      section: 'application',
      key: 'config/description',
      value: '"overwritten-by-e2e"',
    });
    expect(overwritten.isError, overwritten.text).toBe(false);
    const raw = readFileSync(join(active.projectPath, 'project.godot'), 'utf8');
    expect(raw.match(/config\/description=/g)).toHaveLength(1);

    // Independent observation: the running engine resolves the setting.
    await launch(active);
    expect(await engineEval(active, 'return ProjectSettings.get_setting("application/config/description")'))
      .toBe('overwritten-by-e2e');
  });

  it('modify_project_settings creates a missing section and rejects invalid projects', async () => {
    const active = await startedServer();

    const created = await active.call('modify_project_settings', {
      projectPath: active.projectPath,
      section: 'debug',
      key: 'settings/stdout/print_fps',
      value: 'false',
    });
    expect(created.isError, created.text).toBe(false);
    const reread = await active.call('read_project_settings', { projectPath: active.projectPath });
    expect((payload(reread.text) as Record<string, Record<string, string>>).debug['settings/stdout/print_fps']).toBe('false');

    const missingProject = await active.call('modify_project_settings', {
      projectPath: join(active.root, 'not-a-project'),
      section: 'application',
      key: 'config/name',
      value: '"x"',
    });
    expect(missingProject.isError).toBe(true);
    expect(missingProject.text).toMatch(/invalid path/i);

    const outsideAllowed = await active.call('read_project_settings', { projectPath: '/etc' });
    expect(outsideAllowed.isError).toBe(true);
    expect(outsideAllowed.text).toMatch(/invalid path/i);
  });

  it('manage_autoloads list/add/remove is verified by the autoload actually loading in the engine', async () => {
    const active = await startedServer();

    const empty = await active.call('manage_autoloads', { projectPath: active.projectPath, action: 'list' });
    expect(empty.isError, empty.text).toBe(false);
    expect(payload(empty.text)).toEqual({});

    const written = await active.call('write_file', {
      projectPath: active.projectPath,
      filePath: 'e2e_autoload.gd',
      content: 'extends Node\n\n\nfunc _ready() -> void:\n\tadd_to_group("autoload-alive")\n\n\nfunc marker() -> String:\n\treturn "autoload-marker"\n',
    });
    expect(written.isError, written.text).toBe(false);

    const added = await active.call('manage_autoloads', {
      projectPath: active.projectPath,
      action: 'add',
      name: 'E2EAutoload',
      path: 'res://e2e_autoload.gd',
    });
    expect(added.isError, added.text).toBe(false);

    const listed = await active.call('manage_autoloads', { projectPath: active.projectPath, action: 'list' });
    expect(payload(listed.text)).toMatchObject({ E2EAutoload: '"*res://e2e_autoload.gd"' });

    // Independent observation: Godot instantiated the singleton at /root.
    await launch(active);
    expect(await engineEval(active, 'return get_node("/root/E2EAutoload").marker()')).toBe('autoload-marker');
    const grouped = await active.call('game_get_nodes_in_group', { group: 'autoload-alive' });
    expect(grouped.isError, grouped.text).toBe(false);
    expect(grouped.text).toContain('E2EAutoload');

    // Removal must not disturb the MCP runtime server's own autoload entry.
    const removed = await active.call('manage_autoloads', {
      projectPath: active.projectPath, action: 'remove', name: 'E2EAutoload',
    });
    expect(removed.isError, removed.text).toBe(false);
    expect(payload((await active.call('manage_autoloads', { projectPath: active.projectPath, action: 'list' })).text))
      .not.toHaveProperty('E2EAutoload');
    // The runtime autoload lives in the generated override.cfg, so user-facing
    // autoload edits in project.godot cannot disturb it (and vice versa).
    expect(readFileSync(join(active.projectPath, 'override.cfg'), 'utf8')).toContain('res://mcp_interaction_server.gd');
    expect(readFileSync(join(active.projectPath, 'project.godot'), 'utf8')).not.toContain('mcp_interaction_server.gd');
  });

  it('manage_autoloads reports missing arguments and unknown actions', async () => {
    const active = await startedServer();
    const noName = await active.call('manage_autoloads', { projectPath: active.projectPath, action: 'add' });
    expect(noName.isError).toBe(true);
    expect(noName.text).toMatch(/name and path are required/i);

    const bogus = await active.call('manage_autoloads', { projectPath: active.projectPath, action: 'sideload' });
    expect(bogus.isError).toBe(true);
    expect(bogus.text).toMatch(/invalid action/i);
  });

  it('manage_input_map add/list/remove is verified through the live InputMap', async () => {
    const active = await startedServer();

    const added = await active.call('manage_input_map', {
      projectPath: active.projectPath,
      action: 'add',
      actionName: 'e2e_jump',
      key: 'space',
      deadzone: 0.25,
    });
    expect(added.isError, added.text).toBe(false);

    const secondKey = await active.call('manage_input_map', {
      projectPath: active.projectPath,
      action: 'add',
      actionName: 'e2e_jump',
      key: 'W',
      deadzone: 0.75,
    });
    expect(secondKey.isError, secondKey.text).toBe(false);

    // Repeating a binding must be idempotent and must never write a second
    // project.godot property with the same action name.
    const duplicate = await active.call('manage_input_map', {
      projectPath: active.projectPath,
      action: 'add',
      actionName: 'e2e_jump',
      key: 'space',
    });
    expect(duplicate.isError, duplicate.text).toBe(false);
    const rawInputMap = readFileSync(join(active.projectPath, 'project.godot'), 'utf8');
    expect(rawInputMap.match(/^e2e_jump=/gm)).toHaveLength(1);

    const listed = await active.call('manage_input_map', { projectPath: active.projectPath, action: 'list' });
    expect(listed.text).toContain('e2e_jump');

    // Independent observation: the live engine, not the edited text or handler
    // response, sees both distinct bindings and the original deadzone.
    await launch(active);
    const observed = await engineEval(active, [
      'var events = InputMap.action_get_events("e2e_jump")',
      'return {',
      '\t"has": InputMap.has_action("e2e_jump"),',
      '\t"deadzone": InputMap.action_get_deadzone("e2e_jump"),',
      '\t"keycodes": events.map(func(event: InputEvent) -> int: return event.physical_keycode),',
      '}',
    ].join('\n')) as { has: boolean; deadzone: number; keycodes: number[] };
    expect(observed.has).toBe(true);
    expect(observed.deadzone).toBeCloseTo(0.25, 5);
    expect(observed.keycodes).toEqual([32, 87]); // KEY_SPACE, KEY_W

    const removed = await active.call('manage_input_map', {
      projectPath: active.projectPath, action: 'remove', actionName: 'e2e_jump',
    });
    expect(removed.isError, removed.text).toBe(false);
    expect(payload((await active.call('manage_input_map', { projectPath: active.projectPath, action: 'list' })).text))
      .not.toHaveProperty('e2e_jump');
  });

  it('manage_input_map defaults the deadzone and validates arguments', async () => {
    const active = await startedServer();
    const added = await active.call('manage_input_map', {
      projectPath: active.projectPath, action: 'add', actionName: 'e2e_default',
    });
    expect(added.isError, added.text).toBe(false);
    expect(readFileSync(join(active.projectPath, 'project.godot'), 'utf8')).toContain('"deadzone": 0.5');

    const missing = await active.call('manage_input_map', { projectPath: active.projectPath, action: 'add' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/actionName is required/i);
  });

  it('manage_layers set/list is verified through the engine layer names', async () => {
    const active = await startedServer();

    const set = await active.call('manage_layers', {
      projectPath: active.projectPath,
      action: 'set',
      layerType: '2d_physics',
      layer: 3,
      name: 'enemies',
    });
    expect(set.isError, set.text).toBe(false);

    // Re-setting the same layer replaces rather than duplicates.
    const reset = await active.call('manage_layers', {
      projectPath: active.projectPath, action: 'set', layerType: '2d_physics', layer: 3, name: 'hazards',
    });
    expect(reset.isError, reset.text).toBe(false);

    const listed = await active.call('manage_layers', { projectPath: active.projectPath, action: 'list' });
    expect(payload(listed.text)).toEqual({ layers: [{ type: '2d_physics', layer: 3, name: 'hazards' }] });

    // The key inside [layer_names] must not repeat the section name; a
    // `layer_names/layer_names/...` key is silently ignored by the engine.
    expect(readFileSync(join(active.projectPath, 'project.godot'), 'utf8'))
      .toContain('\n2d_physics/layer_3="hazards"');

    await launch(active);
    expect(await engineEval(active, 'return ProjectSettings.get_setting("layer_names/2d_physics/layer_3")'))
      .toBe('hazards');

    const incomplete = await active.call('manage_layers', { projectPath: active.projectPath, action: 'set', layerType: '2d_physics' });
    expect(incomplete.isError).toBe(true);
    expect(incomplete.text).toMatch(/layerType, layer, and name are required/i);
  });

  it('set_main_scene changes which scene the engine actually boots', async () => {
    const active = await startedServer();

    const createdScene = await active.call('create_scene', {
      projectPath: active.projectPath,
      scenePath: 'res://alternate.tscn',
      rootNodeType: 'Node2D',
    });
    expect(createdScene.isError, createdScene.text).toBe(false);

    // Accepts a bare path and normalizes it to res://.
    const set = await active.call('set_main_scene', { projectPath: active.projectPath, scenePath: 'alternate.tscn' });
    expect(set.isError, set.text).toBe(false);
    expect(set.text).toContain('res://alternate.tscn');
    expect(readFileSync(join(active.projectPath, 'project.godot'), 'utf8'))
      .toContain('run/main_scene="res://alternate.tscn"');
    expect(readFileSync(join(active.projectPath, 'project.godot'), 'utf8').match(/run\/main_scene=/g)).toHaveLength(1);

    // Independent observation: booting the project loads the new scene, not main.tscn.
    await launch(active);
    expect(await engineEval(active, 'return get_tree().current_scene.scene_file_path'))
      .toBe('res://alternate.tscn');
    expect(await engineEval(active, 'return ProjectSettings.get_setting("application/run/main_scene")'))
      .toBe('res://alternate.tscn');
  });

  it('manage_translations add/list/remove is verified through the engine locale list', async () => {
    const active = await startedServer();

    const empty = await active.call('manage_translations', { projectPath: active.projectPath, action: 'list' });
    expect(payload(empty.text)).toEqual({ translations: [] });

    // A real .po compiles into the engine's TranslationServer at boot.
    writeFileSync(join(active.projectPath, 'strings.fr.po'), [
      'msgid ""', 'msgstr ""',
      '"Language: fr\\n"',
      '"Content-Type: text/plain; charset=UTF-8\\n"',
      '', 'msgid "GREETING"', 'msgstr "Bonjour"', '',
    ].join('\n'));

    const added = await active.call('manage_translations', {
      projectPath: active.projectPath, action: 'add', translationPath: 'strings.fr.po',
    });
    expect(added.isError, added.text).toBe(false);
    expect(added.text).toContain('res://strings.fr.po');

    const listed = await active.call('manage_translations', { projectPath: active.projectPath, action: 'list' });
    expect(payload(listed.text)).toEqual({ translations: ['res://strings.fr.po'] });

    // A bare `translations=` key inside [internationalization] is ignored by the
    // engine; the setting it actually reads is `locale/translations`.
    expect(readFileSync(join(active.projectPath, 'project.godot'), 'utf8'))
      .toContain('locale/translations=PackedStringArray("res://strings.fr.po")');

    // Independent observation: the engine loaded the translation and can translate
    // with it. Godot only resolves a .po after it has been imported, so the fixture
    // is imported first — the same step the editor performs on file discovery.
    await importProjectResources(active.projectPath);
    await launch(active);
    const observed = await engineEval(active, [
      'TranslationServer.set_locale("fr")',
      'return {',
      '\t"locales": Array(TranslationServer.get_loaded_locales()),',
      '\t"greeting": TranslationServer.translate("GREETING"),',
      '}',
    ].join('\n')) as { locales: string[]; greeting: string };
    expect(observed.locales).toContain('fr');
    expect(observed.greeting).toBe('Bonjour');

    const removed = await active.call('manage_translations', {
      projectPath: active.projectPath, action: 'remove', translationPath: 'strings.fr.po',
    });
    expect(removed.isError, removed.text).toBe(false);
    expect(payload((await active.call('manage_translations', { projectPath: active.projectPath, action: 'list' })).text))
      .toEqual({ translations: [] });
  });

  it('manage_plugins list/enable/disable round-trips through project.godot', async () => {
    const active = await startedServer();

    const bare = await active.call('manage_plugins', { projectPath: active.projectPath, action: 'list' });
    expect(payload(bare.text)).toEqual({ enabled: [], available: [] });

    mkdirSync(join(active.projectPath, 'addons', 'sample_plugin'), { recursive: true });
    writeFileSync(join(active.projectPath, 'addons', 'sample_plugin', 'plugin.cfg'), [
      '[plugin]', '', 'name="Sample Plugin"', 'description=""', 'author=""',
      'version="1.0"', 'script="plugin.gd"', '',
    ].join('\n'));

    const discovered = await active.call('manage_plugins', { projectPath: active.projectPath, action: 'list' });
    expect(payload(discovered.text)).toEqual({ enabled: [], available: ['sample_plugin'] });

    const enabled = await active.call('manage_plugins', {
      projectPath: active.projectPath, action: 'enable', pluginName: 'sample_plugin',
    });
    expect(enabled.isError, enabled.text).toBe(false);
    expect(payload((await active.call('manage_plugins', { projectPath: active.projectPath, action: 'list' })).text))
      .toEqual({ enabled: ['sample_plugin'], available: ['sample_plugin'] });

    const disabled = await active.call('manage_plugins', {
      projectPath: active.projectPath, action: 'disable', pluginName: 'sample_plugin',
    });
    expect(disabled.isError, disabled.text).toBe(false);
    expect(payload((await active.call('manage_plugins', { projectPath: active.projectPath, action: 'list' })).text))
      .toEqual({ enabled: [], available: ['sample_plugin'] });
    // Disabling removes the canonical plugin.cfg path from one enabled array.
    expect(readFileSync(join(active.projectPath, 'project.godot'), 'utf8').match(/^enabled=PackedStringArray\(/gm)).toHaveLength(1);

    const unknown = await active.call('manage_plugins', { projectPath: active.projectPath, action: 'purge' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/unknown action/i);
  });

  it('manage_export_presets list/add/remove round-trips through export_presets.cfg', async () => {
    const active = await startedServer();

    const empty = await active.call('manage_export_presets', { projectPath: active.projectPath, action: 'list' });
    expect(payload(empty.text)).toEqual({ presets: [] });

    const added = await active.call('manage_export_presets', {
      projectPath: active.projectPath, action: 'add', name: 'LinuxE2E', platform: 'Linux/X11', runnable: true,
    });
    expect(added.isError, added.text).toBe(false);
    expect(existsSync(join(active.projectPath, 'export_presets.cfg'))).toBe(true);

    const listed = await active.call('manage_export_presets', { projectPath: active.projectPath, action: 'list' });
    expect(listed.text).toContain('LinuxE2E');
    expect(listed.text).toContain('Linux/X11');

    const removed = await active.call('manage_export_presets', {
      projectPath: active.projectPath, action: 'remove', name: 'LinuxE2E',
    });
    expect(removed.isError, removed.text).toBe(false);
    const after = await active.call('manage_export_presets', { projectPath: active.projectPath, action: 'list' });
    expect(after.text).not.toContain('LinuxE2E');
  });
});

describe('project file and script tools through MCP', () => {
  it('write_file/read_file/rename_file/delete_file/create_directory round-trip on the real filesystem', async () => {
    const active = await startedServer();

    const written = await active.call('write_file', {
      projectPath: active.projectPath, filePath: 'data/notes.txt', content: 'héllo → wörld\nsecond line\n',
    });
    expect(written.isError, written.text).toBe(false);
    // write_file creates intermediate directories.
    expect(existsSync(join(active.projectPath, 'data', 'notes.txt'))).toBe(true);

    // Independent observation: read back through a different tool, and verify
    // UTF-8 and line endings survive the round trip byte for byte.
    const read = await active.call('read_file', { projectPath: active.projectPath, filePath: 'data/notes.txt' });
    expect(read.isError, read.text).toBe(false);
    expect(read.text).toBe('héllo → wörld\nsecond line\n');

    const dir = await active.call('create_directory', { projectPath: active.projectPath, directoryPath: 'data/nested/deep' });
    expect(dir.isError, dir.text).toBe(false);
    expect(existsSync(join(active.projectPath, 'data', 'nested', 'deep'))).toBe(true);

    const renamed = await active.call('rename_file', {
      projectPath: active.projectPath, filePath: 'data/notes.txt', newPath: 'data/nested/deep/moved.txt',
    });
    expect(renamed.isError, renamed.text).toBe(false);
    expect(existsSync(join(active.projectPath, 'data', 'notes.txt'))).toBe(false);
    const moved = await active.call('read_file', { projectPath: active.projectPath, filePath: 'data/nested/deep/moved.txt' });
    expect(moved.text).toBe('héllo → wörld\nsecond line\n');

    const deleted = await active.call('delete_file', {
      projectPath: active.projectPath, filePath: 'data/nested/deep/moved.txt',
    });
    expect(deleted.isError, deleted.text).toBe(false);
    expect(existsSync(join(active.projectPath, 'data', 'nested', 'deep', 'moved.txt'))).toBe(false);

    const gone = await active.call('read_file', { projectPath: active.projectPath, filePath: 'data/nested/deep/moved.txt' });
    expect(gone.isError).toBe(true);
    expect(gone.text).toMatch(/does not exist/i);
  });

  it('file tools reject traversal and absolute escapes without touching the filesystem', async () => {
    const active = await startedServer();
    const secret = join(active.root, 'outside.txt');
    writeFileSync(secret, 'do-not-touch');

    for (const filePath of ['../outside.txt', 'data/../../outside.txt', '/etc/passwd']) {
      const read = await active.call('read_file', { projectPath: active.projectPath, filePath });
      expect(read.isError, `read_file must reject ${filePath}`).toBe(true);
      expect(read.text).toMatch(/invalid path|outside the project/i);

      const write = await active.call('write_file', { projectPath: active.projectPath, filePath, content: 'pwned' });
      expect(write.isError, `write_file must reject ${filePath}`).toBe(true);

      const remove = await active.call('delete_file', { projectPath: active.projectPath, filePath });
      expect(remove.isError, `delete_file must reject ${filePath}`).toBe(true);
    }
    // Nothing outside the project was written or removed.
    expect(readFileSync(secret, 'utf8')).toBe('do-not-touch');

    const missingFile = await active.call('delete_file', { projectPath: active.projectPath, filePath: 'nope.txt' });
    expect(missingFile.isError).toBe(true);
    expect(missingFile.text).toMatch(/does not exist/i);

    const missingRename = await active.call('rename_file', {
      projectPath: active.projectPath, filePath: 'nope.txt', newPath: 'other.txt',
    });
    expect(missingRename.isError).toBe(true);
    expect(missingRename.text).toMatch(/not found/i);
  });

  it('write_file reports a read-only target without corrupting it', async () => {
    const active = await startedServer();
    const target = join(active.projectPath, 'locked.txt');
    writeFileSync(target, 'original');
    chmodSync(target, 0o444);
    try {
      const result = await active.call('write_file', {
        projectPath: active.projectPath, filePath: 'locked.txt', content: 'replacement',
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/failed to write file|permission denied/i);
      expect(readFileSync(target, 'utf8')).toBe('original');
    } finally {
      chmodSync(target, 0o644);
    }
  });

  it('list_project_files filters by extension and subdirectory', async () => {
    const active = await startedServer();
    await active.call('write_file', { projectPath: active.projectPath, filePath: 'src/a.gd', content: 'extends Node\n' });
    await active.call('write_file', { projectPath: active.projectPath, filePath: 'src/b.txt', content: 'text\n' });
    await active.call('write_file', { projectPath: active.projectPath, filePath: 'src/deep/c.gd', content: 'extends Node\n' });

    const all = await active.call('list_project_files', { projectPath: active.projectPath });
    expect(all.isError, all.text).toBe(false);
    const allFiles = (payload(all.text) as { count: number; files: string[] });
    expect(allFiles.files).toContain('main.tscn');
    expect(allFiles.count).toBe(allFiles.files.length);

    const scripts = await active.call('list_project_files', { projectPath: active.projectPath, extensions: ['.gd'] });
    const scriptFiles = (payload(scripts.text) as { files: string[] }).files;
    expect(scriptFiles).toEqual(expect.arrayContaining(['main.gd', 'src/a.gd', 'src/deep/c.gd']));
    expect(scriptFiles).not.toContain('src/b.txt');

    const scoped = await active.call('list_project_files', {
      projectPath: active.projectPath, subdirectory: 'src', extensions: ['.gd'],
    });
    const scopedFiles = (payload(scoped.text) as { files: string[] }).files;
    expect(scopedFiles.sort()).toEqual(['src/a.gd', 'src/deep/c.gd']);

    const missing = await active.call('list_project_files', { projectPath: active.projectPath, subdirectory: 'absent' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/subdirectory does not exist/i);
  });

  it('list_project_files paginates a large project deterministically', async () => {
    const active = await startedServer();
    const largeDir = join(active.projectPath, 'large');
    mkdirSync(largeDir);
    for (let index = 0; index < 1205; index += 1) {
      writeFileSync(join(largeDir, `asset-${index.toString().padStart(4, '0')}.txt`), 'x');
    }

    const first = await active.call('list_project_files', {
      projectPath: active.projectPath, subdirectory: 'large', limit: 1000,
    });
    expect(first.isError, first.text).toBe(false);
    const firstPage = payload(first.text) as {
      count: number; total: number; files: string[]; nextCursor: number | null;
    };
    expect(firstPage).toMatchObject({ count: 1000, total: 1205, nextCursor: 1000 });
    expect(firstPage.files[0]).toBe('large/asset-0000.txt');
    expect(firstPage.files.at(-1)).toBe('large/asset-0999.txt');

    const second = await active.call('list_project_files', {
      projectPath: active.projectPath, subdirectory: 'large', limit: 1000, cursor: firstPage.nextCursor,
    });
    const secondPage = payload(second.text) as {
      count: number; total: number; files: string[]; nextCursor: number | null;
    };
    expect(secondPage).toMatchObject({ count: 205, total: 1205, nextCursor: null });
    expect(secondPage.files[0]).toBe('large/asset-1000.txt');
    expect(secondPage.files.at(-1)).toBe('large/asset-1204.txt');
    expect(new Set([...firstPage.files, ...secondPage.files]).size).toBe(1205);

    await expect(active.client.callTool({
      name: 'list_project_files', arguments: { projectPath: active.projectPath, limit: 1001 },
    })).rejects.toThrow(/limit must be at most 1000/i);
  });

  it('create_script builds source from options and Godot parses the result', async () => {
    const active = await startedServer();

    const generated = await active.call('create_script', {
      projectPath: active.projectPath,
      scriptPath: 'scripts/player.gd',
      extends: 'CharacterBody2D',
      className: 'E2EPlayer',
      methods: ['_ready', 'take_damage'],
    });
    expect(generated.isError, generated.text).toBe(false);

    const source = await active.call('read_file', { projectPath: active.projectPath, filePath: 'scripts/player.gd' });
    expect(source.text).toContain('extends CharacterBody2D');
    expect(source.text).toContain('class_name E2EPlayer');
    expect(source.text).toContain('func take_damage():');

    // Independent observation: real Godot parses the generated script.
    const validated = await active.call('validate_script', {
      projectPath: active.projectPath, scriptPath: 'scripts/player.gd',
    });
    expect(validated.isError, validated.text).toBe(false);
    expect(payload(validated.text)).toMatchObject({ valid: true, errorCount: 0 });

    // Explicit source wins over the generator, and defaults to `extends Node`.
    const explicit = await active.call('create_script', {
      projectPath: active.projectPath, scriptPath: 'scripts/verbatim.gd', source: 'extends Area2D\n',
    });
    expect(explicit.isError, explicit.text).toBe(false);
    expect((await active.call('read_file', { projectPath: active.projectPath, filePath: 'scripts/verbatim.gd' })).text)
      .toBe('extends Area2D\n');

    const defaulted = await active.call('create_script', { projectPath: active.projectPath, scriptPath: 'scripts/plain.gd' });
    expect(defaulted.isError, defaulted.text).toBe(false);
    expect((await active.call('read_file', { projectPath: active.projectPath, filePath: 'scripts/plain.gd' })).text)
      .toContain('extends Node');
  });

  it('validate_script reports real Godot parse errors and rejects non-GDScript', async () => {
    const active = await startedServer();

    await active.call('write_file', {
      projectPath: active.projectPath,
      filePath: 'scripts/broken.gd',
      content: 'extends Node\n\nfunc _ready() -> void:\n\tthis is not gdscript(((\n',
    });
    const invalid = await active.call('validate_script', {
      projectPath: active.projectPath, scriptPath: 'scripts/broken.gd',
    });
    expect(invalid.isError, invalid.text).toBe(false);
    const report = payload(invalid.text) as { valid: boolean; errorCount: number; errors: unknown[] };
    expect(report.valid).toBe(false);
    expect(report.errorCount).toBeGreaterThan(0);
    expect(report.errors.length).toBeGreaterThan(0);

    const wrongType = await active.call('validate_script', {
      projectPath: active.projectPath, scriptPath: 'main.tscn',
    });
    expect(wrongType.isError).toBe(true);
    expect(wrongType.text).toMatch(/only checks GDScript/i);

    const absent = await active.call('validate_script', {
      projectPath: active.projectPath, scriptPath: 'scripts/absent.gd',
    });
    expect(absent.isError).toBe(true);
    expect(absent.text).toMatch(/does not exist/i);
  });

  it('validate_script resolves multiple autoloads and still performs a fresh real compile', async () => {
    const active = await startedServer();
    await active.call('write_file', {
      projectPath: active.projectPath,
      filePath: 'first_autoload.gd',
      content: 'extends Node\n\nfunc value() -> int:\n\treturn 20\n',
    });
    await active.call('write_file', {
      projectPath: active.projectPath,
      filePath: 'second_autoload.gd',
      content: 'extends Node\n\nfunc value() -> int:\n\treturn 22\n',
    });
    expect((await active.call('manage_autoloads', {
      projectPath: active.projectPath, action: 'add', name: 'FirstAutoload', path: 'res://first_autoload.gd',
    })).isError).toBe(false);
    expect((await active.call('manage_autoloads', {
      projectPath: active.projectPath, action: 'add', name: 'SecondAutoload', path: 'res://second_autoload.gd',
    })).isError).toBe(false);

    const scriptPath = 'scripts/autoload_consumer.gd';
    await active.call('write_file', {
      projectPath: active.projectPath,
      filePath: scriptPath,
      content: [
        'extends Node',
        '',
        'var combined: int = FirstAutoload.value() + SecondAutoload.value()',
        '',
      ].join('\n'),
    });
    const valid = await active.call('validate_script', { projectPath: active.projectPath, scriptPath });
    expect(valid.isError, valid.text).toBe(false);
    expect(payload(valid.text)).toMatchObject({ valid: true, errorCount: 0 });

    // Rewrite the same path so a stale ResourceCache entry could conceal the
    // regression. The validator must recompile and report this genuine error.
    await active.call('write_file', {
      projectPath: active.projectPath,
      filePath: scriptPath,
      content: [
        'extends Node',
        '',
        'var combined: int = FirstAutoload.value() + SecondAutoload.value()',
        'var broken: int = "not an integer"',
        '',
      ].join('\n'),
    });
    const invalid = await active.call('validate_script', { projectPath: active.projectPath, scriptPath });
    expect(invalid.isError, invalid.text).toBe(false);
    const report = payload(invalid.text) as { valid: boolean; errorCount: number; errors: { file?: string; line?: number }[] };
    expect(report.valid).toBe(false);
    expect(report.errorCount).toBeGreaterThan(0);
    expect(report.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: 'res://scripts/autoload_consumer.gd', line: 4 }),
    ]));
  });

  it('validate_scripts covers explicit, changed, all, and invalid scopes against real Godot', async () => {
    const active = await startedServer();
    await active.call('create_script', { projectPath: active.projectPath, scriptPath: 'scripts/ok.gd', extends: 'Node' });
    await active.call('write_file', {
      projectPath: active.projectPath, filePath: 'scripts/bad.gd', content: 'extends Node\n\nfunc broken(:\n',
    });

    const explicit = await active.call('validate_scripts', {
      projectPath: active.projectPath, scriptPaths: ['scripts/ok.gd', 'scripts/bad.gd', 'scripts/ghost.gd', 'main.tscn'],
    });
    expect(explicit.isError, explicit.text).toBe(false);
    const result = payload(explicit.text) as {
      scope: string; fileCount: number; filesWithErrors: number; allValid: boolean;
      results: { scriptPath: string; checked: boolean; valid?: boolean; error?: string }[];
    };
    expect(result.scope).toBe('explicit');
    expect(result.allValid).toBe(false);
    expect(result.filesWithErrors).toBe(1);
    const byPath = new Map(result.results.map(entry => [entry.scriptPath, entry]));
    expect(byPath.get('scripts/ok.gd')).toMatchObject({ checked: true, valid: true });
    expect(byPath.get('scripts/bad.gd')).toMatchObject({ checked: true, valid: false });
    expect(byPath.get('scripts/ghost.gd')).toMatchObject({ checked: false, error: 'Script does not exist' });
    expect(byPath.get('main.tscn')).toMatchObject({ checked: false, error: 'Not a valid .gd path' });

    execFileSync('git', ['init', '--quiet'], { cwd: active.projectPath });
    const changed = await active.call('validate_scripts', { projectPath: active.projectPath, scope: 'changed' });
    expect(changed.isError, changed.text).toBe(false);
    const changedResult = payload(changed.text) as { scope: string; results: { scriptPath: string }[] };
    expect(changedResult.scope).toBe('changed');
    expect(changedResult.results.map(entry => entry.scriptPath)).toEqual(expect.arrayContaining(['scripts/ok.gd', 'scripts/bad.gd']));

    const all = await active.call('validate_scripts', { projectPath: active.projectPath, scope: 'all' });
    expect(all.isError, all.text).toBe(false);
    const allResult = payload(all.text) as { scope: string; results: { scriptPath: string }[] };
    expect(allResult.scope).toBe('all');
    expect(allResult.results.map(entry => entry.scriptPath)).toEqual(expect.arrayContaining(['main.gd', 'scripts/ok.gd']));

    // An out-of-enum scope is refused by argument validation before the handler runs.
    await expect(active.client.callTool({
      name: 'validate_scripts',
      arguments: { projectPath: active.projectPath, scope: 'sideways' },
    })).rejects.toThrow(/scope must be one of: changed, all/i);
  });

  it('manage_shader create/read produces a shader the engine compiles', async () => {
    const active = await startedServer();

    const created = await active.call('manage_shader', {
      projectPath: active.projectPath, shaderPath: 'shaders/tint.gdshader', action: 'create', shaderType: 'canvas_item',
    });
    expect(created.isError, created.text).toBe(false);

    const read = await active.call('manage_shader', {
      projectPath: active.projectPath, shaderPath: 'shaders/tint.gdshader', action: 'read',
    });
    expect(read.isError, read.text).toBe(false);
    expect(read.text).toContain('shader_type canvas_item;');

    const custom = await active.call('manage_shader', {
      projectPath: active.projectPath,
      shaderPath: 'shaders/custom.gdshader',
      action: 'create',
      source: 'shader_type canvas_item;\n\nuniform vec4 tint : source_color = vec4(1.0);\n\nvoid fragment() {\n\tCOLOR = tint;\n}\n',
    });
    expect(custom.isError, custom.text).toBe(false);

    // Independent observation: the engine loads and compiles both shaders and
    // sees the declared uniform.
    await launch(active);
    const observed = await engineEval(active, [
      'var generated := load("res://shaders/tint.gdshader") as Shader',
      'var custom := load("res://shaders/custom.gdshader") as Shader',
      'var names: Array[String] = []',
      'for entry in custom.get_shader_uniform_list():',
      '\tnames.append(entry["name"])',
      'return {',
      '\t"generated_mode": generated.get_mode(),',
      '\t"custom_mode": custom.get_mode(),',
      '\t"uniforms": names,',
      '}',
    ].join('\n')) as { generated_mode: number; custom_mode: number; uniforms: string[] };
    expect(observed.generated_mode).toBe(1); // Shader.MODE_CANVAS_ITEM
    expect(observed.custom_mode).toBe(1);
    expect(observed.uniforms).toContain('tint');

    const missing = await active.call('manage_shader', {
      projectPath: active.projectPath, shaderPath: 'shaders/absent.gdshader', action: 'read',
    });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/shader not found/i);
  });
});
