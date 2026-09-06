// @test-kind: unit
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RUNTIME_PORT,
  RUNTIME_PORT_ENVIRONMENT_VARIABLE,
  parseExplicitRuntimePort,
  selectRuntimePort,
} from '../src/runtime-port.js';
import {
  explicitHarnessPortRaw,
  resolveHarnessRuntimePort,
} from './e2e/helpers/harness.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Direct-integration port isolation: each run selects exactly one port (a
 * freshly allocated free port, or a validated explicit override), exports it
 * to every process that needs it, and the fixture reads the same value when
 * constructing its runtime connection. Parallel auto-allocated runs never
 * default to the literal product port.
 */
describe('direct integration runtime port isolation', () => {
  it('honors a valid explicit override as the single selected port', () => {
    expect(parseExplicitRuntimePort('18080')).toBe(18080);
    expect(resolveHarnessRuntimePort('18080', 54321)).toBe(18080);
    expect(selectRuntimePort('18080', 54321)).toBe(18080);
  });

  it('rejects an invalid explicit override with a diagnostic', () => {
    for (const raw of ['0', '65536', '-1', 'not-a-port', '9090.5']) {
      expect(() => parseExplicitRuntimePort(raw), raw).toThrow(
        new RegExp(`Invalid ${RUNTIME_PORT_ENVIRONMENT_VARIABLE}=`),
      );
      expect(() => resolveHarnessRuntimePort(raw, 54321), raw).toThrow(/expected an integer port/);
    }
  });

  it('treats an unset override as auto-allocate', () => {
    expect(parseExplicitRuntimePort(undefined)).toBeUndefined();
    expect(resolveHarnessRuntimePort(undefined, 54321)).toBe(54321);
  });

  it('prefers an extraEnv override over the ambient environment', () => {
    const previous = process.env[RUNTIME_PORT_ENVIRONMENT_VARIABLE];
    process.env[RUNTIME_PORT_ENVIRONMENT_VARIABLE] = '19091';
    try {
      expect(explicitHarnessPortRaw({ [RUNTIME_PORT_ENVIRONMENT_VARIABLE]: '19092' })).toBe('19092');
      expect(explicitHarnessPortRaw()).toBe('19091');
      expect(explicitHarnessPortRaw({})).toBe('19091');
    } finally {
      if (previous === undefined) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- process.env requires literal deletion; assignment stringifies undefined.
        delete process.env[RUNTIME_PORT_ENVIRONMENT_VARIABLE];
      } else process.env[RUNTIME_PORT_ENVIRONMENT_VARIABLE] = previous;
    }
  });

  it('selects distinct non-default ports for parallel auto-allocated runs', () => {
    const first = resolveHarnessRuntimePort(undefined, 54321);
    const second = resolveHarnessRuntimePort(undefined, 54322);
    expect(first).toBe(54321);
    expect(second).toBe(54322);
    expect(first).not.toBe(second);
    expect(first).not.toBe(DEFAULT_RUNTIME_PORT);
    expect(second).not.toBe(DEFAULT_RUNTIME_PORT);
  });

  it('propagates one shared port from the harness to the server environment', () => {
    const harness = readFileSync(join(root, 'tests', 'e2e', 'helpers', 'harness.ts'), 'utf8');
    // The selected port is applied after caller extras so extraEnv cannot
    // diverge from the reported runtimePort.
    const envBlock = harness.slice(harness.indexOf('const transport = new StdioClientTransport'));
    expect(envBlock).toContain('[RUNTIME_PORT_ENVIRONMENT_VARIABLE]: String(runtimePort)');
    expect(harness).toContain('allocateIsolatedRuntimePort()');
    expect(harness).not.toMatch(/GODOT_MCP_RUNTIME_PORT: String\(runtimePort\)[\s\S]*\.\.\.\(options\.extraEnv \?\? \{\}\)/);
  });

  it('constructs the fixture runtime connection from the same selected value', () => {
    const fixture = readFileSync(join(root, 'tests', 'godot', 'fixture', 'mcp_interaction_server.gd'), 'utf8');
    expect(fixture).toContain('const PORT_ENVIRONMENT_VARIABLE: String = "GODOT_MCP_RUNTIME_PORT"');
    expect(fixture).toContain('OS.get_environment(PORT_ENVIRONMENT_VARIABLE)');
    const shipped = readFileSync(join(root, 'src', 'scripts', 'mcp_interaction_server.gd'), 'utf8');
    expect(fixture).toBe(shipped);
  });

  it('hands the selected port to every Godot child the server launches', () => {
    const server = readFileSync(join(root, 'src', 'index.ts'), 'utf8');
    expect(server).toContain('GODOT_MCP_RUNTIME_PORT: String(RUNTIME_PORT)');
  });
});
