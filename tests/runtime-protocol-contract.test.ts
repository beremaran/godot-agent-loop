import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CANCELLABLE_RUNTIME_COMMANDS, CANCEL_METHOD, HANDSHAKE_METHOD, RUNTIME_CAPABILITIES, RUNTIME_COMMANDS, RUNTIME_PROTOCOL_VERSION, commandMethod } from '../src/runtime-protocol.js';

const root = join(fileURLToPath(new URL('..', import.meta.url)));

function schemaCommands(): string[] {
  const schema = JSON.parse(readFileSync(join(root, 'docs/runtime-api.schema.json'), 'utf8'));
  return schema['x-runtime-contract'].commands as string[];
}

/** Every .gd file that can register commands: the composition root plus each domain script. */
function gdscriptSources(): string[] {
  const runtimeDir = join(root, 'src/scripts/mcp_runtime');
  const domains = readdirSync(runtimeDir)
    .filter(file => file.endsWith('.gd'))
    .map(file => join(runtimeDir, file));
  return [join(root, 'src/scripts/mcp_interaction_server.gd'), ...domains];
}

function gdscriptRegisteredCommands(): string[] {
  // Matches the server's _register_command("x", ...) and a domain's register_command("x", ...).
  return gdscriptSources().flatMap(path =>
    [...readFileSync(path, 'utf8').matchAll(/register_command\("([^"]*)"/g)].map(match => match[1])
  );
}

function typescriptSentCommands(): string[] {
  const handlers = readFileSync(join(root, 'src/tool-handlers/game-tool-handlers.ts'), 'utf8');
  return [...handlers.matchAll(/(?:gameCommand|execute|send)\('([^']*)'/g)].map(match => match[1]);
}

describe('runtime protocol contract', () => {
  it('keeps the TypeScript and GDScript bindings aligned with the published schema', () => {
    const schema = JSON.parse(readFileSync(join(root, 'docs/runtime-api.schema.json'), 'utf8'));
    const gdscript = readFileSync(join(root, 'src/scripts/mcp_interaction_server.gd'), 'utf8');

    expect(schema['x-runtime-contract'].protocolVersion).toBe(RUNTIME_PROTOCOL_VERSION);
    expect(schema['x-runtime-contract'].capabilities).toEqual([...RUNTIME_CAPABILITIES]);
    expect(schema.$defs.request.properties.method.pattern).toContain('godot');
    expect(gdscript).toContain(`const PROTOCOL_VERSION: String = "${RUNTIME_PROTOCOL_VERSION}"`);
    expect(gdscript).toContain(`const METHOD_PREFIX: String = "${HANDSHAKE_METHOD.replace('handshake', '')}"`);
    for (const capability of RUNTIME_CAPABILITIES) expect(gdscript).toContain(`"${capability}"`);
    expect(schema['x-runtime-contract'].cancellation.method).toBe(CANCEL_METHOD);
    expect(schema['x-runtime-contract'].cancellation.cancellableCommands).toEqual([...CANCELLABLE_RUNTIME_COMMANDS]);
  });

  it('uses the contract namespace for every runtime command method', () => {
    expect(commandMethod('get_scene_tree')).toBe('godot.runtime.get_scene_tree');
  });

  it('publishes a well-formed command manifest in the schema', () => {
    const commands = schemaCommands();
    const schema = JSON.parse(readFileSync(join(root, 'docs/runtime-api.schema.json'), 'utf8'));
    const methodPattern = new RegExp(schema.$defs.request.properties.method.pattern);

    expect(commands.length).toBeGreaterThan(0);
    expect(commands).toEqual([...commands].sort());
    expect(new Set(commands).size).toBe(commands.length);
    for (const command of commands) {
      expect(command).toMatch(/^[a-z0-9_]+$/);
      expect(commandMethod(command)).toMatch(methodPattern);
    }
    expect(schema['x-runtime-contract'].cancellation.cancellableCommands.every((command: string) => commands.includes(command))).toBe(true);
  });

  it('keeps the TypeScript command binding identical to the schema manifest', () => {
    // Exact array equality rejects missing, extra, and misnamed commands.
    expect([...RUNTIME_COMMANDS]).toEqual(schemaCommands());
  });

  it('registers exactly the schema manifest commands in the GDScript server', () => {
    const registered = gdscriptRegisteredCommands();
    expect(new Set(registered).size).toBe(registered.length);
    expect([...registered].sort()).toEqual(schemaCommands());
  });

  it('only sends manifest commands from the TypeScript tool handlers, and exercises all of them', () => {
    const sent = [...new Set(typescriptSentCommands())].sort();
    expect(sent).toEqual(schemaCommands());
  });

  it('keeps request state on a typed connection session', () => {
    const gdscript = readFileSync(join(root, 'src/scripts/mcp_interaction_server.gd'), 'utf8');

    expect(gdscript).toContain('class RuntimeSession:');
    expect(gdscript).toContain('var _sessions: Dictionary = {}');
    expect(gdscript).toContain('var _next_session_id: int = 1');
    expect(gdscript).toContain('_send_response_raw(session,');
    expect(gdscript).not.toContain('var _client: StreamPeerTCP');
    expect(gdscript).not.toContain('var _busy: bool');
    expect(gdscript).not.toContain('var _current_id: Variant');
    expect(gdscript).toContain('var request_state: String = "received"');
    expect(gdscript).toContain('const CANCELLABLE_COMMANDS: Array[String] = ["wait", "await_signal"]');
  });

  it('dispatches runtime commands through a typed registry', () => {
    const gdscript = readFileSync(join(root, 'src/scripts/mcp_interaction_server.gd'), 'utf8');

    expect(gdscript).toContain('class CommandDescriptor:');
    expect(gdscript).toContain('func _register_commands() -> void:');
    expect(gdscript).toContain('_send_error(session, req_id, -32601, "Unknown method: %s" % method)');
    // Unknown commands must be a JSON-RPC -32601 error, never a successful
    // transport envelope wrapping an application-level error string.
    expect(gdscript).not.toContain('"Unknown command:');
    expect(gdscript).not.toContain('match command:');
  });

  it('owns subsystem handlers in domain scripts, not in the composition root', () => {
    const server = readFileSync(join(root, 'src/scripts/mcp_interaction_server.gd'), 'utf8');
    const inputDomain = readFileSync(join(root, 'src/scripts/mcp_runtime/input_domain.gd'), 'utf8');

    // The input domain owns its commands and the input state that used to sit on the server.
    for (const command of ['click', 'key_press', 'key_hold', 'key_release', 'scroll', 'mouse_move', 'mouse_drag', 'gamepad', 'touch', 'input_state', 'input_action']) {
      expect(inputDomain).toContain(`register_command("${command}"`);
      expect(server).not.toContain(`_cmd_${command}(`);
    }
    for (const state of ['_held_keys', '_key_map', '_string_to_keycode']) {
      expect(inputDomain).toContain(state);
      expect(server).not.toContain(state);
    }

    // Domains reach the transport only through RuntimeDomain, never through
    // sessions, sockets, or the registry directly.
    const domainFiles = gdscriptSources().filter(path => path.includes('mcp_runtime') && !path.endsWith('runtime_domain.gd') && !path.endsWith('command_params.gd'));
    expect(domainFiles.length).toBeGreaterThan(0);
    for (const path of domainFiles) {
      const domain = readFileSync(path, 'utf8');
      expect(domain).toContain('extends "res://mcp_runtime/runtime_domain.gd"');
      for (const internal of ['_sessions', '_active_session', '_send_response_raw', 'StreamPeerTCP', '_commands[']) {
        expect(domain).not.toContain(internal);
      }
    }
  });

  it('resolves every res:// script path the runtime preloads', () => {
    // A preload or DOMAIN_SCRIPTS path that does not exist in the installed layout
    // fails the autoload at parse time, so the paths are checked against disk.
    for (const path of gdscriptSources()) {
      const source = readFileSync(path, 'utf8');
      const referenced = [...source.matchAll(/"(res:\/\/mcp_runtime\/[^"]+\.gd)"/g)].map(match => match[1]);
      for (const reference of referenced) {
        const onDisk = join(root, 'src/scripts', reference.replace('res://', ''));
        expect(existsSync(onDisk), `${path} references missing ${reference}`).toBe(true);
      }
    }
    // The server must load every domain script that exists.
    const server = readFileSync(join(root, 'src/scripts/mcp_interaction_server.gd'), 'utf8');
    const domains = readdirSync(join(root, 'src/scripts/mcp_runtime'))
      .filter(file => file.endsWith('_domain.gd') && file !== 'runtime_domain.gd');
    for (const domain of domains) {
      expect(server).toContain(`"res://mcp_runtime/${domain}"`);
    }
  });

  it('documents and enforces bounded runtime transport payloads', () => {
    const schema = JSON.parse(readFileSync(join(root, 'docs/runtime-api.schema.json'), 'utf8'));
    const gdscript = readFileSync(join(root, 'src/scripts/mcp_interaction_server.gd'), 'utf8');

    expect(schema['x-runtime-contract'].limits).toMatchObject({
      requestLineBytes: 1024 * 1024,
      receiveBufferBytes: 2 * 1024 * 1024,
      responseBytes: 8 * 1024 * 1024,
      screenshotPngBytes: 6 * 1024 * 1024,
    });
    expect(schema['x-runtime-contract'].errorCodes['-32006']).toContain('limit');
    expect(gdscript).toContain('@export var max_request_line_bytes: int = 1 * 1024 * 1024');
    expect(gdscript).toContain('@export var max_response_bytes: int = 8 * 1024 * 1024');
    expect(gdscript).toContain('func _validate_json_limits(');
    expect(gdscript).toContain('line.to_utf8_buffer() != line_bytes');
    expect(gdscript).toContain('max_screenshot_png_bytes');
  });
});
