// @test-kind: e2e
import { afterEach, describe, expect, it } from 'vitest';
import { advertisedToolDefinitions } from '../../src/tool-surface.js';
import { startServer, type E2EServer } from './helpers/harness.js';

let server: E2EServer | null = null;

afterEach(async () => {
  if (server) {
    const active = server;
    server = null;
    await active.close();
  }
});

function payload(text: string): Record<string, any> {
  return JSON.parse(text) as Record<string, any>;
}

describe('progressive MCP tool disclosure', () => {
  it('discovers, describes, and calls a hidden tool through the default core', async () => {
    server = await startServer({ toolSurface: 'core' });
    const listed = await server.client.listTools();
    expect(listed.tools.map(tool => tool.name))
      .toEqual(advertisedToolDefinitions('core').map(tool => tool.name));
    expect(listed.tools.map(tool => tool.name)).toContain('godot_tools');
    expect(listed.tools.map(tool => tool.name)).not.toContain('game_light_3d');

    const searched = await server.call('godot_tools', {
      action: 'search', query: 'light 3d', domain: 'game',
    });
    expect(searched.isError, searched.text).toBe(false);
    expect(payload(searched.text).results).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'game_light_3d', domain: 'game' }),
    ]));
    const projectSearch = await server.call('godot_tools', {
      action: 'search', query: 'scene', domain: 'project', limit: 3,
    });
    expect(payload(projectSearch.text).results).toEqual(expect.arrayContaining([
      expect.objectContaining({ domain: 'project' }),
    ]));
    const lifecycleSearch = await server.call('godot_tools', {
      action: 'search', query: 'project', domain: 'lifecycle', limit: 3,
    });
    expect(payload(lifecycleSearch.text).results).toEqual(expect.arrayContaining([
      expect.objectContaining({ domain: 'lifecycle' }),
    ]));

    const described = await server.call('godot_tools', {
      action: 'describe', toolName: 'game_light_3d',
    });
    expect(described.isError, described.text).toBe(false);
    expect(payload(described.text)).toMatchObject({
      definition: { name: 'game_light_3d', inputSchema: { required: ['action'] } },
      backend: { kind: 'runtime', command: 'light_3d' },
    });

    expect((await server.call('run_project', { projectPath: server.projectPath })).isError).toBe(false);
    await server.waitForGameConnection();
    const created = await server.call('godot_tools', {
      action: 'call',
      toolName: 'game_light_3d',
      arguments: {
        action: 'create', parentPath: '/root/Main', lightType: 'omni', name: 'DiscoveredLight',
      },
    });
    expect(created.isError, created.text).toBe(false);

    // Independent observation through a directly visible core tool.
    const tree = await server.call('game_get_scene_tree');
    expect(tree.isError, tree.text).toBe(false);
    expect(tree.text).toContain('DiscoveredLight');

    const invalid = await server.call('godot_tools', {
      action: 'call', toolName: 'game_light_3d', arguments: { action: 42 },
    });
    expect(invalid.isError).toBe(true);
    expect(invalid.text).toMatch(/Invalid arguments.*action must be string/i);
    expect((await server.call('stop_project')).isError).toBe(false);
  });

  it('retains full static discovery as an explicit compatibility mode', async () => {
    server = await startServer({ toolSurface: 'full' });
    const listed = await server.client.listTools();
    expect(listed.tools).toHaveLength(167);
    expect(listed.tools.map(tool => tool.name)).toContain('game_light_3d');
  });
});
