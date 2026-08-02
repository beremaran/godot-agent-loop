export const HEADLESS_MODE_ENV = 'GODOT_MCP_HEADLESS';

/**
 * When enabled, every MCP-owned long-running Godot process (run_project,
 * launch_editor, and the persistent authoring session) is spawned with
 * Godot's `--headless` flag so no window is opened. Rendering-dependent
 * operations such as screenshots fail fast with a headed-display
 * remediation; the flag is intended for CI and headless workstations.
 */
export function resolveHeadlessMode(value = process.env[HEADLESS_MODE_ENV]): boolean {
  return value === '1' || value === 'true';
}
