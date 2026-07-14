// @test-kind: unit
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, it, expect } from 'vitest';
import {
  PARAMETER_MAPPINGS,
  REVERSE_PARAMETER_MAPPINGS,
  normalizeParameters,
  convertCamelToSnakeCase,
  validatePath,
  PathSecurity,
  createErrorResponse,
  isGodot44OrLater,
} from '../src/utils.js';

const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'godot-agent-loop-path-security-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe('PARAMETER_MAPPINGS', () => {
  it('contains only names generic conversion cannot reproduce', () => {
    expect(PARAMETER_MAPPINGS).toEqual({
      msaa_2d: 'msaa2d', msaa_3d: 'msaa3d', relative_x: 'relative_x', relative_y: 'relative_y',
    });
  });
});

describe('REVERSE_PARAMETER_MAPPINGS', () => {
  it('is the inverse of PARAMETER_MAPPINGS', () => {
    for (const [snake, camel] of Object.entries(PARAMETER_MAPPINGS)) {
      expect(REVERSE_PARAMETER_MAPPINGS[camel]).toBe(snake);
    }
  });

  it('has same number of entries as PARAMETER_MAPPINGS', () => {
    expect(Object.keys(REVERSE_PARAMETER_MAPPINGS).length).toBe(
      Object.keys(PARAMETER_MAPPINGS).length
    );
  });
});

describe('normalizeParameters', () => {
  it('converts snake_case keys to camelCase', () => {
    const result = normalizeParameters({ project_path: '/foo', scene_path: 'bar.tscn' });
    expect(result).toEqual({ projectPath: '/foo', scenePath: 'bar.tscn' });
  });

  it('preserves already-camelCase keys', () => {
    const result = normalizeParameters({ projectPath: '/foo', scenePath: 'bar.tscn' });
    expect(result).toEqual({ projectPath: '/foo', scenePath: 'bar.tscn' });
  });

  it('converts any snake_case key', () => {
    const result = normalizeParameters({ custom_key: 'value', another: 42 });
    expect(result).toEqual({ customKey: 'value', another: 42 });
  });

  it('keeps nested arrays as arrays at every depth', () => {
    // Mesh buffers arrive as [x, y, z] triples. A nested array is still
    // typeof "object", and normalizing it as a record turned each triple into
    // {"0": x, "1": y, "2": z}, which the engine read as an empty vector.
    const result = normalizeParameters({
      vertices: [[0, 0, 0], [1, 2, 3]],
      uvs: [[0, 1]],
      indices: [0, 1, 2],
      nested_pairs: [[{ node_path: '/root/A' }]],
    });
    expect(result).toEqual({
      vertices: [[0, 0, 0], [1, 2, 3]],
      uvs: [[0, 1]],
      indices: [0, 1, 2],
      nestedPairs: [[{ nodePath: '/root/A' }]],
    });
  });

  it('handles nested objects', () => {
    const result = normalizeParameters({
      project_path: '/foo',
      nested: { node_path: '/root/Player' },
    });
    expect(result).toEqual({
      projectPath: '/foo',
      nested: { nodePath: '/root/Player' },
    });
  });

  it('recurses through arrays', () => {
    const result = normalizeParameters({ items: [{ node_path: '/root' }, 2] });
    expect(result).toEqual({ items: [{ nodePath: '/root' }, 2] });
  });

  it('returns falsy inputs as-is', () => {
    expect(normalizeParameters(null as any)).toBeNull();
    expect(normalizeParameters(undefined as any)).toBeUndefined();
  });

  it('handles empty object', () => {
    expect(normalizeParameters({})).toEqual({});
  });

  it('handles mixed snake_case and camelCase', () => {
    const result = normalizeParameters({
      project_path: '/foo',
      nodeName: 'Player',
    });
    expect(result).toEqual({ projectPath: '/foo', nodeName: 'Player' });
  });

  it('normalizes new parameter mappings', () => {
    const result = normalizeParameters({
      directory_path: 'scripts',
      from_x: 10, from_y: 20,
      to_x: 100, to_y: 200,
      project_name: 'MyGame',
      action_name: 'jump',
    });
    expect(result.directoryPath).toBe('scripts');
    expect(result.fromX).toBe(10);
    expect(result.fromY).toBe(20);
    expect(result.toX).toBe(100);
    expect(result.toY).toBe(200);
    expect(result.projectName).toBe('MyGame');
    expect(result.actionName).toBe('jump');
  });
});

