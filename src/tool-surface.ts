import { toolDefinitions, type ToolDefinition, type ToolName } from './tool-definitions.js';
import { toolManifest } from './tool-manifest.js';

export const TOOL_SURFACE_ENV = 'GODOT_MCP_TOOL_SURFACE';
export type ToolSurfaceMode = 'core' | 'full';

/**
 * Stable, task-oriented starting surface. The complete catalog remains callable
 * through godot_tools and can be advertised directly with TOOL_SURFACE_ENV=full.
 */
export const CORE_TOOL_NAMES: ReadonlySet<ToolName> = new Set([
  'godot_tools',
  'launch_editor', 'editor_session', 'editor_control', 'editor_transaction', 'run_project', 'verify_project', 'game_wait_until', 'game_scenario', 'run_project_tests',
  'get_debug_output', 'stop_project', 'get_godot_version', 'get_project_info',
  'create_project', 'create_scene', 'add_node', 'read_scene', 'modify_scene_node',
  'remove_scene_node', 'save_scene', 'create_script', 'attach_script', 'read_file',
  'write_file', 'validate_script', 'validate_scripts', 'read_project_settings',
  'modify_project_settings', 'manage_input_map', 'set_main_scene',
  'game_get_scene_tree', 'game_get_ui', 'game_screenshot', 'game_get_node_info',
  'game_get_errors', 'game_get_logs', 'game_click', 'game_key_press',
  'game_key_release',
]);

export const TOOL_SURFACE_BUDGETS = {
  fullBytesMax: 100_000,
  coreBytesMax: 25_000,
  coreEstimatedTokensMax: 6_250,
  coreToolCountMax: 40,
  coreReductionPercentMin: 70,
} as const;

export function resolveToolSurfaceMode(value = process.env[TOOL_SURFACE_ENV]): ToolSurfaceMode {
  return value === 'full' ? 'full' : 'core';
}

export function advertisedToolDefinitions(
  mode: ToolSurfaceMode = resolveToolSurfaceMode(),
): readonly ToolDefinition[] {
  return mode === 'full'
    ? toolDefinitions
    : toolDefinitions.filter(definition => CORE_TOOL_NAMES.has(definition.name));
}

export function compactToolSurfaceBytes(definitions: readonly ToolDefinition[]): number {
  return Buffer.byteLength(JSON.stringify(definitions), 'utf8');
}

export function estimatedToolSurfaceTokens(definitions: readonly ToolDefinition[]): number {
  return Math.ceil(compactToolSurfaceBytes(definitions) / 4);
}

export function searchToolCatalog(
  query: string,
  domain?: string,
  limit = 20,
): Record<string, unknown>[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return toolDefinitions
    .filter(definition => {
      const manifest = toolManifest[definition.name];
      if (domain && manifest.domain !== domain) return false;
      const searchable = [definition.name, definition.description, ...(manifest.actions ?? [])]
        .join(' ').toLowerCase();
      return terms.every(term => searchable.includes(term));
    })
    .slice(0, limit)
    .map(definition => {
      const manifest = toolManifest[definition.name];
      return {
        name: definition.name,
        domain: manifest.domain,
        description: definition.description,
        actions: manifest.actions ?? ['*'],
        privileged: manifest.privileged,
      };
    });
}

export function describeCatalogTool(name: string): Record<string, unknown> | undefined {
  const definition = toolDefinitions.find(candidate => candidate.name === name);
  if (!definition) return undefined;
  const manifest = toolManifest[definition.name];
  return { definition, domain: manifest.domain, backend: manifest.backend, privileged: manifest.privileged };
}
