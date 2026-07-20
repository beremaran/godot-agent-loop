import { spawn, type ChildProcess } from 'child_process';
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
import { describeCatalogTool, searchToolCatalog, type ToolCatalogDetail, type ToolCatalogSearchOptions } from '../tool-surface.js';
import {
  cancellableDelay,
  currentExecutionContext,
  getToolResultMetadata,
  isAbortError,
  reportProgress,
  setToolResultMetadata,
  throwIfCancelled,
} from '../execution-context.js';
import type { EditorPluginInstallation } from '../editor-plugin-installer.js';
import { canonicalProjectPath, type PublicEditorSession } from '../editor-session-registry.js';
import { createBoundedObservationResponse } from '../observation-result.js';
import { PRIVILEGED_RUNTIME_CAPABILITY, privilegedGroupCapability } from '../runtime-protocol.js';
import type { StructuredToolError } from '../tool-results.js';

const execFileAsync = promisify(execFile);

export interface LifecycleToolHandlerContext {
  executable: GodotExecutableService;
  getActiveProcess: () => GodotProcess | null;
  isPathAllowed: (projectPath: string) => boolean;
  isRelativePathAllowed: (projectPath: string, relativePath: string) => boolean;
  logDebug: (message: string) => void;
  startProjectProcess: (executable: string, args: string[], onExit: () => void, env?: NodeJS.ProcessEnv) => GodotProcess;
  stopProjectProcess: () => GodotProcess | null;
  stopAuthoringSession?: () => void;
  connectToGame: (projectPath: string, signal?: AbortSignal) => Promise<void>;
  disconnectFromGame: () => void;
  injectInteractionServer: (projectPath: string) => void;
  removeInteractionServer: (projectPath: string) => void;
  getConnectedProjectPath: () => string | null;
  clearConnectedProjectPath: () => void;
  getInteractionPort: () => number;
  getRuntimeHandshake?: () => Record<string, unknown> | null;
  getRuntimeEnvironment: () => NodeJS.ProcessEnv;
  installEditorPlugin?: (projectPath: string) => EditorPluginInstallation;
  removeEditorPlugin?: (projectPath: string, installation: EditorPluginInstallation | null) => void;
  getEditorEnvironment?: () => NodeJS.ProcessEnv;
  ensureEditorSession?: (projectPath: string, timeoutMs?: number, signal?: AbortSignal) => Promise<PublicEditorSession>;
  getEditorSessionStatus?: (projectPath: string) => Promise<PublicEditorSession>;
  disconnectEditorSession?: (projectPath: string) => PublicEditorSession;
  sendEditorCommand?: (
    projectPath: string,
    command: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ) => Promise<Record<string, unknown>>;
  isGameConnected: () => boolean;
  sendGameCommand: (
    command: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal | null,
  ) => Promise<GameResponse>;
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

const PROPERTY_WAIT_REFLECTION_ERROR: StructuredToolError = {
  code: 'reflection_privilege_required',
  category: 'policy',
  message: 'Property waits and assertions require the reflection privilege group, but the connected runtime did not authorize it.',
  retryable: true,
  remediation: 'Enable GODOT_MCP_PRIVILEGED_GROUPS=reflection and restart the runtime, or use a log condition or game_get_ui observation that does not require reflection.',
  details: {
    condition: 'property',
    privilegeGroup: 'reflection',
    fallbackTools: ['game_wait_until condition=log', 'game_get_ui'],
  },
};

function waitSuccess(condition: unknown, startedAt: number, attempts: number, observed: unknown): Record<string, unknown> {
  return { satisfied: true, condition, elapsed_ms: Date.now() - startedAt, attempts, last_observed: observed };
}

function compactNodeWaitObservation(observed: unknown): unknown {
  if (!observed || typeof observed !== 'object' || Array.isArray(observed)) return observed;
  const record = observed as Record<string, unknown>;
  return {
    found: true,
    ...(['path', 'name', 'class'] as const).reduce<Record<string, unknown>>((result, key) => {
      if (record[key] !== undefined) result[key] = record[key];
      return result;
    }, {}),
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Implements editor launch, project runtime, and Godot version tools. */
export class LifecycleToolHandlers {
  private processGeneration = 0;
  private readonly editorEnsureTails = new Map<string, Promise<ToolResponse>>();

  constructor(private readonly context: LifecycleToolHandlerContext) {}

  public async handleGodotCatalog(args: ToolArguments): Promise<ToolResponse> {
    args = normalizeParameters(args || {});
    if (args.action === 'search') {
      const filters: ToolCatalogSearchOptions = {
        ...(typeof args.domain === 'string' ? { domain: args.domain as ToolCatalogSearchOptions['domain'] } : {}),
        ...(typeof args.backend === 'string' ? { backend: args.backend as ToolCatalogSearchOptions['backend'] } : {}),
        ...(typeof args.effect === 'string' ? { effect: args.effect as ToolCatalogSearchOptions['effect'] } : {}),
        ...(typeof args.state === 'string' ? { state: args.state as ToolCatalogSearchOptions['state'] } : {}),
        ...(typeof args.privilege === 'string' ? { privilege: args.privilege as ToolCatalogSearchOptions['privilege'] } : {}),
        ...(typeof args.mutation === 'string' ? { mutation: args.mutation as ToolCatalogSearchOptions['mutation'] } : {}),
        limit: typeof args.limit === 'number' ? args.limit : 20,
      };
      const results = searchToolCatalog(typeof args.query === 'string' ? args.query : '', filters);
      return { content: [{ type: 'text', text: JSON.stringify({ results, count: results.length }, null, 2) }] };
    }
    if (args.action === 'describe') {
      if (typeof args.toolName !== 'string') return createErrorResponse('toolName is required for godot_catalog describe.');
      const detail = (typeof args.detail === 'string' ? args.detail : 'summary') as ToolCatalogDetail;
      const tool = describeCatalogTool(args.toolName, detail);
      if (!tool) return createErrorResponse(`Unknown Godot tool: ${args.toolName}`);
      return { content: [{ type: 'text', text: JSON.stringify(tool, null, 2) }] };
    }
    return createErrorResponse('action must be search or describe.');
  }

  public async handleGodotCall(args: ToolArguments): Promise<ToolResponse> {
    args = normalizeParameters(args || {});
    if (typeof args.toolName !== 'string') return createErrorResponse('toolName is required for godot_call.');
    if (['godot_catalog', 'godot_call', 'godot_tools'].includes(args.toolName)) {
      return createErrorResponse('godot_call cannot recursively call a dispatcher.');
    }
    if (!this.context.dispatchTool) return createErrorResponse('Expanded tool dispatch is unavailable.');
    try {
      return await this.context.dispatchTool(args.toolName, args.arguments ?? {});
    } catch (error: unknown) {
      return setToolResultMetadata(createErrorResponse(`godot_call failed: ${errorMessage(error)}`), {
        outcome: isAbortError(error) ? 'cancelled' : 'failure',
      });
    }
  }

  public async handleGodotTools(args: ToolArguments): Promise<ToolResponse> {
    args = normalizeParameters(args || {});
    if (args.action === 'search') {
      return this.handleGodotCatalog(args);
    }
    if (args.action === 'describe') {
      if (typeof args.toolName !== 'string') return createErrorResponse('toolName is required for godot_tools describe.');
      const tool = describeCatalogTool(args.toolName, 'full');
      if (!tool) return createErrorResponse(`Unknown Godot tool: ${args.toolName}`);
      return { content: [{ type: 'text', text: JSON.stringify({
        definition: tool.definition,
        domain: tool.domain,
        backend: tool.backendDetails,
        privileged: tool.privilege === 'required',
      }, null, 2) }] };
    }
    if (args.action === 'call') {
      if (typeof args.toolName !== 'string') return createErrorResponse('toolName is required for godot_tools call.');
      return this.handleGodotCall(args);
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

    let spawnedEditor: ChildProcess | null = null;
    let installedPlugin: EditorPluginInstallation | null = null;
    try {
      const timeoutMs = Math.round((typeof args.timeoutSeconds === 'number' ? args.timeoutSeconds : 2) * 1_000);
      const discovered = await this.context.ensureEditorSession?.(args.projectPath, timeoutMs, currentExecutionContext()?.signal);
      if (discovered?.connected) return this.editorSessionResponse({ ...discovered, reused: true, spawned: false });
      if (discovered && ['addon_upgrade_restart_required', 'protocol_incompatible']
        .includes(discovered.state)) {
        // These states require an explicit install/upgrade and editor restart.
        // Launching another process cannot make a running stale addon safe and
        // would turn a watched request into an ambiguous second editor.
        return this.editorSessionResponse(discovered);
      }
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
      installedPlugin = editorPlugin ?? null;
      const editorArgs = ['-e', '--path', args.projectPath];
      const editorProcess = spawn(godotPath, editorArgs, {
        stdio: 'pipe', env: { ...process.env, ...this.context.getRuntimeEnvironment(), ...(this.context.getEditorEnvironment?.() ?? {}) },
      });
      spawnedEditor = editorProcess;
      editorProcess.on('error', (err: Error) => { console.error('Failed to start Godot editor:', err); });
      const attached = await this.context.ensureEditorSession?.(args.projectPath, 20_000, currentExecutionContext()?.signal);
      if (!attached?.connected) {
        throw new Error(`Editor launched but bridge did not become ready: ${attached?.state ?? 'registry_unavailable'}${attached?.reason ? ` (${attached.reason})` : ''}`);
      }
      return this.editorSessionResponse({
        ...attached,
        reused: false,
        spawned: true,
        plugin_owned: editorPlugin?.owned ?? false,
        plugin_distribution: editorPlugin?.distribution ?? 'unavailable',
      });
    } catch (error: unknown) {
      if (spawnedEditor && spawnedEditor.exitCode === null && spawnedEditor.signalCode === null) {
        spawnedEditor.kill('SIGTERM');
      }
      if (installedPlugin) this.context.removeEditorPlugin?.(args.projectPath, installedPlugin);
      if (isAbortError(error)) throw error;
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
    if (args.scenePath !== undefined && !this.isEditorPathAllowed(args.projectPath, args.scenePath)) {
      return createErrorResponse('scenePath is outside the project root');
    }
    const params: Record<string, unknown> = {};
    for (const key of ['nodePaths', 'scenePath', 'nodePath', 'property', 'value', 'name']) {
      if (args[key] !== undefined) params[key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)] = args[key];
    }
    try {
      if (!this.context.sendEditorCommand) return createErrorResponse('Editor bridge is not configured. Launch the editor through launch_editor first.');
      const result = await this.context.sendEditorCommand(
        args.projectPath, args.action, params, 15_000, currentExecutionContext()?.signal,
      );
      if (result.error) return createErrorResponse(`editor_control failed: ${typeof result.error === 'string' ? result.error : JSON.stringify(result.error)}`);
      return { content: [{ type: 'text', text: JSON.stringify({ project_path: args.projectPath, action: args.action, ...result }, null, 2) }] };
    } catch (error: unknown) {
      if (isAbortError(error)) throw error;
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
    if (!this.isEditorPathAllowed(args.projectPath, args.scenePath)) {
      return createErrorResponse('scenePath is outside the project root');
    }
    for (const [index, operation] of args.operations.entries()) {
      if (!operation || typeof operation !== 'object') continue;
      for (const key of ['scenePath', 'scriptPath', 'resourcePath']) {
        if (operation[key] !== undefined && !this.isEditorPathAllowed(args.projectPath, operation[key])) {
          return createErrorResponse(`operations[${index}].${key} is outside the project root`);
        }
      }
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
      const result = await this.context.sendEditorCommand(
        args.projectPath, 'transaction', params, 30_000, currentExecutionContext()?.signal,
      );
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
      if (isAbortError(error)) throw error;
      return createErrorResponse(`editor_transaction failed: ${this.errorMessage(error)}`);
    }
  }

  public async handleRunProject(args: ToolArguments) {
    args = normalizeParameters(args);
    const startupStartedAt = performance.now();
    if (!args.projectPath) return createErrorResponse('Project path is required');
    if (!validatePath(args.projectPath)) return createErrorResponse('Invalid project path');
    if (!this.context.isPathAllowed(args.projectPath)) {
      return createErrorResponse(
        `Project path is outside the allowed roots (GODOT_MCP_ALLOWED_DIRS): ${args.projectPath}`,
      );
    }

    let installationOwned = false;
    try {
      throwIfCancelled();
      await reportProgress(0, 4, 'Validating project and Godot executable');
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
      installationOwned = true;
      await reportProgress(1, 4, 'Installed authenticated runtime bridge');
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
      if (args.scene && this.context.isRelativePathAllowed(args.projectPath, args.scene)) commandArgs.push(args.scene);

      this.context.logDebug(`Running Godot project: ${args.projectPath}`);
      const processGeneration = ++this.processGeneration;
      const runningProcess = this.context.startProjectProcess(
        godotPath, commandArgs, () => { this.handleProjectExit(processGeneration); }, {
          ...this.context.getRuntimeEnvironment(),
          ...(mode === 'deterministic' ? deterministicSessionEnvironment() : realtimeSessionEnvironment()),
        },
      );
      await reportProgress(2, 4, 'Godot process started; waiting for runtime authentication');
      const executionSignal = currentExecutionContext()?.signal;
      const startupController = new AbortController();
      const forwardCancellation = () => {
        startupController.abort(executionSignal?.reason);
      };
      executionSignal?.addEventListener('abort', forwardCancellation, { once: true });
      try {
        await Promise.race([
          this.context.connectToGame(args.projectPath, startupController.signal),
          this.watchForFatalStartup(runningProcess, startupController.signal),
        ]);
      } finally {
        executionSignal?.removeEventListener('abort', forwardCancellation);
        startupController.abort();
      }
      throwIfCancelled();
      await reportProgress(3, 4, 'Runtime authenticated; probing scene tree readiness');
      const probe = await this.context.sendGameCommand(
        'get_scene_tree', { max_nodes: 1 }, 5_000, currentExecutionContext()?.signal,
      );
      if ('error' in probe) throw new Error(`Runtime readiness probe failed: ${probe.error.message}`);
      const fatalStartup = this.fatalStartupMessage(runningProcess);
      if (fatalStartup) throw new Error(`Godot reported a fatal startup error: ${fatalStartup}`);
      await reportProgress(4, 4, 'Runtime authenticated and ready');

      const handshake = this.context.getRuntimeHandshake?.() ?? null;
      const probeResult = probe.result && typeof probe.result === 'object'
        ? probe.result as Record<string, unknown>
        : {};
      const observedProjectPath = typeof handshake?.projectPath === 'string' ? handshake.projectPath : null;
      const canonicalRequestedProject = canonicalProjectPath(args.projectPath);
      const canonicalObservedProject = observedProjectPath === null ? null : canonicalProjectPath(observedProjectPath);
      const reportedObservedProject = canonicalObservedProject === canonicalRequestedProject
        ? args.projectPath
        : observedProjectPath;
      const observedScene = typeof probeResult.current_scene === 'string' ? probeResult.current_scene
        : typeof handshake?.currentScene === 'string' ? handshake.currentScene
          : null;

      return { content: [{ type: 'text', text: JSON.stringify({
        started: true,
        process_started: true,
        runtime_connected: true,
        runtime_ready: true,
        authenticated: true,
        project_path: args.projectPath,
        scene: args.scene ?? null,
        observed_project_path: reportedObservedProject,
        observed_scene: observedScene,
        project_identity: {
          requested: canonicalRequestedProject,
          observed: canonicalObservedProject,
          matched: canonicalObservedProject === null ? null : canonicalObservedProject === canonicalRequestedProject,
        },
        scene_identity: {
          requested: args.scene ?? null,
          observed: observedScene,
          source: typeof probeResult.current_scene === 'string' ? 'readiness_probe' : 'authenticated_handshake',
        },
        engine_version: typeof handshake?.engineVersion === 'string' ? handshake.engineVersion : null,
        startup_duration_ms: Math.round(performance.now() - startupStartedAt),
        startup_diagnostics: this.startupDiagnostics(runningProcess),
        interaction_port: this.context.getInteractionPort(),
        timing_policy: timingPolicy(mode),
        handshake,
        message: 'Godot project started in debug mode; use get_debug_output for process output.',
      }, null, 2) }] };
    } catch (error: unknown) {
      const cleanup: Record<string, unknown> = { attempted: installationOwned };
      if (installationOwned) {
        this.processGeneration += 1;
        this.context.disconnectFromGame();
        const stopped = this.context.stopProjectProcess();
        if (stopped) await this.waitForProcessExit(stopped, 10_000);
        try {
          this.context.removeInteractionServer(args.projectPath);
          cleanup.runtime_artifacts_removed = true;
        } catch (cleanupError) {
          cleanup.runtime_artifacts_removed = false;
          cleanup.error = this.errorMessage(cleanupError);
        }
        this.context.clearConnectedProjectPath();
        cleanup.process_stopped = this.context.getActiveProcess() === null;
      }
      const cancelled = isAbortError(error);
      return setToolResultMetadata(createErrorResponse(
        `${cancelled ? 'Cancelled' : 'Failed to run'} Godot project: ${this.errorMessage(error)}`,
      ), { outcome: cancelled ? 'cancelled' : 'failure', details: { cleanup } });
    }
  }

  private isEditorPathAllowed(projectPath: string, relativePath: unknown): relativePath is string {
    return typeof relativePath === 'string'
      && this.context.isRelativePathAllowed(projectPath, relativePath);
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
    const response = {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      ...(result.satisfied === true ? {} : { isError: true }),
    };
    return this.isReflectionPreconditionFailure(result)
      ? setToolResultMetadata(response, { outcome: 'failure', error: PROPERTY_WAIT_REFLECTION_ERROR })
      : response;
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
    let cancelled = false;
    let structuredError: StructuredToolError | undefined;
    const heldKeys = new Set<string>();
    const heldActions = new Set<string>();
    await reportProgress(0, args.steps.length + 1, `Starting scenario ${args.name}`);
    for (let index = 0; index < args.steps.length; index++) {
      try { throwIfCancelled(); } catch (error) {
        cancelled = true; passed = false; failure = this.errorMessage(error); break;
      }
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
          if (result.satisfied !== true) {
            passed = false;
            if (this.isReflectionPreconditionFailure(result)) {
              structuredError = PROPERTY_WAIT_REFLECTION_ERROR;
              failure = `Step ${index} failed: ${PROPERTY_WAIT_REFLECTION_ERROR.message}`;
            } else {
              failure = `Step ${index} condition was not satisfied`;
            }
          }
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
          const childMetadata = getToolResultMetadata(response);
          item.outcome = childMetadata.outcome ?? (response.isError === true ? 'failure' : 'success');
          if (response.isError === true) {
            throw new Error(childMetadata.error?.message
              ?? `Scenario child tool failed: ${tool} (${childMetadata.outcome ?? 'failure'})`);
          }
          item.result = response.structuredContent ?? response.content.map(content => content.type === 'image'
            ? { type: 'image', mime_type: 'mimeType' in content ? content.mimeType : 'image/png', preview_omitted: true }
            : { type: content.type, text: 'text' in content ? String(content.text).slice(0, 2_000) : '' });
          if (tool === 'game_key_hold' && typeof step.arguments?.key === 'string') heldKeys.add(step.arguments.key);
          if (tool === 'game_key_hold' && typeof step.arguments?.action === 'string') heldActions.add(step.arguments.action);
          if (tool === 'game_key_release' && typeof step.arguments?.key === 'string') heldKeys.delete(step.arguments.key);
          if (tool === 'game_key_release' && typeof step.arguments?.action === 'string') heldActions.delete(step.arguments.action);
        } else {
          throw new Error(`Unsupported scenario step type: ${String(step.type)}`);
        }
      } catch (error) {
        passed = false;
        cancelled = isAbortError(error);
        failure = `Step ${index} failed: ${this.errorMessage(error)}`;
        item.error = this.errorMessage(error);
      }
      item.duration_ms = Date.now() - stepStartedAt;
      evidence.push(item);
      await reportProgress(index + 1, args.steps.length + 1, `Completed scenario step ${index + 1}/${args.steps.length}`);
      if (!passed) break;
    }
    const teardown: Record<string, unknown> = { attempted: true };
    try {
      const released: string[] = [];
      for (const key of heldKeys) {
        const response = await this.context.sendGameCommand('key_release', { key }, 2_000, null);
        if (!('error' in response)) released.push(key);
      }
      teardown.released_keys = released;
      const releasedActions: string[] = [];
      for (const action of heldActions) {
        const response = await this.context.sendGameCommand('key_release', { action }, 2_000, null);
        if (!('error' in response)) releasedActions.push(action);
      }
      teardown.released_actions = releasedActions;
      const restored = await this.context.sendGameCommand('time_scale', { action: 'set', time_scale: 1 }, 2_000, null);
      teardown.time_scale_restored = !('error' in restored);
    } catch (error) {
      teardown.time_scale_restored = false;
      teardown.error = this.errorMessage(error);
      passed = false;
    }
    await reportProgress(args.steps.length + 1, args.steps.length + 1, 'Scenario cleanup complete');
    return setToolResultMetadata({
      content: [{ type: 'text', text: JSON.stringify({
        name: args.name, passed, failure, step_count: evidence.length,
        duration_ms: Date.now() - startedAt, steps: evidence, teardown,
      }, null, 2) }],
      ...(passed ? {} : { isError: true }),
    }, {
      outcome: cancelled ? 'cancelled' : passed ? 'success' : 'failure',
      details: { teardown },
      ...(structuredError ? { error: structuredError } : {}),
    });
  }

  private async waitUntilEvidence(args: ToolArguments): Promise<Record<string, unknown>> {
    const condition = args.condition;
    if (!['connection', 'node', 'property', 'signal', 'log', 'scene'].includes(condition)) {
      return { satisfied: false, error: 'condition must be connection, node, property, signal, log, or scene' };
    }
    // get_node_info exposes only editor-visible ("@export"-class) properties
    // unprivileged, which covers the overwhelming majority of gameplay state
    // (position, visible, modulate, ...). Only non-editor properties need the
    // privileged get_property command, so the reflection gate is enforced
    // lazily below once we know the editor-visible lookup actually missed.
    const propertyUsesReflectionFallback = condition === 'property' && !this.runtimeSupportsReflection();
    const timeoutMs = Math.round((typeof args.timeoutSeconds === 'number' ? args.timeoutSeconds : 10) * 1_000);
    const pollMs = typeof args.pollIntervalMs === 'number' ? args.pollIntervalMs : 100;
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    let attempts = 0;
    let lastObserved: unknown = null;
    const freshLogProcess = condition === 'log' && args.fresh === true
      ? this.context.getActiveProcess()
      : null;
    const freshLogStart = freshLogProcess?.output.length ?? 0;
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
        const activeProcess = this.context.getActiveProcess();
        const outputLines = activeProcess?.output ?? [];
        const start = args.fresh === true && activeProcess === freshLogProcess
          ? Math.min(freshLogStart, outputLines.length)
          : 0;
        const output = outputLines.slice(start).join('\n');
        lastObserved = { tail: output.slice(-2_000), ...(args.fresh === true ? { fresh: true } : {}) };
        if (typeof args.text === 'string' && output.includes(args.text)) return waitSuccess(condition, startedAt, attempts, lastObserved);
      } else {
        if (!this.context.isGameConnected()) lastObserved = { connected: false };
        else if (condition === 'property' && propertyUsesReflectionFallback) {
          // No reflection privilege: try the free, editor-property-only
          // get_node_info read before giving up. This covers the common case
          // (position, visible, modulate, ...) without requiring the caller
          // to opt into arbitrary reflection just to poll one safe property.
          const nodeInfoResult = await this.pollPropertyViaNodeInfo(args, deadline);
          if (nodeInfoResult.found) {
            lastObserved = nodeInfoResult.observed;
            if (sameJson(nodeInfoResult.value, args.value)) return waitSuccess(condition, startedAt, attempts, lastObserved);
          } else {
            return {
              satisfied: false,
              condition,
              elapsed_ms: Date.now() - startedAt,
              attempts,
              last_observed: nodeInfoResult.observed,
              error: PROPERTY_WAIT_REFLECTION_ERROR.message,
            };
          }
        } else if (condition === 'property') {
          const response = await this.tryGameCommand('get_property', { node_path: args.nodePath, property: args.property }, deadline, (error) => {
            if (lastObserved === null) lastObserved = { error: this.errorMessage(error) };
          });
          if (response) {
            lastObserved = 'error' in response ? { error: response.error } : response.result;
            if (!('error' in response)) {
              const result = response.result as Record<string, unknown>;
              if (sameJson(result.value, args.value)) return waitSuccess(condition, startedAt, attempts, lastObserved);
            }
          }
        } else {
          const command = condition === 'node' ? 'get_node_info' : 'get_scene_tree';
          const params = condition === 'node' ? { node_path: args.nodePath } : {};
          const response = await this.tryGameCommand(command, params, deadline, (error) => {
            // A poll issued at the edge of the deadline can consume its own
            // remaining transport budget. That is timeout evidence, not an
            // MCP handler crash, and must not erase the last successful read.
            if (lastObserved === null) lastObserved = { error: this.errorMessage(error) };
          });
          if (response) {
            lastObserved = 'error' in response ? { error: response.error } : response.result;
            if (condition === 'node' && !('error' in response)) {
              return waitSuccess(condition, startedAt, attempts, compactNodeWaitObservation(lastObserved));
            }
            if (condition === 'scene' && !('error' in response)) {
              const result = response.result as Record<string, unknown>;
              if (result.current_scene === args.scenePath) return waitSuccess(condition, startedAt, attempts, lastObserved);
            }
          }
        }
      }
      if (Date.now() >= deadline) break;
      await cancellableDelay(Math.min(pollMs, deadline - Date.now()));
    }
    return {
      satisfied: false, condition, elapsed_ms: Date.now() - startedAt, attempts,
      timeout_ms: timeoutMs, last_observed: lastObserved,
    };
  }

  private async tryGameCommand(
    command: string, params: Record<string, unknown>, deadline: number, onError: (error: unknown) => void,
  ): Promise<GameResponse | null> {
    try {
      return await this.context.sendGameCommand(command, params, Math.min(5_000, Math.max(1, deadline - Date.now())));
    } catch (error) {
      onError(error);
      return null;
    }
  }

  private async pollPropertyViaNodeInfo(
    args: ToolArguments, deadline: number,
  ): Promise<{ found: boolean; value: unknown; observed: unknown }> {
    const response = await this.tryGameCommand(
      'get_node_info', { node_path: args.nodePath, detail: 'compact', property_names: [args.property] }, deadline, () => { /* no-op: treated as not-found below */ },
    );
    if (!response || 'error' in response) return { found: false, value: undefined, observed: response ? { error: response.error } : null };
    const result = response.result as Record<string, unknown>;
    const properties = Array.isArray(result.properties) ? result.properties as Record<string, unknown>[] : [];
    const match = properties.find((p) => p.name === args.property);
    if (!match) return { found: false, value: undefined, observed: result };
    return { found: true, value: match.value, observed: { value: match.value, property: args.property, node_path: args.nodePath } };
  }

  private runtimeSupportsReflection(): boolean {
    const capabilities = this.context.getRuntimeHandshake?.()?.capabilities;
    return Array.isArray(capabilities)
      && (capabilities.includes(PRIVILEGED_RUNTIME_CAPABILITY)
        || capabilities.includes(privilegedGroupCapability('reflection')));
  }

  private isReflectionPreconditionFailure(result: Record<string, unknown>): boolean {
    return result.condition === 'property'
      && result.error === PROPERTY_WAIT_REFLECTION_ERROR.message;
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
    const outputDropped = activeProcess.outputDropped ?? 0;
    const errorsDropped = activeProcess.errorsDropped ?? 0;
    return createBoundedObservationResponse(
      { output: activeProcess.output, errors: activeProcess.errors, outputDropped, errorsDropped },
      {
        preferredArrayKeys: ['output', 'errors'],
        returnedCount: payload => ['output', 'errors'].reduce(
          (count, key) => count + (Array.isArray(payload[key]) ? payload[key].length : 0),
          0,
        ),
        sourceTruncated: () => outputDropped > 0 || errorsDropped > 0,
        refinement: 'Use cursor-based game_get_logs and game_get_errors for smaller incremental pages.',
        continuation: 'Call game_get_logs and game_get_errors to read retained output through their independent cursors.',
      },
    );
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
    await this.waitForProcessExit(stoppedProcess, 10_000);
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
      const { stdout } = await execFileAsync(godotPath, ['--version'], {
        ...GODOT_VERSION_OPTIONS,
        signal: currentExecutionContext()?.signal,
      });
      return { content: [{ type: 'text', text: stdout.trim() }] };
    } catch (error: unknown) {
      if (isAbortError(error)) throw error;
      return createErrorResponse(`Failed to get Godot version: ${this.errorMessage(error)}`);
    }
  }

