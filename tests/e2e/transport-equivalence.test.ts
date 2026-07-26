// @test-kind: e2e
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  repoRoot,
  resolveGodotBinary,
  startServer,
  type E2EServer,
} from './helpers/harness.js';

let stdioServer: E2EServer | null = null;
let httpClient: Client | null = null;
let httpProcess: ChildProcess | null = null;
let httpRoot: string | null = null;

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function stableResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableResult);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['traceId', 'durationMs'].includes(key))
    .map(([key, entry]) => [key, stableResult(entry)]));
}

function waitForHttpUrl(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      reject(new Error(`HTTP launcher timed out: ${stderr}`));
    }, 30_000);
    child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    child.stdout?.on('data', chunk => {
      stdout += chunk.toString();
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      try {
        const record = JSON.parse(stdout.slice(0, newline)) as { url: string };
        resolve(record.url);
      } catch (error) {
        reject(new Error(`Invalid HTTP launcher record: ${stdout}`, { cause: error }));
      }
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`HTTP launcher exited before readiness: code=${code} signal=${signal}\n${stderr}`));
    });
  });
}

function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 10_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

afterEach(async () => {
  if (httpClient) await httpClient.close().catch(() => undefined);
  httpClient = null;
  if (httpProcess) await stopProcess(httpProcess);
  httpProcess = null;
  if (stdioServer) await stdioServer.close();
  stdioServer = null;
  if (httpRoot) rmSync(httpRoot, { recursive: true, force: true });
  httpRoot = null;
});

describe('evaluation HTTP transport equivalence', () => {
  it('uses the same tool list and representative result contract as production stdio', async () => {
    stdioServer = await startServer({ toolSurface: 'core' });
    httpRoot = mkdtempSync(join(tmpdir(), 'godot-agent-loop-http-eval-'));
    const projectPath = join(httpRoot, 'project');
    mkdirSync(projectPath);
    httpProcess = spawn(process.execPath, [join(repoRoot, 'scripts/evaluation-http-server.mjs')], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GODOT_PATH: resolveGodotBinary(),
        GODOT_MCP_ALLOWED_DIRS: httpRoot,
        GODOT_MCP_TOOL_SURFACE: 'core',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const url = await waitForHttpUrl(httpProcess);
    httpClient = new Client({ name: 'transport-equivalence', version: '1.0.0' });
    await httpClient.connect(new StreamableHTTPClientTransport(new URL(url)));

    const stdioTools = await stdioServer.client.listTools();
    const httpTools = await httpClient.listTools();
    expect(hash(httpTools.tools)).toBe(hash(stdioTools.tools));

    const request = {
      name: 'godot_catalog',
      arguments: { action: 'describe', toolName: 'get_godot_version' },
    };
    const stdioResult = await stdioServer.client.callTool(request);
    const httpResult = await httpClient.callTool(request);
    expect(stableResult(httpResult.structuredContent))
      .toEqual(stableResult(stdioResult.structuredContent));
  });
});
