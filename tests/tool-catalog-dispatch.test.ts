// @test-kind: contract
import { describe, expect, it, vi } from 'vitest';
import {
  LifecycleToolHandlers,
  type LifecycleToolHandlerContext,
} from '../src/tool-handlers/lifecycle-tool-handlers.js';

function handlersWithDispatch(
  dispatchTool?: LifecycleToolHandlerContext['dispatchTool'],
): LifecycleToolHandlers {
  return new LifecycleToolHandlers({ dispatchTool } as LifecycleToolHandlerContext);
}

describe('split catalog and hidden-tool dispatch handlers', () => {
  it('forwards exactly one named hidden tool and its arguments through godot_call', async () => {
    const dispatchTool = vi.fn(async (name: string, args: Record<string, unknown>) => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ name, args }) }],
    }));
    const result = await handlersWithDispatch(dispatchTool).handleGodotCall({
      toolName: 'game_light_3d',
      arguments: { action: 'create', nodePath: '/root/KeyLight' },
    });

    expect(dispatchTool).toHaveBeenCalledOnce();
    expect(dispatchTool).toHaveBeenCalledWith('game_light_3d', {
      action: 'create', nodePath: '/root/KeyLight',
    });
    expect(result.isError).not.toBe(true);
  });

  it('rejects dispatcher recursion and unavailable expanded dispatch', async () => {
    for (const toolName of ['godot_catalog', 'godot_call', 'godot_tools']) {
      const result = await handlersWithDispatch(vi.fn()).handleGodotCall({ toolName, arguments: {} });
      expect(result.isError, toolName).toBe(true);
      expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('cannot recursively') });
    }
    const unavailable = await handlersWithDispatch().handleGodotCall({
      toolName: 'game_light_3d', arguments: {},
    });
    expect(unavailable.isError).toBe(true);
    expect(unavailable.content[0]).toMatchObject({
      type: 'text', text: expect.stringContaining('Expanded tool dispatch is unavailable'),
    });
  });
});
