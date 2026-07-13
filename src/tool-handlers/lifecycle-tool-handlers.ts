import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { createErrorResponse, normalizeParameters, validatePath, type ToolArguments } from '../utils.js';
import type { GodotProcess } from '../godot-process-manager.js';
import type { GodotExecutableService } from '../godot-executable.js';
import { GODOT_VERSION_OPTIONS } from '../godot-subprocess.js';
import type { GameResponse } from '../game-connection.js';

const execFileAsync = promisify(execFile);

export interface LifecycleToolHandlerContext {
  executable: GodotExecutableService;
  getActiveProcess: () => GodotProcess | null;
  isPathAllowed: (projectPath: string) => boolean;
  isRelativePathAllowed?: (projectPath: string, relativePath: string) => boolean;
  logDebug: (message: string) => void;
  startProjectProcess: (executable: string, args: string[], onExit: () => void, env?: NodeJS.ProcessEnv) => void;
  stopProjectProcess: () => GodotProcess | null;
  connectToGame: (projectPath: string) => Promise<void>;
  disconnectFromGame: () => void;
  injectInteractionServer: (projectPath: string) => void;
  removeInteractionServer: (projectPath: string) => void;
  getConnectedProjectPath: () => string | null;
  clearConnectedProjectPath: () => void;
  getInteractionPort: () => number;
  getRuntimeEnvironment: () => NodeJS.ProcessEnv;
  installEditorPlugin?: (projectPath: string) => boolean;
  removeEditorPlugin?: (projectPath: string, owned: boolean) => void;
  getEditorEnvironment?: () => NodeJS.ProcessEnv;
  sendEditorCommand?: (command: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>;
  isGameConnected: () => boolean;
  sendGameCommand: (command: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<GameResponse>;
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
      const editorPluginOwned = this.context.installEditorPlugin?.(args.projectPath) ?? false;
      const editorArgs = ['-e', '--path', args.projectPath];
      // Display-less environments (CI, the E2E harness) opt in to a headless
      // editor process, same as run_project.
      if (process.env.GODOT_MCP_RUN_HEADLESS === 'true') editorArgs.unshift('--headless');
      const editorProcess = spawn(godotPath, editorArgs, {
        stdio: 'pipe', env: { ...process.env, ...this.context.getRuntimeEnvironment(), ...(this.context.getEditorEnvironment?.() ?? {}) },
      });
      editorProcess.on('error', (err: Error) => { console.error('Failed to start Godot editor:', err); });
      const editorEnvironment = this.context.getEditorEnvironment?.() ?? {};
      return { content: [{ type: 'text', text: JSON.stringify({ launched: true, project_path: args.projectPath, editor_plugin: true, plugin_owned: editorPluginOwned, editor_bridge_port: editorEnvironment.GODOT_MCP_EDITOR_PORT ?? null }, null, 2) }] };
    } catch (error: unknown) {
      return createErrorResponse(`Failed to launch Godot editor: ${this.errorMessage(error)}`);
    }
  }

  public async handleEditorControl(args: ToolArguments) {
    args = normalizeParameters(args || {});
    const allowed = ['inspect', 'select', 'save', 'reload', 'open_scene', 'set_property', 'rename_node', 'undo', 'redo'];
    if (!args.projectPath || !allowed.includes(args.action)) {
      return createErrorResponse('projectPath and a valid editor action are required.');
    }
    if (!validatePath(args.projectPath) || !this.context.isPathAllowed(args.projectPath)) {
      return createErrorResponse('Project path is outside the allowed roots');
    }
    const params: Record<string, unknown> = {};
    for (const key of ['nodePaths', 'scenePath', 'nodePath', 'property', 'value', 'name']) {
      if (args[key] !== undefined) params[key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)] = args[key];
    }
    try {
      if (!this.context.sendEditorCommand) return createErrorResponse('Editor bridge is not configured. Launch the editor through launch_editor first.');
      const result = await this.context.sendEditorCommand(args.action, params, 15_000);
      if (result.error) return createErrorResponse(`editor_control failed: ${typeof result.error === 'string' ? result.error : JSON.stringify(result.error)}`);
      return { content: [{ type: 'text', text: JSON.stringify({ project_path: args.projectPath, action: args.action, ...result }, null, 2) }] };
    } catch (error: unknown) {
      return createErrorResponse(`editor_control failed: ${this.errorMessage(error)}`);
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
        const stopped = this.context.stopProjectProcess();
        // The old process still holds the interaction port until it exits;
        // starting the replacement immediately made its server fail to listen
        // and the relaunch never became reachable.
        if (stopped) await this.waitForProcessExit(stopped, 10_000);
      }

