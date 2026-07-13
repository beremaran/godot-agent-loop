// @test-kind: e2e
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  importProjectResources,
  startServer,
  writePngFixture,
  type E2EServer,
} from './helpers/harness.js';

/**
 * Phase 2: the 16 headless (godot_operations.gd) tools through the complete
 * MCP path — every public action, defaulted and structured parameters, the
 * documented failure classes, and effects verified by reading project files
 * or re-loading them through a separate engine invocation.
 */

let server: E2EServer;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server.close();
});

function call(name: string, args: Record<string, unknown>) {
  return server.call(name, { projectPath: server.projectPath, ...args });
}

function projectFile(relativePath: string): string {
  return readFileSync(join(server.projectPath, relativePath), 'utf8');
}

describe('scene authoring', () => {
  it('create_scene honors the default root type and an explicit one', async () => {
    const defaulted = await call('create_scene', { scenePath: 'scenes/level.tscn' });
    expect(defaulted.isError, defaulted.text).toBe(false);
    expect(projectFile('scenes/level.tscn')).toMatch(/type="Node2D"/);

    const explicit = await call('create_scene', { scenePath: 'scenes/space.tscn', rootNodeType: 'Node3D' });
    expect(explicit.isError, explicit.text).toBe(false);
    expect(projectFile('scenes/space.tscn')).toMatch(/type="Node3D"/);
  });

  it('create_scene fails cleanly for an uninstantiable root type', async () => {
    const result = await call('create_scene', { scenePath: 'scenes/bad.tscn', rootNodeType: 'NotAClass' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Failed to instantiate/i);
    expect(existsSync(join(server.projectPath, 'scenes/bad.tscn'))).toBe(false);
  });

  it('add_node applies structured properties and persists them', async () => {
    const added = await call('add_node', {
      scenePath: 'scenes/level.tscn',
      nodeType: 'Sprite2D',
      nodeName: 'Player',
      properties: { position: { x: 32, y: 48 }, visible: true },
    });
    expect(added.isError, added.text).toBe(false);
    const scene = projectFile('scenes/level.tscn');
    expect(scene).toMatch(/\[node name="Player" type="Sprite2D" parent="\."/);
    expect(scene).toContain('position = Vector2(32, 48)');
  });

  it('add_node fails for a missing parent without corrupting the scene', async () => {
    const before = projectFile('scenes/level.tscn');
    const result = await call('add_node', {
      scenePath: 'scenes/level.tscn',
      nodeType: 'Node2D',
      nodeName: 'Orphan',
      parentNodePath: 'root/DoesNotExist',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Parent node not found/i);
    expect(projectFile('scenes/level.tscn')).toBe(before);
  });

  it('load_sprite assigns an imported texture and persists it', async () => {
    writePngFixture(server.projectPath, 'icon.png');
    await importProjectResources(server.projectPath);
    const result = await call('load_sprite', {
      scenePath: 'scenes/level.tscn',
      nodePath: 'Player',
      texturePath: 'icon.png',
    });
    expect(result.isError, result.text).toBe(false);
    expect(projectFile('scenes/level.tscn')).toContain('texture =');
  });

  it('load_sprite rejects a non-sprite node', async () => {
    const result = await call('load_sprite', {
      scenePath: 'scenes/level.tscn',
      nodePath: 'root',
      texturePath: 'icon.png',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/not a sprite-compatible type/i);
  });

  it('modify_scene_node persists property changes verified by engine reload', async () => {
    const result = await call('modify_scene_node', {
      scenePath: 'scenes/level.tscn',
      nodePath: 'Player',
      properties: { position: { x: 10, y: 20 }, visible: false },
    });
    expect(result.isError, result.text).toBe(false);
    const scene = projectFile('scenes/level.tscn');
    expect(scene).toContain('position = Vector2(10, 20)');
    expect(scene).toContain('visible = false');

    const read = await call('read_scene', { scenePath: 'scenes/level.tscn' });
    expect(read.isError, read.text).toBe(false);
    expect(read.text).toContain('"Player"');
  });

  it('modify_scene_node fails for a missing node', async () => {
    const result = await call('modify_scene_node', {
      scenePath: 'scenes/level.tscn',
      nodePath: 'Ghost',
      properties: { visible: false },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/not found/i);
  });

  it('attach_script wires a script written through write_file', async () => {
    const written = await call('write_file', {
      filePath: 'scripts/player.gd',
      content: 'extends Sprite2D\n',
    });
    expect(written.isError, written.text).toBe(false);

    const attached = await call('attach_script', {
      scenePath: 'scenes/level.tscn',
      nodePath: 'Player',
      scriptPath: 'scripts/player.gd',
    });
    expect(attached.isError, attached.text).toBe(false);
    expect(projectFile('scenes/level.tscn')).toContain('scripts/player.gd');
  });

  it('attach_script fails for a missing script file', async () => {
    const result = await call('attach_script', {
      scenePath: 'scenes/level.tscn',
      nodePath: 'Player',
      scriptPath: 'scripts/absent.gd',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/does not exist/i);
  });

  it('save_scene resaves in place and saves a copy to a new path', async () => {
    const inPlace = await call('save_scene', { scenePath: 'scenes/level.tscn' });
    expect(inPlace.isError, inPlace.text).toBe(false);

    const copied = await call('save_scene', { scenePath: 'scenes/level.tscn', newPath: 'scenes/level_copy.tscn' });
    expect(copied.isError, copied.text).toBe(false);
    expect(existsSync(join(server.projectPath, 'scenes/level_copy.tscn'))).toBe(true);
    // The copy is loadable by a fresh engine invocation.
    const read = await call('read_scene', { scenePath: 'scenes/level_copy.tscn' });
    expect(read.isError, read.text).toBe(false);
    expect(read.text).toContain('"Player"');
  });

  it('read_scene reports a structured failure for a missing scene', async () => {
    const result = await call('read_scene', { scenePath: 'scenes/absent.tscn' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/does not exist/i);
  });
});

describe('manage_scene_structure actions', () => {
  it('renames, duplicates, and moves nodes with persisted results', async () => {
    await call('create_scene', { scenePath: 'scenes/structure.tscn' });
    await call('add_node', { scenePath: 'scenes/structure.tscn', nodeType: 'Node2D', nodeName: 'Container' });
    await call('add_node', { scenePath: 'scenes/structure.tscn', nodeType: 'Node2D', nodeName: 'Actor' });

    const renamed = await call('manage_scene_structure', {
      scenePath: 'scenes/structure.tscn', action: 'rename', nodePath: 'Actor', newName: 'Hero',
    });
    expect(renamed.isError, renamed.text).toBe(false);
    expect(projectFile('scenes/structure.tscn')).toContain('name="Hero"');

    const duplicated = await call('manage_scene_structure', {
      scenePath: 'scenes/structure.tscn', action: 'duplicate', nodePath: 'Hero',
    });
    expect(duplicated.isError, duplicated.text).toBe(false);
    expect(projectFile('scenes/structure.tscn')).toContain('name="Hero2"');

    const moved = await call('manage_scene_structure', {
      scenePath: 'scenes/structure.tscn', action: 'move', nodePath: 'Hero', newParentPath: 'Container',
    });
    expect(moved.isError, moved.text).toBe(false);
    expect(projectFile('scenes/structure.tscn')).toMatch(/name="Hero"[^\n]*parent="Container"/);

    // Verified through a fresh engine load, not just the text format.
    const read = await call('read_scene', { scenePath: 'scenes/structure.tscn' });
    expect(read.text).toContain('"Hero"');
    expect(read.text).toContain('"Container"');
  });

  it('rejects an unknown action, a root move, and a cyclic move', async () => {
    const unknown = await call('manage_scene_structure', {
      scenePath: 'scenes/structure.tscn', action: 'explode', nodePath: 'Container',
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/Allowed actions: rename, duplicate, move/);

    const rootMove = await call('manage_scene_structure', {
      scenePath: 'scenes/structure.tscn', action: 'move', nodePath: 'root', newParentPath: 'Container',
    });
    expect(rootMove.isError).toBe(true);

    const cyclic = await call('manage_scene_structure', {
      scenePath: 'scenes/structure.tscn', action: 'move', nodePath: 'Container', newParentPath: 'Container/Hero',
    });
    expect(cyclic.isError).toBe(true);
    expect(cyclic.text).toMatch(/into itself|descendant/i);
  });

  it('remove_scene_node deletes a subtree but never the root', async () => {
    const removed = await call('remove_scene_node', { scenePath: 'scenes/structure.tscn', nodePath: 'Hero2' });
    expect(removed.isError, removed.text).toBe(false);
    expect(projectFile('scenes/structure.tscn')).not.toContain('Hero2');

    const rootRemoval = await call('remove_scene_node', { scenePath: 'scenes/structure.tscn', nodePath: 'root' });
    expect(rootRemoval.isError).toBe(true);
    expect(rootRemoval.text).toMatch(/Cannot remove the root node/i);
  });
});

describe('manage_scene_signals actions', () => {
  it('lists, adds, and removes persisted signal connections', async () => {
    const empty = await call('manage_scene_signals', { scenePath: 'scenes/structure.tscn', action: 'list' });
    expect(empty.isError, empty.text).toBe(false);
    expect(empty.text).toContain('"connections":[]');

    const added = await call('manage_scene_signals', {
      scenePath: 'scenes/structure.tscn',
      action: 'add',
      signalName: 'visibility_changed',
      sourcePath: '.',
      targetPath: '.',
      method: '_on_visibility_changed',
    });
    expect(added.isError, added.text).toBe(false);

    const listed = await call('manage_scene_signals', { scenePath: 'scenes/structure.tscn', action: 'list' });
    expect(listed.text).toContain('visibility_changed');
    expect(listed.text).toContain('_on_visibility_changed');
    expect(projectFile('scenes/structure.tscn')).toContain('[connection signal="visibility_changed"');

    const removed = await call('manage_scene_signals', {
      scenePath: 'scenes/structure.tscn', action: 'remove', signalName: 'visibility_changed',
    });
    expect(removed.isError, removed.text).toBe(false);
    const after = await call('manage_scene_signals', { scenePath: 'scenes/structure.tscn', action: 'list' });
    expect(after.text).toContain('"connections":[]');
  });
});

describe('resource tools', () => {
  it('create_resource writes typed properties, manage_resource reads and modifies them', async () => {
    const created = await call('create_resource', {
      resourceType: 'BoxMesh',
      resourcePath: 'resources/box.tres',
      properties: { size: { x: 2, y: 2, z: 2 } },
    });
    expect(created.isError, created.text).toBe(false);
    expect(projectFile('resources/box.tres')).toContain('size = Vector3(2, 2, 2)');

    const read = await call('manage_resource', { resourcePath: 'resources/box.tres', action: 'read' });
    expect(read.isError, read.text).toBe(false);
    expect(read.text).toContain('"type":"BoxMesh"');

    const modified = await call('manage_resource', {
      resourcePath: 'resources/box.tres', action: 'modify', properties: { size: { x: 4, y: 4, z: 4 } },
    });
    expect(modified.isError, modified.text).toBe(false);
    expect(projectFile('resources/box.tres')).toContain('size = Vector3(4, 4, 4)');
  });

  it('create_resource and manage_resource classify their failures', async () => {
    const badType = await call('create_resource', { resourceType: 'NotAResource', resourcePath: 'resources/x.tres' });
    expect(badType.isError).toBe(true);
    expect(badType.text).toMatch(/Unknown resource type/i);

    const badAction = await call('manage_resource', { resourcePath: 'resources/box.tres', action: 'explode' });
    expect(badAction.isError).toBe(true);
    expect(badAction.text).toMatch(/Allowed actions: read, modify/);

    const missing = await call('manage_resource', { resourcePath: 'resources/absent.tres', action: 'read' });
    expect(missing.isError).toBe(true);
  });

  it('manage_theme_resource creates, reads, and modifies a theme', async () => {
    const created = await call('manage_theme_resource', { resourcePath: 'resources/ui.tres', action: 'create' });
    expect(created.isError, created.text).toBe(false);
    expect(existsSync(join(server.projectPath, 'resources/ui.tres'))).toBe(true);

    const read = await call('manage_theme_resource', { resourcePath: 'resources/ui.tres', action: 'read' });
    expect(read.isError, read.text).toBe(false);
    expect(read.text).toContain('"type":"Theme"');

    const modified = await call('manage_theme_resource', {
      resourcePath: 'resources/ui.tres', action: 'modify', properties: { default_font_size: 24 },
    });
    expect(modified.isError, modified.text).toBe(false);
    expect(projectFile('resources/ui.tres')).toContain('default_font_size = 24');
  });

  it('export_mesh_library exports meshes from a scene into a .tres library', async () => {
    await call('create_scene', { scenePath: 'scenes/blocks.tscn', rootNodeType: 'Node3D' });
    // Resource-typed property assigned by res:// path — a distinct parameter family.
    await call('add_node', {
      scenePath: 'scenes/blocks.tscn',
      nodeType: 'MeshInstance3D',
      nodeName: 'Block',
      properties: { mesh: 'res://resources/box.tres' },
    });
    const exported = await call('export_mesh_library', {
      scenePath: 'scenes/blocks.tscn',
      outputPath: 'resources/blocks.tres',
    });
    expect(exported.isError, exported.text).toBe(false);
    expect(exported.text).toMatch(/exported successfully with 1 items/i);
    expect(projectFile('resources/blocks.tres')).toContain('MeshLibrary');
  });
});

describe('exotic project paths', () => {
  it('authors scenes in a project directory with spaces and non-ASCII characters', async () => {
    const exotic = await startServer({ project: (await import('./helpers/harness.js')).createTempProject({ name: 'Проект Ñü 2' }) });
    try {
      const created = await exotic.call('create_scene', {
        projectPath: exotic.projectPath, scenePath: 'scenes/level.tscn',
      });
      expect(created.isError, created.text).toBe(false);
      const added = await exotic.call('add_node', {
        projectPath: exotic.projectPath, scenePath: 'scenes/level.tscn', nodeType: 'Node2D', nodeName: 'Actor',
      });
      expect(added.isError, added.text).toBe(false);
      const read = await exotic.call('read_scene', {
        projectPath: exotic.projectPath, scenePath: 'scenes/level.tscn',
      });
      expect(read.isError, read.text).toBe(false);
      expect(read.text).toContain('"Actor"');
    } finally {
      await exotic.close();
    }
  });
});

describe('repeatability', () => {
  it('create_scene overwrites deterministically and add_node de-duplicates names', async () => {
    const again = await call('create_scene', { scenePath: 'scenes/level.tscn', rootNodeType: 'Node2D' });
    expect(again.isError, again.text).toBe(false);

    await call('add_node', { scenePath: 'scenes/level.tscn', nodeType: 'Node2D', nodeName: 'Twin' });
    const second = await call('add_node', { scenePath: 'scenes/level.tscn', nodeType: 'Node2D', nodeName: 'Twin' });
    expect(second.isError, second.text).toBe(false);
    const read = await call('read_scene', { scenePath: 'scenes/level.tscn' });
    // Godot renames the second node (@Twin@..., Twin2, ...) rather than
    // silently merging; both children must survive the round trip.
    expect((read.text.match(/Twin/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe('UID tools', () => {
  it('get_uid reports a script UID after update_project_uids generates it', async () => {
    const before = await call('get_uid', { filePath: 'scripts/player.gd' });
    expect(before.isError, before.text).toBe(false);
    expect(before.text).toContain('"file":"res://scripts/player.gd"');

    const resaved = await call('update_project_uids', {});
    expect(resaved.isError, resaved.text).toBe(false);

    const after = await call('get_uid', { filePath: 'scripts/player.gd' });
    expect(after.isError, after.text).toBe(false);
    expect(after.text).toContain('"exists":true');
    expect(after.text).toContain('"uid":"uid://');
  });

  it('get_uid fails for a file outside the project contract', async () => {
    const missing = await call('get_uid', { filePath: 'scripts/absent.gd' });
    expect(missing.text).toMatch(/"exists":false|does not exist|not found/i);
  });
});