describe('convertCamelToSnakeCase', () => {
  it('converts known camelCase keys to snake_case', () => {
    const result = convertCamelToSnakeCase({ projectPath: '/foo', scenePath: 'bar.tscn' });
    expect(result).toEqual({ project_path: '/foo', scene_path: 'bar.tscn' });
  });

  it('keeps nested arrays as arrays at every depth', () => {
    // This runs on every runtime command, so collapsing a [x, y, z] triple into
    // a record silently emptied every mesh buffer the engine tried to read.
    const result = convertCamelToSnakeCase({
      vertices: [[0, 0, 0], [1, 2, 3]],
      uvs: [[0, 1]],
      nestedPairs: [[{ nodePath: '/root/A' }]],
    });
    expect(result).toEqual({
      vertices: [[0, 0, 0], [1, 2, 3]],
      uvs: [[0, 1]],
      nested_pairs: [[{ node_path: '/root/A' }]],
    });
  });

  it('converts unknown camelCase keys using regex', () => {
    const result = convertCamelToSnakeCase({ myCustomKey: 'value' });
    expect(result).toEqual({ my_custom_key: 'value' });
  });

  it('handles nested objects', () => {
    const result = convertCamelToSnakeCase({
      projectPath: '/foo',
      nested: { nodePath: '/root' },
    });
    expect(result).toEqual({
      project_path: '/foo',
      nested: { node_path: '/root' },
    });
  });

  it('recurses through arrays', () => {
    const result = convertCamelToSnakeCase({ items: [{ nodePath: '/root' }, 2] });
    expect(result).toEqual({ items: [{ node_path: '/root' }, 2] });
  });

  it('handles empty object', () => {
    expect(convertCamelToSnakeCase({})).toEqual({});
  });

  it('preserves already snake_case keys', () => {
    const result = convertCamelToSnakeCase({ already_snake: 'value' });
    expect(result).toEqual({ already_snake: 'value' });
  });
});

describe('validatePath', () => {
  it('returns true for valid paths', () => {
    expect(validatePath('/home/user/project')).toBe(true);
    expect(validatePath('scenes/main.tscn')).toBe(true);
    expect(validatePath('C:\\Users\\test')).toBe(true);
  });

  it('returns false for paths with ..', () => {
    expect(validatePath('../../../etc/passwd')).toBe(false);
    expect(validatePath('foo/../bar')).toBe(false);
    expect(validatePath('..')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(validatePath('')).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(validatePath(null as any)).toBe(false);
    expect(validatePath(undefined as any)).toBe(false);
  });
});

describe('PathSecurity', () => {
  it('enforces configured allowed roots for projects and project-relative paths', () => {
    const workspace = makeTemporaryDirectory();
    const allowedRoot = join(workspace, 'allowed');
    const project = join(allowedRoot, 'project');
    const outsideProject = join(workspace, 'outside-project');
    mkdirSync(project, { recursive: true });
    mkdirSync(outsideProject);
    writeFileSync(join(project, 'project.godot'), '');

    const security = new PathSecurity([allowedRoot]);

    expect(security.isProjectPathAllowed(project)).toBe(true);
    expect(security.isProjectPathAllowed(outsideProject)).toBe(false);
    expect(security.isRelativePathAllowed(project, 'scenes/main.tscn')).toBe(true);
    expect(security.isRelativePathAllowed(project, '../outside-project/secret.gd')).toBe(false);
  });

  it('rejects project-relative paths that escape through a symlink', () => {
    const workspace = makeTemporaryDirectory();
    const allowedRoot = join(workspace, 'allowed');
    const project = join(allowedRoot, 'project');
    const outsideDirectory = join(workspace, 'outside');
    mkdirSync(project, { recursive: true });
    mkdirSync(outsideDirectory);
    writeFileSync(join(project, 'project.godot'), '');
    symlinkSync(outsideDirectory, join(project, 'linked-outside'));

    const security = new PathSecurity([allowedRoot]);

    expect(security.resolveProjectPath(project, 'linked-outside/secret.gd')).toBeNull();
    expect(security.isRelativePathAllowed(project, 'linked-outside/secret.gd')).toBe(false);
  });
});

describe('createErrorResponse', () => {
  it('returns object with isError true', () => {
    const result = createErrorResponse('Something went wrong');
    expect(result.isError).toBe(true);
  });

  it('includes error message in content', () => {
    const result = createErrorResponse('Test error');
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toBe('Test error');
  });

  it('handles different error messages', () => {
    const result = createErrorResponse('Another error');
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Another error');
  });
});

describe('isGodot44OrLater', () => {
  it('returns true for 4.4', () => {
    expect(isGodot44OrLater('4.4.0')).toBe(true);
    expect(isGodot44OrLater('4.4')).toBe(true);
  });

  it('returns true for versions after 4.4', () => {
    expect(isGodot44OrLater('4.5.0')).toBe(true);
    expect(isGodot44OrLater('5.0.0')).toBe(true);
    expect(isGodot44OrLater('4.10.1')).toBe(true);
  });

  it('returns false for versions before 4.4', () => {
    expect(isGodot44OrLater('4.3.0')).toBe(false);
    expect(isGodot44OrLater('4.0.0')).toBe(false);
    expect(isGodot44OrLater('3.5.0')).toBe(false);
  });

  it('returns false for non-matching strings', () => {
    expect(isGodot44OrLater('')).toBe(false);
    expect(isGodot44OrLater('invalid')).toBe(false);
  });

  it('handles version strings with extra info', () => {
    expect(isGodot44OrLater('4.4.1.stable')).toBe(true);
    expect(isGodot44OrLater('4.3.2.rc1')).toBe(false);
  });
});
