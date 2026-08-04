// @test-kind: e2e
import { afterEach, describe, expect, it } from 'vitest';
import godotAgentLoopPi from '../../agent-plugin/pi/extension.js';
import { advertisedToolDefinitions } from '../../src/tool-surface.js';
import { resolveGodotBinary, startServer, type E2EServer } from './helpers/harness.js';

let server: E2EServer | undefined;

afterEach(async () => {
  const active = server;
  server = undefined;
  if (active) await active.close();
});

describe('shared adapter MCP smoke path', () => {
  it.each(['core', 'compact'] as const)(
    '%s initializes the shared core server, calls Godot, discovers a hidden tool, and tears down',
    async toolSurface => {
      server = await startServer({ toolSurface });
      const listed = await server.client.listTools();
      expect(listed.tools).toHaveLength(advertisedToolDefinitions('core').length);
      expect(listed.tools.map(tool => tool.name)).toContain('godot_catalog');
      expect(listed.tools.map(tool => tool.name)).toContain('godot_call');
      // Representative hidden tools stay out of the advertised core surface.
      expect(listed.tools.map(tool => tool.name)).not.toContain('export_project');
      expect(listed.tools.map(tool => tool.name)).not.toContain('game_eval');
      expect(listed.tools.map(tool => tool.name)).not.toContain('game_light_3d');

      const version = await server.call('run_project_tests', {
        projectPath: server.projectPath, action: 'discover',
      });
      expect(version.isError, version.text).toBe(false);
      expect(version.text).toContain('frameworks');

      const hidden = await server.call('godot_catalog', {
        action: 'search', query: 'visual regression', domain: 'game',
      });
      expect(hidden.isError, hidden.text).toBe(false);
      expect(JSON.parse(hidden.text).results).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'game_visual_regression' }),
      ]));

      for (const detail of ['summary', 'schema', 'full'] as const) {
        const described = await server.call('godot_catalog', {
          action: 'describe', toolName: 'analyze_project_integrity', detail,
        });
        expect(described.isError, described.text).toBe(false);
        expect(JSON.parse(described.text)).toMatchObject({ name: 'analyze_project_integrity' });
      }

      const delegated = await server.call('godot_call', {
        toolName: 'analyze_project_integrity',
        arguments: { projectPath: server.projectPath, action: 'analyze' },
      });
      expect(delegated.isError, delegated.text).toBe(false);
      expect(delegated.text).toContain('main.tscn');
      expect(JSON.parse(delegated.text)).toMatchObject({
        main_scene_structure: { configured: true, scene_path: 'main.tscn' },
      });
    },
  );

  it('applies every godot_catalog filter through a real MCP client', async () => {
    server = await startServer({ toolSurface: 'core' });
    const filters = [
      ...(['lifecycle', 'project', 'game'] as const).map(domain => ({ domain })),
      ...(['process', 'subprocess', 'runtime', 'runtime-buffer', 'godot-cli', 'local'] as const)
        .map(backend => ({ backend })),
      ...(['read-only', 'project-persistent', 'runtime-ephemeral', 'process', 'external-open-world'] as const)
        .map(effect => ({ effect })),
      ...(['none', 'project', 'editor', 'runtime'] as const).map(state => ({ state })),
      ...(['none', 'required'] as const).map(privilege => ({ privilege })),
      ...(['read-only', 'mutating', 'mixed'] as const).map(mutation => ({ mutation })),
    ];
    for (const filter of filters) {
      const result = await server.call('godot_catalog', {
        action: 'search', query: 'tool', limit: 1, ...filter,
      });
      expect(result.isError, result.text).toBe(false);
      expect(JSON.parse(result.text)).toHaveProperty('results');
    }
  });

  it('Pi dynamically registers and forwards the manifest-selected real core MCP path', async () => {
    const handlers = new Map<string, (...args: any[]) => any>();
    const tools = new Map<string, any>();
    const notices: { message: string; type?: string }[] = [];
    const api = {
      on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
      registerTool(tool: any) { tools.set(tool.name, tool); },
    };
    const previousGodotPath = process.env.GODOT_PATH;
    process.env.GODOT_PATH = resolveGodotBinary();
    try {
      godotAgentLoopPi(api);
      await handlers.get('session_start')?.({}, {
        ui: { notify(message: string, type?: string) { notices.push({ message, type }); } },
      });
      const expectedCount = advertisedToolDefinitions('core').length;
      expect(notices).toContainEqual({ message: `Godot Agent Loop connected (${expectedCount} tools)`, type: 'info' });
      expect(tools.size).toBe(expectedCount);
      expect(tools.has('godot_catalog')).toBe(true);
      expect(tools.has('godot_call')).toBe(true);
      expect(tools.has('export_project')).toBe(false);
      expect(tools.has('game_eval')).toBe(false);
      expect(tools.has('game_light_3d')).toBe(false);
      expect(tools.has('get_godot_version')).toBe(false);

      const described = await tools.get('godot_catalog').execute('pi-discovery', {
        action: 'describe', toolName: 'godot_catalog',
      }, undefined);
      const describedPayload = JSON.parse(described.content[0].text);
      expect(describedPayload).toMatchObject({ name: 'godot_catalog' });

      const hidden = await tools.get('godot_catalog').execute('pi-discovery', {
        action: 'search', query: 'visual regression', domain: 'game',
      }, undefined);
      const payload = JSON.parse(hidden.content[0].text);
      expect(payload.results).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'game_visual_regression' }),
      ]));
    } finally {
      await handlers.get('session_shutdown')?.({});
      if (previousGodotPath === undefined) delete process.env.GODOT_PATH;
      else process.env.GODOT_PATH = previousGodotPath;
    }
  });
});
