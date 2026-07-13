// @test-kind: contract
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(fileURLToPath(new URL('..', import.meta.url)));

const SERVER = 'src/scripts/mcp_interaction_server.gd';
const HEADLESS = 'src/scripts/godot_operations.gd';

/** Every shipped GDScript file: the two entry points plus the runtime domain scripts. */
function shippedScripts(): string[] {
  const runtimeDir = join(root, 'src/scripts/mcp_runtime');
  const domains = readdirSync(runtimeDir)
    .filter(file => file.endsWith('.gd'))
    .map(file => `src/scripts/mcp_runtime/${file}`);
  return [HEADLESS, SERVER, ...domains];
}

function read(relativePath: string): string {
  return readFileSync(join(root, relativePath), 'utf8');
}

/** Source lines paired with their 1-based number, with comment-only lines dropped. */
function codeLines(source: string): { line: number; text: string }[] {
  return source
    .split('\n')
    .map((text, index) => ({ line: index + 1, text }))
    .filter(entry => !/^\s*#/.test(entry.text));
}

describe('GDScript source guardrails', () => {
  // The typing gate itself lives in tests/godot/typecheck; these are the rules
  // Godot's warnings cannot express, and they are what keep the gate honest.

  it('suppresses warnings only per line, never across a region or a file', () => {
    // @warning_ignore_start disables a warning until it is restored, so a single
    // line of it would silently reopen everything the strict tiers now promote.
    for (const path of shippedScripts()) {
      const offenders = codeLines(read(path)).filter(entry =>
        /@warning_ignore_start|@warning_ignore_restore/.test(entry.text)
      );
      expect(offenders.map(entry => `${path}:${entry.line}`)).toEqual([]);
    }
  });

  it('names the warning it suppresses at every @warning_ignore', () => {
    // A bare @warning_ignore() would suppress nothing but still read as intent;
    // an argument list keeps each suppression greppable and reviewable.
    for (const path of shippedScripts()) {
      const offenders = codeLines(read(path)).filter(
        entry => entry.text.includes('@warning_ignore') && !/@warning_ignore\("[^"]+"/.test(entry.text)
      );
      expect(offenders.map(entry => `${path}:${entry.line}`)).toEqual([]);
    }
  });

  it('gives every runtime command handler a typed params argument and no return value', () => {
    // Handlers are dispatched through one awaited Callable, so a handler that
    // took an untyped argument or returned a value would break the registry's
    // uniform contract rather than fail at the call site.
    let handlers = 0;
    for (const path of shippedScripts().filter(file => file !== HEADLESS)) {
      for (const entry of codeLines(read(path))) {
        const match = /^func (_cmd_\w+)\(([^)]*)\)(.*)$/.exec(entry.text);
        if (!match) continue;
        const [, name, args, tail] = match;
        const where = `${path}:${entry.line} ${name}`;
        // An unused params argument is spelled `_params`, and is still typed.
        expect(args.replace(/^_/, ''), `${where} must take (params: Dictionary)`).toBe('params: Dictionary');
        expect(tail.trim(), `${where} must declare -> void`).toBe('-> void:');
        handlers += 1;
      }
    }
    expect(handlers).toBeGreaterThan(50);
  });

  it('calls quit() only from the headless CLI entry point', () => {
    // Every operation returns an OperationResult, so exactly one place decides
    // the process exit status. A quit() inside an operation would reintroduce
    // the bug where a failure still exited 0.
    const source = read(HEADLESS);
    const initStart = source.split('\n').findIndex(text => text.startsWith('func _init('));
    const initEnd = source
      .split('\n')
      .findIndex((text, index) => index > initStart && text.startsWith('func '));
    const offenders = codeLines(source).filter(
      entry => /(^|[^\w.])quit\(/.test(entry.text) && (entry.line <= initStart || entry.line > initEnd)
    );
    expect(offenders.map(entry => `${HEADLESS}:${entry.line}`)).toEqual([]);
  });

  it('writes to a socket only from the transport layer', () => {
    // Domains reach the client through RuntimeDomain.respond(); a put_data() or
    // disconnect_from_host() anywhere else would bypass session correlation,
    // response limits, and the request lifecycle.
    const socketCall = /\b(put_data|put_partial_data|disconnect_from_host)\s*\(/;
    for (const path of shippedScripts().filter(file => file !== SERVER && file !== HEADLESS)) {
      const offenders = codeLines(read(path)).filter(entry => socketCall.test(entry.text));
      expect(offenders.map(entry => `${path}:${entry.line}`)).toEqual([]);
    }
    // The server keeps them, which is what makes it the transport layer.
    expect(read(SERVER)).toMatch(socketCall);
  });

  it('reaches the client only through the RuntimeDomain helpers', () => {
    // A domain that touched _sessions, _active_session, or a request id directly
    // would be able to answer a request that is no longer the live one.
    const transportInternals = /\b(_sessions|_active_session|_send_response_raw|_send_error|request_id)\b/;
    const runtimeDir = join(root, 'src/scripts/mcp_runtime');
    const domains = readdirSync(runtimeDir).filter(file => file.endsWith('_domain.gd'));
    expect(domains.length).toBeGreaterThan(0);
    for (const file of domains) {
      const path = `src/scripts/mcp_runtime/${file}`;
      const offenders = codeLines(read(path)).filter(entry => transportInternals.test(entry.text));
      expect(offenders.map(entry => `${path}:${entry.line}`)).toEqual([]);
    }
  });
});
