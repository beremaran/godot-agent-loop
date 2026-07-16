import { toolManifest } from './tool-manifest.js';
import type { ToolName } from './tool-definitions.js';
import type { ToolArguments } from './utils.js';

/**
 * Calls which only observe state. Everything not listed here is deliberately
 * classified as mutating so a newly added tool cannot bypass the editor's
 * cooperative driver lock by omission.
 */
export const READ_ONLY_TOOLS: ReadonlySet<ToolName> = new Set([
  'godot_catalog',
  'get_debug_output',
  'get_godot_version',
  'list_projects',
  'get_project_info',
  'get_uid',
  'game_screenshot',
  'game_get_ui',
  'game_get_scene_tree',
  'game_get_property',
  'game_get_node_info',
  'game_get_nodes_in_group',
  'game_find_nodes_by_class',
  'read_scene',
  'read_project_settings',
  'list_project_files',
  'read_file',
  'game_get_errors',
  'game_get_logs',
  'game_get_camera',
  'game_raycast',
  'game_get_audio',
  'game_list_signals',
  'game_os_info',
  'game_physics_3d',
  'game_physics_2d',
  'validate_script',
  'validate_scripts',
]);

/** Read-only modes on tools whose other actions mutate project/runtime state. */
export const READ_ONLY_ACTIONS: Readonly<Partial<Record<ToolName, readonly string[]>>> = {
  godot_catalog: ['search', 'describe'],
  godot_tools: ['search', 'describe'],
  editor_session: ['status', 'disconnect'],
  editor_control: ['inspect'],
  run_project_tests: ['discover'],
  manage_import_pipeline: ['inspect', 'dependencies'],
  analyze_project_integrity: ['analyze', 'preview_rename', 'assets', 'localization', 'accessibility', 'extensions', 'leaks'],
  verify_export_readiness: ['inspect'],
  verify_dotnet_project: ['inspect'],
  manage_addon: ['inspect'],
  game_performance: ['sample', 'report', 'leaks'],
  game_play_animation: ['get_list'],
  manage_autoloads: ['list'],
  manage_input_map: ['list'],
  manage_export_presets: ['list'],
  game_tilemap: ['get_cell', 'get_used_cells'],
  game_environment: ['get'],
  game_manage_group: ['get_groups'],
  game_bone_pose: ['list', 'get'],
  game_viewport: ['get'],
  game_websocket: ['status'],
  game_multiplayer: ['status'],
  game_input_state: ['query'],
  game_input_action: ['list'],
  game_script: ['get_source'],
  game_window: ['get'],
  game_time_scale: ['get'],
  game_world_settings: ['get'],
  game_multimesh: ['get_info'],
  game_gridmap: ['get_cell', 'get_used'],
  game_path_3d: ['get_points'],
  game_camera_attributes: ['get'],
  game_path_2d: ['get_points'],
  game_shape_2d: ['get_points'],
  game_animation_tree: ['get_state'],
  game_animation_control: ['get_info'],
  game_audio_effect: ['list'],
  game_audio_bus_layout: ['list'],
  game_audio_spatial: ['get_info'],
  manage_resource: ['read'],
  manage_scene_signals: ['list'],
  manage_layers: ['list'],
  manage_plugins: ['list'],
  manage_shader: ['read'],
  manage_theme_resource: ['read'],
  manage_translations: ['list'],
  game_locale: ['get', 'translate'],
  game_ui_control: ['get_info'],
  game_ui_text: ['get'],
  game_ui_popup: ['get_info'],
  game_ui_tree: ['get_items'],
  game_ui_item_list: ['get_items'],
  game_ui_tabs: ['get_tabs'],
  game_ui_menu: ['get_items'],
  game_ui_range: ['get'],
  game_render_settings: ['get'],
  game_resource: ['exists'],
  game_visual_shader: ['get_nodes'],
  game_terrain: ['get_height'],
  game_video: ['get_status'],
  manage_ci_pipeline: ['read'],
  manage_docker_export: ['read'],
};

/**
 * Returns true unless a call is explicitly proven observational. Unknown tools,
 * missing selectors, and action fields used as data all remain mutating.
 */
export function isToolCallMutating(name: string, args: ToolArguments): boolean {
  if (name === 'godot_call' || (name === 'godot_tools' && args.action === 'call')) {
    if (typeof args.toolName !== 'string' || ['godot_tools', 'godot_call', 'godot_catalog'].includes(args.toolName)) return true;
    const nested = args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)
      ? args.arguments as ToolArguments
      : {};
    return isToolCallMutating(args.toolName, nested);
  }
  if (!Object.prototype.hasOwnProperty.call(toolManifest, name)) return true;
  const toolName = name as ToolName;
  if (READ_ONLY_TOOLS.has(toolName)) return false;

  const entry = toolManifest[toolName];
  if (entry.actionParamIsData) return true;
  const readOnlyActions = READ_ONLY_ACTIONS[toolName];
  return !readOnlyActions?.includes(typeof args.action === 'string' ? args.action : '');
}

/**
 * Pausing protects persistent and ephemeral mutation while retaining the
 * observation and cleanup calls needed to understand and safely unwind state.
 */
export function isToolCallAllowedWhilePaused(name: string, args: ToolArguments): boolean {
  if (!isToolCallMutating(name, args)) return true;
  if (name === 'godot_call' || (name === 'godot_tools' && args.action === 'call')) {
    if (typeof args.toolName !== 'string') return false;
    const nested = args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)
      ? args.arguments as ToolArguments
      : {};
    return isToolCallAllowedWhilePaused(args.toolName, nested);
  }
  // Re-establishing the watched editor is part of the human-control channel,
  // not an agent-authored project/runtime mutation. It must remain possible
  // after a paused editor exits so the same paused state can be observed and
  // resumed by the human UI.
  if (name === 'launch_editor' || (name === 'editor_session' && args.action === 'ensure')) return true;
  if (name === 'stop_project' || name === 'game_key_release') return true;
  if (name === 'game_key_press' && args.pressed === false) return true;
  if (name === 'game_touch' && (args.action === 'release' || args.pressed === false)) return true;
  if (name === 'game_gamepad' && Number(args.value) === 0) return true;
  if (name === 'game_input_action' && args.action === 'set_strength' && Number(args.strength) === 0) return true;
  return false;
}
