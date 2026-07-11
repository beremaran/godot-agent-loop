#!/usr/bin/env node
/**
 * Godot MCP Server
 *
 * This MCP server provides tools for interacting with the Godot game engine.
 * It enables AI assistants to launch the Godot editor, run Godot projects,
 * capture debug output, and control project execution.
 */

import { fileURLToPath } from 'url';
import { join, dirname, basename, normalize, resolve, relative, isAbsolute } from 'path';
import { existsSync, readdirSync } from 'fs';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import {
  normalizeParameters,
  convertCamelToSnakeCase,
  validatePath,
  createErrorResponse,
  parseGodotScriptDiagnostics,
  collectGdPaths,
  type OperationParams,
} from './utils.js';
import { toolDefinitions, type ToolName } from './tool-definitions.js';
import { GodotExecutableValidator, detectGodotExecutablePath } from './godot-executable.js';
import { HeadlessOperationRunner } from './headless-operation-runner.js';
import { InteractionServerInstaller } from './interaction-server-installer.js';
import { GameConnection } from './game-connection.js';
import { ToolRegistry, type ToolHandler } from './tool-registry.js';
import { GodotProcessManager, type GodotProcess } from './godot-process-manager.js';
import { GameToolHandlers } from './tool-handlers/game-tool-handlers.js';
import { ProjectToolHandlers } from './tool-handlers/project-tool-handlers.js';

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

