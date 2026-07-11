import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { createErrorResponse, normalizeParameters, validatePath, type ToolArguments } from '../utils.js';
import type { GodotProcess } from '../godot-process-manager.js';
import type { GodotExecutableService } from '../godot-executable.js';
import { GODOT_VERSION_OPTIONS } from '../godot-subprocess.js';

const execFileAsync = promisify(execFile);

export interface LifecycleToolHandlerContext {
  executable: GodotExecutableService;
  getActiveProcess: () => GodotProcess | null;
  isPathAllowed: (projectPath: string) => boolean;
  isRelativePathAllowed?: (projectPath: string, relativePath: string) => boolean;
  logDebug: (message: string) => void;
  startProjectProcess: (executable: string, args: string[], onExit: () => void) => void;
  stopProjectProcess: () => GodotProcess | null;
  connectToGame: (projectPath: string) => Promise<void>;
  disconnectFromGame: () => void;
  injectInteractionServer: (projectPath: string) => void;
  removeInteractionServer: (projectPath: string) => void;
  getConnectedProjectPath: () => string | null;
  clearConnectedProjectPath: () => void;
  getInteractionPort: () => number;
}

/** Implements editor launch, project runtime, and Godot version tools. */
export class LifecycleToolHandlers {
  constructor(private readonly context: LifecycleToolHandlerContext) {}

  public async handleLaunchEditor(args: ToolArguments) {
    args = normalizeParameters(args);
    if (!args.projectPath) return createErrorResponse('Project path is required');
    if (!validatePath(args.projectPath)) return createErrorResponse('Invalid project path');
    if (!this.context.isPathAllowed(args.projectPath)) return createErrorResponse('Project path is outside the allowed roots');

    try {
      const godotPath = await this.requireGodotPath();
      if (!godotPath) return createErrorResponse('Could not find a valid Godot executable path');

      if (!existsSync(join(args.projectPath, 'project.godot')))
        return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);

      this.context.logDebug(`Launching Godot editor for project: ${args.projectPath}`);
      const process = spawn(godotPath, ['-e', '--path', args.projectPath], { stdio: 'pipe' });
      process.on('error', (err: Error) => { console.error('Failed to start Godot editor:', err); });
      return { content: [{ type: 'text', text: `Godot editor launched successfully for project at ${args.projectPath}.` }] };
    } catch (error: unknown) {
      return createErrorResponse(`Failed to launch Godot editor: ${this.errorMessage(error)}`);
    }
  }

  public async handleRunProject(args: ToolArguments) {
    args = normalizeParameters(args);
    if (!args.projectPath) return createErrorResponse('Project path is required');
    if (!validatePath(args.projectPath)) return createErrorResponse('Invalid project path');
    if (!this.context.isPathAllowed(args.projectPath)) {
      return createErrorResponse(
        `Project path is outside the allowed roots (GODOT_MCP_ALLOWED_DIRS): ${args.projectPath}`,
      );
    }

    try {
      const godotPath = await this.requireGodotPath();
      if (!godotPath) return createErrorResponse('Could not find a valid Godot executable path');
      if (!existsSync(join(args.projectPath, 'project.godot')))
        return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);

      if (this.context.getActiveProcess()) {
        this.context.logDebug('Killing existing Godot process before starting a new one');
        this.context.disconnectFromGame();
        const existingProjectPath = this.context.getConnectedProjectPath();
        if (existingProjectPath) this.context.removeInteractionServer(existingProjectPath);
        this.context.stopProjectProcess();
      }

      this.context.injectInteractionServer(args.projectPath);
      const commandArgs = ['-d', '--path', args.projectPath];
      if (args.scene && (!this.context.isRelativePathAllowed || this.context.isRelativePathAllowed(args.projectPath, args.scene))) commandArgs.push(args.scene);

      this.context.logDebug(`Running Godot project: ${args.projectPath}`);
      this.context.startProjectProcess(godotPath, commandArgs, () => { this.handleProjectExit(); });
      this.context.connectToGame(args.projectPath).catch(error => {
        this.context.logDebug(`Failed to connect to game interaction server: ${error}`);
      });

      return {
        content: [{
          type: 'text',
          text: `Godot project started in debug mode. Use get_debug_output to see output. Game interaction server connecting on port ${this.context.getInteractionPort()}...`,
        }],
      };
    } catch (error: unknown) {
      return createErrorResponse(`Failed to run Godot project: ${this.errorMessage(error)}`);
    }
  }

  public async handleGetDebugOutput() {
    const activeProcess = this.context.getActiveProcess();
    if (!activeProcess) return createErrorResponse('No active Godot process.');
    return { content: [{ type: 'text', text: JSON.stringify({ output: activeProcess.output, errors: activeProcess.errors }, null, 2) }] };
  }

  public async handleStopProject() {
    if (!this.context.getActiveProcess()) return createErrorResponse('No active Godot process to stop.');

    this.context.logDebug('Stopping active Godot process');
    this.context.disconnectFromGame();
    const stoppedProcess = this.context.stopProjectProcess()!;
    const projectPath = this.context.getConnectedProjectPath();
    if (projectPath) {
      this.context.removeInteractionServer(projectPath);
      this.context.clearConnectedProjectPath();
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ message: 'Godot project stopped', finalOutput: stoppedProcess.output, finalErrors: stoppedProcess.errors }, null, 2),
      }],
    };
  }

  public async handleGetGodotVersion() {
    try {
      const godotPath = await this.requireGodotPath();
      if (!godotPath) return createErrorResponse('Could not find a valid Godot executable path');
      this.context.logDebug('Getting Godot version');
      const { stdout } = await execFileAsync(godotPath, ['--version'], GODOT_VERSION_OPTIONS);
      return { content: [{ type: 'text', text: stdout.trim() }] };
    } catch (error: unknown) {
      return createErrorResponse(`Failed to get Godot version: ${this.errorMessage(error)}`);
    }
  }

  private async requireGodotPath(): Promise<string | null> {
    return this.context.executable.requirePath();
  }

  private handleProjectExit(): void {
    this.context.disconnectFromGame();
    const projectPath = this.context.getConnectedProjectPath();
    if (projectPath) {
      this.context.removeInteractionServer(projectPath);
      this.context.clearConnectedProjectPath();
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'Unknown error';
  }
}
