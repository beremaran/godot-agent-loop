import { execFile } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { basename, dirname, join, relative } from 'path';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

import {
  collectGdPaths,
  errorMessage,
  parseGodotScriptDiagnostics,
  type ScriptDiagnostic,
} from './utils.js';
import { GODOT_COMMAND_OPTIONS, GODOT_VERSION_OPTIONS } from './godot-subprocess.js';

const execFileAsync = promisify(execFile);

export interface ProjectSupportContext {
  getGodotPath: () => string | null;
  detectGodotPath: () => Promise<void>;
  logDebug: (message: string) => void;
}

export interface GodotProject {
  path: string;
  name: string;
}

export interface ProjectStructure {
  scenes: number;
  scripts: number;
  assets: number;
  other: number;
  error?: string;
}

export interface GdScriptCheck {
  completed: boolean;
  errors: ScriptDiagnostic[];
  error?: string;
}

export interface ChangedGdFiles {
  files?: string[];
  error?: string;
}

/**
 * Filesystem and executable-backed support for project-oriented tools.
 *
 * Keeping this work outside GodotServer lets the server focus on lifecycle
 * orchestration while project handlers share a single, testable service.
 */
export class ProjectSupport {
  private readonly validateScriptPath: string;

  constructor(
    private readonly context: ProjectSupportContext,
    validateScriptPath = join(dirname(fileURLToPath(import.meta.url)), 'scripts', 'validate_script.gd'),
  ) {
    this.validateScriptPath = validateScriptPath;
  }

  public findGodotProjects(directory: string, recursive: boolean): GodotProject[] {
    const projects: GodotProject[] = [];

    try {
      const projectFile = join(directory, 'project.godot');
      if (existsSync(projectFile)) {
        projects.push({
          path: directory,
          name: basename(directory),
        });
      }

      const entries = readdirSync(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || (recursive && entry.name.startsWith('.'))) continue;

        const subdirectory = join(directory, entry.name);
        if (existsSync(join(subdirectory, 'project.godot'))) {
          projects.push({ path: subdirectory, name: entry.name });
        } else if (recursive) {
          projects.push(...this.findGodotProjects(subdirectory, true));
        }
      }
    } catch (error) {
      this.context.logDebug(`Error searching directory ${directory}: ${error}`);
    }