const execFileAsync = promisify(execFile);

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
  private godotPath: string | null = null;
  private readonly gameToolHandlers: GameToolHandlers;
  private readonly projectToolHandlers: ProjectToolHandlers;
  private operationsScriptPath: string;
  private interactionServerInstaller: InteractionServerInstaller;
  private executableValidator: GodotExecutableValidator;
  private operationRunner: HeadlessOperationRunner;
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
        if (!this.godotPath) await this.detectGodotPath();
        if (!this.godotPath) throw new Error('Could not find a valid Godot executable path');
        return this.godotPath;
      },
      logDebug: message => { this.logDebug(message); },
    });
    if (debugMode) console.error(`[DEBUG] Operations script path: ${this.operationsScriptPath}`);
    this.gameToolHandlers = new GameToolHandlers({
      getActiveProcess: () => this.activeProcess,
      isGameConnected: () => this.gameConnection.connected,
      sendGameCommand: (command, params, timeoutMs) => this.sendGameCommand(command, params, timeoutMs),
      gameCommand: (name, args, argsFn, timeoutMs) => this.gameCommand(name, args, argsFn, timeoutMs),
      readNewErrors: () => this.processManager.readNewErrors(),
      readNewLogs: () => this.processManager.readNewLogs(),
    });
    this.projectToolHandlers = new ProjectToolHandlers({
      getGodotPath: () => this.godotPath,
      detectGodotPath: () => this.detectGodotPath(),
      logDebug: message => { this.logDebug(message); },
      executeOperation: (operation, params, projectPath) => this.executeOperation(operation, params, projectPath),
      headlessOp: (operation, args, argsFn) => this.headlessOp(operation, args, argsFn),
      getProjectStructureAsync: projectPath => this.getProjectStructureAsync(projectPath),
      isDotnetProject: projectPath => this.isDotnetProject(projectPath),
      detectGodotNetSdkVersion: () => this.detectGodotNetSdkVersion(),
      keyNameToScancode: key => this.keyNameToScancode(key),
      runGdScriptCheck: (projectPath, scriptPath) => this.runGdScriptCheck(projectPath, scriptPath),
      listChangedGdFiles: projectPath => this.listChangedGdFiles(projectPath),
      listAllGdFiles: projectPath => this.listAllGdFiles(projectPath),
      findGodotProjects: (directory, recursive) => this.findGodotProjects(directory, recursive),
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
    return this.executableValidator.isValidSync(path);
  }

  /**
   * Validate if a Godot path is valid and executable
   */
  private async isValidGodotPath(path: string): Promise<boolean> {
    return this.executableValidator.isValid(path);
  }

  /**
   * Detect the Godot executable path based on the operating system
   */
  private async detectGodotPath() {
    this.godotPath = await detectGodotExecutablePath({
      currentPath: this.godotPath,
      strictPathValidation: this.strictPathValidation,
      isValid: path => this.isValidGodotPath(path),
      logDebug: message => { this.logDebug(message); },
    });
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
    const normalizedPath = normalize(customPath);
    if (await this.isValidGodotPath(normalizedPath)) {
      this.godotPath = normalizedPath;
      this.logDebug(`Godot path set to: ${normalizedPath}`);
      return true;
    }

    this.logDebug(`Failed to set invalid Godot path: ${normalizedPath}`);
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
   * Send a command to the running game and wait for a response
   */
  private async sendGameCommand(command: string, params: Record<string, any> = {}, timeoutMs = 10000): Promise<any> {
    return this.gameConnection.send(command, params, timeoutMs);
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

  private async gameCommand(
    name: string,
    args: any,
    argsFn: (a: any) => Record<string, any>,
    timeoutMs?: number
  ): Promise<any> {
    if (!this.activeProcess) return createErrorResponse('No active Godot process. Use run_project first.');
    if (!this.gameConnection.connected) return createErrorResponse('Not connected to game interaction server.');
    args = normalizeParameters(args || {});
    try {
      const response = await this.sendGameCommand(name, convertCamelToSnakeCase(argsFn(args)), timeoutMs);
      if (response.error) return createErrorResponse(`${name} failed: ${response.error}`);
      return { content: [{ type: 'text', text: JSON.stringify(response, null, 2) }] };
    } catch (error: any) {
      return createErrorResponse(`${name} failed: ${error?.message || 'Unknown error'}`);
    }
  }

  private async headlessOp(
    operation: string,
    args: any,
    argsFn: (a: any) => { projectPath: string; params: OperationParams }
  ): Promise<any> {
    args = normalizeParameters(args || {});
    const { projectPath, params } = argsFn(args);

    if (!projectPath) return createErrorResponse('projectPath is required.');
    if (!validatePath(projectPath)) return createErrorResponse('Invalid path.');

    const projectFile = join(projectPath, 'project.godot');
    if (!existsSync(projectFile)) return createErrorResponse(`Not a valid Godot project: ${projectPath}`);

    try {
      const { stdout, stderr } = await this.executeOperation(operation, params, projectPath);
      if (stderr && stderr.includes('Failed to')) return createErrorResponse(`${operation} failed: ${stderr}`);
      return { content: [{ type: 'text', text: `${operation} succeeded.\n\nOutput: ${stdout}` }] };
    } catch (error: any) {
      return createErrorResponse(`${operation} failed: ${error?.message || 'Unknown error'}`);
    }
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
    return this.operationRunner.execute(operation, params, projectPath);
  }

  /**
   * Find Godot projects in a directory
   * @param directory Directory to search
   * @param recursive Whether to search recursively
   * @returns Array of Godot projects
   */
  private findGodotProjects(directory: string, recursive: boolean): { path: string; name: string }[] {
    const projects: { path: string; name: string }[] = [];

    try {
      // Check if the directory itself is a Godot project
      const projectFile = join(directory, 'project.godot');
      if (existsSync(projectFile)) {
        projects.push({
          path: directory,
          name: basename(directory),
        });
      }

      // If not recursive, only check immediate subdirectories
      if (!recursive) {
        const entries = readdirSync(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const subdir = join(directory, entry.name);
            const projectFile = join(subdir, 'project.godot');
            if (existsSync(projectFile)) {
              projects.push({
                path: subdir,
                name: entry.name,
              });
            }
          }
        }
      } else {
        // Recursive search
        const entries = readdirSync(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const subdir = join(directory, entry.name);
            // Skip hidden directories
            if (entry.name.startsWith('.')) {
              continue;
            }
            // Check if this directory is a Godot project
            const projectFile = join(subdir, 'project.godot');
            if (existsSync(projectFile)) {
              projects.push({
                path: subdir,
                name: entry.name,
              });
            } else {
              // Recursively search this directory
              const subProjects = this.findGodotProjects(subdir, true);
              projects.push(...subProjects);
            }
          }
        }
      }
    } catch (error) {
      this.logDebug(`Error searching directory ${directory}: ${error}`);
    }

    return projects;
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
      'launch_editor': args => this.handleLaunchEditor(args),
      'run_project': args => this.handleRunProject(args),
      'get_debug_output': () => this.handleGetDebugOutput(),
      'stop_project': () => this.handleStopProject(),
      'get_godot_version': () => this.handleGetGodotVersion(),
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



  /**
   * Handle the launch_editor tool
   * @param args Tool arguments
   */
  private async handleLaunchEditor(args: any) {
    // Normalize parameters to camelCase
    args = normalizeParameters(args);
    
    if (!args.projectPath) {
      return createErrorResponse(
        'Project path is required'
      );
    }

    if (!validatePath(args.projectPath)) {
      return createErrorResponse(
        'Invalid project path'
      );
    }

    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return createErrorResponse(
            'Could not find a valid Godot executable path'
          );
        }
      }

      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`
        );
      }

      this.logDebug(`Launching Godot editor for project: ${args.projectPath}`);
      const process = spawn(this.godotPath, ['-e', '--path', args.projectPath], {
        stdio: 'pipe',
      });

      process.on('error', (err: Error) => {
        console.error('Failed to start Godot editor:', err);
      });

      return {
        content: [
          {
            type: 'text',
            text: `Godot editor launched successfully for project at ${args.projectPath}.`,
          },
        ],
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return createErrorResponse(
        `Failed to launch Godot editor: ${errorMessage}`
      );
    }
  }

  /**
   * Handle the run_project tool
   * @param args Tool arguments
   */
  private async handleRunProject(args: any) {
    // Normalize parameters to camelCase
    args = normalizeParameters(args);
    
    if (!args.projectPath) {
      return createErrorResponse(
        'Project path is required'
      );
    }

    if (!validatePath(args.projectPath)) {
      return createErrorResponse(
        'Invalid project path'
      );
    }

    if (!isPathWithinAllowedRoots(args.projectPath)) {
      return createErrorResponse(
        `Project path is outside the allowed roots (GODOT_MCP_ALLOWED_DIRS): ${args.projectPath}`
      );
    }

    try {
      // Check if the project directory exists and contains a project.godot file
      const projectFile = join(args.projectPath, 'project.godot');
      if (!existsSync(projectFile)) {
        return createErrorResponse(
          `Not a valid Godot project: ${args.projectPath}`
        );
      }

      // Kill any existing process
      if (this.activeProcess) {
        this.logDebug('Killing existing Godot process before starting a new one');
        this.disconnectFromGame();
        if (this.gameConnection.projectPath) {
          this.removeInteractionServer(this.gameConnection.projectPath);
        }
        this.processManager.stop();
      }

      // Inject interaction server before launching
      this.injectInteractionServer(args.projectPath);

      const cmdArgs = ['-d', '--path', args.projectPath];
      if (args.scene && validatePath(args.scene)) {
        this.logDebug(`Adding scene parameter: ${args.scene}`);
        cmdArgs.push(args.scene);
      }

      this.logDebug(`Running Godot project: ${args.projectPath}`);
      this.processManager.start({
        executable: this.godotPath!,
        args: cmdArgs,
        onExit: () => {
          this.disconnectFromGame();
          if (this.gameConnection.projectPath) {
            this.removeInteractionServer(this.gameConnection.projectPath);
            this.gameConnection.projectPath = null;
          }
        },
        onError: err => {
          console.error('Failed to start Godot process:', err);
        },
      });

      // Start async TCP connection to the interaction server (fire-and-forget)
      this.connectToGame(args.projectPath).catch(err => {
        this.logDebug(`Failed to connect to game interaction server: ${err}`);
      });

      return {
        content: [
          {
            type: 'text',
            text: `Godot project started in debug mode. Use get_debug_output to see output. Game interaction server connecting on port ${this.gameConnection.interactionPort}...`,
          },
        ],
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return createErrorResponse(
        `Failed to run Godot project: ${errorMessage}`
      );
    }
  }

  /**
   * Handle the get_debug_output tool
   */
  private async handleGetDebugOutput() {
    if (!this.activeProcess) {
      return createErrorResponse(
        'No active Godot process.'
      );
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              output: this.activeProcess.output,
              errors: this.activeProcess.errors,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  /**
   * Handle the stop_project tool
   */
  private async handleStopProject() {
    if (!this.activeProcess) {
      return createErrorResponse(
        'No active Godot process to stop.'
      );
    }

    this.logDebug('Stopping active Godot process');
    this.disconnectFromGame();
    const stoppedProcess = this.processManager.stop()!;
    const output = stoppedProcess.output;
    const errors = stoppedProcess.errors;

    // Remove injected interaction server
    if (this.gameConnection.projectPath) {
      this.removeInteractionServer(this.gameConnection.projectPath);
      this.gameConnection.projectPath = null;
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              message: 'Godot project stopped',
              finalOutput: output,
              finalErrors: errors,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  /**
   * Handle the get_godot_version tool
   */
  private async handleGetGodotVersion() {
    try {
      // Ensure godotPath is set
      if (!this.godotPath) {
        await this.detectGodotPath();
        if (!this.godotPath) {
          return createErrorResponse(
            'Could not find a valid Godot executable path'
          );
        }
      }

      this.logDebug('Getting Godot version');
      const { stdout } = await execFileAsync(this.godotPath, ['--version']);
      return {
        content: [
          {
            type: 'text',
            text: stdout.trim(),
          },
        ],
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return createErrorResponse(
        `Failed to get Godot version: ${errorMessage}`
      );
    }
  }

  /**
   * Handle the list_projects tool
   */

  private getProjectStructureAsync(projectPath: string): Promise<any> {
    return new Promise((resolve) => {
      try {
        const structure = {
          scenes: 0,
          scripts: 0,
          assets: 0,
          other: 0,
        };

        const scanDirectory = (currentPath: string) => {
          const entries = readdirSync(currentPath, { withFileTypes: true });
          
          for (const entry of entries) {
            const entryPath = join(currentPath, entry.name);
            
            // Skip hidden files and directories
            if (entry.name.startsWith('.')) {
              continue;
            }
            
            if (entry.isDirectory()) {
              // Recursively scan subdirectories
              scanDirectory(entryPath);
            } else if (entry.isFile()) {
              // Count file by extension
              const ext = entry.name.split('.').pop()?.toLowerCase();
              
              if (ext === 'tscn') {
                structure.scenes++;
              } else if (ext === 'gd' || ext === 'gdscript' || ext === 'cs') {
                structure.scripts++;
              } else if (['png', 'jpg', 'jpeg', 'webp', 'svg', 'ttf', 'wav', 'mp3', 'ogg'].includes(ext || '')) {
                structure.assets++;
              } else {
                structure.other++;
              }
            }
          }
        };
        
        // Start scanning from the project root
        scanDirectory(projectPath);
        resolve(structure);
      } catch (error) {
        this.logDebug(`Error getting project structure asynchronously: ${error}`);
        resolve({ 
          error: 'Failed to get project structure',
          scenes: 0,
          scripts: 0,
          assets: 0,
          other: 0
        });
      }
    });
  }

  /**
   * Handle the get_project_info tool
   */




















  private isDotnetProject(projectPath: string): boolean {
    try {
      return readdirSync(projectPath).some(entry => entry.toLowerCase().endsWith('.csproj'));
    } catch {
      return false;
    }
  }

  private async detectGodotNetSdkVersion(): Promise<string | null> {
    try {
      if (!this.godotPath) await this.detectGodotPath();
      if (!this.godotPath) return null;
      const { stdout } = await execFileAsync(this.godotPath, ['--version'], { timeout: 10000 });
      const match = /^(\d+)\.(\d+)(?:\.\d+)?\.stable\b/.exec(stdout.trim());
      if (!match) return null;
      return `${match[1]}.${match[2]}.0`;
    } catch {
      return null;
    }
  }




  private keyNameToScancode(key: string): number {
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





  private async runGdScriptCheck(
    projectPath: string,
    scriptFull: string
  ): Promise<{ completed: boolean; errors: ReturnType<typeof parseGodotScriptDiagnostics>; error?: string }> {
    let output: string;
    let failed = false;
    try {
      const { stdout, stderr } = await execFileAsync(
        this.godotPath!,
        ['--headless', '--path', projectPath, '--check-only', '--script', scriptFull],
        { timeout: 30000, maxBuffer: 16 * 1024 * 1024 }
      );
      output = `${stdout ?? ''}${stderr ?? ''}`;
    } catch (error: any) {
      failed = true;
      output = `${error?.stdout ?? ''}${error?.stderr ?? ''}`;
      const aborted = error?.killed === true || error?.signal != null ||
        error?.code === 'ETIMEDOUT' || error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
      if (aborted) return { completed: false, errors: [], error: 'Godot timed out or produced too much output' };
      if (!output) return { completed: false, errors: [], error: error?.message || 'Unknown error' };
    }
    const errors = parseGodotScriptDiagnostics(output);
    if (errors.length === 0 && failed) {
      const tail = output.trim().split(/\r?\n/).slice(-6).join(' ');
      return { completed: false, errors: [], error: `Godot exited with an error: ${tail}` };
    }
    return { completed: true, errors };
  }


  private async listChangedGdFiles(projectPath: string): Promise<{ files?: string[]; error?: string }> {
    const git = (gitArgs: string[]) =>
      execFileAsync('git', ['-c', 'core.quotepath=false', '-C', projectPath, ...gitArgs], { timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
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
      return { files: collectGdPaths(outputs.map(o => o.stdout ?? '')) };
    } catch (error: any) {
      return { error: `Failed to list changed files: ${error?.message || 'Unknown error'}` };
    }
  }

  private listAllGdFiles(projectPath: string): string[] {
    const results: string[] = [];
    const skipDirs = new Set(['.godot', '.git', 'node_modules', '.import']);
    const walk = (dir: string) => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (skipDirs.has(entry.name) || entry.name.startsWith('.')) continue;
          walk(join(dir, entry.name));
        } else if (entry.isFile() && /\.gd$/i.test(entry.name)) {
          results.push(relative(projectPath, join(dir, entry.name)).replace(/\\/g, '/'));
        }
      }
    };
    walk(projectPath);
    return results;
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
