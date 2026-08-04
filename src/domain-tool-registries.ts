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
      'godot_catalog': args => handlers.handleGodotCatalog(args),
      'godot_call': args => handlers.handleGodotCall(args),
      'launch_editor': args => handlers.handleLaunchEditor(args),
      'editor_session': args => handlers.handleEditorSession(args),
      'editor_control': args => handlers.handleEditorControl(args),
      'editor_transaction': args => handlers.handleEditorTransaction(args),
      'run_project': args => handlers.handleRunProject(args),
      'verify_project': args => handlers.handleVerifyProject(args),
      'game_wait_until': args => handlers.handleGameWaitUntil(args),
      'game_scenario': args => handlers.handleGameScenario(args),
      'get_debug_output': () => handlers.handleGetDebugOutput(),
      'stop_project': () => handlers.handleStopProject(),
      'get_godot_version': () => handlers.handleGetGodotVersion(),
  };
}

export function createProjectToolRegistry(
  handlers: ProjectToolHandlers,
): ToolHandlerRegistry {
  return {
      'get_project_info': args => handlers.handleGetProjectInfo(args),
      'run_project_tests': args => handlers.handleRunProjectTests(args),
      'validate_script': args => handlers.handleValidateScript(args),
      'validate_scripts': args => handlers.handleValidateScripts(args),
      'analyze_project_integrity': args => handlers.handleAnalyzeProjectIntegrity(args),
      'export_project': args => handlers.handleExportProject(args),
      'verify_export_readiness': args => handlers.handleVerifyExportReadiness(args),
      'manage_import_pipeline': args => handlers.handleManageImportPipeline(args),
      'verify_dotnet_project': args => handlers.handleVerifyDotnetProject(args),
      'manage_addon': args => handlers.handleManageAddon(args),
  };
}

export function createGameToolRegistry(
  handlers: GameToolHandlers,
): ToolHandlerRegistry {
  return {
      'game_screenshot': args => handlers.handleGameScreenshot(args),
      'game_visual_regression': args => handlers.handleGameVisualRegression(args),
      'game_click': args => handlers.handleGameClick(args),
      'game_key_press': args => handlers.handleGameKeyPress(args),
      'game_key_hold': args => handlers.handleGameKeyHold(args),
      'game_key_release': args => handlers.handleGameKeyRelease(args),
      'game_mouse_move': args => handlers.handleGameMouseMove(args),
      'game_mouse_drag': args => handlers.handleGameMouseDrag(args),
      'game_scroll': args => handlers.handleGameScroll(args),
      'game_gamepad': args => handlers.handleGameGamepad(args),
      'game_touch': args => handlers.handleGameTouch(args),
      'game_get_ui': args => handlers.handleGameGetUi(args),
      'game_get_scene_tree': args => handlers.handleGameGetSceneTree(args),
      'game_get_node_info': args => handlers.handleGameGetNodeInfo(args),
      'game_get_errors': args => handlers.handleGameGetErrors(args),
      'game_get_logs': args => handlers.handleGameGetLogs(args),
      'game_eval': args => handlers.handleGameEval(args),
      'game_get_property': args => handlers.handleGameGetProperty(args),
      'game_set_property': args => handlers.handleGameSetProperty(args),
      'game_call_method': args => handlers.handleGameCallMethod(args),
      'game_script': args => handlers.handleGameScript(args),
      'game_spawn_node': args => handlers.handleGameSpawnNode(args),
      'game_remove_node': args => handlers.handleGameRemoveNode(args),
      'game_change_scene': args => handlers.handleGameChangeScene(args),
      'game_instantiate_scene': args => handlers.handleGameInstantiateScene(args),
      'game_reparent_node': args => handlers.handleGameReparentNode(args),
      'game_connect_signal': args => handlers.handleGameConnectSignal(args),
      'game_disconnect_signal': args => handlers.handleGameDisconnectSignal(args),
      'game_emit_signal': args => handlers.handleGameEmitSignal(args),
      'game_get_nodes_in_group': args => handlers.handleGameGetNodesInGroup(args),
      'game_find_nodes_by_class': args => handlers.handleGameFindNodesByClass(args),
      'game_list_signals': args => handlers.handleGameListSignals(args),
      'game_await_signal': args => handlers.handleGameAwaitSignal(args),
      'game_manage_group': args => handlers.handleGameManageGroup(args),
      'game_input_state': args => handlers.handleGameInputState(args),
      'game_input_action': args => handlers.handleGameInputAction(args),
      'game_performance': args => handlers.handleGamePerformance(args),
      'game_wait': args => handlers.handleGameWait(args),
      'game_get_camera': () => handlers.handleGameGetCamera(),
      'game_get_audio': () => handlers.handleGameGetAudio(),
      'game_os_info': args => handlers.handleGameOsInfo(args),
  };
}
