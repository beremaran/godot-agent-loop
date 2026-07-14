// @test-kind: contract
import { describe, expect, it } from 'vitest';
import { EditorMutationGuard, AGENT_MUTATIONS_PAUSED_MESSAGE } from '../src/editor-mutation-guard.js';
import { toolManifest } from '../src/tool-manifest.js';
import { isToolCallMutating, READ_ONLY_ACTIONS, READ_ONLY_TOOLS } from '../src/tool-mutation-policy.js';

describe('tool mutation policy', () => {
  it('defaults unknown, missing, and data-valued actions to mutating', () => {
    expect(isToolCallMutating('unknown_future_tool', {})).toBe(true);
    expect(isToolCallMutating('editor_control', {})).toBe(true);
    expect(isToolCallMutating('game_key_press', { action: 'query' })).toBe(true);
  });

  it('distinguishes representative observations from mutations', () => {
    expect(isToolCallMutating('read_file', {})).toBe(false);
    expect(isToolCallMutating('game_get_scene_tree', {})).toBe(false);
    expect(isToolCallMutating('editor_control', { action: 'inspect' })).toBe(false);
    expect(isToolCallMutating('game_window', { action: 'get' })).toBe(false);
    expect(isToolCallMutating('write_file', {})).toBe(true);
    expect(isToolCallMutating('add_node', {})).toBe(true);
    expect(isToolCallMutating('game_set_property', {})).toBe(true);
    expect(isToolCallMutating('editor_control', { action: 'save' })).toBe(true);
    expect(isToolCallMutating('game_window', { action: 'set' })).toBe(true);
  });

  it('keeps every read-only exemption aligned with the exhaustive manifest', () => {
    for (const name of READ_ONLY_TOOLS) expect(toolManifest[name]).toBeDefined();
    for (const [rawName, readActions] of Object.entries(READ_ONLY_ACTIONS)) {
      const name = rawName as keyof typeof toolManifest;
      const entry = toolManifest[name];
      expect(entry, name).toBeDefined();
      expect(entry.actionParamIsData, name).not.toBe(true);
      expect(entry.actions, name).not.toBeNull();
      for (const action of readActions ?? []) expect(entry.actions, `${name}:${action}`).toContain(action);
    }
    for (const [name, entry] of Object.entries(toolManifest)) {
      expect(typeof isToolCallMutating(name, {}), name).toBe('boolean');
      for (const action of entry.actions ?? []) {
        expect(typeof isToolCallMutating(name, { action }), `${name}:${action}`).toBe('boolean');
      }
    }
  });
});

describe('EditorMutationGuard', () => {
  it('does not contact the editor for observational calls', async () => {
    let reads = 0;
    const guard = new EditorMutationGuard(async () => { reads += 1; return { paused: true }; });

    await expect(guard.check('read_file', {})).resolves.toBeUndefined();
    expect(reads).toBe(0);
  });

  it('allows unattended mutation when no editor bridge is reachable', async () => {
    const guard = new EditorMutationGuard(async () => { throw new Error('ECONNREFUSED'); });
    await expect(guard.check('write_file', {})).resolves.toBeUndefined();
  });

  it('returns an actionable tool error while the human pause is active', async () => {
    const guard = new EditorMutationGuard(async (command, params, timeoutMs) => {
      expect(command).toBe('driver_state');
      expect(params).toEqual({});
      expect(timeoutMs).toBe(500);
      return { paused: true, agent_driving: false };
    });

    const response = await guard.check('add_node', {});
    expect(response?.isError).toBe(true);
    expect(response?.content[0]?.text).toBe(AGENT_MUTATIONS_PAUSED_MESSAGE);
  });
});
