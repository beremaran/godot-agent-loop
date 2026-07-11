import { existsSync } from 'fs';
import { join } from 'path';

import { createErrorResponse, errorMessage, validatePath, type OperationParams, type ToolResponse } from './utils.js';
import type { HeadlessOperationRunner } from './headless-operation-runner.js';

/** Coordinates validated tool operations that execute Godot headlessly. */
export class HeadlessOperationService {
  constructor(private readonly runner: HeadlessOperationRunner) {}

  public execute(operation: string, params: OperationParams, projectPath: string): Promise<{ stdout: string; stderr: string }> {
    return this.runner.execute(operation, params, projectPath);
  }

  public async run(operation: string, projectPath: string, params: OperationParams): Promise<ToolResponse> {
    if (!projectPath) return createErrorResponse('projectPath is required.');
    if (!validatePath(projectPath)) return createErrorResponse('Invalid path.');
    if (!existsSync(join(projectPath, 'project.godot')))
      return createErrorResponse(`Not a valid Godot project: ${projectPath}`);

    try {
      const { stdout, stderr } = await this.execute(operation, params, projectPath);
      if (stderr && stderr.includes('Failed to')) return createErrorResponse(`${operation} failed: ${stderr}`);
      return { content: [{ type: 'text', text: `${operation} succeeded.\n\nOutput: ${stdout}` }] };
    } catch (error: unknown) {
      return createErrorResponse(`${operation} failed: ${errorMessage(error)}`);
    }
  }
}
