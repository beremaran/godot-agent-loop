#!/usr/bin/env node
/**
 * Godot MCP Server
 *
 * This MCP server provides tools for interacting with the Godot game engine.
 * It enables AI assistants to launch the Godot editor, run Godot projects,
 * capture debug output, and control project execution.
 */

import { fileURLToPath } from 'url';
import { join, dirname, normalize, resolve, relative, isAbsolute } from 'path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import type { OperationParams } from './utils.js';
import { toolDefinitions, type ToolName } from './tool-definitions.js';
import { GodotExecutableService, GodotExecutableValidator } from './godot-executable.js';
import { HeadlessOperationRunner } from './headless-operation-runner.js';
import { HeadlessOperationService } from './headless-operation-service.js';
import { GameCommandService } from './game-command-service.js';
import { InteractionServerInstaller } from './interaction-server-installer.js';
import { GameConnection } from './game-connection.js';
import { ToolRegistry, type ToolHandler } from './tool-registry.js';
import { GodotProcessManager, type GodotProcess } from './godot-process-manager.js';
import { GameToolHandlers } from './tool-handlers/game-tool-handlers.js';
import { ProjectToolHandlers } from './tool-handlers/project-tool-handlers.js';
import { LifecycleToolHandlers } from './tool-handlers/lifecycle-tool-handlers.js';
import { ProjectSupport } from './project-support.js';

// Check if debug mode is enabled
const DEBUG_MODE: boolean = process.env.DEBUG === 'true';

const ALLOWED_PROJECT_ROOTS: string[] = (process.env.GODOT_MCP_ALLOWED_DIRS || '')
  .split(process.platform === 'win32' ? /[;,]/ : /[:,]/)
  .map(p => p.trim())
  .filter(p => p.length > 0)
  .map(p => resolve(p));

