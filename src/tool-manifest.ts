import type { ToolName } from './tool-definitions.js';

/**
 * How a tool reaches the Godot engine (or does not).
 *
 * - `process`: owns or inspects a Godot editor/game process launched by the server.
 * - `runtime`: sends one JSON-RPC command to the in-game runtime server over TCP.
 * - `runtime-buffer`: reads output buffered from the runtime connection without a command.
 * - `godot-cli`: invokes the Godot executable directly (version, --check-only, export).
 * - `local`: implemented in TypeScript against the project files and configuration.
 */
export type ToolBackend =
  | { readonly kind: 'process' }
  | { readonly kind: 'subprocess'; readonly operation: string }
  | { readonly kind: 'runtime'; readonly command: string }
  | { readonly kind: 'runtime-buffer' }
  | { readonly kind: 'godot-cli' }
  | { readonly kind: 'local' };

export interface ToolManifestEntry {
  /** Owning handler class, mirrored from domain-tool-registries.ts. */
  readonly domain: 'lifecycle' | 'project' | 'game';
  /** Handler method dispatched by the domain registry. */
  readonly handler: string;
  readonly backend: ToolBackend;
  /**
   * Every public action the tool accepts, or null for single-action tools.
   * Keep this list aligned with schema enums, GDScript action declarations,
   * and handler dispatch when changing a multi-action tool.
   */
  readonly actions: readonly string[] | null;
  /** True when the schema's `action` field is data (an InputMap action name), not a mode selector. */
  readonly actionParamIsData?: true;
  /** True when the downstream runtime command requires the privileged-commands capability. */
  readonly privileged: boolean;
}

/**
 * Machine-readable routing manifest: one entry per advertised MCP tool.
 * The Record key type makes completeness and uniqueness a compile-time fact.
 */
