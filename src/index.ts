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

import { PathSecurity, type OperationParams } from './utils.js';
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
import { EditorConnection } from './editor-connection.js';
import { EditorPluginInstaller } from './editor-plugin-installer.js';
import { PRIVILEGED_RUNTIME_GROUPS, type PrivilegedRuntimeGroup } from './runtime-protocol.js';
import { AuthoringSessionManager } from './authoring-session-manager.js';
import { EditorMutationGuard } from './editor-mutation-guard.js';
import { SERVER_INSTRUCTIONS } from './server-instructions.js';
import { advertisedToolDefinitions } from './tool-surface.js';
import { runOpenCodeSetup } from './opencode-setup.js';

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

function resolveEditorPort(): number {
  const configured = process.env.GODOT_MCP_EDITOR_PORT;
  if (!configured) return 9091;
  const parsed = Number(configured);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : 9091;
}

const pathSecurity = new PathSecurity();

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
  private readonly editorConnection = new EditorConnection({ port: resolveEditorPort(), secret: RUNTIME_SECRET });
  private readonly editorMutationGuard = new EditorMutationGuard(
    (command, params, timeoutMs) => this.editorConnection.send(command, params, timeoutMs),
  );
  private toolRegistry: ToolRegistry<ToolName> | null = null;
  private readonly editorPluginInstaller: EditorPluginInstaller;
  private editorProjectPath: string | null = null;
  private editorPluginOwned = false;
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
        void this.editorConnection.send('filesystem_changed', { ...event }, 2_000).catch(() => undefined);
      },
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
        this.editorPluginOwned = this.editorPluginInstaller.install(projectPath);
        this.editorProjectPath = projectPath;
        return this.editorPluginOwned;
      },
      removeEditorPlugin: (projectPath, owned) => { this.editorPluginInstaller.remove(projectPath, owned); },
      getEditorEnvironment: () => ({ GODOT_MCP_EDITOR_PORT: String(resolveEditorPort()), GODOT_MCP_EDITOR_SECRET: RUNTIME_SECRET }),
      sendEditorCommand: (command, params, timeoutMs) => this.editorConnection.send(command, params, timeoutMs),
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
  }

  private forwardEditorActivity(event: import('./game-connection.js').GameLifecycleEvent): void {
    void this.editorConnection.send('activity', { ...event }, 1_000).catch(() => undefined);
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
    this.editorConnection.disconnect();
    if (this.editorProjectPath) this.editorPluginInstaller.remove(this.editorProjectPath, this.editorPluginOwned);
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
      return tools.dispatch(request.params.name, request.params.arguments);
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
