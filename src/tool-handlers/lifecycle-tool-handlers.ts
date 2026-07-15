import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { convertCamelToSnakeCase, createErrorResponse, errorMessage, normalizeParameters, validatePath, type ToolArguments, type ToolResponse } from '../utils.js';
import type { GodotProcess } from '../godot-process-manager.js';
import type { GodotExecutableService } from '../godot-executable.js';
import { GODOT_VERSION_OPTIONS } from '../godot-subprocess.js';
import type { GameResponse } from '../game-connection.js';
import {
  deterministicSessionArguments,
  deterministicSessionEnvironment,
  realtimeSessionArguments,
  realtimeSessionEnvironment,
  timingPolicy,
  type TimingMode,
} from '../session-timing.js';
import { describeCatalogTool, searchToolCatalog } from '../tool-surface.js';
import type { EditorPluginInstallation } from '../editor-plugin-installer.js';
import type { PublicEditorSession } from '../editor-session-registry.js';

const execFileAsync = promisify(execFile);

export interface LifecycleToolHandlerContext {
  executable: GodotExecutableService;
  getActiveProcess: () => GodotProcess | null;
  isPathAllowed: (projectPath: string) => boolean;
  isRelativePathAllowed?: (projectPath: string, relativePath: string) => boolean;
  logDebug: (message: string) => void;
  startProjectProcess: (executable: string, args: string[], onExit: () => void, env?: NodeJS.ProcessEnv) => void;
  stopProjectProcess: () => GodotProcess | null;
  stopAuthoringSession?: () => void;
  connectToGame: (projectPath: string) => Promise<void>;
  disconnectFromGame: () => void;
  injectInteractionServer: (projectPath: string) => void;
  removeInteractionServer: (projectPath: string) => void;
  getConnectedProjectPath: () => string | null;
  clearConnectedProjectPath: () => void;
  getInteractionPort: () => number;
  getRuntimeEnvironment: () => NodeJS.ProcessEnv;
  installEditorPlugin?: (projectPath: string) => EditorPluginInstallation;
  removeEditorPlugin?: (projectPath: string, installation: EditorPluginInstallation | null) => void;
  getEditorEnvironment?: () => NodeJS.ProcessEnv;
  ensureEditorSession?: (projectPath: string, timeoutMs?: number) => Promise<PublicEditorSession>;
  getEditorSessionStatus?: (projectPath: string) => Promise<PublicEditorSession>;
  disconnectEditorSession?: (projectPath: string) => PublicEditorSession;
  sendEditorCommand?: (projectPath: string, command: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>;
  isGameConnected: () => boolean;
  sendGameCommand: (command: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<GameResponse>;
  dispatchTool?: (name: string, args: ToolArguments) => Promise<ToolResponse>;
}

const SCENARIO_INPUT_TOOLS = new Set([
  'game_key_press', 'game_key_hold', 'game_key_release', 'game_click', 'game_mouse_move',
  'game_scroll', 'game_mouse_drag', 'game_gamepad', 'game_input_action',
]);

const SCENARIO_OBSERVE_TOOLS = new Set([
  'game_get_scene_tree', 'game_get_ui', 'game_get_node_info', 'game_get_property',
  'game_get_errors', 'game_get_logs', 'game_get_camera', 'game_get_audio', 'game_performance',
]);

function waitSuccess(condition: unknown, startedAt: number, attempts: number, observed: unknown): Record<string, unknown> {
  return { satisfied: true, condition, elapsed_ms: Date.now() - startedAt, attempts, last_observed: observed };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Implements editor launch, project runtime, and Godot version tools. */
export class LifecycleToolHandlers {
  private processGeneration = 0;
  private readonly editorEnsureTails = new Map<string, Promise<ToolResponse>>();

  constructor(private readonly context: LifecycleToolHandlerContext) {}

  public async handleGodotTools(args: ToolArguments): Promise<ToolResponse> {
    args = normalizeParameters(args || {});
    if (args.action === 'search') {
      const results = searchToolCatalog(
        typeof args.query === 'string' ? args.query : '',
        typeof args.domain === 'string' ? args.domain : undefined,
        typeof args.limit === 'number' ? args.limit : 20,
      );
      return { content: [{ type: 'text', text: JSON.stringify({ results, count: results.length }, null, 2) }] };
    }
    if (args.action === 'describe') {
      if (typeof args.toolName !== 'string') return createErrorResponse('toolName is required for godot_tools describe.');
      const tool = describeCatalogTool(args.toolName);
      if (!tool) return createErrorResponse(`Unknown Godot tool: ${args.toolName}`);
      return { content: [{ type: 'text', text: JSON.stringify(tool, null, 2) }] };
    }
    if (args.action === 'call') {
      if (typeof args.toolName !== 'string') return createErrorResponse('toolName is required for godot_tools call.');
      if (args.toolName === 'godot_tools') return createErrorResponse('godot_tools cannot call itself.');
      if (!this.context.dispatchTool) return createErrorResponse('Expanded tool dispatch is unavailable.');
      try {
        return await this.context.dispatchTool(args.toolName, args.arguments ?? {});
      } catch (error: unknown) {
        return createErrorResponse(`godot_tools call failed: ${errorMessage(error)}`);
      }
    }
    return createErrorResponse('action must be search, describe, or call.');
  }

  public async handleLaunchEditor(args: ToolArguments) {
    return this.ensureEditor(normalizeParameters(args), true);
  }

  public async handleEditorSession(args: ToolArguments): Promise<ToolResponse> {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !['ensure', 'status', 'disconnect'].includes(args.action)) {
      return createErrorResponse('projectPath and action ensure, status, or disconnect are required.');
    }
    if (!validatePath(args.projectPath) || !this.context.isPathAllowed(args.projectPath)) {
      return createErrorResponse('Project path is outside the allowed roots');
    }
    if (!existsSync(join(args.projectPath, 'project.godot'))) {
      return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    }
    if (args.action === 'disconnect') {
      const session = this.context.disconnectEditorSession?.(args.projectPath);
      if (!session) return createErrorResponse('Editor session registry is unavailable.');
      return this.editorSessionResponse(session);
    }
    if (args.action === 'status') {
      const session = await this.context.getEditorSessionStatus?.(args.projectPath);
      if (!session) return createErrorResponse('Editor session registry is unavailable.');
      return this.editorSessionResponse(session);
    }
    return this.ensureEditor(args, args.launchIfNeeded === true);
  }

  private ensureEditor(args: ToolArguments, launchIfNeeded: boolean): Promise<ToolResponse> {
    const projectPath = typeof args.projectPath === 'string' ? args.projectPath : '';
    const existing = this.editorEnsureTails.get(projectPath);
    if (existing) return existing;
    const pending = this.ensureEditorUnserialized(args, launchIfNeeded);
    this.editorEnsureTails.set(projectPath, pending);
    void pending.finally(() => {
      if (this.editorEnsureTails.get(projectPath) === pending) this.editorEnsureTails.delete(projectPath);
    });
    return pending;
  }

  private async ensureEditorUnserialized(args: ToolArguments, launchIfNeeded: boolean): Promise<ToolResponse> {
    args = normalizeParameters(args);
    if (!args.projectPath) return createErrorResponse('Project path is required');
    if (!validatePath(args.projectPath)) return createErrorResponse('Invalid project path');
    if (!this.context.isPathAllowed(args.projectPath)) return createErrorResponse('Project path is outside the allowed roots');
    if (!existsSync(join(args.projectPath, 'project.godot'))) {
      return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    }

    try {
      const timeoutMs = Math.round((typeof args.timeoutSeconds === 'number' ? args.timeoutSeconds : 2) * 1_000);
      const discovered = await this.context.ensureEditorSession?.(args.projectPath, timeoutMs);
      if (discovered?.connected) return this.editorSessionResponse({ ...discovered, reused: true, spawned: false });
      if (!launchIfNeeded) {
        return this.editorSessionResponse(discovered ?? {
          state: 'no_editor', project_path: args.projectPath, connected: false, reused: false, spawned: false,
          editor_pid: null, editor_start_identity: null, port: null, protocol_version: null,
          addon_version: null, godot_version: null, created_at: null,
          reason: 'No discoverable compatible editor. Install and enable the persistent addon, or retry with launchIfNeeded.',
        });
      }
      const godotPath = await this.requireGodotPath();
      if (!godotPath) return createErrorResponse('Could not find a valid Godot executable path');

      this.context.logDebug(`No reusable editor found; launching Godot editor for project: ${args.projectPath}`);
      const editorPlugin = this.context.installEditorPlugin?.(args.projectPath);
      const editorArgs = ['-e', '--path', args.projectPath];
      const editorProcess = spawn(godotPath, editorArgs, {
        stdio: 'pipe', env: { ...process.env, ...this.context.getRuntimeEnvironment(), ...(this.context.getEditorEnvironment?.() ?? {}) },
      });
      editorProcess.on('error', (err: Error) => { console.error('Failed to start Godot editor:', err); });
      const attached = await this.context.ensureEditorSession?.(args.projectPath, 20_000);
      if (!attached?.connected) {
        return createErrorResponse(`Editor launched but bridge did not become ready: ${attached?.state ?? 'registry_unavailable'}${attached?.reason ? ` (${attached.reason})` : ''}`);
      }
      return this.editorSessionResponse({
        ...attached,
        reused: false,
        spawned: true,
        plugin_owned: editorPlugin?.owned ?? false,
        plugin_distribution: editorPlugin?.distribution ?? 'unavailable',
      });
    } catch (error: unknown) {
      const message = this.errorMessage(error);
      if (message.includes('protocol is incompatible')) {
        return this.editorSessionResponse({
          state: 'addon_upgrade_restart_required', project_path: args.projectPath, connected: false,
          reused: false, spawned: false, editor_pid: null, editor_start_identity: null, port: null,
          protocol_version: null, addon_version: null, godot_version: null, created_at: null, reason: message,
        });
      }
      return createErrorResponse(`Failed to ensure Godot editor: ${message}`);
    }
  }

  private editorSessionResponse(session: PublicEditorSession): ToolResponse {
    return { content: [{ type: 'text', text: JSON.stringify({ editor_session: session }, null, 2) }] };
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
      const result = await this.context.sendEditorCommand(args.projectPath, args.action, params, 15_000);
      if (result.error) return createErrorResponse(`editor_control failed: ${typeof result.error === 'string' ? result.error : JSON.stringify(result.error)}`);
      return { content: [{ type: 'text', text: JSON.stringify({ project_path: args.projectPath, action: args.action, ...result }, null, 2) }] };
    } catch (error: unknown) {
      return createErrorResponse(`editor_control failed: ${this.errorMessage(error)}`);
    }
  }

  public async handleEditorTransaction(args: ToolArguments): Promise<ToolResponse> {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.scenePath || !args.name || !Array.isArray(args.operations) || args.operations.length === 0) {
      return createErrorResponse('projectPath, scenePath, name, and at least one operation are required.');
    }
    if (!validatePath(args.projectPath) || !this.context.isPathAllowed(args.projectPath)) {
      return createErrorResponse('Project path is outside the allowed roots');
    }
    if (!this.context.sendEditorCommand) return createErrorResponse('Editor session registry is unavailable.');
    try {
      const params = convertCamelToSnakeCase({
        scenePath: args.scenePath,
        name: args.name,
        rootType: args.rootType,
        operations: args.operations,
        focusPath: args.focusPath,
        save: args.save !== false,
      });
      const result = await this.context.sendEditorCommand(args.projectPath, 'transaction', params, 30_000);
      if (result.error) {
        return createErrorResponse(`editor_transaction failed: ${typeof result.error === 'string' ? result.error : JSON.stringify(result.error)}`);
      }
      const editorSession = await this.context.getEditorSessionStatus?.(args.projectPath);
      return { content: [{ type: 'text', text: JSON.stringify({
        project_path: args.projectPath,
        backend: 'editor',
        editor_session: editorSession ?? null,
        sync_status: 'acknowledged',
        fallback_reason: null,
        observed_target_state: result.observed_target_state ?? null,
        ...result,
      }, null, 2) }] };
    } catch (error: unknown) {
      return createErrorResponse(`editor_transaction failed: ${this.errorMessage(error)}`);
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

      // The game and authoring harness both depend on the generated runtime
      // installation. Give the user-facing run exclusive ownership before it
      // injects and launches the project.
      this.context.stopAuthoringSession?.();

      if (this.context.getActiveProcess()) {
        this.context.logDebug('Killing existing Godot process before starting a new one');
        this.processGeneration += 1;
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
      const mode: TimingMode = args.timingMode === 'deterministic' ? 'deterministic' : 'realtime';
      const commandArgs = [
        ...(mode === 'deterministic' ? deterministicSessionArguments() : realtimeSessionArguments()),
        '--path', args.projectPath,
      ];
      if (args.scene && (!this.context.isRelativePathAllowed || this.context.isRelativePathAllowed(args.projectPath, args.scene))) commandArgs.push(args.scene);

      this.context.logDebug(`Running Godot project: ${args.projectPath}`);
      const processGeneration = ++this.processGeneration;
      this.context.startProjectProcess(
        godotPath, commandArgs, () => { this.handleProjectExit(processGeneration); }, {
          ...this.context.getRuntimeEnvironment(),
          ...(mode === 'deterministic' ? deterministicSessionEnvironment() : realtimeSessionEnvironment()),
        },
      );
      this.context.connectToGame(args.projectPath).catch(error => {
        this.context.logDebug(`Failed to connect to game interaction server: ${error}`);
      });

      return { content: [{ type: 'text', text: JSON.stringify({
        started: true,
        project_path: args.projectPath,
        scene: args.scene ?? null,
        interaction_port: this.context.getInteractionPort(),
        timing_policy: timingPolicy(mode),
        message: 'Godot project started in debug mode; use get_debug_output for process output.',
      }, null, 2) }] };
    } catch (error: unknown) {
      return createErrorResponse(`Failed to run Godot project: ${this.errorMessage(error)}`);
    }
  }

  public async handleVerifyProject(args: ToolArguments) {
    args = normalizeParameters(args || {});
    const teardown = args.teardown !== false;
    const started = await this.handleRunProject({
      projectPath: args.projectPath,
      ...(args.scene ? { scene: args.scene } : {}),
      timingMode: 'deterministic',
    });
    if (started.isError === true) return started;

    const evidence: Record<string, unknown> = {
      project_path: args.projectPath,
      started: true,
      assertions: [],
      screenshot: null,
      teardown,
      timing_policy: timingPolicy('deterministic'),
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

  public async handleGameWaitUntil(args: ToolArguments): Promise<ToolResponse> {
    args = normalizeParameters(args || {});
    const result = await this.waitUntilEvidence(args);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      ...(result.satisfied === true ? {} : { isError: true }),
    };
  }

  public async handleGameScenario(args: ToolArguments): Promise<ToolResponse> {
    args = normalizeParameters(args || {});
    if (!args.name || !Array.isArray(args.steps) || args.steps.length === 0) {
      return createErrorResponse('name and at least one scenario step are required.');
    }
    if (!this.context.isGameConnected()) return createErrorResponse('Not connected to a running Godot project.');
    const startedAt = Date.now();
    const deadline = startedAt + Math.round((typeof args.timeoutSeconds === 'number' ? args.timeoutSeconds : 60) * 1_000);
    const evidence: Record<string, unknown>[] = [];
    let passed = true;
    let failure: string | null = null;
    for (let index = 0; index < args.steps.length; index++) {
      if (Date.now() >= deadline) { passed = false; failure = 'Scenario timeout expired'; break; }
      const step = args.steps[index] as ToolArguments;
      const stepStartedAt = Date.now();
      const item: Record<string, unknown> = { index, type: step.type, label: step.label ?? null };
      try {
        if (step.type === 'wait' || step.type === 'assert') {
          const condition = normalizeParameters((step.condition ?? {}) as ToolArguments);
          const remaining = Math.max(0.05, (deadline - Date.now()) / 1_000);
          const requestedTimeout = typeof condition.timeoutSeconds === 'number' ? condition.timeoutSeconds : remaining;
          const result = await this.waitUntilEvidence({ ...condition, timeoutSeconds: Math.min(remaining, requestedTimeout) });
          item.result = result;
          if (result.satisfied !== true) { passed = false; failure = `Step ${index} condition was not satisfied`; }
        } else if (step.type === 'screenshot') {
          const response = await this.context.sendGameCommand('screenshot', {}, Math.max(1, deadline - Date.now()));
          if ('error' in response) throw new Error(response.error.message);
          const result = response.result as { data?: string; width?: number; height?: number };
          const bytes = Buffer.from(result.data ?? '', 'base64');
          item.result = {
            captured: bytes.length > 0, width: result.width, height: result.height, bytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'), preview_omitted: true,
          };
        } else if (step.type === 'performance') {
          const response = await this.context.sendGameCommand('get_performance', {
            action: 'sample', sample_count: 1,
          }, Math.max(1, deadline - Date.now()));
          if ('error' in response) throw new Error(response.error.message);
          item.result = response.result;
        } else if (step.type === 'input' || step.type === 'observe') {
          const allowed = step.type === 'input' ? SCENARIO_INPUT_TOOLS : SCENARIO_OBSERVE_TOOLS;
          const tool = typeof step.tool === 'string' ? step.tool : step.type === 'input' ? 'game_key_press' : 'game_get_scene_tree';
          if (!allowed.has(tool)) throw new Error(`Scenario ${step.type} tool is not allowed: ${tool}`);
          if (!this.context.dispatchTool) throw new Error('Scenario tool dispatch is unavailable');
          const response = await this.context.dispatchTool(tool, (step.arguments ?? {}) as ToolArguments);
          if (response.isError === true) throw new Error(response.content.map(content => 'text' in content ? content.text : content.type).join('; '));
          item.result = response.content.map(content => content.type === 'image'
            ? { type: 'image', mime_type: 'mimeType' in content ? content.mimeType : 'image/png', preview_omitted: true }
            : { type: content.type, text: 'text' in content ? String(content.text).slice(0, 2_000) : '' });
        } else {
          throw new Error(`Unsupported scenario step type: ${String(step.type)}`);
        }
      } catch (error) {
        passed = false;
        failure = `Step ${index} failed: ${this.errorMessage(error)}`;
        item.error = this.errorMessage(error);
      }
      item.duration_ms = Date.now() - stepStartedAt;
      evidence.push(item);
      if (!passed) break;
    }
    const teardown: Record<string, unknown> = { attempted: true };
    try {
      const restored = await this.context.sendGameCommand('time_scale', { action: 'set', time_scale: 1 }, 2_000);
      teardown.time_scale_restored = !('error' in restored);
    } catch (error) {
      teardown.time_scale_restored = false;
      teardown.error = this.errorMessage(error);
      passed = false;
    }
    return {
      content: [{ type: 'text', text: JSON.stringify({
        name: args.name, passed, failure, step_count: evidence.length,
        duration_ms: Date.now() - startedAt, steps: evidence, teardown,
      }, null, 2) }],
      ...(passed ? {} : { isError: true }),
    };
  }

  private async waitUntilEvidence(args: ToolArguments): Promise<Record<string, unknown>> {
    const condition = args.condition;
    if (!['connection', 'node', 'property', 'signal', 'log', 'scene'].includes(condition)) {
      return { satisfied: false, error: 'condition must be connection, node, property, signal, log, or scene' };
    }
    const timeoutMs = Math.round((typeof args.timeoutSeconds === 'number' ? args.timeoutSeconds : 10) * 1_000);
    const pollMs = typeof args.pollIntervalMs === 'number' ? args.pollIntervalMs : 100;
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    let attempts = 0;
    let lastObserved: unknown = null;
    if (condition === 'signal') {
      if (!args.nodePath || !args.signal) return { satisfied: false, error: 'nodePath and signal are required' };
      const response = await this.context.sendGameCommand('await_signal', {
        node_path: args.nodePath, signal_name: args.signal, timeout: timeoutMs / 1_000,
      }, timeoutMs + 1_000);
      return 'error' in response
        ? { satisfied: false, condition, elapsed_ms: Date.now() - startedAt, attempts: 1, last_observed: response.error }
        : { satisfied: true, condition, elapsed_ms: Date.now() - startedAt, attempts: 1, last_observed: response.result };
    }
    while (Date.now() <= deadline) {
      attempts += 1;
      if (condition === 'connection') {
        lastObserved = { connected: this.context.isGameConnected() };
        if (this.context.isGameConnected()) return waitSuccess(condition, startedAt, attempts, lastObserved);
      } else if (condition === 'log') {
        const output = this.context.getActiveProcess()?.output.join('\n') ?? '';
        lastObserved = { tail: output.slice(-2_000) };
        if (typeof args.text === 'string' && output.includes(args.text)) return waitSuccess(condition, startedAt, attempts, lastObserved);
      } else {
        if (!this.context.isGameConnected()) lastObserved = { connected: false };
        else {
          const command = condition === 'node' ? 'get_node_info' : condition === 'property' ? 'get_property' : 'get_scene_tree';
          const params = condition === 'node' ? { node_path: args.nodePath }
            : condition === 'property' ? { node_path: args.nodePath, property: args.property }
            : {};
          let response: GameResponse | null = null;
          try {
            response = await this.context.sendGameCommand(
              command, params, Math.min(5_000, Math.max(1, deadline - Date.now())),
            );
          } catch (error) {
            // A poll issued at the edge of the deadline can consume its own
            // remaining transport budget. That is timeout evidence, not an
            // MCP handler crash, and must not erase the last successful read.
            if (lastObserved === null) lastObserved = { error: this.errorMessage(error) };
          }
          if (response) {
            lastObserved = 'error' in response ? { error: response.error } : response.result;
            if (condition === 'node' && !('error' in response)) return waitSuccess(condition, startedAt, attempts, lastObserved);
            if (condition === 'property' && !('error' in response)) {
              const result = response.result as Record<string, unknown>;
              if (sameJson(result.value, args.value)) return waitSuccess(condition, startedAt, attempts, lastObserved);
            }
            if (condition === 'scene' && !('error' in response)) {
              const result = response.result as Record<string, unknown>;
              if (result.current_scene === args.scenePath) return waitSuccess(condition, startedAt, attempts, lastObserved);
            }
          }
        }
      }
      if (Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, deadline - Date.now())));
    }
    return {
      satisfied: false, condition, elapsed_ms: Date.now() - startedAt, attempts,
      timeout_ms: timeoutMs, last_observed: lastObserved,
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
    // Invalidate the child's eventual exit callback before performing the same
    // cleanup synchronously. A late callback must never tear down a replacement.
    this.processGeneration += 1;
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

  private handleProjectExit(processGeneration: number): void {
    if (processGeneration !== this.processGeneration) return;
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