  private waitForProcessExit(record: GodotProcess, timeoutMs: number): Promise<void> {
    return new Promise(resolve => {
      const child = record.process;
      if (!child || typeof child.once !== 'function' || child.exitCode !== null || child.signalCode !== null) {
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

  private startupDiagnostics(record: GodotProcess | null | undefined): Record<string, unknown> {
    const stdout = (record?.output ?? []).join('\n');
    const stderr = (record?.errors ?? []).join('\n');
    const maxStreamCharacters = 8 * 1024;
    return {
      stdout: stdout.slice(-maxStreamCharacters),
      stderr: stderr.slice(-maxStreamCharacters),
      truncated: stdout.length > maxStreamCharacters || stderr.length > maxStreamCharacters,
      limit_bytes: maxStreamCharacters * 2,
    };
  }

  private fatalStartupMessage(record: GodotProcess | null | undefined): string | null {
    const output = [...(record?.output ?? []), ...(record?.errors ?? [])].join('\n');
    const patterns = [
      /ERROR:\s+(?:Error parsing ['"][^'"\n]*project\.godot['"]|Couldn't load file ['"][^'"\n]*project\.godot['"])[^\n]*/i,
      /(?:SCRIPT ERROR:\s*)?(?:Parse Error|Failed to load script|Could not load script|Can't load script)[^\n]*/i,
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(output);
      if (match) return match[0];
    }
    return null;
  }

  private watchForFatalStartup(record: GodotProcess, signal: AbortSignal): Promise<never> {
    return new Promise((_, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal.removeEventListener('abort', cleanup);
      };
      const inspect = () => {
        if (signal.aborted) {
          cleanup();
          return;
        }
        const fatal = this.fatalStartupMessage(record);
        if (fatal) {
          cleanup();
          reject(new Error(`Godot reported a fatal startup error: ${fatal}`));
          return;
        }
        timer = setTimeout(inspect, 25);
      };
      signal.addEventListener('abort', cleanup, { once: true });
      inspect();
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
