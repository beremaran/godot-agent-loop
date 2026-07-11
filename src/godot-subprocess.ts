import type { ExecFileOptionsWithStringEncoding } from 'child_process';

/** Shared resource limits for short-lived Godot CLI invocations. */
export const GODOT_COMMAND_TIMEOUT_MS = 30_000;
export const GODOT_VERSION_TIMEOUT_MS = 10_000;
export const GODOT_EXPORT_TIMEOUT_MS = 120_000;
export const GODOT_COMMAND_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export const GODOT_COMMAND_OPTIONS: ExecFileOptionsWithStringEncoding = {
  timeout: GODOT_COMMAND_TIMEOUT_MS,
  maxBuffer: GODOT_COMMAND_MAX_BUFFER_BYTES,
  encoding: 'utf8',
};

export const GODOT_VERSION_OPTIONS: ExecFileOptionsWithStringEncoding = {
  timeout: GODOT_VERSION_TIMEOUT_MS,
  maxBuffer: GODOT_COMMAND_MAX_BUFFER_BYTES,
  encoding: 'utf8',
};

export const GODOT_EXPORT_OPTIONS: ExecFileOptionsWithStringEncoding = {
  timeout: GODOT_EXPORT_TIMEOUT_MS,
  maxBuffer: GODOT_COMMAND_MAX_BUFFER_BYTES,
  encoding: 'utf8',
};

/** Long-running game processes retain only recent output to protect server memory. */
export const GODOT_PROCESS_LOG_LINE_LIMIT = 1_000;
export const GODOT_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5_000;
