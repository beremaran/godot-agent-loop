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
import { existsSync, readdirSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, renameSync } from 'fs';
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
  isGodot44OrLater,
  generateGodotProjectFeatures,
  generateCsprojContent,
  generateCsharpScriptSource,
  toDotnetIdentifier,
  isValidCsharpIdentifier,
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
      'list_projects': args => this.handleListProjects(args),
      'get_project_info': args => this.handleGetProjectInfo(args),
      'create_scene': args => this.handleCreateScene(args),
      'add_node': args => this.handleAddNode(args),
      'load_sprite': args => this.handleLoadSprite(args),
      'export_mesh_library': args => this.handleExportMeshLibrary(args),
      'save_scene': args => this.handleSaveScene(args),
      'get_uid': args => this.handleGetUid(args),
      'update_project_uids': args => this.handleUpdateProjectUids(args),
      'game_screenshot': () => this.handleGameScreenshot(),
      'game_click': args => this.handleGameClick(args),
      'game_key_press': args => this.handleGameKeyPress(args),
      'game_mouse_move': args => this.handleGameMouseMove(args),
      'game_get_ui': () => this.handleGameGetUi(),
      'game_get_scene_tree': () => this.handleGameGetSceneTree(),
      'game_eval': args => this.handleGameEval(args),
      'game_get_property': args => this.handleGameGetProperty(args),
      'game_set_property': args => this.handleGameSetProperty(args),
      'game_call_method': args => this.handleGameCallMethod(args),
      'game_get_node_info': args => this.handleGameGetNodeInfo(args),
      'game_instantiate_scene': args => this.handleGameInstantiateScene(args),
      'game_remove_node': args => this.handleGameRemoveNode(args),
      'game_change_scene': args => this.handleGameChangeScene(args),
      'game_pause': args => this.handleGamePause(args),
      'game_performance': () => this.handleGamePerformance(),
      'game_wait': args => this.handleGameWait(args),
      'read_scene': args => this.handleReadScene(args),
      'modify_scene_node': args => this.handleModifySceneNode(args),
      'remove_scene_node': args => this.handleRemoveSceneNode(args),
      'read_project_settings': args => this.handleReadProjectSettings(args),
      'modify_project_settings': args => this.handleModifyProjectSettings(args),
      'list_project_files': args => this.handleListProjectFiles(args),
      'game_connect_signal': args => this.handleGameConnectSignal(args),
      'game_disconnect_signal': args => this.handleGameDisconnectSignal(args),
      'game_emit_signal': args => this.handleGameEmitSignal(args),
      'game_play_animation': args => this.handleGamePlayAnimation(args),
      'game_tween_property': args => this.handleGameTweenProperty(args),
      'game_get_nodes_in_group': args => this.handleGameGetNodesInGroup(args),
      'game_find_nodes_by_class': args => this.handleGameFindNodesByClass(args),
      'game_reparent_node': args => this.handleGameReparentNode(args),
      'attach_script': args => this.handleAttachScript(args),
      'create_resource': args => this.handleCreateResource(args),
      'read_file': args => this.handleReadFile(args),
      'write_file': args => this.handleWriteFile(args),
      'delete_file': args => this.handleDeleteFile(args),
      'create_directory': args => this.handleCreateDirectory(args),
      'game_get_errors': () => this.handleGameGetErrors(),
      'game_get_logs': () => this.handleGameGetLogs(),
      'game_key_hold': args => this.handleGameKeyHold(args),
      'game_key_release': args => this.handleGameKeyRelease(args),
      'game_scroll': args => this.handleGameScroll(args),
      'game_mouse_drag': args => this.handleGameMouseDrag(args),
      'game_gamepad': args => this.handleGameGamepad(args),
      'create_project': args => this.handleCreateProject(args),
      'create_csharp_script': args => this.handleCreateCsharpScript(args),
      'manage_autoloads': args => this.handleManageAutoloads(args),
      'manage_input_map': args => this.handleManageInputMap(args),
      'manage_export_presets': args => this.handleManageExportPresets(args),
      'game_get_camera': () => this.handleGameGetCamera(),
      'game_set_camera': args => this.handleGameSetCamera(args),
      'game_raycast': args => this.handleGameRaycast(args),
      'game_get_audio': () => this.handleGameGetAudio(),
      'game_spawn_node': args => this.handleGameSpawnNode(args),
      'game_set_shader_param': args => this.handleGameSetShaderParam(args),
      'game_audio_play': args => this.handleGameAudioPlay(args),
      'game_audio_bus': args => this.handleGameAudioBus(args),
      'game_navigate_path': args => this.handleGameNavigatePath(args),
      'game_tilemap': args => this.handleGameTilemap(args),
      'game_add_collision': args => this.handleGameAddCollision(args),
      'game_environment': args => this.handleGameEnvironment(args),
      'game_manage_group': args => this.handleGameManageGroup(args),
      'game_create_timer': args => this.handleGameCreateTimer(args),
      'game_set_particles': args => this.handleGameSetParticles(args),
      'game_create_animation': args => this.handleGameCreateAnimation(args),
      'export_project': args => this.handleExportProject(args),
      'game_serialize_state': args => this.handleGameSerializeState(args),
      'game_physics_body': args => this.handleGamePhysicsBody(args),
      'game_create_joint': args => this.handleGameCreateJoint(args),
      'game_bone_pose': args => this.handleGameBonePose(args),
      'game_ui_theme': args => this.handleGameUiTheme(args),
      'game_viewport': args => this.handleGameViewport(args),
      'game_debug_draw': args => this.handleGameDebugDraw(args),
      'game_http_request': args => this.handleGameHttpRequest(args),
      'game_websocket': args => this.handleGameWebsocket(args),
      'game_multiplayer': args => this.handleGameMultiplayer(args),
      'game_rpc': args => this.handleGameRpc(args),
      'game_touch': args => this.handleGameTouch(args),
      'game_input_state': args => this.handleGameInputState(args),
      'game_input_action': args => this.handleGameInputAction(args),
      'game_list_signals': args => this.handleGameListSignals(args),
      'game_await_signal': args => this.handleGameAwaitSignal(args),
      'game_script': args => this.handleGameScript(args),
      'game_window': args => this.handleGameWindow(args),
      'game_os_info': args => this.handleGameOsInfo(args),
      'game_time_scale': args => this.handleGameTimeScale(args),
      'game_process_mode': args => this.handleGameProcessMode(args),
      'game_world_settings': args => this.handleGameWorldSettings(args),
      'game_csg': args => this.handleGameCsg(args),
      'game_multimesh': args => this.handleGameMultimesh(args),
      'game_procedural_mesh': args => this.handleGameProceduralMesh(args),
      'game_light_3d': args => this.handleGameLight3d(args),
      'game_mesh_instance': args => this.handleGameMeshInstance(args),
      'game_gridmap': args => this.handleGameGridmap(args),
      'game_3d_effects': args => this.handleGame3dEffects(args),
      'game_gi': args => this.handleGameGi(args),
      'game_path_3d': args => this.handleGamePath3d(args),
      'game_sky': args => this.handleGameSky(args),
      'game_camera_attributes': args => this.handleGameCameraAttributes(args),
      'game_navigation_3d': args => this.handleGameNavigation3d(args),
      'game_physics_3d': args => this.handleGamePhysics3d(args),
      'game_canvas': args => this.handleGameCanvas(args),
      'game_canvas_draw': args => this.handleGameCanvasDraw(args),
      'game_light_2d': args => this.handleGameLight2d(args),
      'game_parallax': args => this.handleGameParallax(args),
      'game_shape_2d': args => this.handleGameShape2d(args),
      'game_path_2d': args => this.handleGamePath2d(args),
      'game_physics_2d': args => this.handleGamePhysics2d(args),
      'game_animation_tree': args => this.handleGameAnimationTree(args),
      'game_animation_control': args => this.handleGameAnimationControl(args),
      'game_skeleton_ik': args => this.handleGameSkeletonIk(args),
      'game_audio_effect': args => this.handleGameAudioEffect(args),
      'game_audio_bus_layout': args => this.handleGameAudioBusLayout(args),
      'game_audio_spatial': args => this.handleGameAudioSpatial(args),
      'rename_file': args => this.handleRenameFile(args),
      'manage_resource': args => this.handleManageResource(args),
      'validate_script': args => this.handleValidateScript(args),
      'validate_scripts': args => this.handleValidateScripts(args),
      'create_script': args => this.handleCreateScript(args),
      'manage_scene_signals': args => this.handleManageSceneSignals(args),
      'manage_layers': args => this.handleManageLayers(args),
      'manage_plugins': args => this.handleManagePlugins(args),
      'manage_shader': args => this.handleManageShader(args),
      'manage_theme_resource': args => this.handleManageThemeResource(args),
      'set_main_scene': args => this.handleSetMainScene(args),
      'manage_scene_structure': args => this.handleManageSceneStructure(args),
      'manage_translations': args => this.handleManageTranslations(args),
      'game_locale': args => this.handleGameLocale(args),
      'game_ui_control': args => this.handleGameUiControl(args),
      'game_ui_text': args => this.handleGameUiText(args),
      'game_ui_popup': args => this.handleGameUiPopup(args),
      'game_ui_tree': args => this.handleGameUiTree(args),
      'game_ui_item_list': args => this.handleGameUiItemList(args),
      'game_ui_tabs': args => this.handleGameUiTabs(args),
      'game_ui_menu': args => this.handleGameUiMenu(args),
      'game_ui_range': args => this.handleGameUiRange(args),
      'game_render_settings': args => this.handleGameRenderSettings(args),
      'game_resource': args => this.handleGameResource(args),
      'game_visual_shader': args => this.handleGameVisualShader(args),
      'game_terrain': args => this.handleGameTerrain(args),
      'game_video': args => this.handleGameVideo(args),
      'manage_ci_pipeline': args => this.handleManageCiPipeline(args),
      'manage_docker_export': args => this.handleManageDockerExport(args),
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
  private async handleListProjects(args: any) {
    // Normalize parameters to camelCase
    args = normalizeParameters(args);
    
    if (!args.directory) {
      return createErrorResponse(
        'Directory is required'
      );
    }

    if (!validatePath(args.directory)) {
      return createErrorResponse(
        'Invalid directory path'
      );
    }

    try {
      this.logDebug(`Listing Godot projects in directory: ${args.directory}`);
      if (!existsSync(args.directory)) {
        return createErrorResponse(
          `Directory does not exist: ${args.directory}`
        );
      }

      const recursive = args.recursive === true;
      const projects = this.findGodotProjects(args.directory, recursive);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(projects, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return createErrorResponse(
        `Failed to list projects: ${error?.message || 'Unknown error'}`
      );
    }
  }

  /**
   * Get the structure of a Godot project asynchronously by counting files recursively
   * @param projectPath Path to the Godot project
   * @returns Promise resolving to an object with counts of scenes, scripts, assets, and other files
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
  private async handleGetProjectInfo(args: any) {
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
  
      this.logDebug(`Getting project info for: ${args.projectPath}`);
  
      // Get Godot version
      const execOptions = { timeout: 10000 }; // 10 second timeout
      const { stdout } = await execFileAsync(this.godotPath, ['--version'], execOptions);
  
      // Get project structure using the recursive method
      const projectStructure = await this.getProjectStructureAsync(args.projectPath);
  
      // Extract project name from project.godot file
      let projectName = basename(args.projectPath);
      try {
        const projectFileContent = readFileSync(projectFile, 'utf8');
        const configNameMatch = /config\/name="([^"]+)"/.exec(projectFileContent);
        if (configNameMatch && configNameMatch[1]) {
          projectName = configNameMatch[1];
          this.logDebug(`Found project name in config: ${projectName}`);
        }
      } catch (error) {
        this.logDebug(`Error reading project file: ${error}`);
        // Continue with default project name if extraction fails
      }
  
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                name: projectName,
                path: args.projectPath,
                godotVersion: stdout.trim(),
                isDotnet: this.isDotnetProject(args.projectPath),
                structure: projectStructure,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error: any) {
      return createErrorResponse(
        `Failed to get project info: ${error?.message || 'Unknown error'}`
      );
    }
  }

  /**
   * Handle the create_scene tool
   */
  private async handleCreateScene(args: any) {
    // Normalize parameters to camelCase
    args = normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath) {
      return createErrorResponse(
        'Project path and scene path are required'
      );
    }

    if (!validatePath(args.projectPath) || !validatePath(args.scenePath)) {
      return createErrorResponse(
        'Invalid path'
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

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        scenePath: args.scenePath,
        rootNodeType: args.rootNodeType || 'Node2D',
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('create_scene', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return createErrorResponse(
          `Failed to create scene: ${stderr}`
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Scene created successfully at: ${args.scenePath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return createErrorResponse(
        `Failed to create scene: ${error?.message || 'Unknown error'}`
      );
    }
  }

  /**
   * Handle the add_node tool
   */
  private async handleAddNode(args: any) {
    // Normalize parameters to camelCase
    args = normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.nodeType || !args.nodeName) {
      return createErrorResponse(
        'Missing required parameters'
      );
    }

    if (!validatePath(args.projectPath) || !validatePath(args.scenePath)) {
      return createErrorResponse(
        'Invalid path'
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

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params: any = {
        scenePath: args.scenePath,
        nodeType: args.nodeType,
        nodeName: args.nodeName,
      };

      // Add optional parameters
      if (args.parentNodePath) {
        params.parentNodePath = args.parentNodePath;
      }

      if (args.properties) {
        params.properties = args.properties;
      }

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('add_node', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return createErrorResponse(
          `Failed to add node: ${stderr}`
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Node '${args.nodeName}' of type '${args.nodeType}' added successfully to '${args.scenePath}'.\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return createErrorResponse(
        `Failed to add node: ${error?.message || 'Unknown error'}`
      );
    }
  }

  /**
   * Handle the load_sprite tool
   */
  private async handleLoadSprite(args: any) {
    // Normalize parameters to camelCase
    args = normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.nodePath || !args.texturePath) {
      return createErrorResponse(
        'Missing required parameters'
      );
    }

    if (
      !validatePath(args.projectPath) ||
      !validatePath(args.scenePath) ||
      !validatePath(args.nodePath) ||
      !validatePath(args.texturePath)
    ) {
      return createErrorResponse(
        'Invalid path'
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

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`
        );
      }

      // Check if the texture file exists
      const texturePath = join(args.projectPath, args.texturePath);
      if (!existsSync(texturePath)) {
        return createErrorResponse(
          `Texture file does not exist: ${args.texturePath}`
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        scenePath: args.scenePath,
        nodePath: args.nodePath,
        texturePath: args.texturePath,
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('load_sprite', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return createErrorResponse(
          `Failed to load sprite: ${stderr}`
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Sprite loaded successfully with texture: ${args.texturePath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return createErrorResponse(
        `Failed to load sprite: ${error?.message || 'Unknown error'}`
      );
    }
  }

  /**
   * Handle the export_mesh_library tool
   */
  private async handleExportMeshLibrary(args: any) {
    // Normalize parameters to camelCase
    args = normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath || !args.outputPath) {
      return createErrorResponse(
        'Missing required parameters'
      );
    }

    if (
      !validatePath(args.projectPath) ||
      !validatePath(args.scenePath) ||
      !validatePath(args.outputPath)
    ) {
      return createErrorResponse(
        'Invalid path'
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

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params: any = {
        scenePath: args.scenePath,
        outputPath: args.outputPath,
      };

      // Add optional parameters
      if (args.meshItemNames && Array.isArray(args.meshItemNames)) {
        params.meshItemNames = args.meshItemNames;
      }

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('export_mesh_library', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return createErrorResponse(
          `Failed to export mesh library: ${stderr}`
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `MeshLibrary exported successfully to: ${args.outputPath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return createErrorResponse(
        `Failed to export mesh library: ${error?.message || 'Unknown error'}`
      );
    }
  }

  /**
   * Handle the save_scene tool
   */
  private async handleSaveScene(args: any) {
    // Normalize parameters to camelCase
    args = normalizeParameters(args);
    
    if (!args.projectPath || !args.scenePath) {
      return createErrorResponse(
        'Missing required parameters'
      );
    }

    if (!validatePath(args.projectPath) || !validatePath(args.scenePath)) {
      return createErrorResponse(
        'Invalid path'
      );
    }

    // If newPath is provided, validate it
    if (args.newPath && !validatePath(args.newPath)) {
      return createErrorResponse(
        'Invalid new path'
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

      // Check if the scene file exists
      const scenePath = join(args.projectPath, args.scenePath);
      if (!existsSync(scenePath)) {
        return createErrorResponse(
          `Scene file does not exist: ${args.scenePath}`
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params: any = {
        scenePath: args.scenePath,
      };

      // Add optional parameters
      if (args.newPath) {
        params.newPath = args.newPath;
      }

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('save_scene', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return createErrorResponse(
          `Failed to save scene: ${stderr}`
        );
      }

      const savePath = args.newPath || args.scenePath;
      return {
        content: [
          {
            type: 'text',
            text: `Scene saved successfully to: ${savePath}\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return createErrorResponse(
        `Failed to save scene: ${error?.message || 'Unknown error'}`
      );
    }
  }

  /**
   * Handle the get_uid tool
   */
  private async handleGetUid(args: any) {
    // Normalize parameters to camelCase
    args = normalizeParameters(args);
    
    if (!args.projectPath || !args.filePath) {
      return createErrorResponse(
        'Missing required parameters'
      );
    }

    if (!validatePath(args.projectPath) || !validatePath(args.filePath)) {
      return createErrorResponse(
        'Invalid path'
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

      // Check if the file exists
      const filePath = join(args.projectPath, args.filePath);
      if (!existsSync(filePath)) {
        return createErrorResponse(
          `File does not exist: ${args.filePath}`
        );
      }

      // Get Godot version to check if UIDs are supported
      const { stdout: versionOutput } = await execFileAsync(this.godotPath, ['--version']);
      const version = versionOutput.trim();

      if (!isGodot44OrLater(version)) {
        return createErrorResponse(
          `UIDs are only supported in Godot 4.4 or later. Current version: ${version}`
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        filePath: args.filePath,
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('get_uid', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return createErrorResponse(
          `Failed to get UID: ${stderr}`
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `UID for ${args.filePath}: ${stdout.trim()}`,
          },
        ],
      };
    } catch (error: any) {
      return createErrorResponse(
        `Failed to get UID: ${error?.message || 'Unknown error'}`
      );
    }
  }


  /**
   * Handle the game_screenshot tool
   */
  private async handleGameScreenshot() {
    if (!this.activeProcess) {
      return createErrorResponse('No active Godot process. Use run_project first.');
    }
    if (!this.gameConnection.connected) {
      return createErrorResponse('Not connected to game interaction server. Wait a moment and try again.');
    }

    try {
      const response = await this.sendGameCommand('screenshot');
      if (response.error) {
        return createErrorResponse(`Screenshot failed: ${response.error}`);
      }
      return {
        content: [
          {
            type: 'image',
            data: response.data,
            mimeType: 'image/png',
          },
          {
            type: 'text',
            text: `Screenshot captured: ${response.width}x${response.height}`,
          },
        ],
      };
    } catch (error: any) {
      return createErrorResponse(`Screenshot failed: ${error?.message || 'Unknown error'}`);
    }
  }

  private async handleGameClick(args: any) {
    return this.gameCommand('click', args, a => ({ x: a.x ?? 0, y: a.y ?? 0, button: a.button ?? 1 }));
  }

  private async handleGameKeyPress(args: any) {
    args = args || {};
    if (!args.key && !args.action) return createErrorResponse('Must provide either "key" or "action" parameter.');
    const params: Record<string, any> = {};
    if (args.key) params.key = args.key;
    if (args.action) params.action = args.action;
    if (args.pressed !== undefined) params.pressed = args.pressed;
    return this.gameCommand('key_press', args, () => params);
  }

  private async handleGameMouseMove(args: any) {
    return this.gameCommand('mouse_move', args, a => ({
      x: a.x ?? 0, y: a.y ?? 0, relative_x: a.relative_x ?? 0, relative_y: a.relative_y ?? 0,
    }));
  }

  private async handleGameGetUi() {
    return this.gameCommand('get_ui_elements', {}, () => ({}));
  }

  private async handleGameGetSceneTree() {
    return this.gameCommand('get_scene_tree', {}, () => ({}));
  }

  private async handleGameEval(args: any) {
    args = normalizeParameters(args || {});
    if (!args.code) return createErrorResponse('code parameter is required.');
    return this.gameCommand('eval', args, a => ({ code: a.code }), 30000);
  }

  private async handleGameGetProperty(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.property) return createErrorResponse('nodePath and property are required.');
    return this.gameCommand('get_property', args, a => ({ node_path: a.nodePath, property: a.property }));
  }

  private async handleGameSetProperty(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.property) return createErrorResponse('nodePath and property are required.');
    return this.gameCommand('set_property', args, a => ({
      node_path: a.nodePath, property: a.property, value: a.value, type_hint: a.typeHint || '',
    }));
  }

  private async handleGameCallMethod(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.method) return createErrorResponse('nodePath and method are required.');
    return this.gameCommand('call_method', args, a => ({
      node_path: a.nodePath, method: a.method, args: a.args || [],
    }));
  }

  private async handleGameGetNodeInfo(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath) return createErrorResponse('nodePath is required.');
    return this.gameCommand('get_node_info', args, a => ({ node_path: a.nodePath }));
  }

  private async handleGameInstantiateScene(args: any) {
    args = normalizeParameters(args || {});
    if (!args.scenePath) return createErrorResponse('scenePath is required.');
    return this.gameCommand('instantiate_scene', args, a => ({
      scene_path: a.scenePath, parent_path: a.parentPath || '/root',
    }));
  }

  private async handleGameRemoveNode(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath) return createErrorResponse('nodePath is required.');
    return this.gameCommand('remove_node', args, a => ({ node_path: a.nodePath }));
  }

  private async handleGameChangeScene(args: any) {
    args = normalizeParameters(args || {});
    if (!args.scenePath) return createErrorResponse('scenePath is required.');
    return this.gameCommand('change_scene', args, a => ({ scene_path: a.scenePath }));
  }

  private async handleGamePause(args: any) {
    return this.gameCommand('pause', args, a => ({ paused: a.paused !== undefined ? a.paused : true }));
  }

  private async handleGamePerformance() {
    return this.gameCommand('get_performance', {}, () => ({}));
  }

  private async handleGameWait(args: any) {
    return this.gameCommand('wait', args, a => ({ frames: a.frames || 1, frame_type: a.frameType || 'render' }), 30000);
  }


  /**
   * Handle the read_scene tool - Read a scene file structure
   */
  private async handleReadScene(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.scenePath) {
      return createErrorResponse('projectPath and scenePath are required.');
    }

    if (!validatePath(args.projectPath) || !validatePath(args.scenePath)) {
      return createErrorResponse('Invalid path.');
    }

    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) {
      return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    }

    const scenePath = join(args.projectPath, args.scenePath);
    if (!existsSync(scenePath)) {
      return createErrorResponse(`Scene file does not exist: ${args.scenePath}`);
    }

    try {
      const { stdout, stderr } = await this.executeOperation('read_scene', {
        scenePath: args.scenePath,
      }, args.projectPath);

      // Extract JSON from the SCENE_JSON_START/END markers
      const startMarker = 'SCENE_JSON_START';
      const endMarker = 'SCENE_JSON_END';
      const startIdx = stdout.indexOf(startMarker);
      const endIdx = stdout.indexOf(endMarker);

      if (startIdx !== -1 && endIdx !== -1) {
        const jsonStr = stdout.substring(startIdx + startMarker.length, endIdx).trim();
        try {
          const parsed = JSON.parse(jsonStr);
          return {
            content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) }],
          };
        } catch {
          return {
            content: [{ type: 'text', text: `Raw scene data:\n${jsonStr}` }],
          };
        }
      }

      return {
        content: [{ type: 'text', text: `Scene read output:\n${stdout}\n${stderr ? 'Errors:\n' + stderr : ''}` }],
      };
    } catch (error: any) {
      return createErrorResponse(`Failed to read scene: ${error?.message || 'Unknown error'}`);
    }
  }

  /**
   * Handle the modify_scene_node tool
   */
  private async handleModifySceneNode(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.scenePath || !args.nodePath || !args.properties)
      return createErrorResponse('projectPath, scenePath, nodePath, and properties are required.');
    return this.headlessOp('modify_node', args, a => ({
      projectPath: a.projectPath,
      params: { scenePath: a.scenePath, nodePath: a.nodePath, properties: a.properties },
    }));
  }

  private async handleRemoveSceneNode(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.scenePath || !args.nodePath)
      return createErrorResponse('projectPath, scenePath, and nodePath are required.');
    return this.headlessOp('remove_node', args, a => ({
      projectPath: a.projectPath,
      params: { scenePath: a.scenePath, nodePath: a.nodePath },
    }));
  }


  /**
   * Handle the read_project_settings tool - Parse project.godot as JSON
   */
  private async handleReadProjectSettings(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath) {
      return createErrorResponse('projectPath is required.');
    }

    if (!validatePath(args.projectPath)) {
      return createErrorResponse('Invalid path.');
    }

    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) {
      return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    }

    try {
      const content = readFileSync(projectFile, 'utf8');
      const sections: Record<string, Record<string, string>> = {};
      let currentSection = '';

      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith(';')) continue;

        // Section header
        const sectionMatch = /^\[(.+)\]$/.exec(trimmed);
        if (sectionMatch) {
          currentSection = sectionMatch[1];
          if (!sections[currentSection]) {
            sections[currentSection] = {};
          }
          continue;
        }

        // Key=value pair
        const kvMatch = /^([^=]+)=(.*)$/.exec(trimmed);
        if (kvMatch && currentSection) {
          const key = kvMatch[1].trim();
          const value = kvMatch[2].trim();
          sections[currentSection][key] = value;
        }
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(sections, null, 2) }],
      };
    } catch (error: any) {
      return createErrorResponse(`Failed to read project settings: ${error?.message || 'Unknown error'}`);
    }
  }

  /**
   * Handle the modify_project_settings tool - Change a project.godot setting
   */
  private async handleModifyProjectSettings(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.section || !args.key || args.value === undefined) {
      return createErrorResponse('projectPath, section, key, and value are required.');
    }

    if (!validatePath(args.projectPath)) {
      return createErrorResponse('Invalid path.');
    }

    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) {
      return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    }

    try {
      let content = readFileSync(projectFile, 'utf8');
      const sectionHeader = `[${args.section}]`;
      const keyLine = `${args.key}=${args.value}`;

      // Check if section exists
      const sectionIdx = content.indexOf(sectionHeader);
      if (sectionIdx !== -1) {
        // Section exists - look for existing key
        const sectionEnd = content.indexOf('\n[', sectionIdx + sectionHeader.length);
        const sectionContent = sectionEnd !== -1
          ? content.substring(sectionIdx, sectionEnd)
          : content.substring(sectionIdx);

        // Try to find and replace existing key
        const keyPattern = new RegExp(`^${args.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=.*$`, 'm');
        if (keyPattern.test(sectionContent)) {
          // Replace existing key
          const newSectionContent = sectionContent.replace(keyPattern, keyLine);
          content = content.substring(0, sectionIdx) + newSectionContent +
            (sectionEnd !== -1 ? content.substring(sectionEnd) : '');
        } else {
          // Add key to existing section
          const insertPos = sectionIdx + sectionHeader.length;
          content = content.substring(0, insertPos) + '\n' + keyLine + content.substring(insertPos);
        }
      } else {
        // Add new section at end
        content += `\n\n${sectionHeader}\n\n${keyLine}\n`;
      }

      writeFileSync(projectFile, content, 'utf8');
      return {
        content: [{ type: 'text', text: `Setting updated: [${args.section}] ${args.key}=${args.value}` }],
      };
    } catch (error: any) {
      return createErrorResponse(`Failed to modify project settings: ${error?.message || 'Unknown error'}`);
    }
  }

  /**
   * Handle the list_project_files tool - List files with extension filtering
   */
  private async handleListProjectFiles(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath) {
      return createErrorResponse('projectPath is required.');
    }

    if (!validatePath(args.projectPath)) {
      return createErrorResponse('Invalid path.');
    }

    if (!existsSync(args.projectPath)) {
      return createErrorResponse(`Directory does not exist: ${args.projectPath}`);
    }

    try {
      const baseDir = args.subdirectory
        ? join(args.projectPath, args.subdirectory)
        : args.projectPath;

      if (!existsSync(baseDir)) {
        return createErrorResponse(`Subdirectory does not exist: ${args.subdirectory}`);
      }

      const files: string[] = [];
      const extensions: string[] | undefined = args.extensions;

      const scanDir = (dir: string, relativeTo: string) => {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          const fullPath = join(dir, entry.name);
          const relativePath = fullPath.substring(relativeTo.length + 1).replace(/\\/g, '/');

          if (entry.isDirectory()) {
            scanDir(fullPath, relativeTo);
          } else if (entry.isFile()) {
            if (extensions && extensions.length > 0) {
              const ext = '.' + entry.name.split('.').pop();
              if (extensions.includes(ext)) {
                files.push(relativePath);
              }
            } else {
              files.push(relativePath);
            }
          }
        }
      };

      scanDir(baseDir, args.projectPath);

      return {
        content: [{ type: 'text', text: JSON.stringify({ count: files.length, files }, null, 2) }],
      };
    } catch (error: any) {
      return createErrorResponse(`Failed to list project files: ${error?.message || 'Unknown error'}`);
    }
  }

  private async handleGameConnectSignal(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.signalName || !args.targetPath || !args.method)
      return createErrorResponse('nodePath, signalName, targetPath, and method are required.');
    return this.gameCommand('connect_signal', args, a => ({
      node_path: a.nodePath, signal_name: a.signalName, target_path: a.targetPath, method: a.method,
    }));
  }

  private async handleGameDisconnectSignal(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.signalName || !args.targetPath || !args.method)
      return createErrorResponse('nodePath, signalName, targetPath, and method are required.');
    return this.gameCommand('disconnect_signal', args, a => ({
      node_path: a.nodePath, signal_name: a.signalName, target_path: a.targetPath, method: a.method,
    }));
  }

  private async handleGameEmitSignal(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.signalName) return createErrorResponse('nodePath and signalName are required.');
    return this.gameCommand('emit_signal', args, a => ({
      node_path: a.nodePath, signal_name: a.signalName, args: a.args || [],
    }));
  }

  private async handleGamePlayAnimation(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath) return createErrorResponse('nodePath is required.');
    return this.gameCommand('play_animation', args, a => ({
      node_path: a.nodePath, action: a.action || 'play', animation: a.animation || '',
    }));
  }

  private async handleGameTweenProperty(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.property || args.finalValue === undefined)
      return createErrorResponse('nodePath, property, and finalValue are required.');
    return this.gameCommand('tween_property', args, a => ({
      node_path: a.nodePath, property: a.property, final_value: a.finalValue,
      duration: a.duration || 1.0, trans_type: a.transType || 0, ease_type: a.easeType || 2,
    }));
  }

  private async handleGameGetNodesInGroup(args: any) {
    args = normalizeParameters(args || {});
    if (!args.group) return createErrorResponse('group is required.');
    return this.gameCommand('get_nodes_in_group', args, a => ({ group: a.group }));
  }

  private async handleGameFindNodesByClass(args: any) {
    args = normalizeParameters(args || {});
    if (!args.className) return createErrorResponse('className is required.');
    return this.gameCommand('find_nodes_by_class', args, a => ({
      class_name: a.className, root_path: a.rootPath || '/root',
    }));
  }

  private async handleGameReparentNode(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.newParentPath) return createErrorResponse('nodePath and newParentPath are required.');
    return this.gameCommand('reparent_node', args, a => ({
      node_path: a.nodePath, new_parent_path: a.newParentPath, keep_global_transform: a.keepGlobalTransform !== false,
    }));
  }

  private async handleAttachScript(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.scenePath || !args.nodePath || !args.scriptPath)
      return createErrorResponse('projectPath, scenePath, nodePath, and scriptPath are required.');
    return this.headlessOp('attach_script', args, a => ({
      projectPath: a.projectPath,
      params: { scenePath: a.scenePath, nodePath: a.nodePath, scriptPath: a.scriptPath },
    }));
  }

  private async handleCreateResource(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.resourceType || !args.resourcePath)
      return createErrorResponse('projectPath, resourceType, and resourcePath are required.');
    return this.headlessOp('create_resource', args, a => ({
      projectPath: a.projectPath,
      params: { resourceType: a.resourceType, resourcePath: a.resourcePath, ...(a.properties ? { properties: a.properties } : {}) },
    }));
  }

  // --- File I/O handlers ---

  private async handleReadFile(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.filePath)
      return createErrorResponse('projectPath and filePath are required.');
    if (!validatePath(args.projectPath) || !validatePath(args.filePath))
      return createErrorResponse('Invalid path.');
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile))
      return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    const fullPath = join(args.projectPath, args.filePath);
    if (!existsSync(fullPath))
      return createErrorResponse(`File does not exist: ${args.filePath}`);
    try {
      const content = readFileSync(fullPath, 'utf8');
      return { content: [{ type: 'text', text: content }] };
    } catch (error: any) {
      return createErrorResponse(`Failed to read file: ${error?.message || 'Unknown error'}`);
    }
  }

  private async handleWriteFile(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.filePath || args.content === undefined)
      return createErrorResponse('projectPath, filePath, and content are required.');
    if (!validatePath(args.projectPath) || !validatePath(args.filePath))
      return createErrorResponse('Invalid path.');
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile))
      return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    try {
      const fullPath = join(args.projectPath, args.filePath);
      const parentDir = dirname(fullPath);
      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
      }
      writeFileSync(fullPath, args.content, 'utf8');
      return { content: [{ type: 'text', text: `File written: ${args.filePath}` }] };
    } catch (error: any) {
      return createErrorResponse(`Failed to write file: ${error?.message || 'Unknown error'}`);
    }
  }

  private async handleDeleteFile(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.filePath)
      return createErrorResponse('projectPath and filePath are required.');
    if (!validatePath(args.projectPath) || !validatePath(args.filePath))
      return createErrorResponse('Invalid path.');
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile))
      return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    const fullPath = join(args.projectPath, args.filePath);
    if (!existsSync(fullPath))
      return createErrorResponse(`File does not exist: ${args.filePath}`);
    try {
      unlinkSync(fullPath);
      return { content: [{ type: 'text', text: `File deleted: ${args.filePath}` }] };
    } catch (error: any) {
      return createErrorResponse(`Failed to delete file: ${error?.message || 'Unknown error'}`);
    }
  }

  private async handleCreateDirectory(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.directoryPath)
      return createErrorResponse('projectPath and directoryPath are required.');
    if (!validatePath(args.projectPath) || !validatePath(args.directoryPath))
      return createErrorResponse('Invalid path.');
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile))
      return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    try {
      const fullPath = join(args.projectPath, args.directoryPath);
      mkdirSync(fullPath, { recursive: true });
      return { content: [{ type: 'text', text: `Directory created: ${args.directoryPath}` }] };
    } catch (error: any) {
      return createErrorResponse(`Failed to create directory: ${error?.message || 'Unknown error'}`);
    }
  }

  // --- Error/Log capture handlers ---

  private async handleGameGetErrors() {
    if (!this.activeProcess)
      return createErrorResponse('No active Godot process. Use run_project first.');
    const errors = this.processManager.readNewErrors();
    return { content: [{ type: 'text', text: JSON.stringify({ count: errors.length, errors }, null, 2) }] };
  }

  private async handleGameGetLogs() {
    if (!this.activeProcess)
      return createErrorResponse('No active Godot process. Use run_project first.');
    const logs = this.processManager.readNewLogs();
    return { content: [{ type: 'text', text: JSON.stringify({ count: logs.length, logs }, null, 2) }] };
  }

  // --- Enhanced input handlers ---

  private async handleGameKeyHold(args: any) {
    args = args || {};
    if (!args.key && !args.action) return createErrorResponse('Must provide either "key" or "action" parameter.');
    const params: Record<string, any> = {};
    if (args.key) params.key = args.key;
    if (args.action) params.action = args.action;
    return this.gameCommand('key_hold', args, () => params);
  }

  private async handleGameKeyRelease(args: any) {
    args = args || {};
    if (!args.key && !args.action) return createErrorResponse('Must provide either "key" or "action" parameter.');
    const params: Record<string, any> = {};
    if (args.key) params.key = args.key;
    if (args.action) params.action = args.action;
    return this.gameCommand('key_release', args, () => params);
  }

  private async handleGameScroll(args: any) {
    return this.gameCommand('scroll', args, a => ({
      x: a.x ?? 0, y: a.y ?? 0, direction: a.direction || 'up', amount: a.amount || 1,
    }));
  }

  private async handleGameMouseDrag(args: any) {
    args = normalizeParameters(args || {});
    if (args.fromX === undefined || args.fromY === undefined || args.toX === undefined || args.toY === undefined)
      return createErrorResponse('fromX, fromY, toX, and toY are required.');
    return this.gameCommand('mouse_drag', args, a => ({
      from_x: a.fromX, from_y: a.fromY, to_x: a.toX, to_y: a.toY,
      button: a.button || 1, steps: a.steps || 10,
    }), 30000);
  }

  private async handleGameGamepad(args: any) {
    args = normalizeParameters(args || {});
    if (!args.type || args.index === undefined || args.value === undefined)
      return createErrorResponse('type, index, and value are required.');
    return this.gameCommand('gamepad', args, a => ({
      type: a.type, index: a.index, value: a.value, device: a.device || 0,
    }));
  }

  // --- Project management handlers ---

  private async handleCreateProject(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.projectName)
      return createErrorResponse('projectPath and projectName are required.');
    if (!validatePath(args.projectPath))
      return createErrorResponse('Invalid path.');
    try {
      if (!existsSync(args.projectPath)) {
        mkdirSync(args.projectPath, { recursive: true });
      }
      const projectFile = join(args.projectPath, 'project.godot');
      if (existsSync(projectFile))
        return createErrorResponse('A project.godot already exists at this path.');
      const isDotnet = args.dotnet === true;
      const assemblyName = toDotnetIdentifier(args.projectName);
      const features = generateGodotProjectFeatures(isDotnet);
      let content = `; Engine configuration file.\n; Generated by Godot MCP.\n\nconfig_version=5\n\n[application]\n\nconfig/name="${args.projectName}"\nconfig/features=${features}\n`;
      if (isDotnet) {
        content += `\n[dotnet]\n\nproject/assembly_name="${assemblyName}"\n`;
      }
      writeFileSync(projectFile, content, 'utf8');
      if (isDotnet) {
        const sdkVersion = (await this.detectGodotNetSdkVersion()) ?? undefined;
        writeFileSync(join(args.projectPath, `${assemblyName}.csproj`), generateCsprojContent(args.projectName, sdkVersion), 'utf8');
      }
      return { content: [{ type: 'text', text: `Project "${args.projectName}" created at ${args.projectPath}${isDotnet ? ' (Godot .NET / C#)' : ''}` }] };
    } catch (error: any) {
      return createErrorResponse(`Failed to create project: ${error?.message || 'Unknown error'}`);
    }
  }

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

  private async handleCreateCsharpScript(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.scriptPath) return createErrorResponse('projectPath and scriptPath are required.');
    if (!validatePath(args.projectPath) || !validatePath(args.scriptPath)) return createErrorResponse('Invalid path.');
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    if (!this.isDotnetProject(args.projectPath))
      return createErrorResponse('Not a Godot .NET project (no .csproj found). Use create_project with dotnet: true first.');
    if (!/\.cs$/i.test(args.scriptPath))
      return createErrorResponse('scriptPath must end with .cs');
    const fileBase = basename(args.scriptPath).replace(/\.cs$/i, '');
    if (!isValidCsharpIdentifier(fileBase))
      return createErrorResponse(`Invalid C# script file name "${fileBase}.cs": the name must be a valid class name (letters, digits, underscore; not starting with a digit), because Godot requires the class name to match the file name.`);
    if (args.className && args.className !== fileBase)
      return createErrorResponse(`className "${args.className}" must match the script file name "${fileBase}" for Godot to attach the script.`);
    try {
      const fullPath = join(args.projectPath, args.scriptPath);
      const dir = dirname(fullPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      let source = args.source;
      if (!source) {
        source = generateCsharpScriptSource({
          className: fileBase,
          baseClass: args.baseClass,
          namespaceName: args.namespaceName,
          methods: Array.isArray(args.methods) ? args.methods : undefined,
        });
      }
      writeFileSync(fullPath, source, 'utf8');
      return { content: [{ type: 'text', text: `C# script created at ${args.scriptPath}` }] };
    } catch (error: any) {
      return createErrorResponse(`create_csharp_script failed: ${error?.message || 'Unknown error'}`);
    }
  }

  private async handleManageAutoloads(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.action)
      return createErrorResponse('projectPath and action are required.');
    if (!validatePath(args.projectPath))
      return createErrorResponse('Invalid path.');
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile))
      return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    try {
      let content = readFileSync(projectFile, 'utf8');
      if (args.action === 'list') {
        const autoloads: Record<string, string> = {};
        const autoloadMatch = /\[autoload\]([\s\S]*?)(?=\n\[|$)/.exec(content);
        if (autoloadMatch) {
          for (const line of autoloadMatch[1].split('\n')) {
            const kv = /^([^=]+)=(.*)$/.exec(line.trim());
            if (kv) autoloads[kv[1].trim()] = kv[2].trim();
          }
        }
        return { content: [{ type: 'text', text: JSON.stringify(autoloads, null, 2) }] };
      } else if (args.action === 'add') {
        if (!args.name || !args.path)
          return createErrorResponse('name and path are required for add action.');
        const autoloadLine = `${args.name}="*${args.path}"`;
        if (content.includes('[autoload]')) {
          content = content.replace('[autoload]', `[autoload]\n\n${autoloadLine}`);
        } else {
          content += `\n[autoload]\n\n${autoloadLine}\n`;
        }
        writeFileSync(projectFile, content, 'utf8');
        return { content: [{ type: 'text', text: `Autoload "${args.name}" added: ${args.path}` }] };
      } else if (args.action === 'remove') {
        if (!args.name)
          return createErrorResponse('name is required for remove action.');
        const pattern = new RegExp(`\\n?${args.name}\\s*=.*\\n?`, 'g');
        content = content.replace(pattern, '\n');
        writeFileSync(projectFile, content, 'utf8');
        return { content: [{ type: 'text', text: `Autoload "${args.name}" removed.` }] };
      }
      return createErrorResponse('Invalid action. Use "list", "add", or "remove".');
    } catch (error: any) {
      return createErrorResponse(`Failed to manage autoloads: ${error?.message || 'Unknown error'}`);
    }
  }

  private async handleManageInputMap(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.action)
      return createErrorResponse('projectPath and action are required.');
    if (!validatePath(args.projectPath))
      return createErrorResponse('Invalid path.');
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile))
      return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    try {
      let content = readFileSync(projectFile, 'utf8');
      if (args.action === 'list') {
        const actions: Record<string, string> = {};
        const inputMatch = /\[input\]([\s\S]*?)(?=\n\[|$)/.exec(content);
        if (inputMatch) {
          for (const line of inputMatch[1].split('\n')) {
            const kv = /^([^=]+)=(.*)$/.exec(line.trim());
            if (kv) actions[kv[1].trim()] = kv[2].trim();
          }
        }
        return { content: [{ type: 'text', text: JSON.stringify(actions, null, 2) }] };
      } else if (args.action === 'add') {
        if (!args.actionName)
          return createErrorResponse('actionName is required for add action.');
        const deadzone = args.deadzone !== undefined ? args.deadzone : 0.5;
        let events = '';
        if (args.key) {
          events = `, "events": [Object(InputEventKey,"resource_local_to_scene":false,"resource_name":"","device":-1,"window_id":0,"alt_pressed":false,"shift_pressed":false,"ctrl_pressed":false,"meta_pressed":false,"pressed":false,"keycode":0,"physical_keycode":${this.keyNameToScancode(args.key)},"key_label":0,"unicode":0,"location":0,"echo":false,"script":null)]`;
        }
        const inputLine = `${args.actionName}={"deadzone": ${deadzone}${events}}`;
        if (content.includes('[input]')) {
          content = content.replace('[input]', `[input]\n\n${inputLine}`);
        } else {
          content += `\n[input]\n\n${inputLine}\n`;
        }
        writeFileSync(projectFile, content, 'utf8');
        return { content: [{ type: 'text', text: `Input action "${args.actionName}" added.` }] };
      } else if (args.action === 'remove') {
        if (!args.actionName)
          return createErrorResponse('actionName is required for remove action.');
        const pattern = new RegExp(`\\n?${args.actionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=.*\\n?`, 'g');
        content = content.replace(pattern, '\n');
        writeFileSync(projectFile, content, 'utf8');
        return { content: [{ type: 'text', text: `Input action "${args.actionName}" removed.` }] };
      }
      return createErrorResponse('Invalid action. Use "list", "add", or "remove".');
    } catch (error: any) {
      return createErrorResponse(`Failed to manage input map: ${error?.message || 'Unknown error'}`);
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

  private async handleManageExportPresets(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.action)
      return createErrorResponse('projectPath and action are required.');
    if (!validatePath(args.projectPath))
      return createErrorResponse('Invalid path.');
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile))
      return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    const presetsFile = join(args.projectPath, 'export_presets.cfg');
    try {
      if (args.action === 'list') {
        if (!existsSync(presetsFile))
          return { content: [{ type: 'text', text: JSON.stringify({ presets: [] }, null, 2) }] };
        const content = readFileSync(presetsFile, 'utf8');
        const presets: { name: string; platform: string }[] = [];
        const nameMatches = content.matchAll(/name="([^"]+)"/g);
        const platformMatches = content.matchAll(/platform="([^"]+)"/g);
        const names = [...nameMatches].map(m => m[1]);
        const platforms = [...platformMatches].map(m => m[1]);
        for (let i = 0; i < names.length; i++) {
          presets.push({ name: names[i], platform: platforms[i] || 'unknown' });
        }
        return { content: [{ type: 'text', text: JSON.stringify({ presets }, null, 2) }] };
      } else if (args.action === 'add') {
        if (!args.name || !args.platform)
          return createErrorResponse('name and platform are required for add action.');
        const runnable = args.runnable ? 'true' : 'false';
        const presetBlock = `\n[preset.${Date.now()}]\n\nname="${args.name}"\nplatform="${args.platform}"\nrunnable=${runnable}\n`;
        let content = existsSync(presetsFile) ? readFileSync(presetsFile, 'utf8') : '';
        content += presetBlock;
        writeFileSync(presetsFile, content, 'utf8');
        return { content: [{ type: 'text', text: `Export preset "${args.name}" added for platform "${args.platform}".` }] };
      } else if (args.action === 'remove') {
        if (!args.name)
          return createErrorResponse('name is required for remove action.');
        if (!existsSync(presetsFile))
          return createErrorResponse('No export_presets.cfg file found.');
        let content = readFileSync(presetsFile, 'utf8');
        // Remove the preset section containing the given name
        const pattern = new RegExp(`\\[preset\\.[^\\]]+\\]\\s*\\n[\\s\\S]*?name="${args.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[\\s\\S]*?(?=\\[preset\\.|$)`, 'g');
        content = content.replace(pattern, '');
        writeFileSync(presetsFile, content, 'utf8');
        return { content: [{ type: 'text', text: `Export preset "${args.name}" removed.` }] };
      }
      return createErrorResponse('Invalid action. Use "list", "add", or "remove".');
    } catch (error: any) {
      return createErrorResponse(`Failed to manage export presets: ${error?.message || 'Unknown error'}`);
    }
  }

  // --- Advanced runtime handlers ---

  private async handleGameGetCamera() {
    return this.gameCommand('get_camera', {}, () => ({}));
  }

  private async handleGameSetCamera(args: any) {
    return this.gameCommand('set_camera', args, a => ({
      ...(a.position ? { position: a.position } : {}),
      ...(a.rotation ? { rotation: a.rotation } : {}),
      ...(a.zoom ? { zoom: a.zoom } : {}),
      ...(a.fov !== undefined ? { fov: a.fov } : {}),
    }));
  }

  private async handleGameRaycast(args: any) {
    args = normalizeParameters(args || {});
    if (!args.from || !args.to)
      return createErrorResponse('from and to are required.');
    return this.gameCommand('raycast', args, a => ({
      from: a.from, to: a.to, collision_mask: a.collisionMask ?? 0xFFFFFFFF,
    }));
  }

  private async handleGameGetAudio() {
    return this.gameCommand('get_audio', {}, () => ({}));
  }

  private async handleGameSpawnNode(args: any) {
    args = normalizeParameters(args || {});
    if (!args.type)
      return createErrorResponse('type is required.');
    return this.gameCommand('spawn_node', args, a => ({
      type: a.type, name: a.name || '', parent_path: a.parentPath || '/root',
      ...(a.properties ? { properties: a.properties } : {}),
    }));
  }

  private async handleGameSetShaderParam(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.paramName)
      return createErrorResponse('nodePath and paramName are required.');
    return this.gameCommand('set_shader_param', args, a => ({
      node_path: a.nodePath, param_name: a.paramName, value: a.value,
      ...(a.typeHint ? { type_hint: a.typeHint } : {}),
    }));
  }

  private async handleGameAudioPlay(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath)
      return createErrorResponse('nodePath is required.');
    return this.gameCommand('audio_play', args, a => ({
      node_path: a.nodePath, action: a.action || 'play',
      ...(a.stream ? { stream: a.stream } : {}),
      ...(a.volume !== undefined ? { volume: a.volume } : {}),
      ...(a.pitch !== undefined ? { pitch: a.pitch } : {}),
      ...(a.bus ? { bus: a.bus } : {}),
      ...(a.fromPosition !== undefined ? { from_position: a.fromPosition } : {}),
    }));
  }

  private async handleGameAudioBus(args: any) {
    return this.gameCommand('audio_bus', args, a => ({
      bus_name: a.busName || 'Master',
      ...(a.volume !== undefined ? { volume: a.volume } : {}),
      ...(a.mute !== undefined ? { mute: a.mute } : {}),
      ...(a.solo !== undefined ? { solo: a.solo } : {}),
    }));
  }

  private async handleGameNavigatePath(args: any) {
    args = normalizeParameters(args || {});
    if (!args.start || !args.end)
      return createErrorResponse('start and end are required.');
    return this.gameCommand('navigate_path', args, a => ({
      start: a.start, end: a.end, optimize: a.optimize ?? true,
    }));
  }

  private async handleGameTilemap(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath)
      return createErrorResponse('nodePath is required.');
    if (!args.action)
      return createErrorResponse('action is required.');
    return this.gameCommand('tilemap', args, a => ({
      node_path: a.nodePath, action: a.action,
      ...(a.x !== undefined ? { x: a.x } : {}),
      ...(a.y !== undefined ? { y: a.y } : {}),
      ...(a.cells ? { cells: a.cells } : {}),
      ...(a.sourceId !== undefined ? { source_id: a.sourceId } : {}),
    }));
  }

  private async handleGameAddCollision(args: any) {
    args = normalizeParameters(args || {});
    if (!args.parentPath || !args.shapeType)
      return createErrorResponse('parentPath and shapeType are required.');
    return this.gameCommand('add_collision', args, a => ({
      parent_path: a.parentPath, shape_type: a.shapeType,
      ...(a.shapeParams ? { shape_params: a.shapeParams } : {}),
      ...(a.collisionLayer !== undefined ? { collision_layer: a.collisionLayer } : {}),
      ...(a.collisionMask !== undefined ? { collision_mask: a.collisionMask } : {}),
      ...(a.disabled !== undefined ? { disabled: a.disabled } : {}),
    }));
  }

  private async handleGameEnvironment(args: any) {
    args = normalizeParameters(args || {});
    const params: Record<string, any> = { action: args.action || 'set' };
    // Pass through all environment settings
    const envKeys = [
      'backgroundMode', 'backgroundColor', 'ambientLightColor', 'ambientLightEnergy',
      'fogEnabled', 'fogDensity', 'fogLightColor',
      'glowEnabled', 'glowIntensity', 'glowBloom',
      'tonemapMode', 'ssaoEnabled', 'ssaoRadius', 'ssaoIntensity', 'ssrEnabled',
      'brightness', 'contrast', 'saturation',
    ];
    const snakeMap: Record<string, string> = {
      backgroundMode: 'background_mode', backgroundColor: 'background_color',
      ambientLightColor: 'ambient_light_color', ambientLightEnergy: 'ambient_light_energy',
      fogEnabled: 'fog_enabled', fogDensity: 'fog_density', fogLightColor: 'fog_light_color',
      glowEnabled: 'glow_enabled', glowIntensity: 'glow_intensity', glowBloom: 'glow_bloom',
      tonemapMode: 'tonemap_mode', ssaoEnabled: 'ssao_enabled', ssaoRadius: 'ssao_radius',
      ssaoIntensity: 'ssao_intensity', ssrEnabled: 'ssr_enabled',
      brightness: 'brightness', contrast: 'contrast', saturation: 'saturation',
    };
    for (const key of envKeys) {
      if (args[key] !== undefined) {
        params[snakeMap[key]] = args[key];
      }
    }
    return this.gameCommand('environment', { ...args }, () => params);
  }

  private async handleGameManageGroup(args: any) {
    args = normalizeParameters(args || {});
    if (!args.action)
      return createErrorResponse('action is required.');
    return this.gameCommand('manage_group', args, a => ({
      action: a.action,
      ...(a.nodePath ? { node_path: a.nodePath } : {}),
      ...(a.group ? { group: a.group } : {}),
    }));
  }

  private async handleGameCreateTimer(args: any) {
    return this.gameCommand('create_timer', args, a => ({
      parent_path: a.parentPath || '/root',
      wait_time: a.waitTime ?? 1.0,
      one_shot: a.oneShot ?? false,
      autostart: a.autostart ?? false,
      ...(a.name ? { name: a.name } : {}),
    }));
  }

  private async handleGameSetParticles(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath)
      return createErrorResponse('nodePath is required.');
    return this.gameCommand('set_particles', args, a => ({
      node_path: a.nodePath,
      ...(a.emitting !== undefined ? { emitting: a.emitting } : {}),
      ...(a.amount !== undefined ? { amount: a.amount } : {}),
      ...(a.lifetime !== undefined ? { lifetime: a.lifetime } : {}),
      ...(a.oneShot !== undefined ? { one_shot: a.oneShot } : {}),
      ...(a.speedScale !== undefined ? { speed_scale: a.speedScale } : {}),
      ...(a.explosiveness !== undefined ? { explosiveness: a.explosiveness } : {}),
      ...(a.randomness !== undefined ? { randomness: a.randomness } : {}),
      ...(a.processMaterial ? { process_material: a.processMaterial } : {}),
    }));
  }

  private async handleGameCreateAnimation(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.animationName)
      return createErrorResponse('nodePath and animationName are required.');
    return this.gameCommand('create_animation', args, a => ({
      node_path: a.nodePath,
      animation_name: a.animationName,
      length: a.length ?? 1.0,
      loop_mode: a.loopMode ?? 0,
      tracks: a.tracks || [],
      ...(a.library !== undefined ? { library: a.library } : {}),
    }));
  }

  private async handleExportProject(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.presetName || !args.outputPath)
      return createErrorResponse('projectPath, presetName, and outputPath are required.');
    if (!validatePath(args.projectPath))
      return createErrorResponse('Invalid project path.');
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile))
      return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    if (!this.godotPath) {
      await this.detectGodotPath();
      if (!this.godotPath) return createErrorResponse('Could not find Godot executable.');
    }
    try {
      const exportFlag = args.debug ? '--export-debug' : '--export-release';
      const exportArgs = ['--headless', '--path', args.projectPath, exportFlag, args.presetName, args.outputPath];
      const { stdout, stderr } = await execFileAsync(this.godotPath, exportArgs, { timeout: 120000 });
      if (stderr && stderr.includes('ERROR'))
        return createErrorResponse(`Export failed: ${stderr}`);
      return { content: [{ type: 'text', text: `Export succeeded.\n\nOutput: ${stdout || args.outputPath}` }] };
    } catch (error: any) {
      return createErrorResponse(`Export failed: ${error?.message || 'Unknown error'}`);
    }
  }

  private async handleGameSerializeState(args: any) {
    args = normalizeParameters(args || {});
    return this.gameCommand('serialize_state', args, a => ({
      node_path: a.nodePath || '/root',
      action: a.action || 'save',
      max_depth: a.maxDepth ?? 5,
      ...(a.data ? { data: a.data } : {}),
    }));
  }

  private async handleGamePhysicsBody(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath)
      return createErrorResponse('nodePath is required.');
    return this.gameCommand('physics_body', args, a => ({
      node_path: a.nodePath,
      ...(a.gravityScale !== undefined ? { gravity_scale: a.gravityScale } : {}),
      ...(a.mass !== undefined ? { mass: a.mass } : {}),
      ...(a.linearVelocity ? { linear_velocity: a.linearVelocity } : {}),
      ...(a.angularVelocity !== undefined ? { angular_velocity: a.angularVelocity } : {}),
      ...(a.linearDamp !== undefined ? { linear_damp: a.linearDamp } : {}),
      ...(a.angularDamp !== undefined ? { angular_damp: a.angularDamp } : {}),
      ...(a.friction !== undefined ? { friction: a.friction } : {}),
      ...(a.bounce !== undefined ? { bounce: a.bounce } : {}),
      ...(a.freeze !== undefined ? { freeze: a.freeze } : {}),
      ...(a.sleeping !== undefined ? { sleeping: a.sleeping } : {}),
    }));
  }

  private async handleGameCreateJoint(args: any) {
    args = normalizeParameters(args || {});
    if (!args.parentPath || !args.jointType)
      return createErrorResponse('parentPath and jointType are required.');
    return this.gameCommand('create_joint', args, a => ({
      parent_path: a.parentPath,
      joint_type: a.jointType,
      ...(a.nodeAPath ? { node_a_path: a.nodeAPath } : {}),
      ...(a.nodeBPath ? { node_b_path: a.nodeBPath } : {}),
      ...(a.stiffness !== undefined ? { stiffness: a.stiffness } : {}),
      ...(a.damping !== undefined ? { damping: a.damping } : {}),
      ...(a.length !== undefined ? { length: a.length } : {}),
      ...(a.restLength !== undefined ? { rest_length: a.restLength } : {}),
      ...(a.softness !== undefined ? { softness: a.softness } : {}),
      ...(a.initialOffset !== undefined ? { initial_offset: a.initialOffset } : {}),
    }));
  }

  private async handleGameBonePose(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath)
      return createErrorResponse('nodePath is required.');
    return this.gameCommand('bone_pose', args, a => ({
      node_path: a.nodePath,
      action: a.action || 'list',
      ...(a.boneIndex !== undefined ? { bone_index: a.boneIndex } : {}),
      ...(a.boneName ? { bone_name: a.boneName } : {}),
      ...(a.position ? { position: a.position } : {}),
      ...(a.rotation ? { rotation: a.rotation } : {}),
      ...(a.scale ? { scale: a.scale } : {}),
    }));
  }

  private async handleGameUiTheme(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.overrides)
      return createErrorResponse('nodePath and overrides are required.');
    return this.gameCommand('ui_theme', args, a => ({
      node_path: a.nodePath,
      overrides: a.overrides,
    }));
  }

  private async handleGameViewport(args: any) {
    args = normalizeParameters(args || {});
    return this.gameCommand('viewport', args, a => ({
      action: a.action || 'create',
      ...(a.parentPath ? { parent_path: a.parentPath } : {}),
      ...(a.nodePath ? { node_path: a.nodePath } : {}),
      ...(a.width !== undefined ? { width: a.width } : {}),
      ...(a.height !== undefined ? { height: a.height } : {}),
      ...(a.msaa !== undefined ? { msaa: a.msaa } : {}),
      ...(a.transparentBg !== undefined ? { transparent_bg: a.transparentBg } : {}),
      ...(a.name ? { name: a.name } : {}),
    }));
  }

  private async handleGameDebugDraw(args: any) {
    args = normalizeParameters(args || {});
    if (!args.action)
      return createErrorResponse('action is required.');
    return this.gameCommand('debug_draw', args, a => ({
      action: a.action,
      ...(a.from ? { from: a.from } : {}),
      ...(a.to ? { to: a.to } : {}),
      ...(a.center ? { center: a.center } : {}),
      ...(a.radius !== undefined ? { radius: a.radius } : {}),
      ...(a.size ? { size: a.size } : {}),
      ...(a.color ? { color: a.color } : {}),
      ...(a.duration !== undefined ? { duration: a.duration } : {}),
    }));
  }

  // --- Batch 1: Networking + Input + System + Signals + Script ---
  private async handleGameHttpRequest(args: any) {
    args = normalizeParameters(args || {});
    if (!args.url) return createErrorResponse('url is required.');
    return this.gameCommand('http_request', args, a => ({
      url: a.url, method: a.method || 'GET',
      ...(a.headers ? { headers: a.headers } : {}),
      ...(a.body ? { body: a.body } : {}),
      ...(a.timeout !== undefined ? { timeout: a.timeout } : {}),
    }), 35000);
  }

  private async handleGameWebsocket(args: any) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    return this.gameCommand('websocket', args, a => ({
      action: a.action,
      ...(a.url ? { url: a.url } : {}),
      ...(a.message ? { message: a.message } : {}),
    }), 15000);
  }

  private async handleGameMultiplayer(args: any) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    return this.gameCommand('multiplayer', args, a => ({
      action: a.action,
      ...(a.port !== undefined ? { port: a.port } : {}),
      ...(a.address ? { address: a.address } : {}),
      ...(a.maxClients !== undefined ? { max_clients: a.maxClients } : {}),
    }));
  }

  private async handleGameRpc(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.action || !args.method) return createErrorResponse('nodePath, action, and method are required.');
    return this.gameCommand('rpc', args, a => ({
      node_path: a.nodePath, action: a.action, method: a.method,
      ...(a.args ? { args: a.args } : {}),
      ...(a.mode ? { mode: a.mode } : {}),
      ...(a.sync !== undefined ? { sync: a.sync } : {}),
      ...(a.channel !== undefined ? { channel: a.channel } : {}),
    }));
  }

  private async handleGameTouch(args: any) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    return this.gameCommand('touch', args, a => ({
      action: a.action, x: a.x ?? 0, y: a.y ?? 0,
      ...(a.index !== undefined ? { index: a.index } : {}),
      ...(a.toX !== undefined ? { to_x: a.toX } : {}),
      ...(a.toY !== undefined ? { to_y: a.toY } : {}),
      ...(a.steps !== undefined ? { steps: a.steps } : {}),
    }), 15000);
  }

  private async handleGameInputState(args: any) {
    args = normalizeParameters(args || {});
    return this.gameCommand('input_state', args, a => ({
      action: a.action || 'query',
      ...(a.x !== undefined ? { x: a.x } : {}),
      ...(a.y !== undefined ? { y: a.y } : {}),
      ...(a.mouseMode ? { mouse_mode: a.mouseMode } : {}),
    }));
  }

  private async handleGameInputAction(args: any) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    return this.gameCommand('input_action', args, a => ({
      action: a.action,
      ...(a.actionName ? { action_name: a.actionName } : {}),
      ...(a.strength !== undefined ? { strength: a.strength } : {}),
      ...(a.key ? { key: a.key } : {}),
    }));
  }

  private async handleGameListSignals(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath) return createErrorResponse('nodePath is required.');
    return this.gameCommand('list_signals', args, a => ({ node_path: a.nodePath }));
  }

  private async handleGameAwaitSignal(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.signalName) return createErrorResponse('nodePath and signalName are required.');
    const timeout = (args.timeout || 10) * 1000 + 2000;
    return this.gameCommand('await_signal', args, a => ({
      node_path: a.nodePath, signal_name: a.signalName, timeout: a.timeout || 10,
    }), timeout);
  }

  private async handleGameScript(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
    return this.gameCommand('script', args, a => ({
      node_path: a.nodePath, action: a.action,
      ...(a.source ? { source: a.source } : {}),
      ...(a.className ? { class_name: a.className } : {}),
    }));
  }

  private async handleGameWindow(args: any) {
    args = normalizeParameters(args || {});
    return this.gameCommand('window', args, a => ({
      action: a.action || 'get',
      ...(a.width !== undefined ? { width: a.width } : {}),
      ...(a.height !== undefined ? { height: a.height } : {}),
      ...(a.fullscreen !== undefined ? { fullscreen: a.fullscreen } : {}),
      ...(a.borderless !== undefined ? { borderless: a.borderless } : {}),
      ...(a.title ? { title: a.title } : {}),
      ...(a.position ? { position: a.position } : {}),
      ...(a.vsync !== undefined ? { vsync: a.vsync } : {}),
    }));
  }

  private async handleGameOsInfo(_args: any) {
    return this.gameCommand('os_info', {}, () => ({}));
  }

  private async handleGameTimeScale(args: any) {
    args = normalizeParameters(args || {});
    return this.gameCommand('time_scale', args, a => ({
      action: a.action || 'get',
      ...(a.timeScale !== undefined ? { time_scale: a.timeScale } : {}),
    }));
  }

  private async handleGameProcessMode(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.mode) return createErrorResponse('nodePath and mode are required.');
    return this.gameCommand('process_mode', args, a => ({
      node_path: a.nodePath, mode: a.mode,
    }));
  }

  private async handleGameWorldSettings(args: any) {
    args = normalizeParameters(args || {});
    return this.gameCommand('world_settings', args, a => ({
      action: a.action || 'get',
      ...(a.gravity !== undefined ? { gravity: a.gravity } : {}),
      ...(a.gravityDirection ? { gravity_direction: a.gravityDirection } : {}),
      ...(a.physicsFps !== undefined ? { physics_fps: a.physicsFps } : {}),
    }));
  }

  // --- Batch 2: 3D Rendering + Lighting + Sky + Physics ---
  private async handleGameCsg(args: any) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    return this.gameCommand('csg', args, a => ({
      action: a.action,
      ...(a.parentPath ? { parent_path: a.parentPath } : {}),
      ...(a.csgType ? { csg_type: a.csgType } : {}),
      ...(a.nodePath ? { node_path: a.nodePath } : {}),
      ...(a.operation ? { operation: a.operation } : {}),
      ...(a.size ? { size: a.size } : {}),
      ...(a.radius !== undefined ? { radius: a.radius } : {}),
      ...(a.height !== undefined ? { height: a.height } : {}),
      ...(a.material ? { material: a.material } : {}),
      ...(a.name ? { name: a.name } : {}),
    }));
  }

  private async handleGameMultimesh(args: any) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    return this.gameCommand('multimesh', args, a => ({
      action: a.action,
      ...(a.parentPath ? { parent_path: a.parentPath } : {}),
      ...(a.nodePath ? { node_path: a.nodePath } : {}),
      ...(a.meshType ? { mesh_type: a.meshType } : {}),
      ...(a.count !== undefined ? { count: a.count } : {}),
      ...(a.index !== undefined ? { index: a.index } : {}),
      ...(a.transform ? { transform: a.transform } : {}),
      ...(a.name ? { name: a.name } : {}),
    }));
  }

  private async handleGameProceduralMesh(args: any) {
    args = normalizeParameters(args || {});
    if (!args.parentPath || !args.vertices) return createErrorResponse('parentPath and vertices are required.');
    return this.gameCommand('procedural_mesh', args, a => ({
      parent_path: a.parentPath, vertices: a.vertices,
      ...(a.normals ? { normals: a.normals } : {}),
      ...(a.uvs ? { uvs: a.uvs } : {}),
      ...(a.indices ? { indices: a.indices } : {}),
      ...(a.name ? { name: a.name } : {}),
    }));
  }

  private async handleGameLight3d(args: any) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    return this.gameCommand('light_3d', args, a => ({
      action: a.action,
      ...(a.parentPath ? { parent_path: a.parentPath } : {}),
      ...(a.lightType ? { light_type: a.lightType } : {}),
      ...(a.nodePath ? { node_path: a.nodePath } : {}),
      ...(a.color ? { color: a.color } : {}),
      ...(a.energy !== undefined ? { energy: a.energy } : {}),
      ...(a.range !== undefined ? { range: a.range } : {}),
      ...(a.shadows !== undefined ? { shadows: a.shadows } : {}),
      ...(a.spotAngle !== undefined ? { spot_angle: a.spotAngle } : {}),
      ...(a.name ? { name: a.name } : {}),
    }));
  }

  private async handleGameMeshInstance(args: any) {
    args = normalizeParameters(args || {});
    if (!args.parentPath || !args.meshType) return createErrorResponse('parentPath and meshType are required.');
    return this.gameCommand('mesh_instance', args, a => ({
      parent_path: a.parentPath, mesh_type: a.meshType,
      ...(a.size ? { size: a.size } : {}),
      ...(a.radius !== undefined ? { radius: a.radius } : {}),
      ...(a.height !== undefined ? { height: a.height } : {}),
      ...(a.material ? { material: a.material } : {}),
      ...(a.name ? { name: a.name } : {}),
    }));
  }

  private async handleGameGridmap(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
    return this.gameCommand('gridmap', args, a => ({
      node_path: a.nodePath, action: a.action,
      ...(a.x !== undefined ? { x: a.x } : {}),
      ...(a.y !== undefined ? { y: a.y } : {}),
      ...(a.z !== undefined ? { z: a.z } : {}),
      ...(a.item !== undefined ? { item: a.item } : {}),
      ...(a.orientation !== undefined ? { orientation: a.orientation } : {}),
    }));
  }

  private async handleGame3dEffects(args: any) {
    args = normalizeParameters(args || {});
    if (!args.parentPath || !args.effectType) return createErrorResponse('parentPath and effectType are required.');
    return this.gameCommand('3d_effects', args, a => ({
      parent_path: a.parentPath, effect_type: a.effectType,
      ...(a.size ? { size: a.size } : {}),
      ...(a.intensity !== undefined ? { intensity: a.intensity } : {}),
      ...(a.name ? { name: a.name } : {}),
    }));
  }

  private async handleGameGi(args: any) {
    args = normalizeParameters(args || {});
    if (!args.parentPath || !args.giType) return createErrorResponse('parentPath and giType are required.');
    return this.gameCommand('gi', args, a => ({
      parent_path: a.parentPath, gi_type: a.giType,
      ...(a.size ? { size: a.size } : {}),
      ...(a.name ? { name: a.name } : {}),
    }));
  }

  private async handleGamePath3d(args: any) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    return this.gameCommand('path_3d', args, a => ({
      action: a.action,
      ...(a.parentPath ? { parent_path: a.parentPath } : {}),
      ...(a.nodePath ? { node_path: a.nodePath } : {}),
      ...(a.points ? { points: a.points } : {}),
      ...(a.point ? { point: a.point } : {}),
      ...(a.name ? { name: a.name } : {}),
    }));
  }

  private async handleGameSky(args: any) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    return this.gameCommand('sky', args, a => ({
      action: a.action,
      ...(a.skyType ? { sky_type: a.skyType } : {}),
      ...(a.topColor ? { top_color: a.topColor } : {}),
      ...(a.bottomColor ? { bottom_color: a.bottomColor } : {}),
      ...(a.sunEnergy !== undefined ? { sun_energy: a.sunEnergy } : {}),
      ...(a.groundColor ? { ground_color: a.groundColor } : {}),
    }));
  }

  private async handleGameCameraAttributes(args: any) {
    args = normalizeParameters(args || {});
    return this.gameCommand('camera_attributes', args, a => ({
      action: a.action || 'get',
      ...(a.dofBlurFar !== undefined ? { dof_blur_far: a.dofBlurFar } : {}),
      ...(a.dofBlurNear !== undefined ? { dof_blur_near: a.dofBlurNear } : {}),
      ...(a.dofBlurAmount !== undefined ? { dof_blur_amount: a.dofBlurAmount } : {}),
      ...(a.exposureMultiplier !== undefined ? { exposure_multiplier: a.exposureMultiplier } : {}),
      ...(a.autoExposure !== undefined ? { auto_exposure: a.autoExposure } : {}),
      ...(a.autoExposureScale !== undefined ? { auto_exposure_scale: a.autoExposureScale } : {}),
    }));
  }

  private async handleGameNavigation3d(args: any) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    return this.gameCommand('navigation_3d', args, a => ({
      action: a.action,
      ...(a.parentPath ? { parent_path: a.parentPath } : {}),
      ...(a.nodePath ? { node_path: a.nodePath } : {}),
      ...(a.cellSize !== undefined ? { cell_size: a.cellSize } : {}),
      ...(a.agentRadius !== undefined ? { agent_radius: a.agentRadius } : {}),
      ...(a.agentHeight !== undefined ? { agent_height: a.agentHeight } : {}),
      ...(a.name ? { name: a.name } : {}),
    }), 30000);
  }

  private async handleGamePhysics3d(args: any) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    return this.gameCommand('physics_3d', args, a => ({
      action: a.action,
      ...(a.nodePath ? { node_path: a.nodePath } : {}),
      ...(a.from ? { from: a.from } : {}),
      ...(a.to ? { to: a.to } : {}),
      ...(a.collisionMask !== undefined ? { collision_mask: a.collisionMask } : {}),
    }), 15000);
  }

  // --- Batch 3: 2D Systems + Animation Advanced + Audio Effects ---
  private async handleGameCanvas(args: any) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    return this.gameCommand('canvas', args, a => ({
      action: a.action,
      ...(a.parentPath ? { parent_path: a.parentPath } : {}),
      ...(a.nodePath ? { node_path: a.nodePath } : {}),
      ...(a.layer !== undefined ? { layer: a.layer } : {}),
      ...(a.offset ? { offset: a.offset } : {}),
      ...(a.visible !== undefined ? { visible: a.visible } : {}),
      ...(a.color ? { color: a.color } : {}),
      ...(a.name ? { name: a.name } : {}),
    }));
  }

  private async handleGameCanvasDraw(args: any) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    return this.gameCommand('canvas_draw', args, a => ({
      action: a.action,
      ...(a.parentPath ? { parent_path: a.parentPath } : {}),
      ...(a.from ? { from: a.from } : {}),
      ...(a.to ? { to: a.to } : {}),
      ...(a.center ? { center: a.center } : {}),
      ...(a.radius !== undefined ? { radius: a.radius } : {}),
      ...(a.rect ? { rect: a.rect } : {}),
      ...(a.points ? { points: a.points } : {}),
      ...(a.position ? { position: a.position } : {}),
      ...(a.text ? { text: a.text } : {}),
      ...(a.fontSize !== undefined ? { font_size: a.fontSize } : {}),
      ...(a.color ? { color: a.color } : {}),
      ...(a.width !== undefined ? { width: a.width } : {}),
      ...(a.filled !== undefined ? { filled: a.filled } : {}),
    }));
  }

  private async handleGameLight2d(args: any) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    return this.gameCommand('light_2d', args, a => ({
      action: a.action,
      ...(a.parentPath ? { parent_path: a.parentPath } : {}),
      ...(a.nodePath ? { node_path: a.nodePath } : {}),
      ...(a.color ? { color: a.color } : {}),
      ...(a.energy !== undefined ? { energy: a.energy } : {}),
      ...(a.range !== undefined ? { range: a.range } : {}),
      ...(a.points ? { points: a.points } : {}),
      ...(a.name ? { name: a.name } : {}),
    }));
  }

  private async handleGameParallax(args: any) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    return this.gameCommand('parallax', args, a => ({
      action: a.action,
      ...(a.parentPath ? { parent_path: a.parentPath } : {}),
      ...(a.nodePath ? { node_path: a.nodePath } : {}),
      ...(a.motionScale ? { motion_scale: a.motionScale } : {}),
      ...(a.motionOffset ? { motion_offset: a.motionOffset } : {}),
      ...(a.mirroring ? { mirroring: a.mirroring } : {}),
      ...(a.scrollOffset ? { scroll_offset: a.scrollOffset } : {}),
      ...(a.scrollBaseOffset ? { scroll_base_offset: a.scrollBaseOffset } : {}),
      ...(a.name ? { name: a.name } : {}),
    }));
  }

  private async handleGameShape2d(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
    return this.gameCommand('shape_2d', args, a => ({
      node_path: a.nodePath, action: a.action,
      ...(a.points ? { points: a.points } : {}),
      ...(a.point ? { point: a.point } : {}),
      ...(a.width !== undefined ? { width: a.width } : {}),
      ...(a.color ? { color: a.color } : {}),
    }));
  }

  private async handleGamePath2d(args: any) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    return this.gameCommand('path_2d', args, a => ({
      action: a.action,
      ...(a.parentPath ? { parent_path: a.parentPath } : {}),
      ...(a.nodePath ? { node_path: a.nodePath } : {}),
      ...(a.points ? { points: a.points } : {}),
      ...(a.point ? { point: a.point } : {}),
      ...(a.name ? { name: a.name } : {}),
    }));
  }

  private async handleGamePhysics2d(args: any) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    return this.gameCommand('physics_2d', args, a => ({
      action: a.action,
      ...(a.nodePath ? { node_path: a.nodePath } : {}),
      ...(a.from ? { from: a.from } : {}),
      ...(a.to ? { to: a.to } : {}),
      ...(a.position ? { position: a.position } : {}),
      ...(a.point ? { point: a.point } : {}),
      ...(a.radius !== undefined ? { radius: a.radius } : {}),
      ...(a.size ? { size: a.size } : {}),
      ...(a.shapeType ? { shape_type: a.shapeType } : {}),
      ...(a.maxResults !== undefined ? { max_results: a.maxResults } : {}),
      ...(a.collideWithAreas !== undefined ? { collide_with_areas: a.collideWithAreas } : {}),
      ...(a.collideWithBodies !== undefined ? { collide_with_bodies: a.collideWithBodies } : {}),
      ...(a.collisionMask !== undefined ? { collision_mask: a.collisionMask } : {}),
    }), 15000);
  }

  private async handleGameAnimationTree(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
    return this.gameCommand('animation_tree', args, a => ({
      node_path: a.nodePath, action: a.action,
      ...(a.stateName ? { state_name: a.stateName } : {}),
      ...(a.paramName ? { param_name: a.paramName } : {}),
      ...(a.paramValue !== undefined ? { param_value: a.paramValue } : {}),
    }));
  }

  private async handleGameAnimationControl(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
    return this.gameCommand('animation_control', args, a => ({
      node_path: a.nodePath, action: a.action,
      ...(a.animationName ? { animation_name: a.animationName } : {}),
      ...(a.position !== undefined ? { position: a.position } : {}),
      ...(a.speed !== undefined ? { speed: a.speed } : {}),
    }));
  }

  private async handleGameSkeletonIk(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
    return this.gameCommand('skeleton_ik', args, a => ({
      node_path: a.nodePath, action: a.action,
      ...(a.target ? { target: a.target } : {}),
    }));
  }

  private async handleGameAudioEffect(args: any) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    return this.gameCommand('audio_effect', args, a => ({
      action: a.action, bus_name: a.busName || 'Master',
      ...(a.effectType ? { effect_type: a.effectType } : {}),
      ...(a.index !== undefined ? { index: a.index } : {}),
      ...(a.properties ? { properties: a.properties } : {}),
      ...(a.enabled !== undefined ? { enabled: a.enabled } : {}),
    }));
  }

  private async handleGameAudioBusLayout(args: any) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    return this.gameCommand('audio_bus_layout', args, a => ({
      action: a.action,
      ...(a.busName ? { bus_name: a.busName } : {}),
      ...(a.sendTo ? { send_to: a.sendTo } : {}),
      ...(a.index !== undefined ? { index: a.index } : {}),
    }));
  }

  private async handleGameAudioSpatial(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
    return this.gameCommand('audio_spatial', args, a => ({
      node_path: a.nodePath, action: a.action,
      ...(a.maxDistance !== undefined ? { max_distance: a.maxDistance } : {}),
      ...(a.unitSize !== undefined ? { unit_size: a.unitSize } : {}),
      ...(a.maxDb !== undefined ? { max_db: a.maxDb } : {}),
      ...(a.attenuationModel ? { attenuation_model: a.attenuationModel } : {}),
    }));
  }

  // --- Batch 4: Editor/Headless + Localization + Resource ---
  private async handleRenameFile(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.filePath || !args.newPath) return createErrorResponse('projectPath, filePath, and newPath are required.');
    if (!validatePath(args.projectPath) || !validatePath(args.filePath) || !validatePath(args.newPath)) return createErrorResponse('Invalid path.');
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    const srcFull = join(args.projectPath, args.filePath);
    const dstFull = join(args.projectPath, args.newPath);
    if (!existsSync(srcFull)) return createErrorResponse(`File not found: ${args.filePath}`);
    try {
      const dstDir = dirname(dstFull);
      if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true });
      renameSync(srcFull, dstFull);
      return { content: [{ type: 'text', text: `Renamed ${args.filePath} → ${args.newPath}` }] };
    } catch (error: any) {
      return createErrorResponse(`rename_file failed: ${error?.message || 'Unknown error'}`);
    }
  }

  private async handleManageResource(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.resourcePath || !args.action) return createErrorResponse('projectPath, resourcePath, and action are required.');
    return this.headlessOp('manage_resource', args, a => ({
      projectPath: a.projectPath,
      params: { resourcePath: a.resourcePath, action: a.action, ...(a.properties ? { properties: a.properties } : {}) },
    }));
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

  private async handleValidateScript(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.scriptPath) return createErrorResponse('projectPath and scriptPath are required.');
    if (!validatePath(args.projectPath) || !validatePath(args.scriptPath)) return createErrorResponse('Invalid path.');
    if (!/\.gd$/i.test(args.scriptPath)) return createErrorResponse('validate_script only checks GDScript (.gd) files.');
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    const scriptFull = join(args.projectPath, args.scriptPath);
    if (!existsSync(scriptFull)) return createErrorResponse(`Script does not exist: ${args.scriptPath}`);
    if (!this.godotPath) {
      await this.detectGodotPath();
      if (!this.godotPath) return createErrorResponse('Could not find a valid Godot executable path');
    }
    const check = await this.runGdScriptCheck(args.projectPath, scriptFull);
    if (!check.completed)
      return createErrorResponse(`validate_script could not check the script; ${check.error}`);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ valid: check.errors.length === 0, scriptPath: args.scriptPath, errorCount: check.errors.length, errors: check.errors }, null, 2),
        },
      ],
    };
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

  private async handleValidateScripts(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath) return createErrorResponse('projectPath is required.');
    if (!validatePath(args.projectPath)) return createErrorResponse('Invalid path.');
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    if (!this.godotPath) {
      await this.detectGodotPath();
      if (!this.godotPath) return createErrorResponse('Could not find a valid Godot executable path');
    }

    let scope: string;
    let candidates: string[];
    const explicit = Array.isArray(args.scriptPaths) && args.scriptPaths.length > 0;
    if (explicit) {
      scope = 'explicit';
      candidates = args.scriptPaths.map((p: any) => String(p));
    } else if (args.scope === undefined || args.scope === 'changed') {
      scope = 'changed';
      const changed = await this.listChangedGdFiles(args.projectPath);
      if (changed.error) return createErrorResponse(changed.error);
      candidates = changed.files!;
    } else if (args.scope === 'all') {
      scope = 'all';
      candidates = this.listAllGdFiles(args.projectPath);
    } else {
      return createErrorResponse(`Invalid scope "${args.scope}". Use "changed" or "all", or pass scriptPaths.`);
    }

    const results: any[] = [];
    let filesWithErrors = 0;
    const toCheck: string[] = [];
    for (const rel of candidates) {
      if (!/\.gd$/i.test(rel) || !validatePath(rel)) {
        if (explicit) results.push({ scriptPath: rel, checked: false, error: 'Not a valid .gd path' });
        continue;
      }
      if (!existsSync(join(args.projectPath, rel))) {
        if (explicit) results.push({ scriptPath: rel, checked: false, error: 'Script does not exist' });
        continue;
      }
      toCheck.push(rel);
    }

    const MAX_BATCH = 60;
    if (toCheck.length > MAX_BATCH)
      return createErrorResponse(`Too many scripts to validate (${toCheck.length} > ${MAX_BATCH}). Narrow the scope or pass an explicit scriptPaths list.`);

    for (const rel of toCheck) {
      const check = await this.runGdScriptCheck(args.projectPath, join(args.projectPath, rel));
      if (!check.completed) {
        results.push({ scriptPath: rel, checked: false, error: check.error });
      } else {
        if (check.errors.length > 0) filesWithErrors++;
        results.push({ scriptPath: rel, checked: true, valid: check.errors.length === 0, errorCount: check.errors.length, errors: check.errors });
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            scope,
            fileCount: results.length,
            filesWithErrors,
            allValid: filesWithErrors === 0 && results.every(r => r.checked !== false),
            results,
          }, null, 2),
        },
      ],
    };
  }

  private async handleCreateScript(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.scriptPath) return createErrorResponse('projectPath and scriptPath are required.');
    if (!validatePath(args.projectPath) || !validatePath(args.scriptPath)) return createErrorResponse('Invalid path.');
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    try {
      const fullPath = join(args.projectPath, args.scriptPath);
      const dir = dirname(fullPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      let source = args.source;
      if (!source) {
        const ext = args.extends || 'Node';
        const lines = [`extends ${ext}`, ''];
        if (args.className) lines.splice(1, 0, `class_name ${args.className}`);
        if (args.methods && Array.isArray(args.methods)) {
          for (const m of args.methods) {
            lines.push('', `func ${m}():`);
            lines.push('\tpass');
          }
        }
        source = lines.join('\n') + '\n';
      }
      writeFileSync(fullPath, source, 'utf8');
      return { content: [{ type: 'text', text: `Script created at ${args.scriptPath}` }] };
    } catch (error: any) {
      return createErrorResponse(`create_script failed: ${error?.message || 'Unknown error'}`);
    }
  }

  private async handleManageSceneSignals(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.scenePath || !args.action) return createErrorResponse('projectPath, scenePath, and action are required.');
    return this.headlessOp('manage_scene_signals', args, a => ({
      projectPath: a.projectPath,
      params: {
        scenePath: a.scenePath, action: a.action,
        ...(a.signalName ? { signalName: a.signalName } : {}),
        ...(a.sourcePath ? { sourcePath: a.sourcePath } : {}),
        ...(a.targetPath ? { targetPath: a.targetPath } : {}),
        ...(a.method ? { method: a.method } : {}),
      },
    }));
  }

  private async handleManageLayers(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.action) return createErrorResponse('projectPath and action are required.');
    if (!validatePath(args.projectPath)) return createErrorResponse('Invalid path.');
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    try {
      let content = readFileSync(projectFile, 'utf8');
      if (args.action === 'list') {
        const layerRegex = /layer_names\/([\w_]+)\/layer_(\d+)="([^"]+)"/g;
        const layers: any[] = [];
        let match;
        while ((match = layerRegex.exec(content)) !== null) {
          layers.push({ type: match[1], layer: parseInt(match[2]), name: match[3] });
        }
        return { content: [{ type: 'text', text: JSON.stringify({ layers }, null, 2) }] };
      } else if (args.action === 'set') {
        if (!args.layerType || !args.layer || !args.name) return createErrorResponse('layerType, layer, and name are required for set.');
        const key = `layer_names/${args.layerType}/layer_${args.layer}`;
        const settingLine = `${key}="${args.name}"`;
        const existingRegex = new RegExp(`${key.replace(/\//g, '\\/')}="[^"]*"`);
        if (existingRegex.test(content)) {
          content = content.replace(existingRegex, settingLine);
        } else {
          if (!content.includes('[layer_names]')) content += '\n[layer_names]\n';
          content = content.replace('[layer_names]', `[layer_names]\n${settingLine}`);
        }
        writeFileSync(projectFile, content, 'utf8');
        return { content: [{ type: 'text', text: `Layer set: ${settingLine}` }] };
      }
      return createErrorResponse(`Unknown action: ${args.action}`);
    } catch (error: any) {
      return createErrorResponse(`manage_layers failed: ${error?.message || 'Unknown error'}`);
    }
  }

  private async handleManagePlugins(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.action) return createErrorResponse('projectPath and action are required.');
    if (!validatePath(args.projectPath)) return createErrorResponse('Invalid path.');
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    try {
      let content = readFileSync(projectFile, 'utf8');
      if (args.action === 'list') {
        const pluginRegex = /(\w+)\/enabled=true/g;
        const plugins: string[] = [];
        let match;
        while ((match = pluginRegex.exec(content)) !== null) {
          plugins.push(match[1]);
        }
        const addonsDir = join(args.projectPath, 'addons');
        const available: string[] = [];
        if (existsSync(addonsDir)) {
          const entries = readdirSync(addonsDir, { withFileTypes: true });
          for (const e of entries) {
            if (e.isDirectory()) available.push(e.name);
          }
        }
        return { content: [{ type: 'text', text: JSON.stringify({ enabled: plugins, available }, null, 2) }] };
      } else if (args.action === 'enable' || args.action === 'disable') {
        if (!args.pluginName) return createErrorResponse('pluginName is required.');
        const key = `${args.pluginName}/enabled`;
        const val = args.action === 'enable' ? 'true' : 'false';
        const existingRegex = new RegExp(`${args.pluginName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/enabled=\\w+`);
        if (existingRegex.test(content)) {
          content = content.replace(existingRegex, `${key}=${val}`);
        } else {
          if (!content.includes('[editor_plugins]')) content += '\n[editor_plugins]\n';
          content = content.replace('[editor_plugins]', `[editor_plugins]\n${key}=${val}`);
        }
        writeFileSync(projectFile, content, 'utf8');
        return { content: [{ type: 'text', text: `Plugin ${args.pluginName} ${args.action}d.` }] };
      }
      return createErrorResponse(`Unknown action: ${args.action}`);
    } catch (error: any) {
      return createErrorResponse(`manage_plugins failed: ${error?.message || 'Unknown error'}`);
    }
  }

  private async handleManageShader(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.shaderPath || !args.action) return createErrorResponse('projectPath, shaderPath, and action are required.');
    if (!validatePath(args.projectPath) || !validatePath(args.shaderPath)) return createErrorResponse('Invalid path.');
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    const fullPath = join(args.projectPath, args.shaderPath);
    try {
      if (args.action === 'read') {
        if (!existsSync(fullPath)) return createErrorResponse(`Shader not found: ${args.shaderPath}`);
        const source = readFileSync(fullPath, 'utf8');
        return { content: [{ type: 'text', text: source }] };
      } else if (args.action === 'create') {
        const dir = dirname(fullPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        let source = args.source;
        if (!source) {
          const type = args.shaderType || 'spatial';
          source = `shader_type ${type};\n\nvoid fragment() {\n\t// Called for every pixel the material is visible on.\n}\n`;
        }
        writeFileSync(fullPath, source, 'utf8');
        return { content: [{ type: 'text', text: `Shader created at ${args.shaderPath}` }] };
      }
      return createErrorResponse(`Unknown action: ${args.action}`);
    } catch (error: any) {
      return createErrorResponse(`manage_shader failed: ${error?.message || 'Unknown error'}`);
    }
  }

  private async handleManageThemeResource(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.resourcePath || !args.action) return createErrorResponse('projectPath, resourcePath, and action are required.');
    return this.headlessOp('manage_theme_resource', args, a => ({
      projectPath: a.projectPath,
      params: { resourcePath: a.resourcePath, action: a.action, ...(a.properties ? { properties: a.properties } : {}) },
    }));
  }

  private async handleSetMainScene(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.scenePath) return createErrorResponse('projectPath and scenePath are required.');
    if (!validatePath(args.projectPath)) return createErrorResponse('Invalid path.');
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    try {
      let content = readFileSync(projectFile, 'utf8');
      const resPath = args.scenePath.startsWith('res://') ? args.scenePath : `res://${args.scenePath}`;
      const settingLine = `run/main_scene="${resPath}"`;
      const existingRegex = /run\/main_scene="[^"]*"/;
      if (existingRegex.test(content)) {
        content = content.replace(existingRegex, settingLine);
      } else {
        if (content.includes('[application]')) {
          content = content.replace('[application]', `[application]\n\n${settingLine}`);
        } else {
          content += `\n[application]\n\n${settingLine}\n`;
        }
      }
      writeFileSync(projectFile, content, 'utf8');
      return { content: [{ type: 'text', text: `Main scene set to ${resPath}` }] };
    } catch (error: any) {
      return createErrorResponse(`set_main_scene failed: ${error?.message || 'Unknown error'}`);
    }
  }

  private async handleManageSceneStructure(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.scenePath || !args.action || !args.nodePath)
      return createErrorResponse('projectPath, scenePath, action, and nodePath are required.');
    return this.headlessOp('manage_scene_structure', args, a => ({
      projectPath: a.projectPath,
      params: {
        scenePath: a.scenePath, action: a.action, nodePath: a.nodePath,
        ...(a.newName ? { newName: a.newName } : {}),
        ...(a.newParentPath ? { newParentPath: a.newParentPath } : {}),
      },
    }));
  }

  private async handleManageTranslations(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.action) return createErrorResponse('projectPath and action are required.');
    if (!validatePath(args.projectPath)) return createErrorResponse('Invalid path.');
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    try {
      let content = readFileSync(projectFile, 'utf8');
      if (args.action === 'list') {
        const match = /translations=PackedStringArray\(([^)]*)\)/.exec(content);
        const translations = match ? match[1].split(',').map(s => s.trim().replace(/"/g, '')).filter(Boolean) : [];
        return { content: [{ type: 'text', text: JSON.stringify({ translations }, null, 2) }] };
      } else if (args.action === 'add') {
        if (!args.translationPath) return createErrorResponse('translationPath is required.');
        const resPath = args.translationPath.startsWith('res://') ? args.translationPath : `res://${args.translationPath}`;
        const match = /translations=PackedStringArray\(([^)]*)\)/.exec(content);
        if (match) {
          const existing = match[1];
          const newVal = existing ? `${existing}, "${resPath}"` : `"${resPath}"`;
          content = content.replace(/translations=PackedStringArray\([^)]*\)/, `translations=PackedStringArray(${newVal})`);
        } else {
          if (!content.includes('[internationalization]')) content += '\n[internationalization]\n';
          content = content.replace('[internationalization]', `[internationalization]\n\ntranslations=PackedStringArray("${resPath}")`);
        }
        writeFileSync(projectFile, content, 'utf8');
        return { content: [{ type: 'text', text: `Translation added: ${resPath}` }] };
      } else if (args.action === 'remove') {
        if (!args.translationPath) return createErrorResponse('translationPath is required.');
        const resPath = args.translationPath.startsWith('res://') ? args.translationPath : `res://${args.translationPath}`;
        content = content.replace(new RegExp(`,?\\s*"${resPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`), '');
        writeFileSync(projectFile, content, 'utf8');
        return { content: [{ type: 'text', text: `Translation removed: ${resPath}` }] };
      }
      return createErrorResponse(`Unknown action: ${args.action}`);
    } catch (error: any) {
      return createErrorResponse(`manage_translations failed: ${error?.message || 'Unknown error'}`);
    }
  }

  private async handleGameLocale(args: any) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    return this.gameCommand('locale', args, a => ({
      action: a.action,
      ...(a.locale ? { locale: a.locale } : {}),
      ...(a.key ? { key: a.key } : {}),
    }));
  }

  // --- Batch 5: UI Controls + Rendering + Resource Runtime ---
  private async handleGameUiControl(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
    return this.gameCommand('ui_control', args, a => ({
      node_path: a.nodePath, action: a.action,
      ...(a.anchorPreset !== undefined ? { anchor_preset: a.anchorPreset } : {}),
      ...(a.tooltip ? { tooltip: a.tooltip } : {}),
      ...(a.mouseFilter ? { mouse_filter: a.mouseFilter } : {}),
      ...(a.minSize ? { min_size: a.minSize } : {}),
    }));
  }

  private async handleGameUiText(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
    return this.gameCommand('ui_text', args, a => ({
      node_path: a.nodePath, action: a.action,
      ...(a.text !== undefined ? { text: a.text } : {}),
      ...(a.caretPosition !== undefined ? { caret_position: a.caretPosition } : {}),
      ...(a.selectionFrom !== undefined ? { selection_from: a.selectionFrom } : {}),
      ...(a.selectionTo !== undefined ? { selection_to: a.selectionTo } : {}),
    }));
  }

  private async handleGameUiPopup(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
    return this.gameCommand('ui_popup', args, a => ({
      node_path: a.nodePath, action: a.action,
      ...(a.size ? { size: a.size } : {}),
      ...(a.title ? { title: a.title } : {}),
      ...(a.text ? { text: a.text } : {}),
    }));
  }

  private async handleGameUiTree(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
    return this.gameCommand('ui_tree', args, a => ({
      node_path: a.nodePath, action: a.action,
      ...(a.itemPath ? { item_path: a.itemPath } : {}),
      ...(a.text ? { text: a.text } : {}),
      ...(a.column !== undefined ? { column: a.column } : {}),
    }));
  }

  private async handleGameUiItemList(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
    return this.gameCommand('ui_item_list', args, a => ({
      node_path: a.nodePath, action: a.action,
      ...(a.index !== undefined ? { index: a.index } : {}),
      ...(a.text ? { text: a.text } : {}),
    }));
  }

  private async handleGameUiTabs(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
    return this.gameCommand('ui_tabs', args, a => ({
      node_path: a.nodePath, action: a.action,
      ...(a.index !== undefined ? { index: a.index } : {}),
      ...(a.title ? { title: a.title } : {}),
    }));
  }

  private async handleGameUiMenu(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
    return this.gameCommand('ui_menu', args, a => ({
      node_path: a.nodePath, action: a.action,
      ...(a.index !== undefined ? { index: a.index } : {}),
      ...(a.text ? { text: a.text } : {}),
      ...(a.checked !== undefined ? { checked: a.checked } : {}),
      ...(a.id !== undefined ? { id: a.id } : {}),
    }));
  }

  private async handleGameUiRange(args: any) {
    args = normalizeParameters(args || {});
    if (!args.nodePath || !args.action) return createErrorResponse('nodePath and action are required.');
    return this.gameCommand('ui_range', args, a => ({
      node_path: a.nodePath, action: a.action,
      ...(a.value !== undefined ? { value: a.value } : {}),
      ...(a.minValue !== undefined ? { min_value: a.minValue } : {}),
      ...(a.maxValue !== undefined ? { max_value: a.maxValue } : {}),
      ...(a.step !== undefined ? { step: a.step } : {}),
      ...(a.color ? { color: a.color } : {}),
    }));
  }

  private async handleGameRenderSettings(args: any) {
    args = normalizeParameters(args || {});
    return this.gameCommand('render_settings', args, a => ({
      action: a.action || 'get',
      ...(a.msaa2d !== undefined ? { msaa_2d: a.msaa2d } : {}),
      ...(a.msaa3d !== undefined ? { msaa_3d: a.msaa3d } : {}),
      ...(a.fxaa !== undefined ? { fxaa: a.fxaa } : {}),
      ...(a.taa !== undefined ? { taa: a.taa } : {}),
      ...(a.scalingMode !== undefined ? { scaling_mode: a.scalingMode } : {}),
      ...(a.scalingScale !== undefined ? { scaling_scale: a.scalingScale } : {}),
    }));
  }

  private async handleGameResource(args: any) {
    args = normalizeParameters(args || {});
    if (!args.action || !args.path) return createErrorResponse('action and path are required.');
    return this.gameCommand('resource', args, a => ({
      action: a.action, path: a.path,
      ...(a.nodePath ? { node_path: a.nodePath } : {}),
      ...(a.property ? { property: a.property } : {}),
    }));
  }

  // --- Batch 6: Visual Shader + Terrain + Video + CI/CD ---
  private async handleGameVisualShader(args: any) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    return this.gameCommand('visual_shader', args, a => ({
      action: a.action,
      ...(a.nodePath ? { node_path: a.nodePath } : {}),
      ...(a.shaderType ? { shader_type: a.shaderType } : {}),
      ...(a.nodeClass ? { node_class: a.nodeClass } : {}),
      ...(a.position ? { position: a.position } : {}),
      ...(a.fromNode !== undefined ? { from_node: a.fromNode } : {}),
      ...(a.fromPort !== undefined ? { from_port: a.fromPort } : {}),
      ...(a.toNode !== undefined ? { to_node: a.toNode } : {}),
      ...(a.toPort !== undefined ? { to_port: a.toPort } : {}),
      ...(a.shaderId !== undefined ? { shader_id: a.shaderId } : {}),
    }));
  }

  private async handleGameTerrain(args: any) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    return this.gameCommand('terrain', args, a => ({
      action: a.action,
      ...(a.parentPath ? { parent_path: a.parentPath } : {}),
      ...(a.nodePath ? { node_path: a.nodePath } : {}),
      ...(a.heightData ? { height_data: a.heightData } : {}),
      ...(a.width !== undefined ? { width: a.width } : {}),
      ...(a.depth !== undefined ? { depth: a.depth } : {}),
      ...(a.maxHeight !== undefined ? { max_height: a.maxHeight } : {}),
      ...(a.x !== undefined ? { x: a.x } : {}),
      ...(a.z !== undefined ? { z: a.z } : {}),
      ...(a.radius !== undefined ? { radius: a.radius } : {}),
      ...(a.heightDelta !== undefined ? { height_delta: a.heightDelta } : {}),
      ...(a.color ? { color: a.color } : {}),
      ...(a.name ? { name: a.name } : {}),
    }));
  }

  private async handleGameVideo(args: any) {
    args = normalizeParameters(args || {});
    if (!args.action) return createErrorResponse('action is required.');
    return this.gameCommand('video', args, a => ({
      action: a.action,
      ...(a.nodePath ? { node_path: a.nodePath } : {}),
      ...(a.parentPath ? { parent_path: a.parentPath } : {}),
      ...(a.videoPath ? { video_path: a.videoPath } : {}),
      ...(a.position !== undefined ? { position: a.position } : {}),
      ...(a.volume !== undefined ? { volume: a.volume } : {}),
      ...(a.loop !== undefined ? { loop: a.loop } : {}),
      ...(a.autoplay !== undefined ? { autoplay: a.autoplay } : {}),
      ...(a.name ? { name: a.name } : {}),
    }));
  }

  private async handleManageCiPipeline(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.action) return createErrorResponse('projectPath and action are required.');
    if (!validatePath(args.projectPath)) return createErrorResponse('Invalid path.');
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    const workflowDir = join(args.projectPath, '.github', 'workflows');
    const workflowPath = join(workflowDir, 'godot-export.yml');
    try {
      if (args.action === 'read') {
        if (!existsSync(workflowPath)) return createErrorResponse('No workflow file found at .github/workflows/godot-export.yml');
        const content = readFileSync(workflowPath, 'utf8');
        return { content: [{ type: 'text', text: content }] };
      } else if (args.action === 'create') {
        if (!existsSync(workflowDir)) mkdirSync(workflowDir, { recursive: true });
        const godotVersion = args.godotVersion || '4.3-stable';
        const platforms = args.platforms || ['linux'];
        const exportSteps = platforms.map((p: string) => `      - name: Export ${p}\n        run: godot --headless --export-release "${p}" build/${p}/game`).join('\n');
        const workflow = `name: Godot Export\non:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\njobs:\n  export:\n    runs-on: ubuntu-latest\n    container:\n      image: barichello/godot-ci:${godotVersion}\n    steps:\n      - uses: actions/checkout@v4\n      - name: Setup export templates\n        run: |\n          mkdir -p ~/.local/share/godot/export_templates/${godotVersion}\n          mv /root/.local/share/godot/export_templates/${godotVersion}/* ~/.local/share/godot/export_templates/${godotVersion}/ || true\n${exportSteps}\n      - uses: actions/upload-artifact@v4\n        with:\n          name: game-builds\n          path: build/\n`;
        writeFileSync(workflowPath, workflow, 'utf8');
        return { content: [{ type: 'text', text: `CI pipeline created at .github/workflows/godot-export.yml for platforms: ${platforms.join(', ')}` }] };
      }
      return createErrorResponse(`Unknown action: ${args.action}`);
    } catch (error: any) {
      return createErrorResponse(`manage_ci_pipeline failed: ${error?.message || 'Unknown error'}`);
    }
  }

  private async handleManageDockerExport(args: any) {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.action) return createErrorResponse('projectPath and action are required.');
    if (!validatePath(args.projectPath)) return createErrorResponse('Invalid path.');
    const projectFile = join(args.projectPath, 'project.godot');
    if (!existsSync(projectFile)) return createErrorResponse(`Not a valid Godot project: ${args.projectPath}`);
    const dockerfilePath = join(args.projectPath, 'Dockerfile');
    try {
      if (args.action === 'read') {
        if (!existsSync(dockerfilePath)) return createErrorResponse('No Dockerfile found in project root.');
        const content = readFileSync(dockerfilePath, 'utf8');
        return { content: [{ type: 'text', text: content }] };
      } else if (args.action === 'create') {
        const godotVersion = args.godotVersion || '4.3-stable';
        const baseImage = args.baseImage || 'ubuntu:22.04';
        const exportPreset = args.exportPreset || 'Linux/X11';
        const dockerfile = `FROM ${baseImage}\n\nARG GODOT_VERSION=${godotVersion}\n\nRUN apt-get update && apt-get install -y \\\n    wget unzip ca-certificates \\\n    && rm -rf /var/lib/apt/lists/*\n\nRUN wget -q https://github.com/godotengine/godot/releases/download/\${GODOT_VERSION}/Godot_v\${GODOT_VERSION}_linux.x86_64.zip \\\n    && unzip Godot_v\${GODOT_VERSION}_linux.x86_64.zip \\\n    && mv Godot_v\${GODOT_VERSION}_linux.x86_64 /usr/local/bin/godot \\\n    && rm Godot_v\${GODOT_VERSION}_linux.x86_64.zip\n\nRUN wget -q https://github.com/godotengine/godot/releases/download/\${GODOT_VERSION}/Godot_v\${GODOT_VERSION}_export_templates.tpz \\\n    && mkdir -p /root/.local/share/godot/export_templates/\${GODOT_VERSION} \\\n    && unzip Godot_v\${GODOT_VERSION}_export_templates.tpz \\\n    && mv templates/* /root/.local/share/godot/export_templates/\${GODOT_VERSION}/ \\\n    && rm -rf templates Godot_v\${GODOT_VERSION}_export_templates.tpz\n\nWORKDIR /game\nCOPY . .\n\nRUN mkdir -p build\nCMD ["godot", "--headless", "--export-release", "${exportPreset}", "build/game"]\n`;
        writeFileSync(dockerfilePath, dockerfile, 'utf8');
        return { content: [{ type: 'text', text: `Dockerfile created for headless Godot export (preset: ${exportPreset})` }] };
      }
      return createErrorResponse(`Unknown action: ${args.action}`);
    } catch (error: any) {
      return createErrorResponse(`manage_docker_export failed: ${error?.message || 'Unknown error'}`);
    }
  }

  /**
   * Handle the update_project_uids tool
   */
  private async handleUpdateProjectUids(args: any) {
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

      // Get Godot version to check if UIDs are supported
      const { stdout: versionOutput } = await execFileAsync(this.godotPath, ['--version']);
      const version = versionOutput.trim();

      if (!isGodot44OrLater(version)) {
        return createErrorResponse(
          `UIDs are only supported in Godot 4.4 or later. Current version: ${version}`
        );
      }

      // Prepare parameters for the operation (already in camelCase)
      const params = {
        projectPath: args.projectPath,
      };

      // Execute the operation
      const { stdout, stderr } = await this.executeOperation('resave_resources', params, args.projectPath);

      if (stderr && stderr.includes('Failed to')) {
        return createErrorResponse(
          `Failed to update project UIDs: ${stderr}`
        );
      }

      return {
        content: [
          {
            type: 'text',
            text: `Project UIDs updated successfully.\n\nOutput: ${stdout}`,
          },
        ],
      };
    } catch (error: any) {
      return createErrorResponse(
        `Failed to update project UIDs: ${error?.message || 'Unknown error'}`
      );
    }
  }

  /**
   * Run the MCP server
   */
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
