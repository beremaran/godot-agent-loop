// @test-kind: unit
import { describe, expect, it, vi } from 'vitest';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { abortError, currentExecutionContext, getToolResultMetadata } from '../src/execution-context.js';
import {
  composeToolHandlerRegistries,
  type ToolHandlerRegistry,
} from '../src/domain-tool-registries.js';

describe('ToolRegistry', () => {
  it('invokes the explicitly registered handler', async () => {
    const handler = vi.fn(async (args: unknown) => ({ args }));
    const registry = new ToolRegistry({ game_light_3d: handler });
    const args = { action: 'create', parentPath: '/root', lightType: 'omni', energy: 2 };

    await expect(registry.dispatch('game_light_3d', args)).resolves.toEqual({ args });
    expect(handler).toHaveBeenCalledWith(args);
  });

  it('preserves the MCP error for unknown tools', () => {
    const registry = new ToolRegistry({});

    try {
      void registry.dispatch('unknown', undefined);
      throw new Error('Expected dispatch to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(McpError);
      expect((error as McpError).code).toBe(ErrorCode.MethodNotFound);
      expect((error as Error).message).toContain('Unknown tool: unknown');
    }
  });

  it('returns recoverable invalid-argument results before invoking the handler', async () => {
    const handler = vi.fn(async () => ({ content: [] }));
    const registry = new ToolRegistry({ game_click: handler });

    await expect(registry.dispatch('game_click', { x: 'not-a-number' })).resolves.toMatchObject({
      isError: true,
      content: [{ type: 'text', text: expect.stringContaining('Invalid arguments') }],
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs preflight after parsing and refuses dispatch when it returns a response', async () => {
    const handler = vi.fn(async () => ({ content: [] }));
    const blocked = { content: [{ type: 'text', text: 'paused' }], isError: true };
    const preflight = vi.fn(async () => blocked);
    const registry = new ToolRegistry({ game_click: handler }, preflight);

    await expect(registry.dispatch('game_click', { x: 12, y: 34 })).resolves.toBe(blocked);
    expect(preflight).toHaveBeenCalledWith('game_click', { x: 12, y: 34 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('dispatches when preflight allows the call', async () => {
    const response = { content: [{ type: 'text', text: 'ok' }] };
    const handler = vi.fn(async () => response);
    const registry = new ToolRegistry({ game_click: handler }, async () => undefined);

    await expect(registry.dispatch('game_click', { x: 1, y: 2 })).resolves.toBe(response);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('resolves effective nested context before preflight and links child calls', async () => {
    const contexts: NonNullable<ReturnType<typeof currentExecutionContext>>[] = [];
    const registry = new ToolRegistry<string>({
      godot_call: async args => registry.dispatch(String(args.toolName), args.arguments ?? {}),
      game_key_hold: async () => {
        contexts.push(currentExecutionContext()!);
        return { content: [{ type: 'text', text: 'held' }] };
      },
    }, (_name, _args, context) => {
      contexts.push(context);
      return undefined;
    }, {
      context: { resolveProject: () => ({ projectPath: '/runtime-project' }) },
    });

    await registry.dispatch('godot_call', { toolName: 'game_key_hold', arguments: { key: 'w' } });

    expect(contexts[0]).toMatchObject({
      invocationToolName: 'godot_call', effectiveToolName: 'game_key_hold',
      projectPath: '/runtime-project', mutating: true,
    });
    const child = contexts.find(context => context.invocationToolName === 'game_key_hold' && context.parentTraceId);
    expect(child?.parentTraceId).toBe(contexts[0].traceId);
  });

  it('provides typed argument errors to the result finalizer', async () => {
    let finalizedError: unknown;
    const registry = new ToolRegistry({ game_click: vi.fn(async () => ({ content: [] })) }, undefined, {
      onFinish: (_context, response) => {
        finalizedError = getToolResultMetadata(response).error;
        return response;
      },
    });

    const response = await registry.dispatch('game_click', { x: 'bad' });

    expect(response.isError).toBe(true);
    expect(finalizedError).toMatchObject({ code: 'invalid_arguments', category: 'argument' });
  });

  it('cancels a pre-aborted request before handler execution', async () => {
    const handler = vi.fn(async () => ({ content: [] }));
    const finalized: string[] = [];
    const controller = new AbortController();
    controller.abort('cancelled before start');
    const registry = new ToolRegistry({ game_click: handler }, undefined, {
      onFinish: (_context, response) => {
        finalized.push(String(getToolResultMetadata(response).outcome));
        return response;
      },
    });

    const response = await registry.dispatch('game_click', { x: 1, y: 2 }, { signal: controller.signal });

    expect(handler).not.toHaveBeenCalled();
    expect(response.isError).toBe(true);
    expect(finalized).toEqual(['cancelled']);
  });

  it('translates AbortError during work into a typed cancelled result', async () => {
    const registry = new ToolRegistry({
      game_click: async () => { throw abortError('cancelled during work'); },
    });

    const response = await registry.dispatch('game_click', { x: 1, y: 2 });

    expect(response.isError).toBe(true);
    expect(getToolResultMetadata(response)).toMatchObject({
      outcome: 'cancelled', error: { code: 'cancelled', category: 'cancelled' },
    });
  });

  it('keeps a completed result when cancellation races after handler completion', async () => {
    const controller = new AbortController();
    const registry = new ToolRegistry({
      game_click: async () => {
        controller.abort('too late');
        return { content: [{ type: 'text', text: 'complete' }] };
      },
    });

    const response = await registry.dispatch('game_click', { x: 1, y: 2 }, { signal: controller.signal });

    expect(response.isError).not.toBe(true);
    expect(response.content[0]?.text).toBe('complete');
  });
});

describe('composeToolHandlerRegistries', () => {
  const handler = vi.fn(async () => ({ content: [] }));

  it('rejects handlers registered by more than one domain', () => {
    const registry: ToolHandlerRegistry = { launch_editor: handler };

    expect(() => composeToolHandlerRegistries(registry, registry))
      .toThrow('Tool handler is registered more than once: launch_editor');
  });

  it('rejects handlers without a corresponding tool definition', () => {
    const registry = { unknown_tool: handler } as ToolHandlerRegistry;

    expect(() => composeToolHandlerRegistries(registry))
      .toThrow('Unknown tool handler: unknown_tool');
  });

  it('rejects a composition that does not cover every tool definition', () => {
    expect(() => composeToolHandlerRegistries({}))
      .toThrow('Missing tool handlers: godot_catalog, godot_call, godot_tools');
  });
});
