// @test-kind: e2e
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createTempProject, startServer, type ClientRootsController, type E2EServer } from './helpers/harness.js';

let server: E2EServer | null = null;
const extraRoots: string[] = [];

afterEach(async () => {
  await server?.close();
  server = null;
  for (const root of extraRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createSiblingProject(root: string, name: string): string {
  const projectPath = join(root, name);
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(join(projectPath, 'project.godot'), 'config_version=5\n');
  writeFileSync(join(projectPath, 'sibling.gd'), 'extends Node\n');
  return projectPath;
}

async function listProjectFiles(projectPath: string) {
  return server!.call('list_project_files', { projectPath });
}

describe('MCP Roots workspace boundary', () => {
  it('requests and intersects multiple official-client roots with configured server roots', async () => {
    const project = createTempProject({ name: 'root one' });
    const secondProject = createSiblingProject(project.root, '根 two');
    const controller: ClientRootsController = { paths: [project.projectPath, secondProject] };
    server = await startServer({ project, clientRoots: controller });

    const first = await listProjectFiles(project.projectPath);
    const second = await listProjectFiles(secondProject);
    expect(first.isError, first.text).toBe(false);
    expect(second.isError, second.text).toBe(false);
    expect(controller.requests).toBe(1);

    const configuredButNotClientRoot = createSiblingProject(project.root, 'not-advertised');
    const denied = await listProjectFiles(configuredButNotClientRoot);
    expect(denied.isError).toBe(true);
    expect(denied.text).toMatch(/invalid path/i);
  });

  it('refreshes roots after list-changed and denies all when refresh fails', async () => {
    const project = createTempProject();
    const replacement = createSiblingProject(project.root, 'replacement');
    const controller: ClientRootsController = { paths: [project.projectPath] };
    server = await startServer({ project, clientRoots: controller });

    expect((await listProjectFiles(project.projectPath)).isError).toBe(false);
    controller.paths = [replacement];
    await server.client.sendRootsListChanged();

    expect((await listProjectFiles(project.projectPath)).isError).toBe(true);
    expect((await listProjectFiles(replacement)).isError).toBe(false);
    expect(controller.requests).toBe(2);

    controller.fail = true;
    await server.client.sendRootsListChanged();
    expect((await listProjectFiles(replacement)).isError).toBe(true);
    expect(server.serverLogs.join('\n')).toMatch(/filesystem access is denied until refresh succeeds/i);

    controller.fail = false;
    await server.client.sendRootsListChanged();
    expect((await listProjectFiles(replacement)).isError).toBe(false);
    expect(controller.requests).toBe(4);
  });

  it('canonicalizes a symlink root and rejects a symlink escape', async () => {
    const project = createTempProject();
    const linkedRoot = join(project.root, 'linked-project');
    symlinkSync(project.projectPath, linkedRoot);
    const outsideConfiguredRoot = createTempProject({ name: 'outside' });
    extraRoots.push(outsideConfiguredRoot.root);
    symlinkSync(outsideConfiguredRoot.projectPath, join(project.projectPath, 'escape'));
    const controller: ClientRootsController = { paths: [linkedRoot] };
    server = await startServer({ project, clientRoots: controller });

    expect((await listProjectFiles(linkedRoot)).isError).toBe(false);
    expect((await listProjectFiles(project.projectPath)).isError).toBe(false);
    const escaped = await listProjectFiles(join(project.projectPath, 'escape'));
    expect(escaped.isError).toBe(true);
    expect(escaped.text).toMatch(/invalid path/i);

  });
});