export const toolManifest: Record<ToolName, ToolManifestEntry> = {
  godot_catalog: {
    domain: 'lifecycle',
    handler: 'handleGodotCatalog',
    backend: { kind: 'local' },
    actions: ['search', 'describe'],
    privileged: false,
  },
  godot_call: {
    domain: 'lifecycle',
    handler: 'handleGodotCall',
    backend: { kind: 'local' },
    actions: null,
    privileged: false,
  },
  editor_session: {
    domain: 'lifecycle',
    handler: 'handleEditorSession',
    backend: { kind: 'process' },
    actions: ['ensure', 'status', 'disconnect'],
    privileged: false,
  },
  editor_control: {
    domain: 'lifecycle',
    handler: 'handleEditorControl',
    backend: { kind: 'process' },
    actions: ['inspect', 'select', 'save', 'reload', 'open_scene', 'undo', 'redo'],
    privileged: false,
  },
  editor_transaction: {
    domain: 'lifecycle',
    handler: 'handleEditorTransaction',
    backend: { kind: 'process' },
    actions: null,
    privileged: false,
  },
  run_project: {
    domain: 'lifecycle',
    handler: 'handleRunProject',
    backend: { kind: 'process' },
    actions: null,
    privileged: false,
  },
  verify_project: {
    domain: 'lifecycle',
    handler: 'handleVerifyProject',
    backend: { kind: 'process' },
    actions: null,
    privileged: false,
  },
  game_wait_until: {
    domain: 'lifecycle',
    handler: 'handleGameWaitUntil',
    backend: { kind: 'process' },
    actions: null,
    privileged: false,
  },
  game_scenario: {
    domain: 'lifecycle',
    handler: 'handleGameScenario',
    backend: { kind: 'process' },
    actions: null,
    privileged: false,
  },
  run_project_tests: {
    domain: 'project',
    handler: 'handleRunProjectTests',
    backend: { kind: 'godot-cli' },
    actions: ['discover', 'run'],
    privileged: false,
  },
  manage_import_pipeline: {
    domain: 'project',
    handler: 'handleManageImportPipeline',
    backend: { kind: 'godot-cli' },
    actions: ['inspect', 'change', 'reimport', 'dependencies'],
    privileged: false,
  },
  analyze_project_integrity: {
    domain: 'project',
    handler: 'handleAnalyzeProjectIntegrity',
    backend: { kind: 'local' },
    actions: ['analyze', 'preview_rename', 'assets', 'localization', 'accessibility', 'extensions', 'leaks'],
    privileged: false,
  },
  verify_export_readiness: {
    domain: 'project',
    handler: 'handleVerifyExportReadiness',
    backend: { kind: 'godot-cli' },
    actions: ['inspect', 'export_smoke'],
    privileged: false,
  },
  verify_dotnet_project: {
    domain: 'project',
    handler: 'handleVerifyDotnetProject',
    backend: { kind: 'godot-cli' },
    actions: ['inspect', 'restore', 'build', 'run'],
    privileged: false,
  },
  manage_addon: {
    domain: 'project',
    handler: 'handleManageAddon',
    backend: { kind: 'godot-cli' },
    actions: ['inspect', 'install', 'update', 'remove', 'enable', 'disable'],
    privileged: false,
  },
  stop_project: {
    domain: 'lifecycle',
    handler: 'handleStopProject',
    backend: { kind: 'process' },
    actions: null,
    privileged: false,
  },
  game_screenshot: {
    domain: 'game',
    handler: 'handleGameScreenshot',
    backend: { kind: 'runtime', command: 'screenshot' },
    actions: null,
    privileged: false,
  },
  game_visual_regression: {
    domain: 'game',
    handler: 'handleGameVisualRegression',
    backend: { kind: 'local' },
    actions: ['capture_baseline', 'compare'],
    privileged: false,
  },
  game_click: {
    domain: 'game',
    handler: 'handleGameClick',
    backend: { kind: 'runtime', command: 'click' },
    actions: null,
    privileged: false,
  },
  game_key_press: {
    domain: 'game',
    handler: 'handleGameKeyPress',
    backend: { kind: 'runtime', command: 'key_press' },
    actions: null,
    actionParamIsData: true,
    privileged: false,
  },
  game_mouse_move: {
    domain: 'game',
    handler: 'handleGameMouseMove',
    backend: { kind: 'runtime', command: 'mouse_move' },
    actions: null,
    privileged: false,
  },
  game_get_ui: {
    domain: 'game',
    handler: 'handleGameGetUi',
    backend: { kind: 'runtime', command: 'get_ui_elements' },
    actions: null,
    privileged: false,
  },
  game_get_scene_tree: {
    domain: 'game',
    handler: 'handleGameGetSceneTree',
    backend: { kind: 'runtime', command: 'get_scene_tree' },
    actions: null,
    privileged: false,
  },
  game_eval: {
    domain: 'game',
    handler: 'handleGameEval',
    backend: { kind: 'runtime', command: 'eval' },
    actions: null,
    privileged: true,
  },
  game_get_property: {
    domain: 'game',
    handler: 'handleGameGetProperty',
    backend: { kind: 'runtime', command: 'get_property' },
    actions: null,
    privileged: true,
  },
  game_set_property: {
    domain: 'game',
    handler: 'handleGameSetProperty',
    backend: { kind: 'runtime', command: 'set_property' },
    actions: null,
    privileged: true,
  },
  game_call_method: {
    domain: 'game',
    handler: 'handleGameCallMethod',
    backend: { kind: 'runtime', command: 'call_method' },
    actions: null,
    privileged: true,
  },
  game_get_node_info: {
    domain: 'game',
    handler: 'handleGameGetNodeInfo',
    backend: { kind: 'runtime', command: 'get_node_info' },
    actions: null,
    privileged: false,
  },
  game_instantiate_scene: {
    domain: 'game',
    handler: 'handleGameInstantiateScene',
    backend: { kind: 'runtime', command: 'instantiate_scene' },
    actions: null,
    privileged: false,
  },
  game_remove_node: {
    domain: 'game',
    handler: 'handleGameRemoveNode',
    backend: { kind: 'runtime', command: 'remove_node' },
    actions: null,
    privileged: false,
  },
  game_change_scene: {
    domain: 'game',
    handler: 'handleGameChangeScene',
    backend: { kind: 'runtime', command: 'change_scene' },
    actions: null,
    privileged: false,
  },
  game_performance: {
    domain: 'game',
    handler: 'handleGamePerformance',
    backend: { kind: 'runtime', command: 'get_performance' },
    actions: ['sample', 'start', 'stop', 'report', 'leaks', 'stress'],
    privileged: false,
  },
  game_wait: {
    domain: 'game',
    handler: 'handleGameWait',
    backend: { kind: 'runtime', command: 'wait' },
    actions: null,
    privileged: false,
  },
  game_connect_signal: {
    domain: 'game',
    handler: 'handleGameConnectSignal',
    backend: { kind: 'runtime', command: 'connect_signal' },
    actions: null,
    privileged: false,
  },
  game_disconnect_signal: {
    domain: 'game',
    handler: 'handleGameDisconnectSignal',
    backend: { kind: 'runtime', command: 'disconnect_signal' },
    actions: null,
    privileged: false,
  },
  game_emit_signal: {
    domain: 'game',
    handler: 'handleGameEmitSignal',
    backend: { kind: 'runtime', command: 'emit_signal' },
    actions: null,
    privileged: false,
  },
  game_get_nodes_in_group: {
    domain: 'game',
    handler: 'handleGameGetNodesInGroup',
    backend: { kind: 'runtime', command: 'get_nodes_in_group' },
    actions: null,
    privileged: false,
  },
  game_find_nodes_by_class: {
    domain: 'game',
    handler: 'handleGameFindNodesByClass',
    backend: { kind: 'runtime', command: 'find_nodes_by_class' },
    actions: null,
    privileged: false,
  },
  game_reparent_node: {
    domain: 'game',
    handler: 'handleGameReparentNode',
    backend: { kind: 'runtime', command: 'reparent_node' },
    actions: null,
    privileged: false,
  },
  game_get_errors: {
    domain: 'game',
    handler: 'handleGameGetErrors',
    backend: { kind: 'runtime-buffer' },
    actions: null,
    privileged: false,
  },
  game_get_logs: {
    domain: 'game',
    handler: 'handleGameGetLogs',
    backend: { kind: 'runtime-buffer' },
    actions: null,
    privileged: false,
  },
  game_key_hold: {
    domain: 'game',
    handler: 'handleGameKeyHold',
    backend: { kind: 'runtime', command: 'key_hold' },
    actions: null,
    actionParamIsData: true,
    privileged: false,
  },
  game_key_release: {
    domain: 'game',
    handler: 'handleGameKeyRelease',
    backend: { kind: 'runtime', command: 'key_release' },
    actions: null,
    actionParamIsData: true,
    privileged: false,
  },
  game_scroll: {
    domain: 'game',
    handler: 'handleGameScroll',
    backend: { kind: 'runtime', command: 'scroll' },
    actions: null,
    privileged: false,
  },
  game_mouse_drag: {
    domain: 'game',
    handler: 'handleGameMouseDrag',
    backend: { kind: 'runtime', command: 'mouse_drag' },
    actions: null,
    privileged: false,
  },
  game_gamepad: {
    domain: 'game',
    handler: 'handleGameGamepad',
    backend: { kind: 'runtime', command: 'gamepad' },
    actions: null,
    privileged: false,
  },
  game_get_camera: {
    domain: 'game',
    handler: 'handleGameGetCamera',
    backend: { kind: 'runtime', command: 'get_camera' },
    actions: null,
    privileged: false,
  },
  game_get_audio: {
    domain: 'game',
    handler: 'handleGameGetAudio',
    backend: { kind: 'runtime', command: 'get_audio' },
    actions: null,
    privileged: false,
  },
  game_spawn_node: {
    domain: 'game',
    handler: 'handleGameSpawnNode',
    backend: { kind: 'runtime', command: 'spawn_node' },
    actions: null,
    privileged: false,
  },
  game_manage_group: {
    domain: 'game',
    handler: 'handleGameManageGroup',
    backend: { kind: 'runtime', command: 'manage_group' },
    actions: ['add', 'remove', 'get_groups'],
    privileged: false,
  },
  game_touch: {
    domain: 'game',
    handler: 'handleGameTouch',
    backend: { kind: 'runtime', command: 'touch' },
    actions: ['press', 'release', 'drag'],
    privileged: false,
  },
  game_input_state: {
    domain: 'game',
    handler: 'handleGameInputState',
    backend: { kind: 'runtime', command: 'input_state' },
    actions: ['query', 'warp_mouse', 'set_mouse_mode'],
    privileged: false,
  },
  game_input_action: {
    domain: 'game',
    handler: 'handleGameInputAction',
    backend: { kind: 'runtime', command: 'input_action' },
    actions: ['set_strength', 'add_action', 'remove_action', 'list'],
    privileged: false,
  },
  game_pause: {
    domain: 'game',
    handler: 'handleGamePause',
    backend: { kind: 'runtime', command: 'pause' },
    actions: null,
    privileged: false,
  },
  game_await_signal: {
    domain: 'game',
    handler: 'handleGameAwaitSignal',
    backend: { kind: 'runtime', command: 'await_signal' },
    actions: null,
    privileged: false,
  },
  game_script: {
    domain: 'game',
    handler: 'handleGameScript',
    backend: { kind: 'runtime', command: 'script' },
    actions: ['get_source', 'attach', 'detach'],
    privileged: true,
  },
};

