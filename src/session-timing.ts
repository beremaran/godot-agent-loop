/** Deterministic frame delta used by every MCP-owned long-running Godot process. */
export const GODOT_SESSION_FIXED_FPS = 60;
export const GODOT_SESSION_INITIAL_TIME_SCALE = 1;
export const GODOT_SESSION_FIXED_FPS_ENV = 'GODOT_MCP_FIXED_FPS';

/**
 * Fixed FPS makes each rendered frame advance the same simulation delta.
 * max-fps retains a wall-clock cap so an idle persistent session does not spin
 * as fast as the CPU allows, and time-scale establishes a known reset value.
 */
export function deterministicSessionArguments(): string[] {
  return [
    '--fixed-fps', String(GODOT_SESSION_FIXED_FPS),
    '--max-fps', String(GODOT_SESSION_FIXED_FPS),
    '--time-scale', String(GODOT_SESSION_INITIAL_TIME_SCALE),
  ];
}

/** Metadata mirrored into the child because Godot strips recognized CLI flags from script-visible args. */
export function deterministicSessionEnvironment(): NodeJS.ProcessEnv {
  return { [GODOT_SESSION_FIXED_FPS_ENV]: String(GODOT_SESSION_FIXED_FPS) };
}
