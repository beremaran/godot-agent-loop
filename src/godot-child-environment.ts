/**
 * Environment sanitization for every Godot process the server spawns.
 *
 * Spawned Godot processes must not inherit the server's full environment:
 * running a project executes its GDScript with the user's OS permissions, so
 * any credential in the environment would be readable by that project code.
 * Only platform essentials needed for the engine to start (PATH, home and
 * temp directories, display/locale configuration) are forwarded by default,
 * plus whatever the server explicitly passes per launch (runtime secret,
 * timing metadata, ...). Operators can forward additional variables
 * deliberately with `GODOT_MCP_CHILD_ENV_ALLOW`.
 */
export const GODOT_MCP_CHILD_ENV_ALLOW = 'GODOT_MCP_CHILD_ENV_ALLOW';

/** Essential variables forwarded from the server process by default. */
export const DEFAULT_CHILD_ENVIRONMENT_KEYS: readonly string[] = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'TMP',
  'TEMP',
  'TMPDIR',
  'XDG_RUNTIME_DIR',
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'XDG_SESSION_TYPE',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'SystemRoot',
  'SystemDrive',
  'ComSpec',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
];

/**
 * Parse the documented opt-in list of extra variables to forward from the
 * server environment into spawned Godot processes.
 */
export function resolveAdditionalChildEnvironmentKeys(source: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  return new Set(
    (source[GODOT_MCP_CHILD_ENV_ALLOW] ?? '')
      .split(',')
      .map(key => key.trim())
      .filter(Boolean),
  );
}

/**
 * Build the sanitized child environment: the default allowlist plus any
 * opt-in keys copied from the server environment, overlaid with the explicit
 * per-launch environment passed by the caller.
 */
export function buildSanitizedGodotEnvironment(
  extra?: NodeJS.ProcessEnv,
  additionalKeys?: ReadonlySet<string>,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const allowlist = new Set([...DEFAULT_CHILD_ENVIRONMENT_KEYS, ...(additionalKeys ?? resolveAdditionalChildEnvironmentKeys(source))]);
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowlist) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return { ...env, ...extra };
}