function isPathWithinAllowedRoots(target: string): boolean {
  if (ALLOWED_PROJECT_ROOTS.length === 0) return true;
  const resolvedTarget = resolve(target);
  return ALLOWED_PROJECT_ROOTS.some(root => {
    const rel = relative(root, resolvedTarget);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
}

// Derive __filename and __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
 * Main server class for the Godot MCP server
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
  private readonly headlessOperations: HeadlessOperationService;
  private readonly gameCommands: GameCommandService;
  private strictPathValidation = false;
  private readonly tcpGameConnection = new GameConnection({
    port: 9090,
    log: message => { this.logDebug(message); },
  });
  private get gameConnection(): GameConnection {
    return this.tcpGameConnection;
  }
  private set gameConnection(state: Partial<GameConnection>) {
    // Compatibility for callers/tests that seed connection state directly.
    Object.assign(this.tcpGameConnection, state);
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
    });
    this.headlessOperations = new HeadlessOperationService(this.operationRunner);
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
    });
    this.lifecycleToolHandlers = new LifecycleToolHandlers({
      executable: this.executable,
      getActiveProcess: () => this.activeProcess,
      isPathAllowed: projectPath => isPathWithinAllowedRoots(projectPath),
      logDebug: message => { this.logDebug(message); },
      startProjectProcess: (executable, args, onExit) => {
        this.processManager.start({
          executable,
          args,
          onExit,
          onError: error => { console.error('Failed to start Godot process:', error); },
        });
      },
      stopProjectProcess: () => this.processManager.stop(),
      connectToGame: projectPath => this.connectToGame(projectPath),
      disconnectFromGame: () => { this.disconnectFromGame(); },
      injectInteractionServer: projectPath => { this.injectInteractionServer(projectPath); },
      removeInteractionServer: projectPath => { this.removeInteractionServer(projectPath); },
      getConnectedProjectPath: () => this.gameConnection.projectPath,
      clearConnectedProjectPath: () => { this.gameConnection.projectPath = null; },
      getInteractionPort: () => this.gameConnection.interactionPort,
    });

    // Initialize the MCP server
    this.server = new McpServer(
      {
        name: 'godot-mcp',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Set up tool handlers
    this.setupToolHandlers();

    // Error handling
    this.server.server.onerror = (error) => { console.error('[MCP Error]', error); };

    // Cleanup on exit
    process.on('SIGINT', () => {
      void this.cleanup().then(() => {
        process.exit(0);
      });
    });
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
    this.gameConnection.interactionServerInjectedByUs = this.interactionServerInstaller.install(projectPath);
  }

  /**
   * Remove the interaction server script and autoload from the project
   */
  private removeInteractionServer(projectPath: string): void {
    const ownedByMcp = this.gameConnection.interactionServerInjectedByUs;
    this.gameConnection.interactionServerInjectedByUs = false;
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

  private rejectAllPending(response: any): void {
    this.gameConnection.rejectAllPending(response);
  }

  private resolveGameResponse(parsed: any): void {
    this.gameConnection.resolveResponse(parsed);
  }

  /**
   * Clean up resources when shutting down
   */
  private async cleanup() {
    this.logDebug('Cleaning up resources');
    this.disconnectFromGame();
    if (this.gameConnection.projectPath) {
      this.removeInteractionServer(this.gameConnection.projectPath);
      this.gameConnection.projectPath = null;
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
    const tools = new ToolRegistry(this.createToolHandlers());

    this.server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: toolDefinitions,
    }));

    this.server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      this.logDebug(`Handling tool request: ${request.params.name}`);
      return tools.dispatch(request.params.name, request.params.arguments);
    });
  }

  private createToolHandlers(): Record<ToolName, ToolHandler> {
    return {
      'launch_editor': args => this.lifecycleToolHandlers.handleLaunchEditor(args),
      'run_project': args => this.lifecycleToolHandlers.handleRunProject(args),
      'get_debug_output': () => this.lifecycleToolHandlers.handleGetDebugOutput(),
      'stop_project': () => this.lifecycleToolHandlers.handleStopProject(),
      'get_godot_version': () => this.lifecycleToolHandlers.handleGetGodotVersion(),
      'list_projects': args => this.projectToolHandlers.handleListProjects(args),
      'get_project_info': args => this.projectToolHandlers.handleGetProjectInfo(args),
      'create_scene': args => this.projectToolHandlers.handleCreateScene(args),
      'add_node': args => this.projectToolHandlers.handleAddNode(args),
      'load_sprite': args => this.projectToolHandlers.handleLoadSprite(args),
      'export_mesh_library': args => this.projectToolHandlers.handleExportMeshLibrary(args),
      'save_scene': args => this.projectToolHandlers.handleSaveScene(args),
      'get_uid': args => this.projectToolHandlers.handleGetUid(args),
      'update_project_uids': args => this.projectToolHandlers.handleUpdateProjectUids(args),
      'game_screenshot': () => this.gameToolHandlers.handleGameScreenshot(),
      'game_click': args => this.gameToolHandlers.handleGameClick(args),
      'game_key_press': args => this.gameToolHandlers.handleGameKeyPress(args),
      'game_mouse_move': args => this.gameToolHandlers.handleGameMouseMove(args),
      'game_get_ui': () => this.gameToolHandlers.handleGameGetUi(),
      'game_get_scene_tree': () => this.gameToolHandlers.handleGameGetSceneTree(),
      'game_eval': args => this.gameToolHandlers.handleGameEval(args),
      'game_get_property': args => this.gameToolHandlers.handleGameGetProperty(args),
      'game_set_property': args => this.gameToolHandlers.handleGameSetProperty(args),
      'game_call_method': args => this.gameToolHandlers.handleGameCallMethod(args),
      'game_get_node_info': args => this.gameToolHandlers.handleGameGetNodeInfo(args),
      'game_instantiate_scene': args => this.gameToolHandlers.handleGameInstantiateScene(args),
      'game_remove_node': args => this.gameToolHandlers.handleGameRemoveNode(args),
      'game_change_scene': args => this.gameToolHandlers.handleGameChangeScene(args),
      'game_pause': args => this.gameToolHandlers.handleGamePause(args),
      'game_performance': () => this.gameToolHandlers.handleGamePerformance(),
      'game_wait': args => this.gameToolHandlers.handleGameWait(args),
      'read_scene': args => this.projectToolHandlers.handleReadScene(args),
      'modify_scene_node': args => this.projectToolHandlers.handleModifySceneNode(args),
      'remove_scene_node': args => this.projectToolHandlers.handleRemoveSceneNode(args),
      'read_project_settings': args => this.projectToolHandlers.handleReadProjectSettings(args),
      'modify_project_settings': args => this.projectToolHandlers.handleModifyProjectSettings(args),
      'list_project_files': args => this.projectToolHandlers.handleListProjectFiles(args),
      'game_connect_signal': args => this.gameToolHandlers.handleGameConnectSignal(args),
      'game_disconnect_signal': args => this.gameToolHandlers.handleGameDisconnectSignal(args),
      'game_emit_signal': args => this.gameToolHandlers.handleGameEmitSignal(args),
      'game_play_animation': args => this.gameToolHandlers.handleGamePlayAnimation(args),
      'game_tween_property': args => this.gameToolHandlers.handleGameTweenProperty(args),
      'game_get_nodes_in_group': args => this.gameToolHandlers.handleGameGetNodesInGroup(args),
      'game_find_nodes_by_class': args => this.gameToolHandlers.handleGameFindNodesByClass(args),
      'game_reparent_node': args => this.gameToolHandlers.handleGameReparentNode(args),
      'attach_script': args => this.projectToolHandlers.handleAttachScript(args),
      'create_resource': args => this.projectToolHandlers.handleCreateResource(args),
      'read_file': args => this.projectToolHandlers.handleReadFile(args),
      'write_file': args => this.projectToolHandlers.handleWriteFile(args),
      'delete_file': args => this.projectToolHandlers.handleDeleteFile(args),
      'create_directory': args => this.projectToolHandlers.handleCreateDirectory(args),
      'game_get_errors': () => this.gameToolHandlers.handleGameGetErrors(),
      'game_get_logs': () => this.gameToolHandlers.handleGameGetLogs(),
      'game_key_hold': args => this.gameToolHandlers.handleGameKeyHold(args),
      'game_key_release': args => this.gameToolHandlers.handleGameKeyRelease(args),
      'game_scroll': args => this.gameToolHandlers.handleGameScroll(args),
      'game_mouse_drag': args => this.gameToolHandlers.handleGameMouseDrag(args),
      'game_gamepad': args => this.gameToolHandlers.handleGameGamepad(args),
      'create_project': args => this.projectToolHandlers.handleCreateProject(args),
      'create_csharp_script': args => this.projectToolHandlers.handleCreateCsharpScript(args),
      'manage_autoloads': args => this.projectToolHandlers.handleManageAutoloads(args),
      'manage_input_map': args => this.projectToolHandlers.handleManageInputMap(args),
      'manage_export_presets': args => this.projectToolHandlers.handleManageExportPresets(args),
      'game_get_camera': () => this.gameToolHandlers.handleGameGetCamera(),
      'game_set_camera': args => this.gameToolHandlers.handleGameSetCamera(args),
      'game_raycast': args => this.gameToolHandlers.handleGameRaycast(args),
      'game_get_audio': () => this.gameToolHandlers.handleGameGetAudio(),
      'game_spawn_node': args => this.gameToolHandlers.handleGameSpawnNode(args),
      'game_set_shader_param': args => this.gameToolHandlers.handleGameSetShaderParam(args),
      'game_audio_play': args => this.gameToolHandlers.handleGameAudioPlay(args),
      'game_audio_bus': args => this.gameToolHandlers.handleGameAudioBus(args),
      'game_navigate_path': args => this.gameToolHandlers.handleGameNavigatePath(args),
      'game_tilemap': args => this.gameToolHandlers.handleGameTilemap(args),
      'game_add_collision': args => this.gameToolHandlers.handleGameAddCollision(args),
      'game_environment': args => this.gameToolHandlers.handleGameEnvironment(args),
      'game_manage_group': args => this.gameToolHandlers.handleGameManageGroup(args),
      'game_create_timer': args => this.gameToolHandlers.handleGameCreateTimer(args),
      'game_set_particles': args => this.gameToolHandlers.handleGameSetParticles(args),
      'game_create_animation': args => this.gameToolHandlers.handleGameCreateAnimation(args),
      'export_project': args => this.projectToolHandlers.handleExportProject(args),
      'game_serialize_state': args => this.gameToolHandlers.handleGameSerializeState(args),
      'game_physics_body': args => this.gameToolHandlers.handleGamePhysicsBody(args),
      'game_create_joint': args => this.gameToolHandlers.handleGameCreateJoint(args),
      'game_bone_pose': args => this.gameToolHandlers.handleGameBonePose(args),
      'game_ui_theme': args => this.gameToolHandlers.handleGameUiTheme(args),
      'game_viewport': args => this.gameToolHandlers.handleGameViewport(args),
      'game_debug_draw': args => this.gameToolHandlers.handleGameDebugDraw(args),
      'game_http_request': args => this.gameToolHandlers.handleGameHttpRequest(args),
      'game_websocket': args => this.gameToolHandlers.handleGameWebsocket(args),
      'game_multiplayer': args => this.gameToolHandlers.handleGameMultiplayer(args),
      'game_rpc': args => this.gameToolHandlers.handleGameRpc(args),
      'game_touch': args => this.gameToolHandlers.handleGameTouch(args),
      'game_input_state': args => this.gameToolHandlers.handleGameInputState(args),
      'game_input_action': args => this.gameToolHandlers.handleGameInputAction(args),
      'game_list_signals': args => this.gameToolHandlers.handleGameListSignals(args),
      'game_await_signal': args => this.gameToolHandlers.handleGameAwaitSignal(args),
      'game_script': args => this.gameToolHandlers.handleGameScript(args),
      'game_window': args => this.gameToolHandlers.handleGameWindow(args),
      'game_os_info': args => this.gameToolHandlers.handleGameOsInfo(args),
      'game_time_scale': args => this.gameToolHandlers.handleGameTimeScale(args),
      'game_process_mode': args => this.gameToolHandlers.handleGameProcessMode(args),
      'game_world_settings': args => this.gameToolHandlers.handleGameWorldSettings(args),
      'game_csg': args => this.gameToolHandlers.handleGameCsg(args),
      'game_multimesh': args => this.gameToolHandlers.handleGameMultimesh(args),
      'game_procedural_mesh': args => this.gameToolHandlers.handleGameProceduralMesh(args),
      'game_light_3d': args => this.gameToolHandlers.handleGameLight3d(args),
      'game_mesh_instance': args => this.gameToolHandlers.handleGameMeshInstance(args),
      'game_gridmap': args => this.gameToolHandlers.handleGameGridmap(args),
      'game_3d_effects': args => this.gameToolHandlers.handleGame3dEffects(args),
      'game_gi': args => this.gameToolHandlers.handleGameGi(args),
      'game_path_3d': args => this.gameToolHandlers.handleGamePath3d(args),
      'game_sky': args => this.gameToolHandlers.handleGameSky(args),
      'game_camera_attributes': args => this.gameToolHandlers.handleGameCameraAttributes(args),
      'game_navigation_3d': args => this.gameToolHandlers.handleGameNavigation3d(args),
      'game_physics_3d': args => this.gameToolHandlers.handleGamePhysics3d(args),
      'game_canvas': args => this.gameToolHandlers.handleGameCanvas(args),
      'game_canvas_draw': args => this.gameToolHandlers.handleGameCanvasDraw(args),
      'game_light_2d': args => this.gameToolHandlers.handleGameLight2d(args),
      'game_parallax': args => this.gameToolHandlers.handleGameParallax(args),
      'game_shape_2d': args => this.gameToolHandlers.handleGameShape2d(args),
      'game_path_2d': args => this.gameToolHandlers.handleGamePath2d(args),
      'game_physics_2d': args => this.gameToolHandlers.handleGamePhysics2d(args),
      'game_animation_tree': args => this.gameToolHandlers.handleGameAnimationTree(args),
      'game_animation_control': args => this.gameToolHandlers.handleGameAnimationControl(args),
      'game_skeleton_ik': args => this.gameToolHandlers.handleGameSkeletonIk(args),
      'game_audio_effect': args => this.gameToolHandlers.handleGameAudioEffect(args),
      'game_audio_bus_layout': args => this.gameToolHandlers.handleGameAudioBusLayout(args),
      'game_audio_spatial': args => this.gameToolHandlers.handleGameAudioSpatial(args),
      'rename_file': args => this.projectToolHandlers.handleRenameFile(args),
      'manage_resource': args => this.projectToolHandlers.handleManageResource(args),
      'validate_script': args => this.projectToolHandlers.handleValidateScript(args),
      'validate_scripts': args => this.projectToolHandlers.handleValidateScripts(args),
      'create_script': args => this.projectToolHandlers.handleCreateScript(args),
      'manage_scene_signals': args => this.projectToolHandlers.handleManageSceneSignals(args),
      'manage_layers': args => this.projectToolHandlers.handleManageLayers(args),
      'manage_plugins': args => this.projectToolHandlers.handleManagePlugins(args),
      'manage_shader': args => this.projectToolHandlers.handleManageShader(args),
      'manage_theme_resource': args => this.projectToolHandlers.handleManageThemeResource(args),
      'set_main_scene': args => this.projectToolHandlers.handleSetMainScene(args),
      'manage_scene_structure': args => this.projectToolHandlers.handleManageSceneStructure(args),
      'manage_translations': args => this.projectToolHandlers.handleManageTranslations(args),
      'game_locale': args => this.gameToolHandlers.handleGameLocale(args),
      'game_ui_control': args => this.gameToolHandlers.handleGameUiControl(args),
      'game_ui_text': args => this.gameToolHandlers.handleGameUiText(args),
      'game_ui_popup': args => this.gameToolHandlers.handleGameUiPopup(args),
      'game_ui_tree': args => this.gameToolHandlers.handleGameUiTree(args),
      'game_ui_item_list': args => this.gameToolHandlers.handleGameUiItemList(args),
      'game_ui_tabs': args => this.gameToolHandlers.handleGameUiTabs(args),
      'game_ui_menu': args => this.gameToolHandlers.handleGameUiMenu(args),
      'game_ui_range': args => this.gameToolHandlers.handleGameUiRange(args),
      'game_render_settings': args => this.gameToolHandlers.handleGameRenderSettings(args),
      'game_resource': args => this.gameToolHandlers.handleGameResource(args),
      'game_visual_shader': args => this.gameToolHandlers.handleGameVisualShader(args),
      'game_terrain': args => this.gameToolHandlers.handleGameTerrain(args),
      'game_video': args => this.gameToolHandlers.handleGameVideo(args),
      'manage_ci_pipeline': args => this.projectToolHandlers.handleManageCiPipeline(args),
      'manage_docker_export': args => this.projectToolHandlers.handleManageDockerExport(args),
    };
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
      console.error('Godot MCP server running on stdio');
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[SERVER] Failed to start:', errorMessage);
      process.exit(1);
    }
  }
}

// Create and run the server
if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  const server = new GodotServer();
  server.run().catch((error: unknown) => {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Failed to run server:', errorMessage);
    process.exit(1);
  });
}
