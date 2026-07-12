import { execFile } from 'child_process';
import { promisify } from 'util';
import { convertCamelToSnakeCase, type OperationParams } from './utils.js';
import type { DebugLogger } from './godot-executable.js';
import { GODOT_COMMAND_OPTIONS } from './godot-subprocess.js';

const execFileAsync = promisify(execFile);

export interface HeadlessOperationRunnerOptions {
  operationsScriptPath: string;
  resolveGodotPath: () => Promise<string>;
  logDebug?: DebugLogger;
  /**
   * Pass --debug-godot to the operations script, enabling its diagnostics
   * service. Diagnostics write probe files into the project and log parameter
   * shapes, so this stays off unless the server itself runs in debug mode.
   */
  debugGodot?: boolean;
}

export interface HeadlessOperationResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Describe operation parameters without disclosing their values: a param can
 * carry a project file path, a script's source, or another secret the debug log
 * has no reason to keep.
 */
function redactValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return `<string, ${value.length} chars>`;
  if (Array.isArray(value)) return `<array, ${value.length} items>`;
  if (typeof value === 'object') return `<object, ${Object.keys(value).length} keys>`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return `<${typeof value}>`;
}

function redactParams(params: OperationParams): string {
  const entries = Object.entries(params).map(([key, value]) => `${key}: ${redactValue(value)}`);
  return `{${entries.join(', ')}}`;
}

export class HeadlessOperationRunner {
  constructor(private readonly options: HeadlessOperationRunnerOptions) {}

  async execute(operation: string, params: OperationParams, projectPath: string): Promise<HeadlessOperationResult> {
    const logDebug = this.options.logDebug ?? (() => undefined);
    logDebug(`Executing operation: ${operation} in project: ${projectPath}`);
    logDebug(`Original operation params: ${redactParams(params)}`);
    const snakeCaseParams = convertCamelToSnakeCase(params);
    logDebug(`Converted snake_case params: ${redactParams(snakeCaseParams)}`);
    const godotPath = await this.options.resolveGodotPath();
    const paramsJson = JSON.stringify(snakeCaseParams);
    const args = ['--headless', '--path', projectPath, '--script', this.options.operationsScriptPath, operation, paramsJson];
    if (this.options.debugGodot ?? false) args.push('--debug-godot');
    const loggableArgs = args.map(arg => (arg === paramsJson ? '<params>' : arg));
    logDebug(`Executing: ${godotPath} ${loggableArgs.join(' ')}`);

    try {
      const { stdout, stderr } = await execFileAsync(godotPath, args, GODOT_COMMAND_OPTIONS);
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
