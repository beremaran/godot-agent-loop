// @test-kind: unit
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { describe, expect, it } from 'vitest';

import { GODOT_MCP_RUNTIME_DISABLED, buildSanitizedGodotCliEnvironment } from '../src/godot-child-environment.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shippedAutoload = join(root, 'src', 'scripts', 'mcp_interaction_server.gd');

/**
 * The TS side sets GODOT_MCP_RUNTIME_DISABLED=true for every short-lived CLI
 * invocation and the docs promise the runtime transport cannot start during
 * such runs. These contract tests pin the GDScript autoload to the same
 * behavior: the flag must be declared and must gate the TCP listener before
 * any port is resolved or bound, even when a leftover override.cfg installs
 * the autoload with a port configured.
 */
describe('runtime transport disable flag', () => {
  const autoload = readFileSync(shippedAutoload, 'utf8');

  it('declares the GODOT_MCP_RUNTIME_DISABLED constant in the shipped autoload', () => {
    expect(autoload).toMatch(/const DISABLED_ENVIRONMENT_VARIABLE: String = "GODOT_MCP_RUNTIME_DISABLED"/);
  });

  it('guards the listener with the flag before any port is bound', () => {
    const listenIndex = autoload.indexOf('_server.listen(');
    expect(listenIndex).toBeGreaterThan(-1);
    const guardIndex = autoload.indexOf('OS.get_environment(DISABLED_ENVIRONMENT_VARIABLE) == "true"');
    expect(guardIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(listenIndex);
  });

  it('returns before resolving or reading the configured port when the flag is set', () => {
    const guard = autoload.slice(
      autoload.indexOf('OS.get_environment(DISABLED_ENVIRONMENT_VARIABLE)'),
      autoload.indexOf('_server = TCPServer.new()'),
    );
    expect(guard).toContain('return');
    expect(guard).not.toContain('_resolve_port()');
  });

  it('keeps the typecheck and fixture mirrors identical to the shipped autoload', () => {
    for (const mirror of [
      join(root, 'tests', 'godot', 'fixture', 'mcp_interaction_server.gd'),
      join(root, 'tests', 'godot', 'typecheck', 'runtime', 'mcp_interaction_server.gd'),
    ]) {
      expect(readFileSync(mirror, 'utf8'), mirror).toBe(autoload);
    }
  });

  it('sets the flag for every short-lived CLI invocation', () => {
    expect(buildSanitizedGodotCliEnvironment()[GODOT_MCP_RUNTIME_DISABLED]).toBe('true');
  });
});
