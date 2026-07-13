// @test-kind: e2e
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type E2EServer } from './helpers/harness.js';

let server: E2EServer | null = null;

afterEach(async () => {
  if (server) {
    const active = server;
    server = null;
    await active.close();
  }
});

function payload(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

function nativeTest(name: string, passed: boolean, exitCode: number): string {
  return [
    'extends SceneTree', '', '', 'func _initialize() -> void:',
    `\tprint('GODOT_MCP_TEST_CASE {"name":"${name}","passed":${passed}}')`,
    `\tquit(${exitCode})`, '',
  ].join('\n');
}

describe('structured project test orchestration through MCP', () => {
  it('discovers native tests and reports structured pass/failure cases with fail-fast', async () => {
    server = await startServer();
    const testsDir = join(server.projectPath, 'tests');
    mkdirSync(testsDir);
    writeFileSync(join(testsDir, 'test_pass.gd'), nativeTest('native pass', true, 0));
    writeFileSync(join(testsDir, 'failure_test.gd'), nativeTest('native failure', false, 7));
    writeFileSync(join(testsDir, 'helper.gd'), 'extends RefCounted\n');

    const discovered = await server.call('run_project_tests', {
      projectPath: server.projectPath, action: 'discover', framework: 'auto',
    });
    expect(discovered.isError, discovered.text).toBe(false);
    expect(payload(discovered.text)).toMatchObject({
      frameworks: { native: true, gut: false, gdunit4: false },
      native_tests: ['tests/failure_test.gd', 'tests/test_pass.gd'], count: 2,
    });

    const passed = await server.call('run_project_tests', {
      projectPath: server.projectPath, action: 'run', framework: 'native',
      testPaths: ['tests/test_pass.gd'], timeoutSeconds: 10, failFast: false,
    });
    expect(passed.isError, passed.text).toBe(false);
    expect(payload(passed.text)).toMatchObject({
      framework: 'native', passed: true, total: 1, failed: 0,
      cases: [{ name: 'native pass', path: 'tests/test_pass.gd', passed: true }],
    });

    const failed = await server.call('run_project_tests', {
      projectPath: server.projectPath, action: 'run', framework: 'native',
      testPaths: ['tests/failure_test.gd', 'tests/test_pass.gd'], failFast: true,
    });
    expect(failed.isError).toBe(true);
    expect(payload(failed.text)).toMatchObject({
      framework: 'native', passed: false, total: 1, failed: 1,
      cases: [{ name: 'native failure', passed: false }],
    });
  });

  it('detects and invokes the documented GUT and GdUnit4 adapters', async () => {
    if (process.platform === 'win32') return;
    server = await startServer();
    const nativePath = join(server.projectPath, 'tests', 'test_adapter_target.gd');
    mkdirSync(join(server.projectPath, 'tests'));
    writeFileSync(nativePath, nativeTest('adapter target', true, 0));

    const gutDir = join(server.projectPath, 'addons', 'gut');
    mkdirSync(gutDir, { recursive: true });
    writeFileSync(join(gutDir, 'gut_cmdln.gd'), [
      'extends SceneTree', '', '', 'func _initialize() -> void:',
      '\tvar joined := " ".join(OS.get_cmdline_args())',
      '\tvar ok := joined.contains("-gexit") and joined.contains("-gtest=res://tests/test_adapter_target.gd")',
      '\tprint("GODOT_MCP_TEST_CASE {\\"name\\":\\"gut adapter\\",\\"passed\\":%s}" % str(ok))',
      '\tquit(0 if ok else 9)', '',
    ].join('\n'));

    const gdunitDir = join(server.projectPath, 'addons', 'gdUnit4');
    mkdirSync(gdunitDir, { recursive: true });
    const runner = join(gdunitDir, 'runtest');
    writeFileSync(runner, [
      '#!/bin/sh',
      'case "$*" in',
      '  *--godot_binary*"-a"*) mkdir -p reports; printf "<testsuite tests=\\"1\\"/>" > reports/gdunit.xml; echo \'GODOT_MCP_TEST_CASE {"name":"gdunit adapter","passed":true}\'; exit 0 ;;',
      '  *) exit 9 ;;',
      'esac', '',
    ].join('\n'));
    chmodSync(runner, 0o755);

    const discovered = await server.call('run_project_tests', {
      projectPath: server.projectPath, action: 'discover', framework: 'gut',
    });
    expect(payload(discovered.text)).toMatchObject({ frameworks: { gut: true, gdunit4: true } });

    const gut = await server.call('run_project_tests', {
      projectPath: server.projectPath, action: 'run', framework: 'gut',
      testPaths: ['tests/test_adapter_target.gd'],
    });
    expect(gut.isError, gut.text).toBe(false);
    expect(payload(gut.text)).toMatchObject({ framework: 'gut', cases: [{ name: 'gut adapter', passed: true }] });

    writeFileSync(join(gutDir, 'gut_cmdln.gd'), [
      'extends SceneTree', '', '', 'func _initialize() -> void:',
      '\tprint(\'GODOT_MCP_TEST_CASE {"name":"lying adapter","passed":true}\')',
      '\tquit(9)', '',
    ].join('\n'));
    const dishonestGut = await server.call('run_project_tests', {
      projectPath: server.projectPath, action: 'run', framework: 'gut',
      testPaths: ['tests/test_adapter_target.gd'],
    });
    expect(dishonestGut.isError).toBe(true);
    expect(payload(dishonestGut.text)).toMatchObject({
      passed: false, cases: [{ name: 'lying adapter', passed: false, message: 'Exited with code 9' }],
    });

    const gdunit = await server.call('run_project_tests', {
      projectPath: server.projectPath, action: 'run', framework: 'gdunit4',
      testPaths: ['tests'], artifactPaths: ['reports/gdunit.xml', 'reports/missing.xml'],
    });
    expect(gdunit.isError, gdunit.text).toBe(false);
    expect(payload(gdunit.text)).toMatchObject({
      framework: 'gdunit4', cases: [{ name: 'gdunit adapter', passed: true }],
      artifacts: [{ path: 'reports/gdunit.xml', bytes: 22 }],
      missing_artifacts: ['reports/missing.xml'],
    });
  });

  it('returns controlled adapter, path, and timeout failures', async () => {
    server = await startServer();
    const missingAdapter = await server.call('run_project_tests', {
      projectPath: server.projectPath, action: 'run', framework: 'gut', testPaths: ['main.gd'],
    });
    expect(missingAdapter.isError).toBe(true);
    expect(missingAdapter.text).toMatch(/GUT is not installed/i);

    const traversal = await server.call('run_project_tests', {
      projectPath: server.projectPath, action: 'run', framework: 'native', testPaths: ['../outside.gd'],
    });
    expect(traversal.isError).toBe(true);
    expect(traversal.text).toMatch(/Invalid test path/i);

    const artifactTraversal = await server.call('run_project_tests', {
      projectPath: server.projectPath, action: 'run', framework: 'native',
      testPaths: ['main.gd'], artifactPaths: ['../report.xml'],
    });
    expect(artifactTraversal.isError).toBe(true);
    expect(artifactTraversal.text).toMatch(/Invalid artifact path/i);

    const timeoutPath = join(server.projectPath, 'test_timeout.gd');
    writeFileSync(timeoutPath, [
      'extends SceneTree', '', '', 'func _initialize() -> void:',
      '\tawait create_timer(30.0).timeout', '\tquit()', '',
    ].join('\n'));
    const timedOut = await server.call('run_project_tests', {
      projectPath: server.projectPath, action: 'run', framework: 'native',
      testPaths: ['test_timeout.gd'], timeoutSeconds: 1,
    });
    expect(timedOut.isError).toBe(true);
    expect(payload(timedOut.text)).toMatchObject({
      passed: false, cases: [{ passed: false, message: 'Timed out' }],
      runs: [{ timed_out: true }],
    });
  });
});