      this.context.injectInteractionServer(args.projectPath);
      // No `-d`: that starts Godot's *local stdout debugger*, which breaks into an
      // interactive `debug>` prompt on any script error and blocks the main loop
      // forever. The game then stops answering every runtime command, so a single
      // bad script hung the whole session. Errors still print with a full
      // backtrace without it, and the editor binary already runs projects as a
      // debug build.
      const commandArgs = ['--path', args.projectPath];
      // Display-less environments (CI, the E2E harness) opt in to headless
      // game processes; the interaction server works the same either way.
      if (process.env.GODOT_MCP_RUN_HEADLESS === 'true') commandArgs.unshift('--headless');
      if (args.scene && (!this.context.isRelativePathAllowed || this.context.isRelativePathAllowed(args.projectPath, args.scene))) commandArgs.push(args.scene);

      this.context.logDebug(`Running Godot project: ${args.projectPath}`);
      this.context.startProjectProcess(
        godotPath, commandArgs, () => { this.handleProjectExit(); }, this.context.getRuntimeEnvironment(),
      );
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

  public async handleVerifyProject(args: ToolArguments) {
    args = normalizeParameters(args || {});
    const teardown = args.teardown !== false;
    const started = await this.handleRunProject({ projectPath: args.projectPath, ...(args.scene ? { scene: args.scene } : {}) });
    if (started.isError === true) return started;

    const evidence: Record<string, unknown> = {
      project_path: args.projectPath,
      started: true,
      assertions: [],
      screenshot: null,
      teardown,
    };
    let passed = true;
    try {
      const deadline = Date.now() + 60_000;
      while (!this.context.isGameConnected()) {
        if (!this.context.getActiveProcess()) throw new Error('Godot exited before the verification runtime connected');
        if (Date.now() > deadline) throw new Error('Timed out waiting for the verification runtime connection');
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      const waited = await this.context.sendGameCommand('wait', {
        frames: args.waitFrames ?? 2, frame_type: 'render',
      }, 30_000);
      if ('error' in waited) throw new Error(`Frame wait failed: ${waited.error.message}`);

      const assertionEvidence = evidence.assertions as Record<string, unknown>[];
      for (const assertion of (args.assertions ?? []) as ToolArguments[]) {
        const result = await this.evaluateVerificationAssertion(assertion);
        assertionEvidence.push(result);
        if (result.passed !== true) passed = false;
      }

      if (args.captureScreenshot === true) {
        const screenshot = await this.context.sendGameCommand('screenshot', {}, 30_000);
        if ('error' in screenshot) {
          evidence.screenshot = { captured: false, error: screenshot.error.message };
          passed = false;
        } else {
          const result = screenshot.result as { data?: string; width?: number; height?: number };
          const bytes = Buffer.from(result.data ?? '', 'base64');
          evidence.screenshot = {
            captured: bytes.length > 0,
            width: result.width,
            height: result.height,
            bytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          };
          if (bytes.length === 0) passed = false;
        }
      }
    } catch (error: unknown) {
      passed = false;
      evidence.workflow_error = error instanceof Error ? error.message : String(error);
    } finally {
      if (teardown && this.context.getActiveProcess()) {
        const stopped = await this.handleStopProject();
        evidence.stopped = stopped.isError !== true;
        if (stopped.isError === true) passed = false;
      }
    }

    evidence.passed = passed;
    return {
      content: [{ type: 'text', text: JSON.stringify(evidence, null, 2) }],
      ...(passed ? {} : { isError: true }),
    };
  }

  private async evaluateVerificationAssertion(assertion: ToolArguments): Promise<Record<string, unknown>> {
    if (assertion.kind === 'node_exists') {
      if (!assertion.nodePath) return { ...assertion, passed: false, error: 'nodePath is required' };
      const response = await this.context.sendGameCommand('get_node_info', { node_path: assertion.nodePath });
      return 'error' in response
        ? { ...assertion, passed: false, error: response.error.message }
        : { ...assertion, passed: true };
    }
    if (assertion.kind === 'group_count') {
      if (!assertion.group || assertion.count === undefined) {
        return { ...assertion, passed: false, error: 'group and count are required' };
      }
      const response = await this.context.sendGameCommand('get_nodes_in_group', { group: assertion.group });
      if ('error' in response) return { ...assertion, passed: false, error: response.error.message };
      const result = response.result as { nodes?: unknown[] };
      const actual = result.nodes?.length ?? 0;
      return { ...assertion, actual, passed: actual === assertion.count };
    }
    if (assertion.kind === 'log_contains') {
      if (typeof assertion.text !== 'string') return { ...assertion, passed: false, error: 'text is required' };
      const output = this.context.getActiveProcess()?.output.join('\n') ?? '';
      return { ...assertion, passed: output.includes(assertion.text) };
    }
    return { ...assertion, passed: false, error: `Unknown assertion kind: ${String(assertion.kind)}` };
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

  private waitForProcessExit(record: GodotProcess, timeoutMs: number): Promise<void> {
    return new Promise(resolve => {
      const child = record.process;
      if (typeof child.once !== 'function' || child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, timeoutMs);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
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
