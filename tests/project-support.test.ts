// @test-kind: unit
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { ProjectSupport } from '../src/project-support.js';

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'godot-mcp-project-support-'));
  temporaryDirectories.push(directory);
  return directory;
}

function createSupport(): ProjectSupport {
  return new ProjectSupport({
    getGodotPath: () => null,
    detectGodotPath: () => Promise.resolve(),
    logDebug: () => undefined,
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('ProjectSupport', () => {
  it('discovers direct and nested Godot projects while skipping hidden directories recursively', () => {
    const root = createTemporaryDirectory();
    const directProject = join(root, 'direct-project');
    const nestedProject = join(root, 'container', 'nested-project');
    const hiddenProject = join(root, '.hidden-project');

    mkdirSync(directProject, { recursive: true });
    mkdirSync(nestedProject, { recursive: true });
    mkdirSync(hiddenProject, { recursive: true });
    writeFileSync(join(directProject, 'project.godot'), '');
    writeFileSync(join(nestedProject, 'project.godot'), '');
    writeFileSync(join(hiddenProject, 'project.godot'), '');

    const support = createSupport();
    const directPaths = support.findGodotProjects(root, false).map(project => project.path);
    expect(directPaths).toEqual(expect.arrayContaining([directProject, hiddenProject]));
    expect(directPaths).not.toContain(nestedProject);

    const recursivePaths = support.findGodotProjects(root, true).map(project => project.path);
    expect(recursivePaths).toEqual(expect.arrayContaining([directProject, nestedProject]));
    expect(recursivePaths).not.toContain(hiddenProject);
  });

  it('scans project structure and omits generated-directory GDScript files from validation candidates', async () => {
    const root = createTemporaryDirectory();
    mkdirSync(join(root, 'scripts'), { recursive: true });
    mkdirSync(join(root, '.godot'), { recursive: true });
    writeFileSync(join(root, 'main.tscn'), '');
    writeFileSync(join(root, 'scripts', 'player.gd'), '');
    writeFileSync(join(root, 'scripts', 'tool.gdscript'), '');
    writeFileSync(join(root, 'icon.png'), '');
    writeFileSync(join(root, 'README.md'), '');
    writeFileSync(join(root, '.hidden.gd'), '');
    writeFileSync(join(root, '.godot', 'cache.gd'), '');

    const support = createSupport();
    await expect(support.getProjectStructureAsync(root)).resolves.toEqual({
      scenes: 1,
      scripts: 2,
      assets: 1,
      other: 1,
    });
    const scripts = support.listAllGdFiles(root);
    expect(scripts).toEqual(expect.arrayContaining(['.hidden.gd', 'scripts/player.gd']));
    expect(scripts).not.toContain('.godot/cache.gd');
  });

  it('detects C# projects and maps Godot key names to scancodes', () => {
    const root = createTemporaryDirectory();
    writeFileSync(join(root, 'Game.csproj'), '');

    const support = createSupport();
    expect(support.isDotnetProject(root)).toBe(true);
    expect(support.keyNameToScancode('space')).toBe(32);
    expect(support.keyNameToScancode('F12')).toBe(16777255);
    expect(support.keyNameToScancode('!')).toBe('!'.charCodeAt(0));
    expect(support.keyNameToScancode('not-a-key')).toBe(0);
  });
});
