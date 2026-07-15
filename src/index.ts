#!/usr/bin/env node
/**
 * Godot Agent Loop server
 *
 * This MCP server provides tools for interacting with the Godot game engine.
 * It enables AI assistants to launch the Godot editor, run Godot projects,
 * capture debug output, and control project execution.
 */

import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { join, dirname, normalize } from 'path';
import { randomBytes } from 'crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { GameResponse } from './game-connection.js';

import { PathSecurity, type OperationParams, type ToolArguments, type ToolResponse } from './utils.js';
import type { ToolName } from './tool-definitions.js';
import { GodotExecutableService, GodotExecutableValidator } from './godot-executable.js';
import { HeadlessOperationRunner } from './headless-operation-runner.js';
import { HeadlessOperationService } from './headless-operation-service.js';
import { GameCommandService } from './game-command-service.js';
import { InteractionServerInstaller } from './interaction-server-installer.js';
import { GameConnection } from './game-connection.js';
import { ToolRegistry } from './tool-registry.js';
import { createToolHandlers } from './domain-tool-registries.js';
import { GodotProcessManager, type GodotProcess } from './godot-process-manager.js';
import { GameToolHandlers } from './tool-handlers/game-tool-handlers.js';
import { ProjectToolHandlers } from './tool-handlers/project-tool-handlers.js';
import { LifecycleToolHandlers } from './tool-handlers/lifecycle-tool-handlers.js';
import { ProjectSupport } from './project-support.js';
import { canonicalProjectPath, EditorSessionRegistry } from './editor-session-registry.js';
import { EditorSyncQueue } from './editor-sync-queue.js';
import { EditorAuthoringRouter } from './editor-authoring-router.js';
import { EditorPluginInstaller, type EditorPluginInstallation } from './editor-plugin-installer.js';
import { PRIVILEGED_RUNTIME_GROUPS, type PrivilegedRuntimeGroup } from './runtime-protocol.js';
import { AuthoringSessionManager } from './authoring-session-manager.js';
import { EditorMutationGuard } from './editor-mutation-guard.js';
import { SERVER_INSTRUCTIONS } from './server-instructions.js';
import { advertisedToolDefinitions } from './tool-surface.js';
import { runOpenCodeSetup } from './opencode-setup.js';
import { LifecycleTrace, type LifecycleOutcome } from './lifecycle-trace.js';
import { toolManifest } from './tool-manifest.js';
import { isToolCallMutating } from './tool-mutation-policy.js';

// Check if debug mode is enabled
const DEBUG_MODE: boolean = process.env.DEBUG === 'true';
const ALLOW_PRIVILEGED_COMMANDS: boolean = process.env.GODOT_MCP_ALLOW_PRIVILEGED_COMMANDS === 'true';
const RUNTIME_SECRET = process.env.GODOT_MCP_RUNTIME_SECRET || randomBytes(32).toString('base64url');

function resolvePrivilegedGroups(): PrivilegedRuntimeGroup[] {
  const configured = process.env.GODOT_MCP_PRIVILEGED_GROUPS ?? '';
  const requested = configured.split(',').map(value => value.trim()).filter(Boolean);
  const invalid = requested.filter(value => !PRIVILEGED_RUNTIME_GROUPS.includes(value as PrivilegedRuntimeGroup));
  if (invalid.length > 0) {
    console.error(`[SERVER] Ignoring unknown GODOT_MCP_PRIVILEGED_GROUPS values: ${invalid.join(', ')}`);
  }
  return [...new Set(requested.filter(
    (value): value is PrivilegedRuntimeGroup => PRIVILEGED_RUNTIME_GROUPS.includes(value as PrivilegedRuntimeGroup),
  ))];
}

const ALLOWED_PRIVILEGED_GROUPS = resolvePrivilegedGroups();

/**
 * The loopback port shared with the in-game interaction server. The spawned
 * game process inherits this environment variable, so both ends agree; the
 * override exists so parallel server instances (and the E2E harness) can each
 * use an isolated port.
 */
