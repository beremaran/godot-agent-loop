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

export interface HeadlessOperationResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export class HeadlessOperationRunner {
  constructor(private readonly options: HeadlessOperationRunnerOptions) {}

  async execute(operation: string, params: OperationParams, projectPath: string): Promise<HeadlessOperationResult> {
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
      return { stdout: stdout ?? '', stderr: stderr ?? '', exitCode: 0, signal: null };
    } catch (error: unknown) {
      if (error instanceof Error && 'stdout' in error && 'stderr' in error && 'code' in error) {
        const execError = error as Error & {
          stdout?: string;
          stderr?: string;
          code?: string | number;
          signal?: NodeJS.Signals | null;
        };
        if (typeof execError.code === 'number' || execError.signal) {
          return {
            stdout: execError.stdout ?? '',
            stderr: execError.stderr ?? '',
            exitCode: typeof execError.code === 'number' ? execError.code : null,
            signal: execError.signal ?? null,
          };
        }
      }
      throw error;
    }
  }
}
