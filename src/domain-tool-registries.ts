import { toolDefinitions, type ToolName } from './tool-definitions.js';
import type { ToolHandler } from './tool-registry.js';
import type { GameToolHandlers } from './tool-handlers/game-tool-handlers.js';
import type { LifecycleToolHandlers } from './tool-handlers/lifecycle-tool-handlers.js';
import type { ProjectToolHandlers } from './tool-handlers/project-tool-handlers.js';

export type ToolHandlerRegistry = Partial<Record<ToolName, ToolHandler>>;
type CompleteToolHandlerRegistry = Record<ToolName, ToolHandler>;

export interface DomainToolHandlers {
  game: GameToolHandlers;
  lifecycle: LifecycleToolHandlers;
  project: ProjectToolHandlers;
}
/** Combines domain-owned registries while rejecting duplicate or missing tools. */
export function composeToolHandlerRegistries(
  ...registries: readonly ToolHandlerRegistry[]
): CompleteToolHandlerRegistry {
  const handlers: ToolHandlerRegistry = {};
  const toolNames = new Set(toolDefinitions.map(tool => tool.name));

  for (const registry of registries) {
    for (const [name, handler] of Object.entries(registry)) {
      if (!toolNames.has(name as ToolName)) {
        throw new Error(`Unknown tool handler: ${name}`);
      }
      if (handlers[name as ToolName]) {
        throw new Error(`Tool handler is registered more than once: ${name}`);
      }
      handlers[name as ToolName] = handler;
    }
  }

  const missing = toolDefinitions
    .map(tool => tool.name)
    .filter(name => !handlers[name]);
  if (missing.length > 0) {
    throw new Error(`Missing tool handlers: ${missing.join(', ')}`);
  }

  return handlers as CompleteToolHandlerRegistry;
}

/** Builds the complete registry from independently maintained domain registries. */
export function createToolHandlers({
  game,
  lifecycle,
  project,
}: DomainToolHandlers): CompleteToolHandlerRegistry {
  return composeToolHandlerRegistries(
    createLifecycleToolRegistry(lifecycle),
    createProjectToolRegistry(project),
    createGameToolRegistry(game),
  );
}

export function createLifecycleToolRegistry(
  handlers: LifecycleToolHandlers,
): ToolHandlerRegistry {
  return {
      'launch_editor': args => handlers.handleLaunchEditor(args),
      'run_project': args => handlers.handleRunProject(args),
      'verify_project': args => handlers.handleVerifyProject(args),
      'get_debug_output': () => handlers.handleGetDebugOutput(),
      'stop_project': () => handlers.handleStopProject(),
      'get_godot_version': () => handlers.handleGetGodotVersion(),
  };
}

export function createProjectToolRegistry(
  handlers: ProjectToolHandlers,
): ToolHandlerRegistry {
  return {
      'run_project_tests': args => handlers.handleRunProjectTests(args),
      'manage_import_pipeline': args => handlers.handleManageImportPipeline(args),
      'analyze_project_integrity': args => handlers.handleAnalyzeProjectIntegrity(args),
      'verify_export_readiness': args => handlers.handleVerifyExportReadiness(args),
      'verify_dotnet_project': args => handlers.handleVerifyDotnetProject(args),
      'manage_addon': args => handlers.handleManageAddon(args),
      'list_projects': args => handlers.handleListProjects(args),
      'get_project_info': args => handlers.handleGetProjectInfo(args),
      'create_scene': args => handlers.handleCreateScene(args),
      'add_node': args => handlers.handleAddNode(args),
      'load_sprite': args => handlers.handleLoadSprite(args),
      'export_mesh_library': args => handlers.handleExportMeshLibrary(args),
      'save_scene': args => handlers.handleSaveScene(args),
      'get_uid': args => handlers.handleGetUid(args),
      'update_project_uids': args => handlers.handleUpdateProjectUids(args),
      'read_scene': args => handlers.handleReadScene(args),
      'modify_scene_node': args => handlers.handleModifySceneNode(args),
      'remove_scene_node': args => handlers.handleRemoveSceneNode(args),
      'read_project_settings': args => handlers.handleReadProjectSettings(args),
      'modify_project_settings': args => handlers.handleModifyProjectSettings(args),
      'list_project_files': args => handlers.handleListProjectFiles(args),
      'attach_script': args => handlers.handleAttachScript(args),
      'create_resource': args => handlers.handleCreateResource(args),
      'read_file': args => handlers.handleReadFile(args),
      'write_file': args => handlers.handleWriteFile(args),
      'delete_file': args => handlers.handleDeleteFile(args),
      'create_directory': args => handlers.handleCreateDirectory(args),
      'create_project': args => handlers.handleCreateProject(args),
      'create_csharp_script': args => handlers.handleCreateCsharpScript(args),
      'manage_autoloads': args => handlers.handleManageAutoloads(args),
      'manage_input_map': args => handlers.handleManageInputMap(args),
      'manage_export_presets': args => handlers.handleManageExportPresets(args),
      'export_project': args => handlers.handleExportProject(args),
      'rename_file': args => handlers.handleRenameFile(args),
      'manage_resource': args => handlers.handleManageResource(args),
      'validate_script': args => handlers.handleValidateScript(args),
      'validate_scripts': args => handlers.handleValidateScripts(args),
      'create_script': args => handlers.handleCreateScript(args),
      'manage_scene_signals': args => handlers.handleManageSceneSignals(args),
      'manage_layers': args => handlers.handleManageLayers(args),
      'manage_plugins': args => handlers.handleManagePlugins(args),
      'manage_shader': args => handlers.handleManageShader(args),
      'manage_theme_resource': args => handlers.handleManageThemeResource(args),
      'set_main_scene': args => handlers.handleSetMainScene(args),
      'manage_scene_structure': args => handlers.handleManageSceneStructure(args),
      'manage_translations': args => handlers.handleManageTranslations(args),
      'manage_ci_pipeline': args => handlers.handleManageCiPipeline(args),
      'manage_docker_export': args => handlers.handleManageDockerExport(args),
  };
}

