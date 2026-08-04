export const HEADLESS_MODE_ENV = 'GODOT_MCP_HEADLESS';

/**
 * When enabled, every MCP-owned long-running Godot process that would otherwise
 * open a window (`run_project`) is spawned with Godot's
 * `--headless` flag. Authoring is file-based and never opens a window, so the
 * flag does not govern it. Rendering-dependent operations such as screenshots
 * fail fast with a headed-display remediation; the flag is intended for CI and
 * headless workstations.
 */
export function resolveHeadlessMode(value = process.env[HEADLESS_MODE_ENV]): boolean {
  return value === '1' || value === 'true';
}
