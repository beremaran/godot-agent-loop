// @test-kind: unit
import { describe, expect, it, vi } from 'vitest';

const execFileCalls = vi.hoisted(() => [] as { file: string; args: string[]; options?: { env?: NodeJS.ProcessEnv } }[]);

vi.mock('child_process', () => {
  const execFile = ((file: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
    execFileCalls.push({ file, args, options });
  }) as unknown as Record<symbol, unknown>;
  execFile[Symbol.for('nodejs.util.promisify.custom')] = (file: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
    execFileCalls.push({ file, args, options });
    return Promise.resolve({ stdout: '', stderr: '' });
  };
  return { execFile };
});

const { HeadlessOperationRunner } = await import('../src/headless-operation-runner.js');

function makeRunner(debugGodot?: boolean, logDebug?: (message: string) => void) {
  execFileCalls.length = 0;
  return new HeadlessOperationRunner({
    operationsScriptPath: '/scripts/godot_operations.gd',
    resolveGodotPath: async () => '/godot',
    logDebug,
    debugGodot,
  });
}

describe('HeadlessOperationRunner debug diagnostics', () => {
  it('does not enable Godot diagnostics on a normal operation', async () => {
    const runner = makeRunner();
    await runner.execute('create_scene', { scenePath: 'res://a.tscn' }, '/project');

    expect(execFileCalls).toHaveLength(1);
    expect(execFileCalls[0].args).not.toContain('--debug-godot');
    expect(execFileCalls[0].options?.env?.GODOT_MCP_RUNTIME_DISABLED).toBe('true');
  });

  it('enables Godot diagnostics only when the server runs in debug mode', async () => {
    const runner = makeRunner(true);
    await runner.execute('create_scene', { scenePath: 'res://a.tscn' }, '/project');

    expect(execFileCalls[0].args).toContain('--debug-godot');
  });

  it('summarizes parameters in debug logs instead of printing their values', async () => {
    const logs: string[] = [];
    const runner = makeRunner(true, message => logs.push(message));
    await runner.execute(
      'attach_script',
      { scriptPath: 'res://secret/token.gd', content: 'extends Node', retries: 2 },
      '/project',
    );

    const debugOutput = logs.join('\n');
    expect(debugOutput).not.toContain('res://secret/token.gd');
    expect(debugOutput).not.toContain('extends Node');
    expect(debugOutput).toContain('script_path: <string, 21 chars>');
    expect(debugOutput).toContain('retries: 2');
  });
});
