// @test-kind: unit
import { describe, expect, it, vi } from 'vitest';

import { EditorAuthoringRouter } from '../src/editor-authoring-router.js';
import type { PublicEditorSession } from '../src/editor-session-registry.js';

const connectedSession: PublicEditorSession = {
  state: 'connected',
  project_path: '/project',
  connected: true,
  reused: false,
  spawned: false,
  editor_pid: 4242,
  editor_start_identity: '4242-1',
  reason: null,
};

function fixture(options: {
  status?: () => Promise<PublicEditorSession>;
  send?: ReturnType<typeof vi.fn>;
  inputKeycodeFor?: (key: string) => number | undefined;
} = {}) {
  const send = options.send ?? vi.fn(async () => ({ success: true, backend: 'editor' }));
  const router = new EditorAuthoringRouter({
    status: options.status ?? (async () => connectedSession),
    ensure: async () => connectedSession,
    send,
    inputKeycodeFor: options.inputKeycodeFor,
  });
  return { router, send };
}

describe('EditorAuthoringRouter project_settings routing', () => {
  it('routes modify_project_settings to the project_settings bridge command', async () => {
    const { router, send } = fixture();
    const attempt = await router.tryExecute(
      'modify_project_settings',
      { projectPath: '/project', section: 'display', key: 'window/size/viewport_width', value: 1280 },
      '/project',
    );

    expect(attempt.handled).toBe(true);
    expect(send).toHaveBeenCalledWith('/project', 'project_settings', {
      name: 'Modify display/window/size/viewport_width',
      settings: [{ section: 'display', key: 'window/size/viewport_width', value: 1280 }],
    }, 30_000);
    const payload = JSON.parse(attempt.result?.stdout ?? '');
    expect(payload.backend).toBe('editor');
    expect(payload.sync_status).toBe('acknowledged');
  });

  it('routes set_main_scene as the application/run/main_scene setting', async () => {
    const { router, send } = fixture();
    const attempt = await router.tryExecute(
      'set_main_scene',
      { projectPath: '/project', scenePath: 'scenes/main.tscn' },
      '/project',
    );

    expect(attempt.handled).toBe(true);
    expect(send).toHaveBeenCalledWith('/project', 'project_settings', {
      name: 'Set main scene',
      settings: [{ section: 'application', key: 'run/main_scene', value: 'res://scenes/main.tscn' }],
    }, 30_000);
  });

  it('routes manage_input_map add with a resolved keycode', async () => {
    const { router, send } = fixture({ inputKeycodeFor: key => (key === 'W' ? 87 : undefined) });
    const attempt = await router.tryExecute(
      'manage_input_map',
      { projectPath: '/project', action: 'add', actionName: 'move_forward', key: 'W', deadzone: 0.3 },
      '/project',
    );

    expect(attempt.handled).toBe(true);
    expect(send).toHaveBeenCalledWith('/project', 'project_settings', {
      name: 'Add input action move_forward',
      settings: [{
        section: 'input',
        key: 'move_forward',
        value: { deadzone: 0.3, events: [{ type: 'InputEventKey', physical_keycode: 87 }] },
      }],
    }, 30_000);
  });

  it('falls back when manage_input_map add has no resolvable keycode', async () => {
    const { router, send } = fixture({ inputKeycodeFor: () => undefined });
    const attempt = await router.tryExecute(
      'manage_input_map',
      { projectPath: '/project', action: 'add', actionName: 'jump', key: '?', deadzone: 0.5 },
      '/project',
    );

    expect(attempt.handled).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('routes manage_input_map remove as a null setting value', async () => {
    const { router, send } = fixture();
    const attempt = await router.tryExecute(
      'manage_input_map',
      { projectPath: '/project', action: 'remove', actionName: 'jump' },
      '/project',
    );

    expect(attempt.handled).toBe(true);
    expect(send).toHaveBeenCalledWith('/project', 'project_settings', {
      name: 'Remove input action jump',
      settings: [{ section: 'input', key: 'jump', value: null }],
    }, 30_000);
  });

  it('never routes read-only manage_input_map list', async () => {
    const { router, send } = fixture();
    const attempt = await router.tryExecute(
      'manage_input_map',
      { projectPath: '/project', action: 'list' },
      '/project',
    );

    expect(attempt.handled).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('falls back when the attached addon predates project_settings', async () => {
    const { router } = fixture({
      send: vi.fn(async () => ({
        error: 'unknown_command',
        allowed: ['inspect', 'transaction', 'resource_transaction'],
      })),
    });
    const attempt = await router.tryExecute(
      'modify_project_settings',
      { projectPath: '/project', section: 'application', key: 'config/name', value: 'Game' },
      '/project',
    );

    expect(attempt.handled).toBe(false);
    expect(attempt.fallbackReason).toContain('does not support project_settings');
  });

  it('falls back when no editor session is attached', async () => {
    const { router, send } = fixture({
      status: async () => ({
        state: 'no_editor', project_path: '/project', connected: false, reused: false,
        spawned: false, editor_pid: null, editor_start_identity: null, reason: null,
      }),
    });
    const attempt = await router.tryExecute(
      'modify_project_settings',
      { projectPath: '/project', section: 'application', key: 'config/name', value: 'Game' },
      '/project',
    );

    expect(attempt.handled).toBe(false);
    expect(attempt.fallbackReason).toContain('Editor session unavailable');
    expect(send).not.toHaveBeenCalled();
  });

  it('reports editor failures instead of duplicating the mutation', async () => {
    const { router } = fixture({
      send: vi.fn(async () => ({ error: 'project_settings_save_failed', error_code: 1 })),
    });
    const attempt = await router.tryExecute(
      'modify_project_settings',
      { projectPath: '/project', section: 'application', key: 'config/name', value: 'Game' },
      '/project',
    );

    expect(attempt.handled).toBe(true);
    expect(attempt.result?.exitCode).toBe(1);
    expect(attempt.result?.stderr).toContain('project_settings_save_failed');
  });
});

describe('EditorAuthoringRouter legacy routing', () => {
  it('still routes authoring_add_node through the transaction command', async () => {
    const { router, send } = fixture();
    const attempt = await router.tryExecute(
      'authoring_add_node',
      { projectPath: '/project', scenePath: 'scenes/main.tscn', parentNodePath: '.', nodeType: 'Sprite2D', nodeName: 'Hero' },
      '/project',
    );

    expect(attempt.handled).toBe(true);
    expect(send).toHaveBeenCalledWith('/project', 'transaction', expect.objectContaining({
      scene_path: 'res://scenes/main.tscn',
      name: 'Add Hero',
      operations: [expect.objectContaining({ op: 'add_node', node_type: 'Sprite2D', node_name: 'Hero' })],
    }), 30_000);
  });

  it('still routes authoring_manage_resource modify through resource_transaction', async () => {
    const { router, send } = fixture();
    const attempt = await router.tryExecute(
      'authoring_manage_resource',
      { projectPath: '/project', resourcePath: 'assets/materials/mat.tres', action: 'modify', properties: { albedo_color: '#ff0000' } },
      '/project',
    );

    expect(attempt.handled).toBe(true);
    expect(send).toHaveBeenCalledWith('/project', 'resource_transaction', expect.objectContaining({
      resource_path: 'res://assets/materials/mat.tres',
    }), 30_000);
  });
});
