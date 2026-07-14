// @test-kind: unit
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { HeadlessOperationService } from '../src/headless-operation-service.js';
import type { HeadlessOperationResult, HeadlessOperationRunner } from '../src/headless-operation-runner.js';
import { AuthoringSessionUnavailableError, type AuthoringSessionManager } from '../src/authoring-session-manager.js';

const projects: string[] = [];

function makeProject(): string {
  const projectPath = mkdtempSync(join(tmpdir(), 'godot-mcp-headless-'));
  projects.push(projectPath);
  writeFileSync(join(projectPath, 'project.godot'), '');
  return projectPath;
}

function makeService(
  result: HeadlessOperationResult,
  session?: Pick<AuthoringSessionManager, 'execute'>,
): HeadlessOperationService {
  const runner = { execute: async (): Promise<HeadlessOperationResult> => result } as unknown as HeadlessOperationRunner;
  const pathSecurity = {
    isProjectPathAllowed: () => true,
    isRelativePathAllowed: () => true,
  };
  return new HeadlessOperationService(runner, pathSecurity as any, session as AuthoringSessionManager | undefined);
}

afterEach(() => {
  while (projects.length > 0) rmSync(projects.pop()!, { recursive: true, force: true });
});

describe('HeadlessOperationService authoring routing', () => {
  it('uses the manifest-declared persistent session backend first', async () => {
    const sessionResult = { stdout: 'session', stderr: '', exitCode: 0, signal: null } satisfies HeadlessOperationResult;
    const session = { execute: async () => sessionResult };
    const response = await makeService(
      { stdout: 'subprocess', stderr: '', exitCode: 0, signal: null }, session,
    ).execute('create_scene', {}, makeProject());

    expect(response.stdout).toBe('session');
  });

  it('uses the explicit subprocess fallback only when session startup is unavailable', async () => {
    const session = {
      execute: async () => { throw new AuthoringSessionUnavailableError('display unavailable'); },
    };
    const response = await makeService(
      { stdout: 'fallback', stderr: '', exitCode: 0, signal: null }, session,
    ).execute('create_scene', {}, makeProject());

    expect(response.stdout).toBe('fallback');
  });

  it('does not replay an operation after the session returns a command failure', async () => {
    const sessionResult = { stdout: '', stderr: 'rejected', exitCode: 1, signal: null } satisfies HeadlessOperationResult;
    const session = { execute: async () => sessionResult };
    const response = await makeService(
      { stdout: 'must not run', stderr: '', exitCode: 0, signal: null }, session,
    ).execute('create_scene', {}, makeProject());

    expect(response).toEqual(sessionResult);
  });
});

describe('HeadlessOperationService process failures', () => {
  it('fails on a non-zero exit even when stderr is empty', async () => {
    const response = await makeService({ stdout: '', stderr: '', exitCode: 1, signal: null })
      .run('check_script', makeProject(), {});

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('exited with code 1');
  });

  it('fails when the process is terminated by a signal', async () => {
    const response = await makeService({ stdout: 'partial output', stderr: '', exitCode: null, signal: 'SIGTERM' })
      .run('check_script', makeProject(), {});

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('terminated by signal SIGTERM');
  });

  it('still reports successful operations with exit code zero', async () => {
    const response = await makeService({ stdout: 'ok', stderr: '', exitCode: 0, signal: null })
      .run('check_script', makeProject(), {});

    expect(response.isError).not.toBe(true);
    expect(response.content[0].text).toContain('check_script succeeded.');
  });
});
