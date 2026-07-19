// @test-kind: unit
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveAuthoringMode, type AuthoringMode } from '../src/authoring-mode.js';
import { HeadlessOperationService } from '../src/headless-operation-service.js';
import type { HeadlessOperationResult, HeadlessOperationRunner } from '../src/headless-operation-runner.js';
import { AuthoringSessionUnavailableError, RenderingContextUnavailableError, type AuthoringSessionManager } from '../src/authoring-session-manager.js';

const projects: string[] = [];

function makeProject(): string {
  const projectPath = mkdtempSync(join(tmpdir(), 'godot-agent-loop-headless-'));
  projects.push(projectPath);
  writeFileSync(join(projectPath, 'project.godot'), '');
  return projectPath;
}

function makeService(
  result: HeadlessOperationResult,
  session?: Pick<AuthoringSessionManager, 'execute'>,
  authoringMode: AuthoringMode = 'persistent',
): HeadlessOperationService {
  const runner = { execute: async (): Promise<HeadlessOperationResult> => result } as unknown as HeadlessOperationRunner;
  const pathSecurity = {
    isProjectPathAllowed: () => true,
    isRelativePathAllowed: () => true,
  };
  return new HeadlessOperationService(
    runner,
    pathSecurity as any,
    session as AuthoringSessionManager | undefined,
    authoringMode,
  );
}

afterEach(() => {
  while (projects.length > 0) rmSync(projects.pop()!, { recursive: true, force: true });
});

describe('authoring mode configuration', () => {
  it('keeps persistent authoring as the default and accepts headless mode', () => {
    expect(resolveAuthoringMode(undefined)).toBe('persistent');
    expect(resolveAuthoringMode('')).toBe('persistent');
    expect(resolveAuthoringMode('persistent')).toBe('persistent');
    expect(resolveAuthoringMode('headless')).toBe('headless');
  });

  it('rejects unknown values', () => {
    expect(() => resolveAuthoringMode('invalid'))
      .toThrow(/Expected persistent or headless/);
  });
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

  it('uses declared subprocess fallbacks without starting a session in headless mode', async () => {
    const runner = {
      execute: vi.fn(async (): Promise<HeadlessOperationResult> => ({
        stdout: 'headless', stderr: '', exitCode: 0, signal: null,
      })),
    };
    const session = { execute: vi.fn() };
    const service = new HeadlessOperationService(
      runner as unknown as HeadlessOperationRunner,
      { isProjectPathAllowed: () => true, isRelativePathAllowed: () => true } as any,
      session as unknown as AuthoringSessionManager,
      'headless',
    );
    const firstProject = makeProject();
    const secondProject = makeProject();

    const results = await Promise.all([
      service.execute('read_scene', { scenePath: 'main.tscn' }, firstProject),
      service.execute('add_node', { scenePath: 'main.tscn' }, secondProject),
      service.execute('manage_resource', { action: 'read', resourcePath: 'theme.tres' }, firstProject),
    ]);

    expect(results.map(result => result.stdout)).toEqual(['headless', 'headless', 'headless']);
    expect(session.execute).not.toHaveBeenCalled();
    expect(runner.execute).toHaveBeenNthCalledWith(
      1, 'read_scene', { scenePath: 'main.tscn' }, firstProject,
    );
    expect(runner.execute).toHaveBeenNthCalledWith(
      2, 'add_node', { scenePath: 'main.tscn' }, secondProject,
    );
    expect(runner.execute).toHaveBeenNthCalledWith(
      3, 'manage_resource', { action: 'read', resourcePath: 'theme.tres' }, firstProject,
    );
  });

  it('does not replay an operation after the session returns a command failure', async () => {
    const sessionResult = { stdout: '', stderr: 'rejected', exitCode: 1, signal: null } satisfies HeadlessOperationResult;
    const session = { execute: async () => sessionResult };
    const response = await makeService(
      { stdout: 'must not run', stderr: '', exitCode: 0, signal: null }, session,
    ).execute('create_scene', {}, makeProject());

    expect(response).toEqual(sessionResult);
  });

  it('does not hide a missing rendering context behind the subprocess fallback', async () => {
    const session = {
      execute: async () => { throw new RenderingContextUnavailableError(); },
    };
    await expect(makeService(
      { stdout: 'must not run', stderr: '', exitCode: 0, signal: null }, session,
    ).execute('create_scene', {}, makeProject())).rejects.toThrow(/Xvfb|DISPLAY/);
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
