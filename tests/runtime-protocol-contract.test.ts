// @test-kind: contract
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AUTHORING_COMMANDS, AUTHORING_COMMANDS_CAPABILITY, CANCELLABLE_RUNTIME_COMMANDS, CANCEL_METHOD, HANDSHAKE_METHOD, PRIVILEGED_RUNTIME_CAPABILITY, PRIVILEGED_RUNTIME_COMMANDS, PRIVILEGED_RUNTIME_COMMAND_GROUPS, PRIVILEGED_RUNTIME_GROUPS, RENDERING_CONTEXT_CAPABILITY, RUNTIME_CAPABILITIES, RUNTIME_COMMANDS, RUNTIME_PROTOCOL_VERSION, SESSION_AUTHENTICATION_CAPABILITY, SESSION_COMMANDS, commandMethod } from '../src/runtime-protocol.js';
import { GODOT_SESSION_FIXED_FPS, GODOT_SESSION_FIXED_FPS_ENV, GODOT_SESSION_INITIAL_TIME_SCALE } from '../src/session-timing.js';

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

  it('publishes and enforces the privileged-command policy', () => {
    const schema = JSON.parse(readFileSync(join(root, 'docs/runtime-api.schema.json'), 'utf8'));
    const policy = schema['x-runtime-contract'].privilegedCommandPolicy;
    const server = readFileSync(join(root, 'src/scripts/mcp_interaction_server.gd'), 'utf8');
    const policyScript = readFileSync(join(root, 'src/scripts/mcp_runtime/privileged_command_policy.gd'), 'utf8');

    expect(policy.capability).toBe(PRIVILEGED_RUNTIME_CAPABILITY);
    expect(policy.commands).toEqual([...PRIVILEGED_RUNTIME_COMMANDS]);
    const groupedCommands = Object.values(policy.groups).flat().sort();
    expect(groupedCommands).toEqual([...PRIVILEGED_RUNTIME_COMMANDS].sort());
    expect(Object.keys(policy.groups)).toEqual([...PRIVILEGED_RUNTIME_GROUPS]);
    for (const command of PRIVILEGED_RUNTIME_COMMANDS) {
      expect(policy.groups[PRIVILEGED_RUNTIME_COMMAND_GROUPS[command]]).toContain(command);
    }
    expect(policy.default).toBe('deny');
    expect(policy.deniedErrorCode).toBe(-32007);
    expect(server).toContain('@export var allow_privileged_commands: bool = false');
    expect(server).toContain('ERROR_PRIVILEGED_COMMAND_DISABLED');
    expect(server).toContain('_privileged_policy.denial_details(command)');
    expect(policyScript).toContain('GODOT_MCP_ALLOW_PRIVILEGED_COMMANDS');
    expect(policyScript).toContain('GODOT_MCP_PRIVILEGED_GROUPS');
    expect(policyScript).toContain('"privileged_command_disabled"');
  });

  it('publishes and enforces per-session authentication', () => {
    const schema = JSON.parse(readFileSync(join(root, 'docs/runtime-api.schema.json'), 'utf8'));
    const authentication = schema['x-runtime-contract'].authentication;
    const server = readFileSync(join(root, 'src/scripts/mcp_interaction_server.gd'), 'utf8');

    expect(authentication.capability).toBe(SESSION_AUTHENTICATION_CAPABILITY);
    expect(authentication.environment).toBe('GODOT_MCP_RUNTIME_SECRET');
    expect(authentication.generatedBits).toBe(256);
    expect(authentication.errorCode).toBe(-32008);
    expect(server).toContain('var authenticated: bool = false');
    expect(server).toContain('ERROR_AUTHENTICATION_REQUIRED');
    expect(server).toContain('"authentication_failed"');
    expect(server).toContain('"authentication_required"');
  });

  it('publishes structured, correlated, redacted runtime observability', () => {
    const schema = JSON.parse(readFileSync(join(root, 'docs/runtime-api.schema.json'), 'utf8'));
    const observability = schema['x-runtime-contract'].observability;
    const server = readFileSync(join(root, 'src/scripts/mcp_interaction_server.gd'), 'utf8');
    const connection = readFileSync(join(root, 'src/game-connection.ts'), 'utf8');

    expect(observability.correlationParam).toBe('_mcp_correlation_id');
    expect(observability.components).toEqual(['godot-mcp-server', 'godot-mcp-runtime']);
    for (const event of ['request_started', 'request_completed', 'request_failed', 'request_timed_out']) {
      expect(observability.events).toContain(event);
      expect(`${server}\n${connection}`).toMatch(new RegExp(`["']${event}["']`));
    }
    expect(observability.redaction).toMatch(/never logged/i);
    expect(connection).not.toContain('Failed to parse game response: ${line}');
  });

  it('publishes large-project response and retention bounds', () => {
    const schema = JSON.parse(readFileSync(join(root, 'docs/runtime-api.schema.json'), 'utf8'));
    const limits = schema['x-runtime-contract'].limits;
    const subprocess = readFileSync(join(root, 'src/godot-subprocess.ts'), 'utf8');
    const manager = readFileSync(join(root, 'src/godot-process-manager.ts'), 'utf8');
    const core = readFileSync(join(root, 'src/scripts/mcp_runtime/core_domain.gd'), 'utf8');

    expect(limits).toMatchObject({
      responseBytes: 8 * 1024 * 1024,
      screenshotPngBytes: 6 * 1024 * 1024,
      sceneTreeNodesDefault: 1000,
      sceneTreeNodesMaximum: 10000,
      processLogLines: 1000,
      logPageItems: 1000,
      headlessBufferBytes: 16 * 1024 * 1024,
    });
    expect(core).toContain('optional_int("max_nodes", 1000, 1, 10000)');
    expect(subprocess).toContain('GODOT_PROCESS_LOG_LINE_LIMIT = 1_000');
    expect(subprocess).toContain('GODOT_COMMAND_MAX_BUFFER_BYTES = 16 * 1024 * 1024');
    expect(manager).toContain('remaining: this.activeProcess.output.length - end');
  });

  it('publishes deterministic session timing and runtime time-scale control', () => {
    const schema = JSON.parse(readFileSync(join(root, 'docs/runtime-api.schema.json'), 'utf8'));
    const timing = schema['x-runtime-contract'].determinism;
    const systemDomain = readFileSync(join(root, 'src/scripts/mcp_runtime/system_domain.gd'), 'utf8');

    expect(timing).toMatchObject({
      fixedFps: GODOT_SESSION_FIXED_FPS,
      wallClockFpsCap: GODOT_SESSION_FIXED_FPS,
      initialTimeScale: GODOT_SESSION_INITIAL_TIME_SCALE,
      metadataEnvironment: GODOT_SESSION_FIXED_FPS_ENV,
      controlCommand: 'time_scale',
    });
    expect(systemDomain).toContain('Engine.time_scale = time_scale');
    expect(systemDomain).toContain('"fixed_fps": _configured_fixed_fps()');
  });

  it('publishes and checks the headed rendering-context precondition', () => {
    const schema = JSON.parse(readFileSync(join(root, 'docs/runtime-api.schema.json'), 'utf8'));
    const rendering = schema['x-runtime-contract'].renderingContext;
    const server = readFileSync(join(root, 'src/scripts/mcp_interaction_server.gd'), 'utf8');

    expect(rendering.capability).toBe(RENDERING_CONTEXT_CAPABILITY);
    expect(rendering.unavailableReason).toBe('rendering_context_unavailable');
    expect(server).toContain('if not _has_rendering_context():');
    expect(server.indexOf('if not _has_rendering_context():'))
      .toBeLessThan(server.indexOf('await get_tree().process_frame', server.indexOf('func _cmd_screenshot')));
    expect(server).not.toContain('RenderingServer.frame_post_draw');
  });

  it('uses the contract namespace for every runtime command method', () => {
    expect(commandMethod('get_scene_tree')).toBe('godot.runtime.get_scene_tree');
  });

  it('publishes the harness-owned authoring surface without routing it prematurely', () => {
    const schema = JSON.parse(readFileSync(join(root, 'docs/runtime-api.schema.json'), 'utf8'));
    const authoring = schema['x-runtime-contract'].authoring;
    const operations = readFileSync(join(root, 'src/scripts/godot_operations.gd'), 'utf8');

    expect(authoring.capability).toBe(AUTHORING_COMMANDS_CAPABILITY);
    expect(authoring.commands).toEqual([...AUTHORING_COMMANDS]);
    expect(AUTHORING_COMMANDS.every(command => command.startsWith('authoring_'))).toBe(true);
    expect(operations).toContain('const SERVE_ARGUMENT: String = "--serve-authoring"');
    expect(operations).toContain('server.call("register_authoring_dispatcher", execute_operation)');
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
    expect([...SESSION_COMMANDS]).toEqual(schemaCommands());
  });

  it('registers exactly the schema manifest commands in the GDScript server', () => {
    const registered = gdscriptRegisteredCommands();
    expect(new Set(registered).size).toBe(registered.length);
    expect([...registered].sort()).toEqual(schemaCommands());
  });

  it('only sends manifest commands from the TypeScript tool handlers, and exercises all of them', () => {
    const sent = [...new Set(typescriptSentCommands())].sort();
    expect(sent).toEqual([...RUNTIME_COMMANDS]);
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
    expect(gdscript).toContain('const CANCELLABLE_COMMANDS: Array[String] = ["wait", "await_signal", "resource", "http_request"]');
  });

  it('keeps every asynchronous cancellable domain cooperatively cancellable', () => {
    const networking = readFileSync(join(root, 'src/scripts/mcp_runtime/networking_domain.gd'), 'utf8');
    const system = readFileSync(join(root, 'src/scripts/mcp_runtime/system_domain.gd'), 'utf8');

    expect(networking).toContain('if cancellation_requested():');
    expect(networking).toContain('_active_http.cancel_request()');
    expect(system).toContain('if cancellation_requested():');
    expect(system).toContain('Resource preload cancelled');
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

    // Each moved domain owns its commands and any helpers/state that used to
    // sit on the server beside unrelated handlers.
    const domainOwnership: Record<string, { commands: string[]; internals: string[] }> = {
      'input_domain.gd': {
        commands: ['click', 'key_press', 'key_hold', 'key_release', 'scroll', 'mouse_move', 'mouse_drag', 'gamepad', 'touch', 'input_state', 'input_action'],
        internals: ['_held_keys', '_key_map', '_string_to_keycode'],
      },
      'ui_domain.gd': {
        commands: ['ui_theme', 'ui_control', 'ui_text', 'ui_popup', 'ui_tree', 'ui_item_list', 'ui_tabs', 'ui_menu', 'ui_range'],
        internals: ['_resolve_anchor_preset', '_collect_tree_items'],
      },
      'scene_2d_domain.gd': {
        commands: ['tilemap', 'canvas', 'canvas_draw', 'light_2d', 'parallax', 'shape_2d', 'path_2d'],
        internals: ['_canvas_draw_node', '_draw_commands', '_create_draw_script'],
      },
      'physics_domain.gd': {
        commands: ['raycast', 'navigate_path', 'add_collision', 'physics_body', 'create_joint', 'navigation_3d', 'physics_3d', 'physics_2d'],
        internals: ['_shape_3d', '_shape_2d', '_respond_ray_hit'],
      },
      'scene_3d_domain.gd': {
        commands: ['csg', 'multimesh', 'procedural_mesh', 'light_3d', 'mesh_instance', 'gridmap', '3d_effects', 'path_3d', 'terrain'],
        internals: ['_terrain_rebuild'],
      },
      'rendering_domain.gd': {
        commands: ['get_camera', 'set_camera', 'camera_attributes', 'set_shader_param', 'visual_shader', 'environment', 'set_particles', 'viewport', 'debug_draw', 'render_settings', 'sky', 'gi', 'video'],
        internals: ['_visual_shaders', '_debug_draw_node', '_clear_debug_draw', '_get_or_create_environment'],
      },
      'audio_animation_domain.gd': {
        commands: ['get_audio', 'audio_play', 'audio_bus', 'audio_effect', 'audio_bus_layout', 'audio_spatial', 'create_animation', 'animation_tree', 'animation_control', 'skeleton_ik', 'bone_pose'],
        internals: ['_find_audio_players', '_resolve_bone_index'],
      },
      'core_domain.gd': {
        commands: ['get_scene_tree', 'get_property', 'set_property', 'call_method', 'get_node_info', 'instantiate_scene', 'remove_node', 'change_scene', 'connect_signal', 'disconnect_signal', 'emit_signal', 'get_nodes_in_group', 'find_nodes_by_class', 'reparent_node', 'spawn_node', 'manage_group', 'list_signals', 'await_signal'],
        internals: ['_build_tree_node', '_find_by_class_recursive'],
      },
      'networking_domain.gd': {
        commands: ['http_request', 'websocket', 'multiplayer', 'rpc'],
        internals: ['_websocket', '_close_websocket'],
      },
      'system_domain.gd': {
        commands: ['window', 'os_info', 'time_scale', 'process_mode', 'world_settings', 'locale', 'resource'],
        internals: [],
      },
    };
    for (const [file, ownership] of Object.entries(domainOwnership)) {
      const domain = readFileSync(join(root, 'src/scripts/mcp_runtime', file), 'utf8');
      for (const command of ownership.commands) {
        expect(domain).toContain(`register_command("${command}"`);
        expect(server).not.toContain(`_cmd_${command}(`);
      }
      for (const internal of ownership.internals) {
        expect(domain).toContain(internal);
        expect(server).not.toContain(internal);
      }
    }

    // Domains reach the transport only through RuntimeDomain, never through
    // sessions, sockets, or the registry directly.
    const domainFiles = gdscriptSources().filter(path => path.includes('mcp_runtime') && path.endsWith('_domain.gd') && !path.endsWith('runtime_domain.gd'));
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
