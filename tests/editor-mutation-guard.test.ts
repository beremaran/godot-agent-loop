// @test-kind: unit
import { describe, expect, it, vi } from 'vitest';
import { EditorMutationGuard } from '../src/editor-mutation-guard.js';
import { createExecutionContext, getToolResultMetadata } from '../src/execution-context.js';
import { ToolRegistry } from '../src/tool-registry.js';

describe('EditorMutationGuard', () => {
  it('uses resolved runtime project context for pathless mutating calls', async () => {
    const read = vi.fn().mockResolvedValue({ paused: true });
    const guard = new EditorMutationGuard(read, () => true);
    const execution = createExecutionContext('game_key_hold', { key: 'w' }, {}, undefined, {
      resolveProject: () => ({ projectPath: '/project' }),
    });

    const response = await guard.check('game_key_hold', { key: 'w' }, execution);

    expect(read).toHaveBeenCalledWith('/project', 'driver_state', {}, 500, execution.signal);
    expect(response?.isError).toBe(true);
    expect(response && getToolResultMetadata(response).outcome).toBe('paused');
  });

  it('blocks an entire scenario when pause is active before it starts', async () => {
    const read = vi.fn().mockResolvedValue({ paused: true });
    const guard = new EditorMutationGuard(read, () => true);
    const args = { name: 'blocked', steps: [{ type: 'input', tool: 'game_key_hold', arguments: { key: 'W' } }] };
    const execution = createExecutionContext('game_scenario', args, {}, undefined, {
      resolveProject: () => ({ projectPath: '/project' }),
    });

    const response = await guard.check('game_scenario', args, execution);

    expect(response?.isError).toBe(true);
    expect(response && getToolResultMetadata(response).outcome).toBe('paused');
    expect(read).toHaveBeenCalledOnce();
  });

  it('fails closed when a previously attached editor cannot confirm pause state', async () => {
    const guard = new EditorMutationGuard(
      vi.fn().mockRejectedValue(new Error('bridge timed out')),
      () => true,
    );
    const response = await guard.check('create_scene', { projectPath: '/project' });
    expect(response?.isError).toBe(true);
    expect(String(response?.content[0]?.text)).toContain('pause state could not be confirmed');
  });

  it('fails closed when the editor disconnects during the pause-state check', async () => {
    let attached = true;
    const read = vi.fn(async () => {
      attached = false;
      throw new Error('editor disconnected during driver_state');
    });
    const guard = new EditorMutationGuard(read, () => attached);

    const response = await guard.check('write_file', {
      projectPath: '/project', filePath: 'player.gd', content: 'extends Node\n',
    });

    expect(attached).toBe(false);
    expect(response?.isError).toBe(true);
    expect(String(response?.content[0]?.text)).toMatch(/pause state could not be confirmed.*disconnected/i);
  });

  it('continues unattended when no editor owns a cooperative pause lock', async () => {
    const guard = new EditorMutationGuard(
      vi.fn().mockRejectedValue(new Error('no editor session')),
      () => false,
    );
    await expect(guard.check('write_file', {
      projectPath: '/project', filePath: 'player.gd', content: 'extends Node\n',
    })).resolves.toBeUndefined();
  });

  it('allows cleanup input while paused without consulting the bridge', async () => {
    const read = vi.fn();
    const guard = new EditorMutationGuard(read, () => true);
    await expect(guard.check('game_key_release', { key: 'w' })).resolves.toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it('blocks hidden persistent mutation through both dispatcher identities', async () => {
    const read = vi.fn().mockResolvedValue({ paused: true });
    const guard = new EditorMutationGuard(read, () => true);
    const write = vi.fn(async () => ({ content: [{ type: 'text', text: 'written' }] }));
    const newDispatcher = vi.fn(async () => ({ content: [] }));
    const legacyDispatcher = vi.fn(async () => ({ content: [] }));
    const registry = new ToolRegistry({
      godot_call: newDispatcher,
      godot_tools: legacyDispatcher,
      write_file: write,
    }, (name, args, execution) => guard.check(name, args, execution), {
      context: {
        resolveProject: (_invocation, _effective, _args, effectiveArgs) => ({
          projectPath: typeof effectiveArgs.projectPath === 'string' ? effectiveArgs.projectPath : undefined,
        }),
      },
    });
    const nested = {
      toolName: 'write_file',
      arguments: { projectPath: '/project', filePath: 'blocked.gd', content: 'extends Node\n' },
    };

    const modern = await registry.dispatch('godot_call', nested);
    const legacy = await registry.dispatch('godot_tools', { action: 'call', ...nested });

    expect(modern.isError).toBe(true);
    expect(legacy.isError).toBe(true);
    expect(getToolResultMetadata(modern).outcome).toBe('paused');
    expect(getToolResultMetadata(legacy).outcome).toBe('paused');
    expect(newDispatcher).not.toHaveBeenCalled();
    expect(legacyDispatcher).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('blocks direct and dispatched pathless runtime property, input, scene, and audio mutations', async () => {
    const read = vi.fn().mockResolvedValue({ paused: true });
    const guard = new EditorMutationGuard(read, () => true);
    const handlers = {
      godot_call: vi.fn(async () => ({ content: [] })),
      godot_tools: vi.fn(async () => ({ content: [] })),
      game_set_property: vi.fn(async () => ({ content: [] })),
      game_key_hold: vi.fn(async () => ({ content: [] })),
      game_change_scene: vi.fn(async () => ({ content: [] })),
      game_audio_play: vi.fn(async () => ({ content: [] })),
    };
    const registry = new ToolRegistry(handlers, (name, args, execution) => guard.check(name, args, execution), {
      context: {
        resolveProject: () => ({ projectPath: '/runtime-project', connectionIdentity: 'runtime:6007' }),
      },
    });
    const runtimeMutations = [
      ['game_set_property', { nodePath: '/root/Main', property: 'visible', value: false }],
      ['game_key_hold', { key: 'W' }],
      ['game_change_scene', { scenePath: 'res://next.tscn' }],
      ['game_audio_play', { nodePath: '/root/Main/Music', action: 'play' }],
    ] as const;

    for (const [toolName, argumentsValue] of runtimeMutations) {
      expect(argumentsValue).not.toHaveProperty('projectPath');
      const direct = await registry.dispatch(toolName, argumentsValue);
      const modern = await registry.dispatch('godot_call', { toolName, arguments: argumentsValue });
      const legacy = await registry.dispatch('godot_tools', { action: 'call', toolName, arguments: argumentsValue });
      for (const response of [direct, modern, legacy]) {
        expect(response.isError, `${toolName} should be blocked while paused`).toBe(true);
        expect(getToolResultMetadata(response).outcome).toBe('paused');
      }
    }

    expect(read).toHaveBeenCalledTimes(runtimeMutations.length * 3);
    for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled();
  });

  it('returns one cancelled terminal result when cancellation arrives during a paused guard check', async () => {
    let announceRead: (() => void) | undefined;
    let rejectRead: ((error: Error) => void) | undefined;
    const readStarted = new Promise<void>(resolve => { announceRead = resolve; });
    const read = vi.fn(() => {
      return new Promise<Record<string, unknown>>((_resolve, reject) => {
        rejectRead = reject;
        announceRead?.();
      });
    });
    const guard = new EditorMutationGuard(read, () => true);
    const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'mutated' }] }));
    const onFinish = vi.fn((_context, response) => response);
    const registry = new ToolRegistry({ game_key_hold: handler },
      (name, args, execution) => guard.check(name, args, execution), {
        context: { resolveProject: () => ({ projectPath: '/project' }) },
        onFinish,
      });
    const controller = new AbortController();

    const pending = registry.dispatch('game_key_hold', { key: 'W' }, { signal: controller.signal });
    await Promise.race([
      readStarted,
      pending.then(response => {
        throw new Error(`guard was not reached: ${String(response.content[0]?.text)}`);
      }),
    ]);
    controller.abort('client cancelled while editor was paused');
    const abort = new Error('client cancelled while editor was paused');
    abort.name = 'AbortError';
    rejectRead?.(abort);
    const response = await pending;

    expect(response.isError).toBe(true);
    expect(getToolResultMetadata(response).outcome).toBe('cancelled');
    expect(String(response.content[0]?.text)).toMatch(/cancelled while editor was paused/i);
    expect(handler).not.toHaveBeenCalled();
    expect(onFinish).toHaveBeenCalledOnce();
    expect(read.mock.calls[0]?.[4]).toBe(controller.signal);
  });
});
