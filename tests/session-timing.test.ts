// @test-kind: unit
import { describe, expect, it } from 'vitest';
import {
  GODOT_SESSION_FIXED_FPS,
  GODOT_SESSION_FIXED_FPS_ENV,
  GODOT_SESSION_INITIAL_TIME_SCALE,
  GODOT_SESSION_TIMING_MODE_ENV,
  deterministicSessionArguments,
  deterministicSessionEnvironment,
  realtimeSessionArguments,
  realtimeSessionEnvironment,
  timingPolicy,
} from '../src/session-timing.js';

describe('deterministicSessionArguments', () => {
  it('pins fixed-fps, max-fps, and time-scale to the shared constants', () => {
    expect(deterministicSessionArguments()).toEqual([
      '--fixed-fps', String(GODOT_SESSION_FIXED_FPS),
      '--max-fps', String(GODOT_SESSION_FIXED_FPS),
      '--time-scale', String(GODOT_SESSION_INITIAL_TIME_SCALE),
    ]);
    expect(GODOT_SESSION_FIXED_FPS).toBe(60);
  });

  it('keeps max-fps equal to fixed-fps so an idle session cannot spin the CPU', () => {
    const args = deterministicSessionArguments();
    expect(args[args.indexOf('--max-fps') + 1]).toBe(String(GODOT_SESSION_FIXED_FPS));
  });
});

describe('deterministicSessionEnvironment', () => {
  it('mirrors the fixed FPS and timing mode into the child environment', () => {
    expect(deterministicSessionEnvironment()).toEqual({
      [GODOT_SESSION_FIXED_FPS_ENV]: String(GODOT_SESSION_FIXED_FPS),
      [GODOT_SESSION_TIMING_MODE_ENV]: 'deterministic',
    });
  });
});

describe('realtimeSessionArguments', () => {
  it('only restores the time-scale and does not force fixed deltas', () => {
    expect(realtimeSessionArguments()).toEqual(['--time-scale', String(GODOT_SESSION_INITIAL_TIME_SCALE)]);
  });
});

describe('realtimeSessionEnvironment', () => {
  it('declares the realtime timing mode and no fixed FPS', () => {
    expect(realtimeSessionEnvironment()).toEqual({
      [GODOT_SESSION_FIXED_FPS_ENV]: '',
      [GODOT_SESSION_TIMING_MODE_ENV]: 'realtime',
    });
  });
});

describe('timingPolicy', () => {
  it('declares the deterministic policy with fixed frame pacing', () => {
    expect(timingPolicy('deterministic')).toEqual({
      mode: 'deterministic',
      fixed_fps: GODOT_SESSION_FIXED_FPS,
      max_fps: GODOT_SESSION_FIXED_FPS,
      time_scale: 1,
      display_pacing: false,
    });
  });

  it('declares the realtime policy with display pacing and no forced deltas', () => {
    expect(timingPolicy('realtime')).toEqual({
      mode: 'realtime',
      fixed_fps: null,
      max_fps: null,
      time_scale: 1,
      display_pacing: true,
    });
  });
});
