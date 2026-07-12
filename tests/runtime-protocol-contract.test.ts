import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CANCELLABLE_RUNTIME_COMMANDS, CANCEL_METHOD, HANDSHAKE_METHOD, RUNTIME_CAPABILITIES, RUNTIME_PROTOCOL_VERSION, commandMethod } from '../src/runtime-protocol.js';

const root = join(fileURLToPath(new URL('..', import.meta.url)));

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
});