function resolveRuntimePort(): number {
  const configured = process.env.GODOT_MCP_RUNTIME_PORT;
  if (!configured) return 9090;
  const parsed = Number(configured);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed >= 65536) {
    console.error(`[SERVER] Ignoring invalid GODOT_MCP_RUNTIME_PORT=${configured}; using 9090`);
    return 9090;
  }
  return parsed;
}

const pathSecurity = new PathSecurity();

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

function toResourcePath(path: string): string {
  return path.startsWith('res://') ? path : `res://${path.replace(/^\/+/, '')}`;
}

function normalizeFocusPath(path: string): string {
  return path.replace(/^\/?root\/?/, '').replace(/^\.\//, '') || '.';
}

// Derive __filename and __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);
const packageMetadata = require('../package.json') as { version: string };
const SERVER_VERSION = packageMetadata.version;

/**
 * Interface representing a running Godot process
 */
/**
 * Interface for server configuration
 */
interface GodotServerConfig {
  godotPath?: string;
  debugMode?: boolean;
  strictPathValidation?: boolean;
}

/**
 * Main server class for Godot Agent Loop
 */
export class GodotServer {
  private server: McpServer;
  private readonly processManager = new GodotProcessManager(message => {
    this.logDebug(message);
  });
  private get activeProcess(): GodotProcess | null {
    return this.processManager.activeProcess;
  }
  private set activeProcess(process: GodotProcess | null) {
    // Preserve the existing test seam while process ownership moves to the manager.
    this.processManager.seedActiveProcess(process);
  }
  private readonly executable: GodotExecutableService;
  private get godotPath(): string | null {
    return this.executable.path;
  }
  private set godotPath(path: string | null) {
    this.executable.path = path;
  }
  private readonly gameToolHandlers: GameToolHandlers;
  private readonly projectToolHandlers: ProjectToolHandlers;
  private readonly lifecycleToolHandlers: LifecycleToolHandlers;
  private readonly projectSupport: ProjectSupport;
  private operationsScriptPath: string;
  private interactionServerInstaller: InteractionServerInstaller;
  private readonly executableValidator: GodotExecutableValidator;
  private operationRunner: HeadlessOperationRunner;
  private readonly authoringSession: AuthoringSessionManager;
  private readonly headlessOperations: HeadlessOperationService;
  private readonly gameCommands: GameCommandService;
  private readonly attachedEditorProjects = new Set<string>();
  private readonly lifecycleTrace = new LifecycleTrace({
    onEvent: (projectPath, event) => {
      if (!this.attachedEditorProjects.has(projectPath)) return;
      void this.editorSessions.send(projectPath, 'activity', event, 1_000).catch(error => {
        this.logDebug(`Editor trace forwarding failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    },
  });
  private readonly editorSessions = new EditorSessionRegistry({
    serverVersion: SERVER_VERSION,
    log: message => { this.logDebug(message); },
    onStateChange: session => {
      if (session.connected) {
        const wasAttached = this.attachedEditorProjects.has(session.project_path);
        this.attachedEditorProjects.add(session.project_path);
        if (!wasAttached) void this.replayEditorTrace(session.project_path);
      } else {
        this.attachedEditorProjects.delete(session.project_path);
      }
    },
  });
  private readonly editorSync = new EditorSyncQueue({
    send: (projectPath, params, timeoutMs) => this.editorSessions.send(projectPath, 'filesystem_changed', params, timeoutMs),
    status: projectPath => this.editorSessions.status(projectPath),
  });
  private readonly editorAuthoring = new EditorAuthoringRouter({
    status: projectPath => this.editorSessions.status(projectPath),
    send: (projectPath, command, params, timeoutMs) => this.editorSessions.send(
      projectPath, command, params, timeoutMs,
    ),
  });
  private readonly editorMutationGuard = new EditorMutationGuard(
    (projectPath, command, params, timeoutMs) => this.editorSessions.send(projectPath, command, params, timeoutMs),
  );
  private toolRegistry: ToolRegistry<ToolName> | null = null;
  private readonly editorPluginInstaller: EditorPluginInstaller;
  private readonly editorPluginInstallations = new Map<string, EditorPluginInstallation>();
  private strictPathValidation = false;
  private readonly tcpGameConnection = new GameConnection({
    port: resolveRuntimePort(),
    allowPrivilegedCommands: ALLOW_PRIVILEGED_COMMANDS,
    allowedPrivilegedGroups: ALLOWED_PRIVILEGED_GROUPS,
    authSecret: RUNTIME_SECRET,
    log: message => { this.logDebug(message); },
    onLifecycleEvent: event => { this.forwardEditorActivity(event); },
  });
  private get gameConnection(): GameConnection {
    return this.tcpGameConnection;
  }

  constructor(config?: GodotServerConfig) {
    // Apply configuration if provided
    let debugMode = DEBUG_MODE;
    this.executableValidator = new GodotExecutableValidator(message => { this.logDebug(message); });
    this.executable = new GodotExecutableService(
      this.executableValidator,
      config?.strictPathValidation ?? false,
      message => { this.logDebug(message); },
    );

    if (config) {
      if (config.debugMode !== undefined) {
        debugMode = config.debugMode;
      }
      if (config.strictPathValidation !== undefined) {
        this.strictPathValidation = config.strictPathValidation;
      }

      // Store and validate custom Godot path if provided
      if (config.godotPath) {
        const normalizedPath = normalize(config.godotPath);
        this.godotPath = normalizedPath;
        this.logDebug(`Custom Godot path provided: ${this.godotPath}`);

        // Validate immediately with sync check
        if (!this.isValidGodotPathSync(this.godotPath)) {
          console.warn(`[SERVER] Invalid custom Godot path provided: ${this.godotPath}`);
          this.godotPath = null; // Reset to trigger auto-detection later
        }
      }
    }

    // Set the path to the operations script
    this.operationsScriptPath = join(__dirname, 'scripts', 'godot_operations.gd');
    this.editorPluginInstaller = new EditorPluginInstaller(join(__dirname, 'scripts', 'mcp_editor_plugin.gd'));
    this.interactionServerInstaller = new InteractionServerInstaller({
      sourceScriptPath: join(__dirname, 'scripts', 'mcp_interaction_server.gd'),
      logDebug: message => { this.logDebug(message); },
    });
    this.operationRunner = new HeadlessOperationRunner({
      operationsScriptPath: this.operationsScriptPath,
      resolveGodotPath: async () => {
        const path = await this.executable.requirePath();
        if (!path) throw new Error('Could not find a valid Godot executable path');
        return path;
      },
      logDebug: message => { this.logDebug(message); },
      debugGodot: debugMode,
    });
    this.authoringSession = new AuthoringSessionManager({
      operationsScriptPath: this.operationsScriptPath,
      resolveGodotPath: async () => {
        const path = await this.executable.requirePath();
        if (!path) throw new Error('Could not find a valid Godot executable path');
        return path;
      },
      installer: this.interactionServerInstaller,
      logDebug: message => { this.logDebug(message); },
      // A running user game owns the installed runtime artifacts. Authoring
      // calls use their declared subprocess fallback until that process stops.
      canStart: () => this.activeProcess === null,
      onLifecycleEvent: event => { this.forwardEditorActivity(event); },
      onProjectWrite: event => {
        return this.editorSync.enqueue(event);
      },
      tryEditorOperation: (command, params, projectPath) => this.editorAuthoring.tryExecute(
        command, params, projectPath,
      ),
    });
    this.headlessOperations = new HeadlessOperationService(this.operationRunner, pathSecurity, this.authoringSession);
    this.gameCommands = new GameCommandService(this.processManager, this.gameConnection);
    if (debugMode) console.error(`[DEBUG] Operations script path: ${this.operationsScriptPath}`);
    this.projectSupport = new ProjectSupport({
      getGodotPath: () => this.godotPath,
      detectGodotPath: () => this.detectGodotPath(),
      logDebug: message => { this.logDebug(message); },
    });
    this.gameToolHandlers = new GameToolHandlers({
      commands: this.gameCommands,
    });
    this.projectToolHandlers = new ProjectToolHandlers({
      executable: this.executable,
      logDebug: message => { this.logDebug(message); },
      operations: this.headlessOperations,
      projectSupport: this.projectSupport,
      pathSecurity,
    });
    this.lifecycleToolHandlers = new LifecycleToolHandlers({
      executable: this.executable,
      getActiveProcess: () => this.activeProcess,
      isPathAllowed: projectPath => pathSecurity.isProjectPathAllowed(projectPath),
      isRelativePathAllowed: (projectPath, relativePath) => pathSecurity.isRelativePathAllowed(projectPath, relativePath),
      logDebug: message => { this.logDebug(message); },
      startProjectProcess: (executable, args, onExit, env) => {
        this.processManager.start({
          executable,
          args,
          env,
          onExit,
          onError: error => { console.error('Failed to start Godot process:', error); },
        });
      },
      stopProjectProcess: () => this.processManager.stop(),
      stopAuthoringSession: () => { this.authoringSession.stop(); },
      connectToGame: projectPath => this.connectToGame(projectPath),
      disconnectFromGame: () => { this.disconnectFromGame(); },
      injectInteractionServer: projectPath => { this.injectInteractionServer(projectPath); },
      removeInteractionServer: projectPath => { this.removeInteractionServer(projectPath); },
      getConnectedProjectPath: () => this.gameConnection.connectedProjectPath,
      clearConnectedProjectPath: () => { this.gameConnection.clearConnectedProject(); },
      getInteractionPort: () => this.gameConnection.interactionPort,
      getRuntimeEnvironment: () => ({ GODOT_MCP_RUNTIME_SECRET: RUNTIME_SECRET }),
      installEditorPlugin: projectPath => {
        const previous = this.editorPluginInstallations.get(projectPath);
        const installation = this.editorPluginInstaller.install(projectPath);
        const cleanupInstallation = previous
          && previous.pluginName === installation.pluginName
          && previous.distribution === installation.distribution
          && previous.enabledByServer
          ? {
              ...installation,
              enabledByServer: true,
              projectBefore: previous.projectBefore,
            }
          : installation;
        this.editorPluginInstallations.set(projectPath, cleanupInstallation);
        return installation;
      },
      removeEditorPlugin: (projectPath, installation) => {
        this.editorPluginInstaller.remove(projectPath, installation);
        this.editorPluginInstallations.delete(projectPath);
      },
      getEditorEnvironment: () => ({
        ...(process.env.GODOT_MCP_EDITOR_START_PAUSED
          ? { GODOT_MCP_EDITOR_START_PAUSED: process.env.GODOT_MCP_EDITOR_START_PAUSED }
          : {}),
      }),
      ensureEditorSession: (projectPath, timeoutMs) => this.editorSessions.ensure(projectPath, timeoutMs),
      getEditorSessionStatus: projectPath => this.editorSessions.status(projectPath),
      disconnectEditorSession: projectPath => this.editorSessions.disconnect(projectPath),
      sendEditorCommand: (projectPath, command, params, timeoutMs) => this.editorSessions.send(projectPath, command, params, timeoutMs),
      isGameConnected: () => this.gameConnection.isConnected,
      sendGameCommand: (command, params, timeoutMs) => this.gameCommands.send(command, params, timeoutMs),
      dispatchTool: (name, args) => {
        if (!this.toolRegistry) throw new Error('Tool registry is not initialized');
        return this.toolRegistry.dispatch(name, args);
      },
    });

    // Initialize the MCP server
    this.server = new McpServer(
      {
        name: 'godot-agent-loop',
        version: SERVER_VERSION,
      },
      {
        capabilities: {
          tools: {},
        },
        instructions: SERVER_INSTRUCTIONS,
      }
    );

    // Set up tool handlers
    this.setupToolHandlers();

    // Error handling
    this.server.server.onerror = (error) => { console.error('[MCP Error]', error); };

    // Cleanup on both interactive interruption and process-manager shutdown.
    // E2E clients and service supervisors use SIGTERM; without this handler a
    // persistent authoring child would outlive the MCP server.
    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      void this.cleanup().finally(() => { process.exit(0); });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
      process.stdin.once('end', shutdown);
    }
  }

  private forwardEditorActivity(event: import('./game-connection.js').GameLifecycleEvent): void {
    const activeProjectPath = this.gameConnection.connectedProjectPath ?? this.authoringSession.activeProjectPath;
    if (!activeProjectPath) return;
    const projectPath = this.traceProjectPath(activeProjectPath);
    this.lifecycleTrace.record(projectPath, {
      correlation_id: event.correlation_id,
      tool: event.command,
      command: event.command,
      target_backend: event.target,
      phase: event.event === 'request_started' ? 'start' : 'finish',
      outcome: event.event === 'request_started' ? 'running'
        : event.event === 'request_timed_out' ? 'timeout'
        : event.outcome === 'success' ? 'success' : 'failure',
      duration_ms: event.duration_ms ?? 0,
      source: 'automatic',
    });
  }

  private async replayEditorTrace(projectPath: string): Promise<void> {
    for (const event of this.lifecycleTrace.events(projectPath)) {
      try {
        await this.editorSessions.send(projectPath, 'activity', { ...event, replayed: true }, 1_000);
      } catch (error) {
        this.logDebug(`Editor trace replay stopped: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
  }

  private traceProjectPath(projectPath: string): string {
    try { return canonicalProjectPath(projectPath); } catch { return projectPath; }
  }

  private async synchronizePersistentToolMutation(
    toolName: ToolName,
    args: ToolArguments,
    projectPath: string,
    response: ToolResponse,
  ): Promise<ToolResponse> {
    const nestedTool = toolName === 'godot_tools' && args.action === 'call' && typeof args.toolName === 'string'
      ? args.toolName as ToolName
      : toolName;
    const nestedArgs = nestedTool === toolName
      ? args
      : args.arguments && typeof args.arguments === 'object' ? args.arguments as ToolArguments : {};
    const manifest = toolManifest[nestedTool];
    if (!manifest || manifest.domain !== 'project' || !isToolCallMutating(nestedTool, nestedArgs)
      || response.isError === true) return response;
    const existingText = response.content
      .filter(item => item.type === 'text' && typeof item.text === 'string')
      .map(item => String(item.text)).join('\n');
    if (/"backend"\s*:\s*"editor"|"sync_status"\s*:/.test(existingText)) return response;

    const sceneCandidate = firstString(nestedArgs.scenePath, nestedArgs.newPath, nestedArgs.filePath);
    const scenePath = sceneCandidate && /\.tscn$/i.test(sceneCandidate) ? toResourcePath(sceneCandidate) : undefined;
    const resourceCandidate = scenePath ? undefined : firstString(
      nestedArgs.resourcePath, nestedArgs.scriptPath, nestedArgs.shaderPath, nestedArgs.themePath,
      nestedArgs.texturePath, nestedArgs.translationPath, nestedArgs.newPath, nestedArgs.filePath,
    );
    const sync = await this.editorSync.enqueue({
      project_path: this.traceProjectPath(projectPath),
      command: nestedTool,
      ...(scenePath ? { scene_path: scenePath } : {}),
      ...(resourceCandidate ? { resource_path: toResourcePath(resourceCandidate) }
        : { resource_path: 'res://project.godot' }),
      ...(typeof nestedArgs.nodePath === 'string' ? { focus_path: normalizeFocusPath(nestedArgs.nodePath) } : {}),
    });
    const backend = manifest.backend.kind === 'authoring-session' ? 'subprocess'
      : manifest.backend.kind === 'local' ? 'file-backed'
      : manifest.backend.kind;
    const metadata = { backend, ...sync };
    const content = response.content.map(item => {
      if (item.type !== 'text' || typeof item.text !== 'string') return item;
      try {
        const parsed = JSON.parse(item.text) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return { ...item, text: JSON.stringify({ ...parsed as Record<string, unknown>, ...metadata }, null, 2) };
        }
      } catch { /* prose responses receive a separate bounded metadata block */ }
      return item;
    });
    const merged = content.some(item => item.type === 'text' && typeof item.text === 'string'
      && /"sync_status"\s*:/.test(item.text));
    if (!merged) content.push({ type: 'text', text: `Mutation metadata: ${JSON.stringify(metadata)}` });
    return { ...response, content };
  }

  /**
   * Log debug messages if debug mode is enabled
   * Using stderr instead of stdout to avoid interfering with JSON-RPC communication
   */
  private logDebug(message: string): void {
    if (DEBUG_MODE) {
      console.error(`[DEBUG] ${message}`);
    }
  }


  /**
   * Synchronous validation for constructor use
   * This is a quick check that only verifies file existence, not executable validity
   * Full validation will be performed later in detectGodotPath
   * @param path Path to check
   * @returns True if the path exists or is 'godot' (which might be in PATH)
   */
  private isValidGodotPathSync(path: string): boolean {
    return this.executable.isValidSync(path);
  }

  /**
   * Validate if a Godot path is valid and executable
   */
  private async isValidGodotPath(path: string): Promise<boolean> {
    return this.executable.isValid(path);
  }

  /**
   * Detect the Godot executable path based on the operating system
   */
  private async detectGodotPath() {
    await this.executable.detect();
  }

  /**
   * Set a custom Godot path
   * @param customPath Path to the Godot executable
   * @returns True if the path is valid and was set, false otherwise
   */
  public async setGodotPath(customPath: string): Promise<boolean> {
    if (!customPath) {
      return false;
    }

    // Normalize the path to ensure consistent format across platforms
    // (e.g., backslashes to forward slashes on Windows, resolving relative paths)
    if (await this.executable.setPath(customPath)) {
      return true;
    }

    this.logDebug(`Failed to set invalid Godot path: ${normalize(customPath)}`);
    return false;
  }

  /**
   * Inject the interaction server script into the Godot project
   */
  private injectInteractionServer(projectPath: string): void {
    this.gameConnection.recordInteractionServerInstallation(this.interactionServerInstaller.install(projectPath));
  }

  /**
   * Remove the interaction server script and autoload from the project
   */
  private removeInteractionServer(projectPath: string): void {
    const ownedByMcp = this.gameConnection.consumeInteractionServerOwnership();
    this.interactionServerInstaller.remove(projectPath, ownedByMcp);
  }

  /**
   * Connect to the game's TCP interaction server with retries
   */
  private async connectToGame(projectPath: string): Promise<void> {
    await this.gameConnection.connect(projectPath, () => this.activeProcess !== null);
  }

  /**
   * Disconnect from the game interaction server
   */
  private disconnectFromGame(): void {
    this.gameConnection.disconnect();
  }

  private rejectAllPending(response: GameResponse): void {
    this.gameConnection.rejectAllPending(response);
  }

  private resolveGameResponse(parsed: unknown): void {
    this.gameConnection.resolveResponse(parsed);
  }

  /**
   * Clean up resources when shutting down
   */
  private async cleanup() {
    this.logDebug('Cleaning up resources');
    this.authoringSession.stop();
    this.disconnectFromGame();
    this.editorSessions.disconnectAll();
    for (const [projectPath, installation] of this.editorPluginInstallations) {
      this.editorPluginInstaller.remove(projectPath, installation);
    }
    this.editorPluginInstallations.clear();
    if (this.gameConnection.connectedProjectPath) {
      this.removeInteractionServer(this.gameConnection.connectedProjectPath);
      this.gameConnection.clearConnectedProject();
    }
    if (this.activeProcess) {
      this.logDebug('Killing active Godot process');
      this.processManager.stop();
    }
    await this.server.close();
  }

  /**
   * Execute a Godot operation using the operations script
   * @param operation The operation to execute
   * @param params The parameters for the operation
   * @param projectPath The path to the Godot project
   * @returns The stdout and stderr from the operation
   */
  private async executeOperation(
    operation: string,
    params: OperationParams,
    projectPath: string
  ): Promise<{ stdout: string; stderr: string }> {
    // Parameter normalization is owned by HeadlessOperationRunner via convertCamelToSnakeCase.
    return this.headlessOperations.execute(operation, params, projectPath);
  }

  // GameToolHandlers owns game_screenshot's type: 'image' / mimeType: 'image/png' response.

  /**
   * Set up the tool handlers for the MCP server
   */
  private setupToolHandlers() {
    const tools = new ToolRegistry(createToolHandlers({
      game: this.gameToolHandlers,
      lifecycle: this.lifecycleToolHandlers,
      project: this.projectToolHandlers,
    }), (name, args) => this.editorMutationGuard.check(name, args));
    this.toolRegistry = tools;

    this.server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: advertisedToolDefinitions(),
    }));

    this.server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      this.logDebug(`Handling tool request: ${request.params.name}`);
      const argumentsValue = request.params.arguments ?? {};
      const nestedArguments = argumentsValue.arguments && typeof argumentsValue.arguments === 'object'
        ? argumentsValue.arguments as Record<string, unknown>
        : null;
      const explicitProject = typeof argumentsValue.projectPath === 'string'
        ? argumentsValue.projectPath
        : typeof nestedArguments?.projectPath === 'string' ? nestedArguments.projectPath : null;
      const projectPath = explicitProject
        ?? this.gameConnection.connectedProjectPath
        ?? this.authoringSession.activeProjectPath;
      const toolName = request.params.name as ToolName;
      const manifest = toolManifest[toolName];
      const span = projectPath
        ? this.lifecycleTrace.begin(this.traceProjectPath(projectPath), toolName, toolName, manifest.backend.kind)
        : null;
      try {
        let response = await tools.dispatch(toolName, argumentsValue);
        if (projectPath) {
          response = await this.synchronizePersistentToolMutation(
            toolName, argumentsValue, projectPath, response,
          );
        }
        if (span) {
          const firstText = response.content.find(item => item.type === 'text' && 'text' in item);
          const text = firstText && 'text' in firstText && typeof firstText.text === 'string' ? firstText.text : '';
          let outcome: LifecycleOutcome = response.isError === true ? 'failure' : 'success';
          if (/unsaved_conflict|"sync_status"\s*:\s*"conflict"/.test(text)) outcome = 'conflict';
          else if (/"sync_status"\s*:\s*"(?:detached|failed)"|"fallback_reason"\s*:\s*(?!null\b)/.test(text)) {
            outcome = 'fallback';
          }
          else if (/paused/i.test(text) && response.isError === true) outcome = 'paused';
          this.lifecycleTrace.finish(span, outcome, { is_error: response.isError === true });
        }
        return response;
      } catch (error) {
        if (span) this.lifecycleTrace.finish(span, 'failure', { error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    });
  }


  async run() {
    try {
      // Detect Godot path before starting the server
      await this.detectGodotPath();

      if (!this.godotPath) {
        console.error('[SERVER] Failed to find a valid Godot executable path');
        console.error('[SERVER] Please set GODOT_PATH environment variable or provide a valid path');
        process.exit(1);
      }

      // Check if the path is valid
      const isValid = await this.isValidGodotPath(this.godotPath);

      if (!isValid) {
        if (this.strictPathValidation) {
          // In strict mode, exit if the path is invalid
          console.error(`[SERVER] Invalid Godot path: ${this.godotPath}`);
          console.error('[SERVER] Please set a valid GODOT_PATH environment variable or provide a valid path');
          process.exit(1);
        } else {
          // In compatibility mode, warn but continue with the default path
          console.error(`[SERVER] Warning: Using potentially invalid Godot path: ${this.godotPath}`);
          console.error('[SERVER] This may cause issues when executing Godot commands');
          console.error('[SERVER] This fallback behavior will be removed in a future version. Set strictPathValidation: true to opt-in to the new behavior.');
        }
      }

      console.error(`[SERVER] Using Godot at: ${this.godotPath}`);

      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.error('Godot Agent Loop server running on stdio');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[SERVER] Failed to start:', errorMessage);
      process.exit(1);
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === 'setup' && args[1] === 'opencode') {
    await runOpenCodeSetup(args.slice(2));
    return;
  }
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Godot Agent Loop\n\nUsage:\n  godot-agent-loop\n  godot-agent-loop setup opencode [uninstall] [--scope project|user] [--config PATH] [--write]');
    return;
  }
  const server = new GodotServer();
  await server.run();
}

if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  main().catch((error: unknown) => {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Godot Agent Loop failed:', errorMessage);
    process.exit(1);
  });
}