export function createGameToolRegistry(
  handlers: GameToolHandlers,
): ToolHandlerRegistry {
  return {
      'game_screenshot': () => handlers.handleGameScreenshot(),
      'game_visual_regression': args => handlers.handleGameVisualRegression(args),
      'game_click': args => handlers.handleGameClick(args),
      'game_key_press': args => handlers.handleGameKeyPress(args),
      'game_mouse_move': args => handlers.handleGameMouseMove(args),
      'game_get_ui': () => handlers.handleGameGetUi(),
      'game_get_scene_tree': args => handlers.handleGameGetSceneTree(args),
      'game_eval': args => handlers.handleGameEval(args),
      'game_get_property': args => handlers.handleGameGetProperty(args),
      'game_set_property': args => handlers.handleGameSetProperty(args),
      'game_call_method': args => handlers.handleGameCallMethod(args),
      'game_get_node_info': args => handlers.handleGameGetNodeInfo(args),
      'game_instantiate_scene': args => handlers.handleGameInstantiateScene(args),
      'game_remove_node': args => handlers.handleGameRemoveNode(args),
      'game_change_scene': args => handlers.handleGameChangeScene(args),
      'game_pause': args => handlers.handleGamePause(args),
      'game_performance': () => handlers.handleGamePerformance(),
      'game_wait': args => handlers.handleGameWait(args),
      'game_connect_signal': args => handlers.handleGameConnectSignal(args),
      'game_disconnect_signal': args => handlers.handleGameDisconnectSignal(args),
      'game_emit_signal': args => handlers.handleGameEmitSignal(args),
      'game_play_animation': args => handlers.handleGamePlayAnimation(args),
      'game_tween_property': args => handlers.handleGameTweenProperty(args),
      'game_get_nodes_in_group': args => handlers.handleGameGetNodesInGroup(args),
      'game_find_nodes_by_class': args => handlers.handleGameFindNodesByClass(args),
      'game_reparent_node': args => handlers.handleGameReparentNode(args),
      'game_get_errors': args => handlers.handleGameGetErrors(args),
      'game_get_logs': args => handlers.handleGameGetLogs(args),
      'game_key_hold': args => handlers.handleGameKeyHold(args),
      'game_key_release': args => handlers.handleGameKeyRelease(args),
      'game_scroll': args => handlers.handleGameScroll(args),
      'game_mouse_drag': args => handlers.handleGameMouseDrag(args),
      'game_gamepad': args => handlers.handleGameGamepad(args),
      'game_get_camera': () => handlers.handleGameGetCamera(),
      'game_set_camera': args => handlers.handleGameSetCamera(args),
      'game_raycast': args => handlers.handleGameRaycast(args),
      'game_get_audio': () => handlers.handleGameGetAudio(),
      'game_spawn_node': args => handlers.handleGameSpawnNode(args),
      'game_set_shader_param': args => handlers.handleGameSetShaderParam(args),
      'game_audio_play': args => handlers.handleGameAudioPlay(args),
      'game_audio_bus': args => handlers.handleGameAudioBus(args),
      'game_navigate_path': args => handlers.handleGameNavigatePath(args),
      'game_tilemap': args => handlers.handleGameTilemap(args),
      'game_add_collision': args => handlers.handleGameAddCollision(args),
      'game_environment': args => handlers.handleGameEnvironment(args),
      'game_manage_group': args => handlers.handleGameManageGroup(args),
      'game_create_timer': args => handlers.handleGameCreateTimer(args),
      'game_set_particles': args => handlers.handleGameSetParticles(args),
      'game_create_animation': args => handlers.handleGameCreateAnimation(args),
      'game_serialize_state': args => handlers.handleGameSerializeState(args),
      'game_physics_body': args => handlers.handleGamePhysicsBody(args),
      'game_create_joint': args => handlers.handleGameCreateJoint(args),
      'game_bone_pose': args => handlers.handleGameBonePose(args),
      'game_ui_theme': args => handlers.handleGameUiTheme(args),
      'game_viewport': args => handlers.handleGameViewport(args),
      'game_debug_draw': args => handlers.handleGameDebugDraw(args),
      'game_http_request': args => handlers.handleGameHttpRequest(args),
      'game_websocket': args => handlers.handleGameWebsocket(args),
      'game_multiplayer': args => handlers.handleGameMultiplayer(args),
      'game_rpc': args => handlers.handleGameRpc(args),
      'game_touch': args => handlers.handleGameTouch(args),
      'game_input_state': args => handlers.handleGameInputState(args),
      'game_input_action': args => handlers.handleGameInputAction(args),
      'game_list_signals': args => handlers.handleGameListSignals(args),
      'game_await_signal': args => handlers.handleGameAwaitSignal(args),
      'game_script': args => handlers.handleGameScript(args),
      'game_window': args => handlers.handleGameWindow(args),
      'game_os_info': args => handlers.handleGameOsInfo(args),
      'game_time_scale': args => handlers.handleGameTimeScale(args),
      'game_process_mode': args => handlers.handleGameProcessMode(args),
      'game_world_settings': args => handlers.handleGameWorldSettings(args),
      'game_csg': args => handlers.handleGameCsg(args),
      'game_multimesh': args => handlers.handleGameMultimesh(args),
      'game_procedural_mesh': args => handlers.handleGameProceduralMesh(args),
      'game_light_3d': args => handlers.handleGameLight3d(args),
      'game_mesh_instance': args => handlers.handleGameMeshInstance(args),
      'game_gridmap': args => handlers.handleGameGridmap(args),
      'game_3d_effects': args => handlers.handleGame3dEffects(args),
      'game_gi': args => handlers.handleGameGi(args),
      'game_path_3d': args => handlers.handleGamePath3d(args),
      'game_sky': args => handlers.handleGameSky(args),
      'game_camera_attributes': args => handlers.handleGameCameraAttributes(args),
      'game_navigation_3d': args => handlers.handleGameNavigation3d(args),
      'game_physics_3d': args => handlers.handleGamePhysics3d(args),
      'game_canvas': args => handlers.handleGameCanvas(args),
      'game_canvas_draw': args => handlers.handleGameCanvasDraw(args),
      'game_light_2d': args => handlers.handleGameLight2d(args),
      'game_parallax': args => handlers.handleGameParallax(args),
      'game_shape_2d': args => handlers.handleGameShape2d(args),
      'game_path_2d': args => handlers.handleGamePath2d(args),
      'game_physics_2d': args => handlers.handleGamePhysics2d(args),
      'game_animation_tree': args => handlers.handleGameAnimationTree(args),
      'game_animation_control': args => handlers.handleGameAnimationControl(args),
      'game_skeleton_ik': args => handlers.handleGameSkeletonIk(args),
      'game_audio_effect': args => handlers.handleGameAudioEffect(args),
      'game_audio_bus_layout': args => handlers.handleGameAudioBusLayout(args),
      'game_audio_spatial': args => handlers.handleGameAudioSpatial(args),
      'game_locale': args => handlers.handleGameLocale(args),
      'game_ui_control': args => handlers.handleGameUiControl(args),
      'game_ui_text': args => handlers.handleGameUiText(args),
      'game_ui_popup': args => handlers.handleGameUiPopup(args),
      'game_ui_tree': args => handlers.handleGameUiTree(args),
      'game_ui_item_list': args => handlers.handleGameUiItemList(args),
      'game_ui_tabs': args => handlers.handleGameUiTabs(args),
      'game_ui_menu': args => handlers.handleGameUiMenu(args),
      'game_ui_range': args => handlers.handleGameUiRange(args),
      'game_render_settings': args => handlers.handleGameRenderSettings(args),
      'game_resource': args => handlers.handleGameResource(args),
      'game_visual_shader': args => handlers.handleGameVisualShader(args),
      'game_terrain': args => handlers.handleGameTerrain(args),
      'game_video': args => handlers.handleGameVideo(args),
  };
}
