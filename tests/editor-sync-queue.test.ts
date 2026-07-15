// @test-kind: unit
import { describe, expect, it, vi } from 'vitest';
import { EditorSyncQueue } from '../src/editor-sync-queue.js';
import { EditorSessionUnavailableError, type PublicEditorSession } from '../src/editor-session-registry.js';

const connected: PublicEditorSession = {
  state: 'connected', project_path: '/project', connected: true, reused: true, spawned: false,
  editor_pid: 10, editor_start_identity: '10-1', port: 30000, protocol_version: '2',
  addon_version: '1.1.0', godot_version: '4.7', created_at: 'now',
};

describe('EditorSyncQueue', () => {
  it('debounces related writes and preserves the final focus target', async () => {
    const send = vi.fn(async () => ({ success: true, observed_target_state: { focused: 'Player' } }));
    const queue = new EditorSyncQueue({ send, status: async () => connected, debounceMs: 5 });
    const first = queue.enqueue({ project_path: '/project', command: 'add', scene_path: 'res://main.tscn', focus_path: 'Old' });
    const second = queue.enqueue({ project_path: '/project', command: 'modify', scene_path: 'res://main.tscn', focus_path: 'Player' });
    await expect(first).resolves.toMatchObject({ sync_status: 'acknowledged' });
    await expect(second).resolves.toMatchObject({ sync_status: 'acknowledged' });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][1]).toMatchObject({ focus_path: 'Player', changes: [{ command: 'add' }, { command: 'modify' }] });
  });

  it('reports unsaved conflict independently from disk persistence', async () => {
    const queue = new EditorSyncQueue({
      send: async () => ({ error: 'unsaved_conflict', state: 'unsaved_conflict', observed_target_state: { unsaved: true } }),
      status: async () => ({ ...connected, state: 'unsaved_conflict' }), debounceMs: 0,
    });
    await expect(queue.enqueue({ project_path: '/project', command: 'modify' })).resolves.toMatchObject({
      sync_status: 'conflict', fallback_reason: expect.stringContaining('unsaved'),
    });
  });

  it('keeps detached authoring successful while disclosing no acknowledgement', async () => {
    const detached = { ...connected, state: 'no_editor' as const, connected: false };
    const queue = new EditorSyncQueue({
      send: async () => { throw new EditorSessionUnavailableError(detached); },
      status: async () => detached, debounceMs: 0,
    });
    await expect(queue.enqueue({ project_path: '/project', command: 'create' })).resolves.toMatchObject({
      sync_status: 'detached', editor_session: { state: 'no_editor' }, fallback_reason: expect.any(String),
    });
  });

  it('surfaces bridge timeouts instead of swallowing them', async () => {
    const queue = new EditorSyncQueue({
      send: async () => { throw new Error('Editor request timed out'); },
      status: async () => connected, debounceMs: 0,
    });
    await expect(queue.enqueue({ project_path: '/project', command: 'save' })).resolves.toMatchObject({
      sync_status: 'timeout', fallback_reason: 'Editor request timed out',
    });
  });
});
