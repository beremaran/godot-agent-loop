process.env.GODOT_MCP_ALLOWED_DIRS = '/fake/project';

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as net from 'net';
import { join } from 'path';

const handlers = new Map<any, any>();

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => {
  return {
    Server: class {
      constructor() {}
      setRequestHandler(schema: any, callback: any) {
        handlers.set(schema, callback);
      }
      connect = vi.fn().mockResolvedValue(undefined);
      close = vi.fn().mockResolvedValue(undefined);
      onerror = vi.fn();
    }
  };
});

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => {
  return {
    StdioServerTransport: class {}
  };
});

let mockExecFileImpl: any = (file: any, args: any, options: any, callback: any) => {
  const cb = typeof options === 'function' ? options : callback;
  if (cb) {
    if (args && args.includes('--version')) {
      cb(null, '4.4.stable', '');
    } else {
      cb(null, 'mock stdout', 'mock stderr');
    }
  }
};

vi.mock('child_process', () => {
  const spawnMock = vi.fn(() => ({
    on: vi.fn((event, cb) => {
      if (event === 'close' || event === 'exit') {
        setTimeout(() => cb(0), 10);
      }
      return this;
    }),
    stdout: {
      on: vi.fn((event, cb) => {
        if (event === 'data') {
          setTimeout(() => cb(Buffer.from('mock process stdout')), 5);
        }
        return this;
      }),
    },
    stderr: {
      on: vi.fn((event, cb) => {
        if (event === 'data') {
          setTimeout(() => cb(Buffer.from('mock process stderr')), 5);
        }
        return this;
      }),
    },
    kill: vi.fn(),
  }));

  const execFileMock = vi.fn((file, args, options, callback) => {
    mockExecFileImpl(file, args, options, callback);
  });

  const util = require('util');
  (execFileMock as any)[util.promisify.custom] = (file: any, args: any, options: any) => {
    return new Promise((resolve, reject) => {
      mockExecFileImpl(file, args, options, (err: any, stdout: any, stderr: any) => {
        if (err) {
          const promiseErr = Object.assign(err instanceof Error ? err : new Error(String(err)), { stdout, stderr });
          reject(promiseErr);
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
  };

  return {
    spawn: spawnMock,
    execFile: execFileMock,
  };
});

let mockExistsSyncImpl: any = (path: any) => true;

vi.mock('fs', () => {
  return {
    existsSync: vi.fn((path) => mockExistsSyncImpl(path)),
    readFileSync: vi.fn((path) => {
      if (typeof path === 'string' && path.endsWith('project.godot')) {
        return '[autoload]\nSomeAutoload="res://some.gd"';
      }
      return 'mock file content';
    }),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn((dir, options) => {
      if (options && (options as any).withFileTypes) {
        return [
          { name: 'main.tscn', isFile: () => true, isDirectory: () => false },
          { name: 'player.gd', isFile: () => true, isDirectory: () => false },
          { name: 'icon.png', isFile: () => true, isDirectory: () => false },
        ] as any;
      }
      return ['main.tscn', 'player.gd', 'icon.png', 'project.csproj'] as any;
    }),
    mkdirSync: vi.fn(),
    copyFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    renameSync: vi.fn(),
    chmodSync: vi.fn(),
  };
});

vi.mock('net', () => {
  return {
    createConnection: vi.fn((options, callback) => {
      const socket = {
        on: vi.fn(),
        write: vi.fn(),
        destroy: vi.fn(),
        end: vi.fn(),
      };
      if (callback) {
        setTimeout(callback, 0);
      }
      return socket;
    })
  };
});

// Import GodotServer after mocks are set up
const { GodotServer } = await import('../src/index.js');
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { toDotnetNamespace } from '../src/utils.js';

function getFakeArgsForSchema(schema: any, toolName: string): any {
  if (!schema || !schema.properties) return {};
  const args: any = {};
  for (const [key, prop] of Object.entries(schema.properties) as any[]) {
    let val: any;
    if (prop.enum && prop.enum.length > 0) {
      val = prop.enum[0];
    } else if (prop.type === 'string') {
      if (key === 'scriptPath' || key === 'filePath') {
        if (toolName.includes('csharp') || toolName.includes('cs')) {
          val = 'Player.cs';
        } else {
          val = 'player.gd';
        }
      } else if (key === 'className') {
        val = 'Player';
      } else if (key === 'action') {
        if (
          toolName.includes('resource') ||
          toolName.includes('structure') ||
          toolName.includes('theme') ||
          toolName.includes('shader') ||
          toolName.includes('ci_pipeline') ||
          toolName.includes('docker_export')
        ) {
          val = 'read';
        } else {
          val = 'list';
        }
      } else if (key.toLowerCase().includes('path') || key === 'directory') {
        val = '/fake/project';
      } else if (key === 'code' || key === 'expression') {
        val = 'print(123)';
      } else if (key === 'scene' || key.toLowerCase().includes('scene')) {
        val = 'res://main.tscn';
      } else {
        val = 'test_string';
      }
    } else if (prop.type === 'number' || prop.type === 'integer') {
      val = 1;
    } else if (prop.type === 'boolean') {
      val = true;
    } else if (prop.type === 'array') {
      val = [];
    } else if (prop.type === 'object') {
      val = {};
    }
    if (val === undefined) {
      val = 'test_string';
    }
    args[key] = val;
  }
  return args;
}

describe('GodotServer class tests', () => {
  let server: GodotServer;
  let executeOperationSpy: any;

  beforeAll(() => {
    // We allow actual implementations of isValidGodotPath, isDotnetProject, detectGodotNetSdkVersion to run to gain coverage
    executeOperationSpy = vi.spyOn(GodotServer.prototype as any, 'executeOperation').mockResolvedValue({
      stdout: 'mock_stdout_output',
      stderr: ''
    });

    server = new GodotServer({
      godotPath: '/fake/godot',
      strictPathValidation: true,
    });
  });

  it('runs initialization successfully', () => {
    expect(server).toBeDefined();
    expect(handlers.has(ListToolsRequestSchema)).toBe(true);
    expect(handlers.has(CallToolRequestSchema)).toBe(true);
  });

  it('list_tools returns all tools', async () => {
    const listTools = handlers.get(ListToolsRequestSchema);
    const result = await listTools();
    expect(result.tools).toBeDefined();
    expect(result.tools.length).toBeGreaterThan(0);
  });

  it('handles all registered tools - happy paths', async () => {
    const mockSocket = {
      write: vi.fn((data: string) => {
        try {
          const payload = JSON.parse(data.trim());
          setTimeout(() => {
            (server as any).resolveGameResponse({
              id: payload.id,
              result: { success: true, value: 'mock_value' }
            });
          }, 0);
        } catch (e) {}
      }),
      on: vi.fn(),
      destroy: vi.fn(),
      end: vi.fn(),
    };

    const listTools = handlers.get(ListToolsRequestSchema);
    const callTool = handlers.get(CallToolRequestSchema);

    const toolsResult = await listTools();
    const errors: string[] = [];

    // Mock disconnectFromGame to do nothing during happy paths to prevent disconnecting game connection mid-loop
    const disconnectSpy = vi.spyOn(server as any, 'disconnectFromGame').mockImplementation(() => {});

    for (const tool of toolsResult.tools) {
      if (tool.name === 'create_project') {
        mockExistsSyncImpl = (path: string) => {
          if (typeof path === 'string' && path.endsWith('project.godot')) {
            return false;
          }
          return true;
        };
      } else {
        mockExistsSyncImpl = (path: string) => true;
      }

      // Re-assign mocked active process and socket before every tool call because some tools like stop_project reset it
      (server as any).activeProcess = {
        process: { kill: vi.fn() },
        output: ['mock log line'],
        errors: ['mock error line']
      };
      (server as any).gameConnection = {
        socket: mockSocket,
        connected: true,
        responseBuffer: '',
        pendingRequests: new Map(),
        projectPath: '/fake/project',
        interactionServerInjectedByUs: true,
      };
      (server as any).godotPath = '/fake/godot';

      const args = getFakeArgsForSchema(tool.inputSchema, tool.name);
      
      try {
        const response = await callTool({
          params: {
            name: tool.name,
            arguments: args
          }
        });
        expect(response).toBeDefined();
        if (response.isError) {
          errors.push(`${tool.name}: ${response.content?.[0]?.text}`);
        }
      } catch (err: any) {
        errors.push(`${tool.name} THREW: ${err.message}`);
      }
    }

    mockExistsSyncImpl = (path: string) => true;
    disconnectSpy.mockRestore();

    expect(errors).toEqual([]);
  });

  it('handles all registered tools - missing and invalid parameters', async () => {
    const callTool = handlers.get(CallToolRequestSchema);
    const listTools = handlers.get(ListToolsRequestSchema);
    const toolsResult = await listTools();

    // Call each tool with missing / empty args to trigger parameter validation lines
    for (const tool of toolsResult.tools) {
      try {
        await callTool({
          params: {
            name: tool.name,
            arguments: {}
          }
        });
        // Call with invalid path
        await callTool({
          params: {
            name: tool.name,
            arguments: { projectPath: '../../outside/path' }
          }
        });
      } catch (err) {}
    }
  });

  it('handles tool calls when not connected to game', async () => {
    // Reset connection
    (server as any).activeProcess = {
      process: { kill: vi.fn() },
      output: ['mock log line'],
      errors: ['mock error line']
    };
    (server as any).gameConnection.connected = false;
    (server as any).gameConnection.socket = null;

    const callTool = handlers.get(CallToolRequestSchema);

    // Call a game command tool, it should return error content
    const response = await callTool({
      params: {
        name: 'game_click',
        arguments: { x: 10, y: 20 }
      }
    });

    expect(response).toBeDefined();
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('Not connected to game interaction server');
  });

  it('handles tool calls when active process is null', async () => {
    (server as any).activeProcess = null;

    const callTool = handlers.get(CallToolRequestSchema);

    const response = await callTool({
      params: {
        name: 'game_click',
        arguments: { x: 10, y: 20 }
      }
    });

    expect(response).toBeDefined();
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('No active Godot process');
  });

  it('tests game connection and event handlers', async () => {
    let dataCallback: any;
    let closeCallback: any;
    let errorCallback: any;

    const mockSocket = {
      on: vi.fn((event, cb) => {
        if (event === 'data') dataCallback = cb;
        if (event === 'close') closeCallback = cb;
        if (event === 'error') errorCallback = cb;
      }),
      write: vi.fn(),
      destroy: vi.fn(),
      end: vi.fn(),
    };

    vi.spyOn(net, 'createConnection').mockImplementation((options: any, callback: any) => {
      if (callback) setTimeout(callback, 0);
      return mockSocket as any;
    });

    (server as any).activeProcess = { process: { kill: vi.fn() } };
    await (server as any).connectToGame('/fake/project');

    expect((server as any).gameConnection.connected).toBe(true);

    // Trigger data event with a response
    if (dataCallback) {
      dataCallback(Buffer.from('{"id": 999, "result": "hello"}\n'));
    }

    // Trigger close event
    if (closeCallback) {
      closeCallback();
    }
    expect((server as any).gameConnection.connected).toBe(false);
  });

  it('tests detectGodotPath across platforms', async () => {
    const originalPlatform = process.platform;
    const originalGodotPathEnv = process.env.GODOT_PATH;

    vi.spyOn(GodotServer.prototype as any, 'isValidGodotPath').mockResolvedValue(true);

    // Test environment variable path
    process.env.GODOT_PATH = '/env/godot';
    (server as any).godotPath = null;
    await (server as any).detectGodotPath();
    expect((server as any).godotPath).toBe('/env/godot');

    // Test platform: darwin
    delete process.env.GODOT_PATH;
    (server as any).godotPath = null;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    await (server as any).detectGodotPath();
    expect((server as any).godotPath).toBeDefined();

    // Test platform: win32
    (server as any).godotPath = null;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    await (server as any).detectGodotPath();
    expect((server as any).godotPath).toBeDefined();

    // Test platform: linux
    (server as any).godotPath = null;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    await (server as any).detectGodotPath();
    expect((server as any).godotPath).toBeDefined();

    // Restore
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    process.env.GODOT_PATH = originalGodotPathEnv;
  });

  it('tests isValidGodotPath and isValidGodotPathSync', async () => {
    // Restore and spy on fs / child_process to verify actual path validation logic
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(cp, 'execFile').mockImplementation((file, args, options, cb: any) => {
      const callback = typeof options === 'function' ? options : cb;
      callback(null, '4.4.stable', '');
    });

    const isValSync = (server as any).isValidGodotPathSync('/some/path');
    expect(isValSync).toBe(true);

    const isVal = await (server as any).isValidGodotPath('/some/path');
    expect(isVal).toBe(true);
  });

  it('tests executeOperation error handling', async () => {
    executeOperationSpy.mockRestore();

    mockExecFileImpl = (file: any, args: any, options: any, callback: any) => {
      const cb = typeof options === 'function' ? options : callback;
      const err: any = new Error('exec error');
      err.stdout = 'stdout error';
      err.stderr = 'stderr error';
      cb(err, 'stdout error', 'stderr error');
    };

    const result = await (server as any).executeOperation('some_op', {}, '/fake/project');
    expect(result.stdout).toBe('stdout error');
    expect(result.stderr).toBe('stderr error');

    executeOperationSpy = vi.spyOn(GodotServer.prototype as any, 'executeOperation').mockResolvedValue({
      stdout: 'mock_stdout_output',
      stderr: ''
    });
  });

  it('tests findGodotProjects', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const readdirSpy = vi.spyOn(fs, 'readdirSync').mockReturnValue([
      { name: 'subdir', isDirectory: () => true, isFile: () => false },
      { name: 'project.godot', isDirectory: () => false, isFile: () => true }
    ] as any);

    const projects = (server as any).findGodotProjects('/fake', true);
    expect(projects.length).toBeGreaterThan(0);

    readdirSpy.mockRestore();
  });

  it('tests path validation with allowed roots', async () => {
    const callTool = handlers.get(CallToolRequestSchema);

    // Should fail because /other/dir is outside the allowed root /fake/project
    const response = await callTool({
      params: {
        name: 'run_project',
        arguments: { projectPath: '/other/dir' }
      }
    });
    expect(response.isError).toBe(true);
  });

  it('covers server run method', async () => {
    await server.run();
  });

  it('handles all registered tools - invalid path validation', async () => {
    const callTool = handlers.get(CallToolRequestSchema);
    const listTools = handlers.get(ListToolsRequestSchema);
    const toolsResult = await listTools();

    for (const tool of toolsResult.tools) {
      const args = getFakeArgsForSchema(tool.inputSchema, tool.name);
      for (const key of Object.keys(args)) {
        if (typeof args[key] === 'string') {
          args[key] = '../../invalid/path';
        }
      }
      try {
        await callTool({
          params: {
            name: tool.name,
            arguments: args
          }
        });
      } catch (err) {}
    }
  });

  it('handles all registered tools - missing project.godot file', async () => {
    const callTool = handlers.get(CallToolRequestSchema);
    const listTools = handlers.get(ListToolsRequestSchema);
    const toolsResult = await listTools();

    mockExistsSyncImpl = (path: string) => {
      if (typeof path === 'string' && path.endsWith('project.godot')) {
        return false;
      }
      return true;
    };

    for (const tool of toolsResult.tools) {
      const args = getFakeArgsForSchema(tool.inputSchema, tool.name);
      try {
        await callTool({
          params: {
            name: tool.name,
            arguments: args
          }
        });
      } catch (err) {}
    }

    mockExistsSyncImpl = (path: string) => true;
  });

  it('handles all registered tools - missing specific scene or script file', async () => {
    const callTool = handlers.get(CallToolRequestSchema);
    const listTools = handlers.get(ListToolsRequestSchema);
    const toolsResult = await listTools();

    mockExistsSyncImpl = (path: string) => {
      if (typeof path === 'string' && path.endsWith('project.godot')) {
        return true;
      }
      return false;
    };

    for (const tool of toolsResult.tools) {
      const args = getFakeArgsForSchema(tool.inputSchema, tool.name);
      try {
        await callTool({
          params: {
            name: tool.name,
            arguments: args
          }
        });
      } catch (err) {}
    }

    mockExistsSyncImpl = (path: string) => true;
  });

  it('handles all registered tools - stderr error response', async () => {
    executeOperationSpy.mockResolvedValue({
      stdout: '',
      stderr: 'Failed to perform operation'
    });

    const mockSocket = {
      write: vi.fn((data: string) => {
        try {
          const payload = JSON.parse(data.trim());
          setTimeout(() => {
            (server as any).resolveGameResponse({
              id: payload.id,
              error: 'mock game connection error'
            });
          }, 0);
        } catch (e) {}
      }),
      on: vi.fn(),
      destroy: vi.fn(),
      end: vi.fn(),
    };
    (server as any).gameConnection.socket = mockSocket;

    const callTool = handlers.get(CallToolRequestSchema);
    const listTools = handlers.get(ListToolsRequestSchema);
    const toolsResult = await listTools();

    for (const tool of toolsResult.tools) {
      const args = getFakeArgsForSchema(tool.inputSchema, tool.name);
      try {
        await callTool({
          params: {
            name: tool.name,
            arguments: args
          }
        });
      } catch (err) {}
    }

    executeOperationSpy = vi.spyOn(GodotServer.prototype as any, 'executeOperation').mockResolvedValue({
      stdout: 'mock_stdout_output',
      stderr: ''
    });
  });

  it('handles all registered tools - catch block exceptions', async () => {
    executeOperationSpy.mockRejectedValue(new Error('Operation error'));

    const mockSocket = {
      write: vi.fn((data: string) => {
        try {
          const payload = JSON.parse(data.trim());
          setTimeout(() => {
            (server as any).rejectAllPending(new Error('Socket error'));
          }, 0);
        } catch (e) {}
      }),
      on: vi.fn(),
      destroy: vi.fn(),
      end: vi.fn(),
    };
    (server as any).gameConnection.socket = mockSocket;

    const callTool = handlers.get(CallToolRequestSchema);
    const listTools = handlers.get(ListToolsRequestSchema);
    const toolsResult = await listTools();

    for (const tool of toolsResult.tools) {
      const args = getFakeArgsForSchema(tool.inputSchema, tool.name);
      try {
        await callTool({
          params: {
            name: tool.name,
            arguments: args
          }
        });
      } catch (err) {}
    }

    executeOperationSpy = vi.spyOn(GodotServer.prototype as any, 'executeOperation').mockResolvedValue({
      stdout: 'mock_stdout_output',
      stderr: ''
    });
  });

  it('covers action-based tools with all valid actions', async () => {
    const callTool = handlers.get(CallToolRequestSchema);

    const actionTools = [
      { name: 'manage_autoloads', actions: ['list', 'add', 'remove'], args: { name: 'MyAutoload', path: 'res://autoload.gd' } },
      { name: 'manage_input_map', actions: ['list', 'add', 'remove'], args: { actionName: 'ui_accept', action_name: 'ui_accept', key: 'Space' } },
      { name: 'manage_export_presets', actions: ['list', 'add', 'remove'], args: { presetName: 'Linux', preset_name: 'Linux', name: 'Linux', platform: 'Linux', exportPath: 'build/', export_path: 'build/' } },
      { name: 'manage_layers', actions: ['list', 'set'], args: { layerType: 'physics_2d', layer_type: 'physics_2d', layer: 1, name: 'Player' } },
      { name: 'manage_plugins', actions: ['list', 'enable', 'disable'], args: { pluginName: 'my_plugin', plugin_name: 'my_plugin' } },
      { name: 'manage_resource', actions: ['read', 'create'], args: { resourcePath: 'res://icon.png', resource_path: 'res://icon.png', resourceType: 'Texture2D', resource_type: 'Texture2D' } },
      { name: 'manage_scene_signals', actions: ['list', 'add', 'remove'], args: { scenePath: 'res://main.tscn', scene_path: 'res://main.tscn', nodePath: 'Player', node_path: 'Player', signalName: 'clicked', signal_name: 'clicked', targetNodePath: 'Game', target_node_path: 'Game', method: 'on_clicked' } },
      { name: 'manage_theme_resource', actions: ['read', 'create'], args: { resourcePath: 'res://main.theme', resource_path: 'res://main.theme', itemType: 'Color', item_type: 'Color', itemName: 'bg', item_name: 'bg', itemValue: '#ffffff', item_value: '#ffffff' } },
      { name: 'manage_scene_structure', actions: ['read', 'create'], args: { scenePath: 'res://main.tscn', scene_path: 'res://main.tscn', nodePath: 'Player', node_path: 'Player', properties: {} } },
      { name: 'manage_translations', actions: ['list', 'add', 'remove'], args: { locale: 'en', translationPath: 'res://en.translation', translation_path: 'res://en.translation' } },
    ];

    for (const tool of actionTools) {
      for (const action of tool.actions) {
        try {
          await callTool({
            params: {
              name: tool.name,
              arguments: {
                projectPath: '/fake/project',
                action,
                ...tool.args
              }
            }
          });
        } catch (err) {}
      }
    }
  });

  it('covers specific tool edge cases', async () => {
    const callTool = handlers.get(CallToolRequestSchema);

    // validate_scripts variations
    await callTool({
      params: {
        name: 'validate_scripts',
        arguments: { projectPath: '/fake/project', scope: 'all' }
      }
    });

    await callTool({
      params: {
        name: 'validate_scripts',
        arguments: { projectPath: '/fake/project', scriptPaths: ['player.gd'] }
      }
    });

    await callTool({
      params: {
        name: 'validate_scripts',
        arguments: { projectPath: '/fake/project', scope: 'invalid_scope' }
      }
    });

    // create_script variations
    await callTool({
      params: {
        name: 'create_script',
        arguments: { projectPath: '/fake/project', scriptPath: 'enemy.gd', extends: 'CharacterBody2D' }
      }
    });
  });

  it('covers toDotnetNamespace utils branch', () => {
    expect(toDotnetNamespace('')).toBe('Game');
  });
});
