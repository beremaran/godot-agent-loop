import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER_ENTRY = join(PACKAGE_ROOT, 'build', 'index.js');
const ADAPTER_MANIFEST = join(PACKAGE_ROOT, 'agent-plugin', 'adapter-manifest.json');

interface PiServerLaunchOptions {
  localServerEntry?: string;
  adapterManifestPath?: string;
  exists?: (path: string) => boolean;
}

export function resolvePiServerLaunch(options: PiServerLaunchOptions = {}): {
  command: string;
  args: string[];
  environment: Record<string, string>;
} {
  const localServerEntry = options.localServerEntry ?? SERVER_ENTRY;
  const manifestPath = options.adapterManifestPath ?? ADAPTER_MANIFEST;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    mcp?: { command?: unknown; environment?: unknown };
  };
  const environment = manifest.mcp?.environment;
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)
    || !Object.values(environment).every(value => typeof value === 'string')) {
    throw new Error(`Invalid MCP environment in ${manifestPath}`);
  }
  if ((options.exists ?? existsSync)(localServerEntry)) {
    return { command: process.execPath, args: [localServerEntry], environment: environment as Record<string, string> };
  }

  const pinned = manifest.mcp?.command;
  if (!Array.isArray(pinned) || pinned.length === 0 || !pinned.every(value => typeof value === 'string')) {
    throw new Error(`Invalid MCP command in ${manifestPath}`);
  }
  return { command: pinned[0], args: pinned.slice(1), environment: environment as Record<string, string> };
}

function inheritedEnvironment(): Record<string, string> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  delete environment.VITEST;
  environment.NODE_ENV = 'production';
  return environment;
}

function resultContent(content: unknown[]): ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] {
  return content.map(item => {
    const value = item as Record<string, unknown>;
    if (value.type === 'text' && typeof value.text === 'string') {
      return { type: 'text' as const, text: value.text };
    }
    if (value.type === 'image' && typeof value.data === 'string' && typeof value.mimeType === 'string') {
      return { type: 'image' as const, data: value.data, mimeType: value.mimeType };
    }
    return { type: 'text' as const, text: JSON.stringify(value) };
  });
}

function errorText(content: unknown[]): string {
  return resultContent(content).map(item => item.type === 'text' ? item.text : `[image: ${item.mimeType}]`).join('\n');
}

export default function godotAgentLoopPi(pi: ExtensionAPI) {
  let client: Client | undefined;

  const close = async () => {
    const active = client;
    client = undefined;
    if (active) await active.close().catch(() => undefined);
  };

  const registerTools = (tools: Tool[]) => {
    for (const tool of tools) {
      pi.registerTool({
        name: tool.name,
        label: tool.title ?? tool.annotations?.title ?? tool.name,
        description: tool.description ?? `Call the ${tool.name} Godot Agent Loop tool.`,
        parameters: tool.inputSchema as never,
        async execute(_toolCallId, params, signal) {
          if (!client) throw new Error('Godot Agent Loop MCP server is not connected');
          const result = await client.callTool(
            { name: tool.name, arguments: params as Record<string, unknown> },
            undefined,
            { signal },
          );
          if (result.isError) throw new Error(errorText(result.content));
          return {
            content: resultContent(result.content),
            details: {
              structuredContent: result.structuredContent,
              metadata: result._meta,
            },
          };
        },
      });
    }
  };

  pi.on('session_start', async (_event, ctx) => {
    await close();
    try {
      const launch = resolvePiServerLaunch();
      const next = new Client(
        { name: 'godot-agent-loop-pi', version: '1.1.1' },
        {
          capabilities: {},
          listChanged: {
            tools: {
              onChanged(error, result) {
                if (error) {
                  ctx.ui.notify(`Godot Agent Loop tool refresh failed: ${error.message}`, 'warning');
                  return;
                }
                if (result) registerTools(result.tools);
              },
            },
          },
        },
      );
      const transport = new StdioClientTransport({
        command: launch.command,
        args: launch.args,
        env: { ...inheritedEnvironment(), ...launch.environment },
        stderr: 'pipe',
      });
      await next.connect(transport);
      client = next;
      const listed = await next.listTools();
      registerTools(listed.tools);
      ctx.ui.notify(`Godot Agent Loop connected (${listed.tools.length} tools)`, 'info');
    } catch (error) {
      await close();
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Godot Agent Loop failed to start: ${message}`, 'error');
    }
  });

  pi.on('session_shutdown', close);
}
