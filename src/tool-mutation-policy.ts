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
  'game_screenshot',
  'game_get_ui',
  'game_get_scene_tree',
  'game_get_property',
  'game_get_node_info',
  'game_get_nodes_in_group',
  'game_find_nodes_by_class',
  'game_get_errors',
  'game_get_logs',
  'game_get_camera',
  'game_get_audio',
]);

/** Read-only modes on tools whose other actions mutate project/runtime state. */
export const READ_ONLY_ACTIONS: Readonly<Partial<Record<ToolName, readonly string[]>>> = {
  godot_catalog: ['search', 'describe'],
  editor_session: ['status', 'disconnect'],
  editor_control: ['inspect', 'select', 'open_scene'],
  run_project_tests: ['discover'],
  manage_import_pipeline: ['inspect', 'dependencies'],
  analyze_project_integrity: ['analyze', 'preview_rename', 'assets', 'localization', 'accessibility', 'extensions', 'leaks'],
  verify_export_readiness: ['inspect'],
  verify_dotnet_project: ['inspect'],
  manage_addon: ['inspect'],
  game_performance: ['sample', 'report', 'leaks'],
  game_manage_group: ['get_groups'],
  game_input_state: ['query'],
  game_input_action: ['list'],
  game_script: ['get_source'],
};

/**
 * Returns true unless a call is explicitly proven observational. Unknown tools,
 * missing selectors, and action fields used as data all remain mutating.
 */
export function isToolCallMutating(name: string, args: ToolArguments): boolean {
  if (name === 'godot_call') {
    if (typeof args.toolName !== 'string' || ['godot_call', 'godot_catalog'].includes(args.toolName)) return true;
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
  if (name === 'godot_call') {
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
  if (name === 'editor_session' && args.action === 'ensure') return true;
  if (name === 'stop_project' || name === 'game_key_release') return true;
  if (name === 'game_key_press' && args.pressed === false) return true;
  if (name === 'game_touch' && (args.action === 'release' || args.pressed === false)) return true;
  if (name === 'game_gamepad' && Number(args.value) === 0) return true;
  if (name === 'game_input_action' && args.action === 'set_strength' && Number(args.strength) === 0) return true;
  return false;
}
