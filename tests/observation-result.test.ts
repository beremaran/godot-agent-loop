// @test-kind: unit
import { describe, expect, it, vi } from 'vitest';

import { GameCommandService } from '../src/game-command-service.js';
import { createBoundedObservationResponse } from '../src/observation-result.js';

function payload(response: ReturnType<typeof createBoundedObservationResponse>): Record<string, any> {
  return JSON.parse(response.content[0].text as string) as Record<string, any>;
}

describe('bounded observation results', () => {
  it('reports exact compact response bytes and leaves a refinement path', () => {
    const response = createBoundedObservationResponse(
      { success: true, elements: Array.from({ length: 20 }, (_, index) => ({ index, text: 'x'.repeat(200) })) },
      {
        limitBytes: 1_024,
        preferredArrayKeys: ['elements'],
        returnedCount: value => Array.isArray(value.elements) ? value.elements.length : 0,
        refinement: 'Inspect one named node.',
        continuation: 'Call game_get_node_info with a nodePath.',
      },
    );
    const result = payload(response);
    const responseBytes = Buffer.byteLength(response.content[0].text as string, 'utf8');

    expect(responseBytes).toBeLessThanOrEqual(1_024);
    expect(result.elements.length).toBeLessThan(20);
    expect(result.observation).toEqual({
      responseBytes,
      limitBytes: 1_024,
      returnedCount: result.elements.length,
      truncated: true,
      refinement: 'Inspect one named node.',
      continuation: 'Call game_get_node_info with a nodePath.',
    });
  });

  it('preserves a source truncation signal even when no local trimming is needed', () => {
    const response = createBoundedObservationResponse(
      { elements: [{ path: '/root/Main/Button' }], truncated: true },
      {
        preferredArrayKeys: ['elements'],
        returnedCount: value => Array.isArray(value.elements) ? value.elements.length : 0,
        sourceTruncated: value => value.truncated === true,
        refinement: 'Narrow the observation.',
        continuation: 'Inspect the returned path directly.',
      },
    );
    const result = payload(response);

    expect(result.elements).toHaveLength(1);
    expect(result.observation).toMatchObject({
      returnedCount: 1,
      truncated: true,
      continuation: 'Inspect the returned path directly.',
    });
  });
});

describe('runtime observation boundary', () => {
  it.each([
    ['get_ui_elements', { success: true, elements: [{ path: '/root/Main/Button' }], truncated: false }, 1],
    ['get_node_info', {
      success: true, properties: [{ name: 'visible', value: true }], signals: ['ready'], methods: ['show'], children: [], truncated: false,
    }, 3],
    ['get_scene_tree', {
      success: true, tree: { name: 'root', children: [{ name: 'Main' }] }, truncated: false,
    }, 2],
  ])('measures %s results before returning them to MCP', async (command, result, count) => {
    const send = vi.fn().mockResolvedValue({ jsonrpc: '2.0', id: 1, result });
    const service = new GameCommandService(
      { activeProcess: {}, readNewErrors: vi.fn(), readNewLogs: vi.fn() } as any,
      { isConnected: true, send } as any,
    );

    const response = await service.execute(command, {}, () => ({}));
    const value = JSON.parse(response.content[0].text as string);

    expect(value.observation).toMatchObject({ returnedCount: count, truncated: false });
    expect(value.observation.responseBytes).toBe(Buffer.byteLength(response.content[0].text as string, 'utf8'));
  });
});
