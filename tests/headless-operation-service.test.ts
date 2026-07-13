// @test-kind: unit
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { HeadlessOperationService } from '../src/headless-operation-service.js';
import type { HeadlessOperationResult, HeadlessOperationRunner } from '../src/headless-operation-runner.js';

const projects: string[] = [];

function makeProject(): string {
  const projectPath = mkdtempSync(join(tmpdir(), 'godot-mcp-headless-'));
  projects.push(projectPath);
  writeFileSync(join(projectPath, 'project.godot'), '');
  return projectPath;
}

function makeService(result: HeadlessOperationResult): HeadlessOperationService {
  const runner = { execute: async (): Promise<HeadlessOperationResult> => result } as unknown as HeadlessOperationRunner;
  const pathSecurity = {
    isProjectPathAllowed: () => true,
    isRelativePathAllowed: () => true,
  };
  return new HeadlessOperationService(runner, pathSecurity as any);
}

afterEach(() => {
  while (projects.length > 0) rmSync(projects.pop()!, { recursive: true, force: true });
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
