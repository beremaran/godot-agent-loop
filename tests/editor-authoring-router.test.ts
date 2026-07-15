// @test-kind: unit
import { describe, expect, it, vi } from 'vitest';

import { EditorAuthoringRouter } from '../src/editor-authoring-router.js';
import type { PublicEditorSession } from '../src/editor-session-registry.js';

function session(overrides: Partial<PublicEditorSession> = {}): PublicEditorSession {
  return {
    state: 'connected',
    project_path: '/project',
    connected: true,
    reused: true,
    spawned: false,
    editor_pid: 123,
    editor_start_identity: '123:1',
    port: 49152,
    protocol_version: '2',
    addon_version: '1.1.0',
    godot_version: '4.7',
    created_at: '1',
    ...overrides,
  };
}

function fixture(editorSession = session()) {
  const send = vi.fn(async () => ({ success: true, undo_recorded: true }));
  const status = vi.fn(async () => editorSession);
  return { router: new EditorAuthoringRouter({ status, send }), send, status };
}

describe('EditorAuthoringRouter', () => {
  it.each([
    ['authoring_create_scene', { scenePath: 'scenes/main.tscn', rootNodeType: 'Node3D' }, { op: 'save' }],
    ['authoring_add_node', { scenePath: 'main.tscn', parentNodePath: 'root/Actors', nodeType: 'Node2D', nodeName: 'Player' }, { op: 'add_node', parent_path: 'Actors', node_name: 'Player' }],
    ['authoring_modify_node', { scenePath: 'main.tscn', nodePath: 'root/Player', properties: { visible: false } }, { op: 'set_properties', node_path: 'Player' }],
    ['authoring_remove_node', { scenePath: 'main.tscn', nodePath: 'root/Player' }, { op: 'remove_node', node_path: 'Player' }],
    ['authoring_attach_script', { scenePath: 'main.tscn', nodePath: 'root/Player', scriptPath: 'scripts/player.gd' }, { op: 'attach_script', script_path: 'res://scripts/player.gd' }],
    ['authoring_save_scene', { scenePath: 'main.tscn' }, { op: 'save' }],
    ['authoring_manage_scene_structure', { scenePath: 'main.tscn', action: 'rename', nodePath: 'root/Player', newName: 'Hero' }, { op: 'rename_node', name: 'Hero' }],
    ['authoring_manage_scene_structure', { scenePath: 'main.tscn', action: 'duplicate', nodePath: 'root/Player' }, { op: 'duplicate_node', node_path: 'Player' }],
    ['authoring_manage_scene_structure', { scenePath: 'main.tscn', action: 'move', nodePath: 'root/Player', newParentPath: 'root/Actors' }, { op: 'reparent_node', new_parent_path: 'Actors' }],
  ])('maps %s to a live editor transaction', async (command, params, expectedOperation) => {
    const { router, send } = fixture();

    const attempt = await router.tryExecute(command, params, '/project');

    expect(attempt.handled).toBe(true);
    expect(attempt.result).toMatchObject({ exitCode: 0, signal: null });
    expect(send).toHaveBeenCalledWith('/project', 'transaction', expect.objectContaining({
      scene_path: expect.stringMatching(/^res:\/\//),
      operations: [expect.objectContaining(expectedOperation)],
      save: true,
    }), 30_000);
    expect(JSON.parse(attempt.result?.stdout ?? '{}')).toMatchObject({
      backend: 'editor', sync_status: 'acknowledged', fallback_reason: null,
    });
  });

  it('discloses a detached editor and leaves the operation to the declared fallback', async () => {
    const { router, send } = fixture(session({ state: 'no_editor', connected: false }));

    const attempt = await router.tryExecute(
      'authoring_add_node',
      { scenePath: 'main.tscn', nodeName: 'Player', nodeType: 'Node2D' },
      '/project',
    );

    expect(attempt).toMatchObject({ handled: false });
    expect(attempt.fallbackReason).toContain('no_editor');
    expect(send).not.toHaveBeenCalled();
  });

  it('does not fall back after the editor rejects a transaction', async () => {
    const { router, send } = fixture();
    send.mockResolvedValueOnce({ error: 'unsaved_conflict', state: 'unsaved_conflict' });

    const attempt = await router.tryExecute(
      'authoring_remove_node',
      { scenePath: 'main.tscn', nodePath: 'Player' },
      '/project',
    );

    expect(attempt).toMatchObject({ handled: true, result: { exitCode: 1 } });
    expect(attempt.result?.stderr).toContain('unsaved_conflict');
  });

  it('keeps save-as on the declared fallback because it is not transaction-compatible', async () => {
    const { router, send } = fixture();
    const attempt = await router.tryExecute(
      'authoring_save_scene',
      { scenePath: 'main.tscn', newPath: 'copy.tscn' },
      '/project',
    );

    expect(attempt).toMatchObject({ handled: false });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ['authoring_create_resource', { resourcePath: 'materials/paddle.tres', resourceType: 'StandardMaterial3D', properties: { roughness: 0.4 } }],
    ['authoring_manage_resource', { resourcePath: 'materials/paddle.tres', action: 'modify', properties: { roughness: 0.2 } }],
  ])('routes supported %s work through the editor resource transaction', async (command, params) => {
    const { router, send } = fixture();

    const attempt = await router.tryExecute(command, params, '/project');

    expect(attempt).toMatchObject({ handled: true, result: { exitCode: 0 } });
    expect(send).toHaveBeenCalledWith('/project', 'resource_transaction', expect.objectContaining({
      resource_path: 'res://materials/paddle.tres', properties: expect.any(Object),
    }), 30_000);
  });

  it('keeps resource reads on their observational authoring backend', async () => {
    const { router, send } = fixture();
    const attempt = await router.tryExecute(
      'authoring_manage_resource',
      { resourcePath: 'materials/paddle.tres', action: 'read' },
      '/project',
    );

    expect(attempt).toMatchObject({ handled: false });
    expect(send).not.toHaveBeenCalled();
  });
});
