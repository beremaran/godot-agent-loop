// @test-kind: e2e
import { afterEach, describe, expect, it } from 'vitest';
import godotAgentLoopPi from '../../agent-plugin/pi/extension.js';
import { resolveGodotBinary, startServer, type E2EServer } from './helpers/harness.js';

let server: E2EServer | undefined;

afterEach(async () => {
  const active = server;
  server = undefined;
  if (active) await active.close();
});

describe('generated client adapter MCP smoke path', () => {
  it.each(['Claude Code', 'Codex', 'OpenCode'])(
    '%s initializes the shared compact server, calls Godot, discovers a hidden tool, and tears down',
    async () => {
      server = await startServer({ toolSurface: 'core' });
      const listed = await server.client.listTools();
      expect(listed.tools).toHaveLength(39);
      expect(listed.tools.map(tool => tool.name)).toContain('godot_tools');
      expect(listed.tools.map(tool => tool.name)).not.toContain('game_light_3d');

      const version = await server.call('get_godot_version');
      expect(version.isError, version.text).toBe(false);
      expect(version.text).toMatch(/4\.[0-9]+/);

      const hidden = await server.call('godot_tools', {
        action: 'search', query: 'light 3d', domain: 'game',
      });
      expect(hidden.isError, hidden.text).toBe(false);
      expect(JSON.parse(hidden.text).results).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'game_light_3d' }),
      ]));
    },
  );

  it('Pi dynamically registers and forwards the same real compact MCP path', async () => {
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
      expect(notices).toContainEqual({ message: 'Godot Agent Loop connected (39 tools)', type: 'info' });
      expect(tools.size).toBe(39);
      expect(tools.has('godot_tools')).toBe(true);
      expect(tools.has('game_light_3d')).toBe(false);

      const version = await tools.get('get_godot_version').execute('pi-version', {}, undefined);
      expect(version.content.map((entry: { text?: string }) => entry.text ?? '').join('\n')).toMatch(/4\.[0-9]+/);

      const hidden = await tools.get('godot_tools').execute('pi-discovery', {
        action: 'search', query: 'light 3d', domain: 'game',
      }, undefined);
      const payload = JSON.parse(hidden.content[0].text);
      expect(payload.results).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'game_light_3d' }),
      ]));
    } finally {
      await handlers.get('session_shutdown')?.({});
      if (previousGodotPath === undefined) delete process.env.GODOT_PATH;
      else process.env.GODOT_PATH = previousGodotPath;
    }
  });
});
