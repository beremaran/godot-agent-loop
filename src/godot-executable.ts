import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { normalize } from 'path';
import { promisify } from 'util';
import { GODOT_VERSION_OPTIONS } from './godot-subprocess.js';

const execFileAsync = promisify(execFile);

export type DebugLogger = (message: string) => void;

/**
 * Resolves and validates the executable used by Godot-facing services.
 *
 * Keeping this mutable state in one service prevents tool handlers from
 * coordinating a pair of get-path/detect-path callbacks themselves.
 */
export class GodotExecutableService {
  private godotPath: string | null = null;

  constructor(
    private readonly validator: GodotExecutableValidator,
    private readonly strictPathValidation: boolean,
    private readonly logDebug: DebugLogger = () => undefined,
  ) {}

  public get path(): string | null {
    return this.godotPath;
  }

  public set path(path: string | null) {
    this.godotPath = path;
  }

  public isValidSync(path: string): boolean {
    return this.validator.isValidSync(path);
  }

  public isValid(path: string): Promise<boolean> {
    return this.validator.isValid(path);
  }

  public async detect(): Promise<string> {
    this.godotPath = await detectGodotExecutablePath({
      currentPath: this.godotPath,
      strictPathValidation: this.strictPathValidation,
      isValid: path => this.isValid(path),
      logDebug: this.logDebug,
    });
    return this.godotPath;
  }

  public async requirePath(): Promise<string | null> {
    if (!this.godotPath) await this.detect();
    return this.godotPath;
  }

  public async setPath(path: string): Promise<boolean> {
    const normalizedPath = normalize(path);
    if (!await this.isValid(normalizedPath)) return false;
    this.godotPath = normalizedPath;
    this.logDebug(`Godot path set to: ${normalizedPath}`);
    return true;
  }
}

export class GodotExecutableValidator {
  private readonly validatedPaths = new Map<string, boolean>();

  constructor(private readonly logDebug: DebugLogger = () => undefined) {}

  isValidSync(path: string): boolean {
    try {
      this.logDebug(`Quick-validating Godot path: ${path}`);
      return path === 'godot' || existsSync(path);
    } catch (error) {
      this.logDebug(`Invalid Godot path: ${path}, error: ${error}`);
      return false;
    }
  }

  async isValid(path: string): Promise<boolean> {
    const cached = this.validatedPaths.get(path);
    if (cached !== undefined) return cached;

    try {
      this.logDebug(`Validating Godot path: ${path}`);
      if (path !== 'godot' && !existsSync(path)) {
        this.logDebug(`Path does not exist: ${path}`);
        this.validatedPaths.set(path, false);
        return false;
      }
      await execFileAsync(path, ['--version'], GODOT_VERSION_OPTIONS);
      this.logDebug(`Valid Godot path: ${path}`);
      this.validatedPaths.set(path, true);
      return true;
    } catch (error) {
      this.logDebug(`Invalid Godot path: ${path}, error: ${error}`);
      this.validatedPaths.set(path, false);
      return false;
    }
  }
}

export interface GodotPathDetectionOptions {
  currentPath: string | null;
  strictPathValidation: boolean;
  isValid: (path: string) => Promise<boolean>;
  logDebug?: DebugLogger;
}

export async function detectGodotExecutablePath(options: GodotPathDetectionOptions): Promise<string> {
  const logDebug = options.logDebug ?? (() => undefined);
  if (options.currentPath && await options.isValid(options.currentPath)) {
    logDebug(`Using existing Godot path: ${options.currentPath}`);
    return options.currentPath;
  }

  if (process.env.GODOT_PATH) {
    const environmentPath = normalize(process.env.GODOT_PATH);
    logDebug(`Checking GODOT_PATH environment variable: ${environmentPath}`);
    if (await options.isValid(environmentPath)) {
      logDebug(`Using Godot path from environment: ${environmentPath}`);
      return environmentPath;
    }
    // An explicit executable selection is authoritative. Falling through to a
    // different auto-detected engine makes a stale or deliberately invalid
    // configuration silently target the wrong binary. GodotServer.run() applies
    // the strict/compatibility policy after this returns: strict mode exits,
    // while compatibility mode keeps structured tool failures available.
    logDebug(`GODOT_PATH environment variable is invalid: ${environmentPath}`);
    return environmentPath;
  }

  const platform = process.platform;
  logDebug(`Auto-detecting Godot path for platform: ${platform}`);
  const possiblePaths = getCandidatePaths(platform);
  for (const candidate of possiblePaths) {
    const normalizedPath = normalize(candidate);
    if (await options.isValid(normalizedPath)) {
      logDebug(`Found Godot at: ${normalizedPath}`);
      return normalizedPath;
    }
  }

  logDebug(`Warning: Could not find Godot in common locations for ${platform}`);
  console.error(`[SERVER] Could not find Godot in common locations for ${platform}`);
  console.error("[SERVER] Set GODOT_PATH=/path/to/godot environment variable or pass { godotPath: '/path/to/godot' } in the config to specify the correct path.");
  if (options.strictPathValidation) {
    throw new Error('Could not find a valid Godot executable. Set GODOT_PATH or provide a valid path in config.');
  }

  const fallback = normalize(platform === 'win32'
    ? 'C:\\Program Files\\Godot\\Godot.exe'
    : platform === 'darwin'
      ? '/Applications/Godot.app/Contents/MacOS/Godot'
      : '/usr/bin/godot');
  logDebug(`Using default path: ${fallback}, but this may not work.`);
  console.error(`[SERVER] Using default path: ${fallback}, but this may not work.`);
  console.error('[SERVER] This fallback behavior will be removed in a future version. Set strictPathValidation: true to opt-in to the new behavior.');
  return fallback;
}

function getCandidatePaths(platform: NodeJS.Platform): string[] {
  const paths = ['godot'];
  if (platform === 'darwin') {
    paths.push(
      '/Applications/Godot.app/Contents/MacOS/Godot',
      '/Applications/Godot_4.app/Contents/MacOS/Godot',
      `${process.env.HOME}/Applications/Godot.app/Contents/MacOS/Godot`,
      `${process.env.HOME}/Applications/Godot_4.app/Contents/MacOS/Godot`,
      `${process.env.HOME}/Library/Application Support/Steam/steamapps/common/Godot Engine/Godot.app/Contents/MacOS/Godot`,
    );
  } else if (platform === 'win32') {
    paths.push(
      'C:\\Program Files\\Godot\\Godot.exe',
      'C:\\Program Files (x86)\\Godot\\Godot.exe',
      'C:\\Program Files\\Godot_4\\Godot.exe',
      'C:\\Program Files (x86)\\Godot_4\\Godot.exe',
      `${process.env.USERPROFILE}\\Godot\\Godot.exe`,
    );
  } else if (platform === 'linux') {
    paths.push('/usr/bin/godot', '/usr/local/bin/godot', '/snap/bin/godot', `${process.env.HOME}/.local/bin/godot`);
  }
  return paths;
}
