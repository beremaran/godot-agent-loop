// @test-kind: unit
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectGodotExecutablePath } from '../src/godot-executable.js';

const originalGodotPath = process.env.GODOT_PATH;

afterEach(() => {
  if (originalGodotPath === undefined) delete process.env.GODOT_PATH;
  else process.env.GODOT_PATH = originalGodotPath;
  vi.restoreAllMocks();
});

describe('Godot executable detection', () => {
  it('keeps an explicitly configured invalid path authoritative', async () => {
    process.env.GODOT_PATH = '/deliberately/missing/godot';
    const isValid = vi.fn().mockResolvedValue(false);
    const logs: string[] = [];

    const detected = await detectGodotExecutablePath({
      currentPath: null,
      strictPathValidation: false,
      isValid,
      logDebug: message => { logs.push(message); },
    });

    expect(detected).toBe('/deliberately/missing/godot');
    expect(isValid).toHaveBeenCalledOnce();
    expect(logs).toContain('GODOT_PATH environment variable is invalid: /deliberately/missing/godot');
  });
});
