/** Deterministic frame delta used by every MCP-owned long-running Godot process. */
export const GODOT_SESSION_FIXED_FPS = 60;
export const GODOT_SESSION_INITIAL_TIME_SCALE = 1;
export const GODOT_SESSION_FIXED_FPS_ENV = 'GODOT_MCP_FIXED_FPS';
export const GODOT_SESSION_TIMING_MODE_ENV = 'GODOT_MCP_TIMING_MODE';
export type TimingMode = 'realtime' | 'deterministic';

export interface TimingPolicy {
  mode: TimingMode;
  fixed_fps: number | null;
  max_fps: number | null;
  time_scale: number;
  display_pacing: boolean;
}

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
  return {
    [GODOT_SESSION_FIXED_FPS_ENV]: String(GODOT_SESSION_FIXED_FPS),
    [GODOT_SESSION_TIMING_MODE_ENV]: 'deterministic',
  };
}

/** Watched runs retain normal display/VSync pacing and do not force fixed simulation deltas. */
export function realtimeSessionArguments(): string[] {
  return ['--time-scale', String(GODOT_SESSION_INITIAL_TIME_SCALE)];
}

export function realtimeSessionEnvironment(): NodeJS.ProcessEnv {
  return { [GODOT_SESSION_FIXED_FPS_ENV]: '', [GODOT_SESSION_TIMING_MODE_ENV]: 'realtime' };
}

export function timingPolicy(mode: TimingMode): TimingPolicy {
  return mode === 'deterministic'
    ? { mode, fixed_fps: GODOT_SESSION_FIXED_FPS, max_fps: GODOT_SESSION_FIXED_FPS, time_scale: 1, display_pacing: false }
    : { mode, fixed_fps: null, max_fps: null, time_scale: 1, display_pacing: true };
}
