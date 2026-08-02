// @test-kind: unit
import { describe, expect, it, vi } from 'vitest';
import { HEADLESS_MODE_ENV, resolveHeadlessMode } from '../src/headless-mode.js';

describe('headless mode resolution', () => {
  it('defaults to headed mode when the variable is unset or empty', () => {
    expect(resolveHeadlessMode(undefined)).toBe(false);
    expect(resolveHeadlessMode('')).toBe(false);
  });

  it('enables headless mode for 1 and true', () => {
    expect(resolveHeadlessMode('1')).toBe(true);
    expect(resolveHeadlessMode('true')).toBe(true);
  });

  it('treats any other value as headed mode', () => {
    expect(resolveHeadlessMode('0')).toBe(false);
    expect(resolveHeadlessMode('yes')).toBe(false);
  });

  it('reads the GODOT_MCP_HEADLESS environment variable by default', () => {
    vi.stubEnv(HEADLESS_MODE_ENV, '1');
    try {
      expect(resolveHeadlessMode()).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
