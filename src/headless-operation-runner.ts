import { execFile } from 'child_process';
import { promisify } from 'util';
import { convertCamelToSnakeCase, type OperationParams } from './utils.js';
import type { DebugLogger } from './godot-executable.js';

const execFileAsync = promisify(execFile);

export interface HeadlessOperationRunnerOptions {
  operationsScriptPath: string;
  resolveGodotPath: () => Promise<string>;
  logDebug?: DebugLogger;
  debugGodot?: boolean;
}

export class HeadlessOperationRunner {
  constructor(private readonly options: HeadlessOperationRunnerOptions) {}

  async execute(operation: string, params: OperationParams, projectPath: string): Promise<{ stdout: string; stderr: string }> {
    const logDebug = this.options.logDebug ?? (() => undefined);
    logDebug(`Executing operation: ${operation} in project: ${projectPath}`);
    logDebug(`Original operation params: ${JSON.stringify(params)}`);
    const snakeCaseParams = convertCamelToSnakeCase(params);
    logDebug(`Converted snake_case params: ${JSON.stringify(snakeCaseParams)}`);
    const godotPath = await this.options.resolveGodotPath();
    const args = ['--headless', '--path', projectPath, '--script', this.options.operationsScriptPath, operation, JSON.stringify(snakeCaseParams)];
    if (this.options.debugGodot ?? true) args.push('--debug-godot');
    logDebug(`Executing: ${godotPath} ${args.join(' ')}`);

    try {
      const { stdout, stderr } = await execFileAsync(godotPath, args);
      return { stdout: stdout ?? '', stderr: stderr ?? '' };
    } catch (error: unknown) {
      if (error instanceof Error && 'stdout' in error && 'stderr' in error) {
        const execError = error as Error & { stdout: string; stderr: string };
        return { stdout: execError.stdout ?? '', stderr: execError.stderr ?? '' };
      }
      throw error;
    }
  }
}
