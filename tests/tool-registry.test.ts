import { describe, expect, it, vi } from 'vitest';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { ToolRegistry } from '../src/tool-registry.js';
import {
  composeToolHandlerRegistries,
  type ToolHandlerRegistry,
} from '../src/domain-tool-registries.js';

describe('ToolRegistry', () => {
  it('invokes the explicitly registered handler', async () => {
    const handler = vi.fn(async (args: unknown) => ({ args }));
    const registry = new ToolRegistry({ game_light_3d: handler });
    const args = { energy: 2 };

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
});

describe('composeToolHandlerRegistries', () => {
  const handler = vi.fn(async () => ({ content: [] }));

  it('rejects handlers registered by more than one domain', () => {
    const registry: ToolHandlerRegistry = { launch_editor: handler };

    expect(() => composeToolHandlerRegistries(registry, registry))
      .toThrow('Tool handler is registered more than once: launch_editor');
  });

  it('rejects a composition that does not cover every tool definition', () => {
    expect(() => composeToolHandlerRegistries({}))
      .toThrow('Missing tool handlers: launch_editor');
  });
});