    return projects;
  }

  public async getProjectStructureAsync(projectPath: string): Promise<ProjectStructure> {
    const structure: ProjectStructure = {
      scenes: 0,
      scripts: 0,
      assets: 0,
      other: 0,
    };

    try {
      const scanDirectory = (currentPath: string): void => {
        const entries = readdirSync(currentPath, { withFileTypes: true });

        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;

          const entryPath = join(currentPath, entry.name);
          if (entry.isDirectory()) {
            scanDirectory(entryPath);
          } else if (entry.isFile()) {
            const extension = entry.name.split('.').pop()?.toLowerCase();
            if (extension === 'tscn') {
              structure.scenes++;
            } else if (extension === 'gd' || extension === 'gdscript' || extension === 'cs') {
              structure.scripts++;
            } else if (['png', 'jpg', 'jpeg', 'webp', 'svg', 'ttf', 'wav', 'mp3', 'ogg'].includes(extension || '')) {
              structure.assets++;
            } else {
              structure.other++;
            }
          }
        }
      };

      scanDirectory(projectPath);
      return structure;
    } catch (error) {
      this.context.logDebug(`Error getting project structure asynchronously: ${error}`);
      return {
        error: 'Failed to get project structure',
        scenes: 0,
        scripts: 0,
        assets: 0,
        other: 0,
      };
    }
  }

  public isDotnetProject(projectPath: string): boolean {
    try {
      return readdirSync(projectPath).some(entry => entry.toLowerCase().endsWith('.csproj'));
    } catch {
      return false;
    }
  }

  public async detectGodotNetSdkVersion(): Promise<string | null> {
    try {
      const godotPath = await this.requireGodotPath();
      if (!godotPath) return null;

      const { stdout } = await execFileAsync(godotPath, ['--version'], GODOT_VERSION_OPTIONS);
      const match = /^(\d+)\.(\d+)(?:\.\d+)?\.stable\b/.exec(stdout.trim());
      return match ? `${match[1]}.${match[2]}.0` : null;
    } catch {
      return null;
    }
  }

  public keyNameToScancode(key: string): number {
    const map: Record<string, number> = {
      'A': 65, 'B': 66, 'C': 67, 'D': 68, 'E': 69, 'F': 70, 'G': 71, 'H': 72,
      'I': 73, 'J': 74, 'K': 75, 'L': 76, 'M': 77, 'N': 78, 'O': 79, 'P': 80,
      'Q': 81, 'R': 82, 'S': 83, 'T': 84, 'U': 85, 'V': 86, 'W': 87, 'X': 88,
      'Y': 89, 'Z': 90, 'SPACE': 32, 'ENTER': 16777221, 'ESCAPE': 16777217,
      'TAB': 16777218, 'BACKSPACE': 16777220, 'UP': 16777232, 'DOWN': 16777234,
      'LEFT': 16777231, 'RIGHT': 16777233, 'SHIFT': 16777237, 'CTRL': 16777238,
      'ALT': 16777240, 'F1': 16777244, 'F2': 16777245, 'F3': 16777246,
      'F4': 16777247, 'F5': 16777248, 'F6': 16777249, 'F7': 16777250,
      'F8': 16777251, 'F9': 16777252, 'F10': 16777253, 'F11': 16777254,
      'F12': 16777255,
    };
    const upper = key.toUpperCase();
    return map[upper] || (key.length === 1 ? key.charCodeAt(0) : 0);
  }

  public async runGdScriptCheck(projectPath: string, scriptFull: string): Promise<GdScriptCheck> {
    const godotPath = await this.requireGodotPath();
    if (!godotPath) {
      return { completed: false, errors: [], error: 'Could not find a valid Godot executable path' };
    }

    let output: string;
    let failed = false;
    const scriptResourcePath = `res://${relative(projectPath, scriptFull).replace(/\\/g, '/')}`;
    try {
      // `--check-only --script <target>` compiles too early for project autoload
      // globals to be registered. The SceneTree validator loads the target from
      // `_initialize()`, after autoload bootstrap, while CACHE_MODE_IGNORE keeps
      // every check a fresh parse of the current file contents.
      const { stdout, stderr } = await execFileAsync(
        godotPath,
        ['--headless', '--path', projectPath, '--script', this.validateScriptPath, scriptResourcePath],
        GODOT_COMMAND_OPTIONS,
      );
      output = `${stdout ?? ''}${stderr ?? ''}`;
    } catch (error: unknown) {
      failed = true;
      const execError = error as { stdout?: string; stderr?: string; killed?: boolean; signal?: string; code?: string };
      output = `${execError.stdout ?? ''}${execError.stderr ?? ''}`;
      const aborted = execError.killed === true || execError.signal != null ||
        execError.code === 'ETIMEDOUT' || execError.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
      if (aborted) return { completed: false, errors: [], error: 'Godot timed out or produced too much output' };
      if (!output) return { completed: false, errors: [], error: errorMessage(error) };
    }

    const errors = parseGodotScriptDiagnostics(output);
    if (errors.length === 0 && failed) {
      const tail = output.trim().split(/\r?\n/).slice(-6).join(' ');
      return { completed: false, errors: [], error: `Godot exited with an error: ${tail}` };
    }
    return { completed: true, errors };
  }

  public async listChangedGdFiles(projectPath: string): Promise<ChangedGdFiles> {
    const git = (gitArgs: string[]) =>
      execFileAsync(
        'git',
        ['-c', 'core.quotepath=false', '-C', projectPath, ...gitArgs],
        { timeout: 15000, maxBuffer: 16 * 1024 * 1024 },
      );

    try {
      await git(['rev-parse', '--is-inside-work-tree']);
    } catch {
      return { error: 'Not a git repository (or git is unavailable). Use scope: "all" or pass scriptPaths.' };
    }

    try {
      const outputs = await Promise.all([
        git(['diff', '--name-only', '--relative']),
        git(['diff', '--name-only', '--relative', '--cached']),
        git(['ls-files', '--others', '--exclude-standard']),
      ]);
      return { files: collectGdPaths(outputs.map(output => output.stdout ?? '')) };
    } catch (error: unknown) {
      return { error: `Failed to list changed files: ${errorMessage(error)}` };
    }
  }

  public listAllGdFiles(projectPath: string): string[] {
    const results: string[] = [];
    const skipDirectories = new Set(['.godot', '.git', 'node_modules', '.import']);
    const walk = (directory: string): void => {
      let entries;
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (skipDirectories.has(entry.name) || entry.name.startsWith('.')) continue;
          walk(join(directory, entry.name));
        } else if (entry.isFile() && /\.gd$/i.test(entry.name)) {
          results.push(relative(projectPath, join(directory, entry.name)).replace(/\\/g, '/'));
        }
      }
    };

    walk(projectPath);
    return results;
  }

  private async requireGodotPath(): Promise<string | null> {
    if (!this.context.getGodotPath()) await this.context.detectGodotPath();
    return this.context.getGodotPath();
  }
}
