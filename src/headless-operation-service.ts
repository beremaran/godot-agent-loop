import { existsSync } from 'fs';
import { isAbsolute, join } from 'path';

import { createErrorResponse, errorMessage, validatePath, PathSecurity, type OperationParams, type ToolResponse } from './utils.js';
import type { HeadlessOperationResult, HeadlessOperationRunner } from './headless-operation-runner.js';
import { isAbortError, setToolResultMetadata } from './execution-context.js';

/** Coordinates validated headless Godot operations. */
export class HeadlessOperationService {
  constructor(
    private readonly runner: HeadlessOperationRunner,
    private readonly pathSecurity = new PathSecurity(),
  ) {}

  public async execute(operation: string, params: OperationParams, projectPath: string): Promise<HeadlessOperationResult> {
    if (!projectPath || !isAbsolute(projectPath) || projectPath.startsWith('-')) {
      throw new Error('Project path must be an absolute path.');
    }
    if (!this.pathsAreSafe(projectPath, params)) {
      throw new Error('A project-relative path escapes the project root.');
    }
    return this.runner.execute(operation, params, projectPath);
  }

  public async run(operation: string, projectPath: string, params: OperationParams): Promise<ToolResponse> {
    if (!projectPath) return createErrorResponse('projectPath is required.');
    if (!isAbsolute(projectPath) || projectPath.startsWith('-')) return createErrorResponse('Project path must be an absolute path.');
    if (!validatePath(projectPath)) return createErrorResponse('Invalid path.');
    if (!this.pathSecurity.isProjectPathAllowed(projectPath)) return createErrorResponse('Project path is outside the allowed roots.');
    if (!existsSync(join(projectPath, 'project.godot')))
      return createErrorResponse(`Not a valid Godot project: ${projectPath}`);
    if (!this.pathsAreSafe(projectPath, params)) return createErrorResponse('A project-relative path escapes the project root.');

    try {
      const { stdout, stderr, exitCode, signal } = await this.execute(operation, params, projectPath);
      if (exitCode !== 0 || signal !== null) {
        const details = signal ? `terminated by signal ${signal}` : `exited with code ${exitCode}`;
        const output = stderr || stdout;
        return createErrorResponse(`${operation} failed (${details})${output ? `: ${output}` : '.'}`);
      }
      return { content: [{ type: 'text', text: `${operation} succeeded.\n\nOutput: ${stdout}` }] };
    } catch (error: unknown) {
      return setToolResultMetadata(createErrorResponse(`${operation} failed: ${errorMessage(error)}`), {
        outcome: isAbortError(error) ? 'cancelled' : 'failure',
      });
    }
  }

  private pathsAreSafe(projectPath: string, params: OperationParams): boolean {
    for (const [key, value] of Object.entries(params)) {
      if (!/(?:scenePath|filePath|scriptPath|resourcePath|shaderPath|themePath|translationPath|outputPath|directoryPath|newPath|texturePath|presetPath|paths)$/i.test(key)) continue;
      const values = Array.isArray(value) ? value : [value];
      for (const candidate of values) {
        if (typeof candidate === 'string' && !this.pathSecurity.isRelativePathAllowed(projectPath, candidate)) return false;
      }
    }
    return true;
  }
}
