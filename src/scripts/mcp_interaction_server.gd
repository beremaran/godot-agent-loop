extends Node

# MCP Interaction Server - newline-delimited JSON-RPC 2.0 server for game interaction.
# No class_name to avoid autoload conflict.
#
# This script is the composition root: it owns the socket lifecycle, sessions,
# the request lifecycle, and the command registry. Subsystem handlers live in
# domain scripts under res://mcp_runtime/, which register their own commands and
# reach the transport only through RuntimeDomain. Handlers that remain below are
# cross-cutting runtime commands owned by this composition root.

const CommandParams = preload("res://mcp_runtime/command_params.gd")
const VariantCodec = preload("res://mcp_runtime/variant_codec.gd")
const PrivilegedCommandPolicy = preload("res://mcp_runtime/privileged_command_policy.gd")
const DOMAIN_SCRIPTS: Array[String] = [
	"res://mcp_runtime/input_domain.gd",
	"res://mcp_runtime/ui_domain.gd",
	"res://mcp_runtime/scene_2d_domain.gd",
	"res://mcp_runtime/physics_domain.gd",
	"res://mcp_runtime/scene_3d_domain.gd",
	"res://mcp_runtime/rendering_domain.gd",
	"res://mcp_runtime/audio_animation_domain.gd",
	"res://mcp_runtime/networking_domain.gd",
	"res://mcp_runtime/system_domain.gd",
	"res://mcp_runtime/core_domain.gd",
]

class RuntimeSession:
	extends RefCounted

	var id: int
	var peer: StreamPeerTCP
	var buffer: PackedByteArray = PackedByteArray()
	var connected: bool = true
	var request_running: bool = false
	var request_id: Variant = null
	var request_command: String = ""
	var request_state: String = "received"
	var cancellation_requested: bool = false
	var authenticated: bool = false
	var request_correlation_id: String = ""
	var request_started_msec: int = 0

	func _init(session_id: int, session_peer: StreamPeerTCP) -> void:
		id = session_id
		peer = session_peer


class CommandDescriptor:
	extends RefCounted

	# Typed dispatch entry for one runtime command. Every handler receives the
	# request params dictionary and is awaited, so synchronous handlers and
	# coroutine handlers share a single execution path in the transport layer.
	var command: String
	var handler: Callable
	var cancellable: bool
	var privileged: bool

	func _init(command_name: String, command_handler: Callable, is_cancellable: bool, is_privileged: bool) -> void:
		command = command_name
		handler = command_handler
		cancellable = is_cancellable
		privileged = is_privileged


var _server: TCPServer
var _sessions: Dictionary = {}
var _next_session_id: int = 1
var _next_correlation_id: int = 1
# Exactly one runtime command executes at a time. Its session owns the request ID
# and peer until it responds, or disconnects and its eventual response is discarded.
var _active_session: RuntimeSession = null
const DEFAULT_PORT: int = 9090
const PORT_ENVIRONMENT_VARIABLE: String = "GODOT_MCP_RUNTIME_PORT"
const SECRET_ENVIRONMENT_VARIABLE: String = "GODOT_MCP_RUNTIME_SECRET"
const DISABLED_ENVIRONMENT_VARIABLE: String = "GODOT_MCP_RUNTIME_DISABLED"
# The listen port. Exported for editor configuration; when the game process is
# started by the MCP server, GODOT_MCP_RUNTIME_PORT overrides it so parallel
# sessions (and the E2E harness) each get an isolated loopback port.
@export var port: int = DEFAULT_PORT
const PROTOCOL_VERSION: String = "1.0"
const CAPABILITIES: Array[String] = ["runtime-commands", "godot-json-values"]
const AUTHORING_COMMANDS_CAPABILITY: String = "authoring-commands"
const RENDERING_CONTEXT_CAPABILITY: String = "rendering-context"
const METHOD_PREFIX: String = "godot.runtime."
const CANCELLABLE_COMMANDS: Array[String] = ["wait", "await_signal", "resource", "http_request"]
const ERROR_LIMIT_EXCEEDED: int = -32006
const ERROR_PRIVILEGED_COMMAND_DISABLED: int = PrivilegedCommandPolicy.ERROR_CODE
const ERROR_AUTHENTICATION_REQUIRED: int = -32008

# The MCP launcher supplies a fresh secret through the child environment. An
# empty value retains compatibility for a user-managed runtime, but every
# MCP-owned launch authenticates before any command is accepted.
@export var runtime_secret: String = ""
@export var allow_privileged_commands: bool = false

# These limits are exports so a project can tune its local developer runtime
# without changing the protocol implementation. Values include JSON framing.
@export var max_request_line_bytes: int = 1 * 1024 * 1024
@export var max_receive_buffer_bytes: int = 2 * 1024 * 1024
@export var max_receive_chunk_bytes: int = 64 * 1024
@export var max_json_nesting_depth: int = 32
@export var max_json_collection_items: int = 1024
@export var max_response_bytes: int = 8 * 1024 * 1024
@export var max_screenshot_pixels: int = 16 * 1024 * 1024
@export var max_screenshot_png_bytes: int = 6 * 1024 * 1024
# Command registry: maps a runtime command name to its CommandDescriptor.
# The transport layer dispatches only through this registry and never names
# individual subsystem commands.
var _commands: Dictionary = {}
# Domain nodes, kept as children so their handlers resolve the scene tree and
# viewport exactly as the server does. Each owns its subsystem's state.
var _domains: Array[Node] = []
var _codec: VariantCodec
var _privileged_policy: PrivilegedCommandPolicy
var _profile_active: bool = false
var _profile_samples: Array[Dictionary] = []
# Set only by godot_operations.gd when it owns the process main loop. Regular
# injected game runs publish the command names but do not advertise or execute
# project-file authoring commands.
var _authoring_dispatcher: Callable = Callable()

func _ready() -> void:
	# Ensure MCP server keeps processing even when game is paused
	process_mode = Node.PROCESS_MODE_ALWAYS
	_codec = VariantCodec.new(max_json_nesting_depth, max_json_collection_items)
	_privileged_policy = PrivilegedCommandPolicy.new()
	runtime_secret = _resolve_runtime_secret()
	_register_domains()
	_register_commands()
	# A one-shot authoring fallback can run while the real game owns this
	# project's runtime port. It still needs the autoloads to parse, but must not
	# start a second transport or emit a misleading bind failure.
	if OS.get_environment(DISABLED_ENVIRONMENT_VARIABLE) == "true":
		return
	_server = TCPServer.new()
	port = _resolve_port()
	var err: int = _server.listen(port, "127.0.0.1")
	if err != OK:
		push_error("McpInteractionServer: Failed to listen on port %d, error: %d" % [port, err])
		return
	print("McpInteractionServer: Listening on 127.0.0.1:%d" % port)


# The environment override wins over the export so the process that launched
# the game controls where it must connect.
func _resolve_port() -> int:
	var configured: String = OS.get_environment(PORT_ENVIRONMENT_VARIABLE)
	if configured.is_valid_int():
		var parsed: int = int(configured)
		if parsed > 0 and parsed < 65536:
			return parsed
		push_warning("McpInteractionServer: Ignoring out-of-range %s=%s" % [PORT_ENVIRONMENT_VARIABLE, configured])
	elif not configured.is_empty():
		push_warning("McpInteractionServer: Ignoring non-numeric %s=%s" % [PORT_ENVIRONMENT_VARIABLE, configured])
	return port


func _resolve_runtime_secret() -> String:
	var configured: String = OS.get_environment(SECRET_ENVIRONMENT_VARIABLE)
	return configured if not configured.is_empty() else runtime_secret


func _process(_delta: float) -> void:
	if _server == null:
		return

	# Accept all pending connections. A newly connected client must never replace a
	# peer retained by an awaited command from an earlier session.
	while _server.is_connection_available():
		var new_client: StreamPeerTCP = _server.take_connection()
		if new_client != null:
			var session: RuntimeSession = RuntimeSession.new(_next_session_id, new_client)
			_sessions[session.id] = session
			_next_session_id += 1
			print("McpInteractionServer: Client connected (session %d)" % session.id)

	for session_id: Variant in _sessions.keys():
		var session_value: Variant = _sessions.get(session_id)
		if not session_value is RuntimeSession:
			continue
		var session: RuntimeSession = session_value
		_poll_session(session)
		if not session.connected and session != _active_session:
			@warning_ignore("return_value_discarded")
			_sessions.erase(session.id)


func _poll_session(session: RuntimeSession) -> void:
	if not session.connected or session.peer == null:
		return

	@warning_ignore("return_value_discarded")
	session.peer.poll()
	var status: int = session.peer.get_status()
	if status == StreamPeerTCP.STATUS_ERROR or status == StreamPeerTCP.STATUS_NONE:
		session.connected = false
		session.buffer = PackedByteArray()
		print("McpInteractionServer: Client disconnected (session %d)" % session.id)
		return

	if status != StreamPeerTCP.STATUS_CONNECTED:
		return

	var available: int = session.peer.get_available_bytes()
	if available > 0:
		var remaining_capacity: int = max_receive_buffer_bytes - session.buffer.size()
		if remaining_capacity <= 0:
			_reject_and_close_session(session, "Receive buffer exceeds the configured limit", {"limit_bytes": max_receive_buffer_bytes})
			return
		var bytes_to_read: int = min(available, min(max_receive_chunk_bytes, remaining_capacity))
		var data: Array = session.peer.get_data(bytes_to_read)
		if data[0] == OK:
			var bytes: PackedByteArray = data[1]
			session.buffer.append_array(bytes)

			# Process complete lines (newline-delimited JSON)
			while true:
				var newline_pos: int = session.buffer.find(10)
				if newline_pos < 0:
					break
				var line_bytes: PackedByteArray = session.buffer.slice(0, newline_pos)
				session.buffer = session.buffer.slice(newline_pos + 1)
				if line_bytes.size() > max_request_line_bytes:
					_reject_and_close_session(session, "Request line exceeds the configured limit", {"limit_bytes": max_request_line_bytes})
					return
				if line_bytes.size() == 0:
					continue
				var line: String = line_bytes.get_string_from_utf8()
				if line.to_utf8_buffer() != line_bytes:
					_reject_and_close_session(session, "Request line is not valid UTF-8")
					return
				line = line.strip_edges()
				if not line.is_empty():
					_handle_command(session, line)
					if not session.connected:
						return

			if session.buffer.size() > max_request_line_bytes:
				_reject_and_close_session(session, "Request line exceeds the configured limit", {"limit_bytes": max_request_line_bytes})


func _reject_and_close_session(session: RuntimeSession, message: String, details: Dictionary = {}) -> void:
	_send_error(session, null, ERROR_LIMIT_EXCEEDED, message, details)
	session.buffer = PackedByteArray()
	session.connected = false
	if session.peer != null:
		# Drain unread input first: closing a socket with pending received data
		# sends a TCP RST, which would discard the queued error response before
		# the client can read it. Drain is bounded so a flooding peer cannot
		# keep this loop alive.
		var drained: int = 0
		@warning_ignore("return_value_discarded")
		session.peer.poll()
		var pending: int = session.peer.get_available_bytes()
		while pending > 0 and drained < max_receive_buffer_bytes:
			var chunk: int = min(pending, max_receive_chunk_bytes)
			@warning_ignore("return_value_discarded")
			session.peer.get_data(chunk)
			drained += chunk
			@warning_ignore("return_value_discarded")
			session.peer.poll()
			pending = session.peer.get_available_bytes()
		session.peer.disconnect_from_host()
	if session != _active_session:
		@warning_ignore("return_value_discarded")
		_sessions.erase(session.id)


func _validate_json_limits(value: Variant, depth: int = 0) -> String:
	if depth > max_json_nesting_depth:
		return "JSON nesting exceeds the configured limit of %d" % max_json_nesting_depth
	if value is Array:
		var array_value: Array = value
		if array_value.size() > max_json_collection_items:
			return "JSON array exceeds the configured limit of %d items" % max_json_collection_items
		for item: Variant in array_value:
			var array_error: String = _validate_json_limits(item, depth + 1)
			if not array_error.is_empty():
				return array_error
	elif value is Dictionary:
		var dictionary_value: Dictionary = value
		if dictionary_value.size() > max_json_collection_items:
			return "JSON object exceeds the configured limit of %d properties" % max_json_collection_items
		for key: Variant in dictionary_value:
			var dictionary_error: String = _validate_json_limits(dictionary_value[key], depth + 1)
			if not dictionary_error.is_empty():
				return dictionary_error
	return ""


func _handle_command(session: RuntimeSession, json_str: String) -> void:
	var json: JSON = JSON.new()
	var parse_err: int = json.parse(json_str)
	if parse_err != OK:
		_send_error(session, null, -32700, "Invalid JSON: %s" % json.get_error_message())
		return

	var data: Variant = json.data
	if not data is Dictionary:
		_send_error(session, null, -32600, "Expected JSON-RPC request object")
		return
	var limits_error: String = _validate_json_limits(data)
	if not limits_error.is_empty():
		_reject_and_close_session(session, limits_error, {"max_depth": max_json_nesting_depth, "max_collection_items": max_json_collection_items})
		return

	var request: Dictionary = data
	var req_id: Variant = request.get("id", null)
	if request.get("jsonrpc", "") != "2.0" or req_id == null or not request.has("method"):
		_send_error(session, req_id, -32600, "Expected a JSON-RPC 2.0 request with id and method")
		return
	var method: String = str(request.get("method", ""))
	var raw_params: Variant = request.get("params", {})
	if not raw_params is Dictionary:
		_send_error(session, req_id, -32602, "params must be an object")
		return
	var params: Dictionary = raw_params
	if method == "godot.runtime.handshake":
		_handle_handshake(session, req_id, params)
		return
	if not session.authenticated:
		# Never echo the provided secret or any later request parameters.
		_send_error(session, req_id, ERROR_AUTHENTICATION_REQUIRED,
			"Runtime session authentication is required", {"reason": "authentication_required"})
		return
	if not method.begins_with(METHOD_PREFIX):
		_send_error(session, req_id, -32601, "Unknown method: %s" % method)
		return
	if method == "%scancel" % METHOD_PREFIX:
		_handle_cancel(session, req_id, params)
		return

	var command: String = method.trim_prefix(METHOD_PREFIX)
	var descriptor: CommandDescriptor = _commands.get(command)
	if descriptor == null:
		_send_error(session, req_id, -32601, "Unknown method: %s" % method)
		return
	if descriptor.privileged and not _privileged_policy.is_enabled(command, allow_privileged_commands):
		# Do not include params, source, property values, URLs, headers, or engine
		# error text in this response. The command name and opt-in mechanism are
		# safe policy metadata; request contents remain private to the caller.
		_audit_event("authorization_denied", session, command)
		_send_error(session, req_id, ERROR_PRIVILEGED_COMMAND_DISABLED,
			"Privileged runtime command is disabled by policy",
			_privileged_policy.denial_details(command))
		return

	if _active_session != null:
		_send_error(session, req_id, -32001, "Server busy processing another command. Try again.")
		return
	session.request_running = true
	session.request_id = req_id
	session.request_command = command
	session.request_state = "running"
	session.cancellation_requested = false
	var supplied_correlation: Variant = params.get("_mcp_correlation_id", "")
	var _correlation_erased: bool = params.erase("_mcp_correlation_id")
	var correlation_string: String = str(supplied_correlation) if supplied_correlation is String else ""
	if correlation_string.length() <= 64 and correlation_string.is_valid_identifier():
		session.request_correlation_id = correlation_string
	else:
		session.request_correlation_id = "runtime_%d_%d" % [session.id, _next_correlation_id]
	_next_correlation_id += 1
	session.request_started_msec = Time.get_ticks_msec()
	_active_session = session
	_audit_request("request_started", session)

	# Synchronous handlers complete before this await resumes; coroutine
	# handlers suspend here until their own awaits finish.
	await descriptor.handler.call(params)


func _register_command(command: String, handler: Callable) -> void:
	_commands[command] = CommandDescriptor.new(
		command,
		handler,
		CANCELLABLE_COMMANDS.has(command),
		_privileged_policy.is_privileged(command),
	)


# Instantiates each domain, attaches it to the tree, and lets it register its
# own commands through _register_command. Domains are the unit of the ongoing
# split; a command belongs either to a domain or to this composition root, and
# the shared registry rejects a duplicate registration either way.
func _register_domains() -> void:
	for script_path: String in DOMAIN_SCRIPTS:
		var domain_script: GDScript = load(script_path)
		var domain: Node = domain_script.new()
		domain.name = script_path.get_file().get_basename()
		_domains.append(domain)
		add_child(domain)
		# Domains are loaded by path rather than preloaded, because RuntimeDomain
		# preloads this script to type its transport helpers. These two calls are
		# the one dynamic seam that direction leaves in the composition root.
		@warning_ignore("unsafe_method_access")
		domain.setup(self, _register_command)
		@warning_ignore("unsafe_method_access")
		domain.register_commands()


func _register_commands() -> void:
	_register_command("authoring_add_node", _cmd_authoring_add_node)
	_register_command("authoring_attach_script", _cmd_authoring_attach_script)
	_register_command("authoring_create_resource", _cmd_authoring_create_resource)
	_register_command("authoring_create_scene", _cmd_authoring_create_scene)
	_register_command("authoring_export_mesh_library", _cmd_authoring_export_mesh_library)
	_register_command("authoring_get_uid", _cmd_authoring_get_uid)
	_register_command("authoring_load_sprite", _cmd_authoring_load_sprite)
	_register_command("authoring_manage_resource", _cmd_authoring_manage_resource)
	_register_command("authoring_manage_scene_signals", _cmd_authoring_manage_scene_signals)
	_register_command("authoring_manage_scene_structure", _cmd_authoring_manage_scene_structure)
	_register_command("authoring_manage_theme_resource", _cmd_authoring_manage_theme_resource)
	_register_command("authoring_modify_node", _cmd_authoring_modify_node)
	_register_command("authoring_read_scene", _cmd_authoring_read_scene)
	_register_command("authoring_remove_node", _cmd_authoring_remove_node)
	_register_command("authoring_resave_resources", _cmd_authoring_resave_resources)
	_register_command("authoring_save_scene", _cmd_authoring_save_scene)
	_register_command("screenshot", _cmd_screenshot)
	_register_command("eval", _cmd_eval)
	_register_command("wait", _cmd_wait)
	_register_command("get_ui_elements", _cmd_get_ui_elements)
	_register_command("pause", _cmd_pause)
	_register_command("get_performance", _cmd_get_performance)
	_register_command("play_animation", _cmd_play_animation)
	_register_command("tween_property", _cmd_tween_property)
	_register_command("create_timer", _cmd_create_timer)
	_register_command("serialize_state", _cmd_serialize_state)
	_register_command("script", _cmd_script)


func register_authoring_dispatcher(dispatcher: Callable) -> void:
	_authoring_dispatcher = dispatcher


func _dispatch_authoring(operation: String, params: Dictionary) -> void:
	if not _authoring_dispatcher.is_valid():
		_send_response({
			"error": "Authoring commands require the harness-owned operations session",
			"error_data": {"reason": "authoring_session_required", "operation": operation},
		})
		return
	var raw_result: Variant = _authoring_dispatcher.call(operation, params)
	if not raw_result is Dictionary:
		_send_response({
			"error": "Authoring dispatcher returned an invalid response",
			"error_data": {"reason": "invalid_authoring_response", "operation": operation},
		})
		return
	var result: Dictionary = raw_result
	_send_response(result)


func _cmd_authoring_add_node(params: Dictionary) -> void:
	_dispatch_authoring("add_node", params)


func _cmd_authoring_attach_script(params: Dictionary) -> void:
	_dispatch_authoring("attach_script", params)


func _cmd_authoring_create_resource(params: Dictionary) -> void:
	_dispatch_authoring("create_resource", params)


func _cmd_authoring_create_scene(params: Dictionary) -> void:
	_dispatch_authoring("create_scene", params)


func _cmd_authoring_export_mesh_library(params: Dictionary) -> void:
	_dispatch_authoring("export_mesh_library", params)


func _cmd_authoring_get_uid(params: Dictionary) -> void:
	_dispatch_authoring("get_uid", params)


func _cmd_authoring_load_sprite(params: Dictionary) -> void:
	_dispatch_authoring("load_sprite", params)


func _cmd_authoring_manage_resource(params: Dictionary) -> void:
	_dispatch_authoring("manage_resource", params)


func _cmd_authoring_manage_scene_signals(params: Dictionary) -> void:
	_dispatch_authoring("manage_scene_signals", params)


func _cmd_authoring_manage_scene_structure(params: Dictionary) -> void:
	_dispatch_authoring("manage_scene_structure", params)


func _cmd_authoring_manage_theme_resource(params: Dictionary) -> void:
	_dispatch_authoring("manage_theme_resource", params)


func _cmd_authoring_modify_node(params: Dictionary) -> void:
	_dispatch_authoring("modify_node", params)


func _cmd_authoring_read_scene(params: Dictionary) -> void:
	_dispatch_authoring("read_scene", params)


func _cmd_authoring_remove_node(params: Dictionary) -> void:
	_dispatch_authoring("remove_node", params)


func _cmd_authoring_resave_resources(params: Dictionary) -> void:
	_dispatch_authoring("resave_resources", params)


func _cmd_authoring_save_scene(params: Dictionary) -> void:
	_dispatch_authoring("save_scene", params)


func _handle_handshake(session: RuntimeSession, req_id: Variant, params: Dictionary) -> void:
	if params.get("protocolVersion", "") != PROTOCOL_VERSION:
		_send_error(session, req_id, -32002, "Unsupported protocol version", {"supported": PROTOCOL_VERSION})
		return
	if not session.authenticated and not runtime_secret.is_empty() and params.get("secret", "") != runtime_secret:
		_audit_event("authentication_failed", session)
		_send_error(session, req_id, ERROR_AUTHENTICATION_REQUIRED,
			"Runtime session authentication failed", {"reason": "authentication_failed"})
		return
	session.authenticated = true
	_audit_event("authentication_succeeded", session)
	var capabilities: Array[String] = _privileged_policy.capabilities(CAPABILITIES, allow_privileged_commands)
	if _has_rendering_context():
		capabilities.append(RENDERING_CONTEXT_CAPABILITY)
	if _authoring_dispatcher.is_valid():
		capabilities.append(AUTHORING_COMMANDS_CAPABILITY)
	if not runtime_secret.is_empty():
		capabilities.append("session-authentication")
	_send_response_raw(session, {"jsonrpc": "2.0", "id": req_id, "result": {
		"protocolVersion": PROTOCOL_VERSION,
		"capabilities": capabilities,
	}})


func _has_rendering_context() -> bool:
	return DisplayServer.get_name() != "headless"


func _audit_event(event: String, session: RuntimeSession, command: String = "", details: Dictionary = {}) -> void:
	var record: Dictionary = {
		"component": "godot-agent-loop-runtime",
		"event": event,
		"session_id": session.id,
		"unix_time": int(Time.get_unix_time_from_system()),
	}
	if not command.is_empty():
		record["command"] = command
	for key: Variant in details:
		record[key] = details[key]
	print(JSON.stringify(record))


func _audit_request(event: String, session: RuntimeSession, error_code: int = 0) -> void:
	var details: Dictionary = {
		"correlation_id": session.request_correlation_id,
		"duration_ms": max(0, Time.get_ticks_msec() - session.request_started_msec),
		"state": session.request_state,
	}
	if error_code != 0:
		details["error_code"] = error_code
	_audit_event(event, session, session.request_command, details)


# Cancellation is cooperative: only commands that regularly yield to the scene
# tree can be cancelled safely. The original request receives -32003 when it
# observes the cancellation; this acknowledgement is for the cancel request.
func _handle_cancel(session: RuntimeSession, req_id: Variant, params: Dictionary) -> void:
	var target_id: Variant = params.get("request_id", null)
	if target_id == null:
		_send_error(session, req_id, -32602, "request_id is required")
		return
	if _active_session == null or _active_session != session or not _active_session.request_running or _active_session.request_id != target_id:
		_send_error(session, req_id, -32004, "Request is not running", {"request_id": target_id})
		return
	var descriptor: CommandDescriptor = _commands.get(_active_session.request_command)
	if descriptor == null or not descriptor.cancellable:
		_send_error(session, req_id, -32005, "Request is not cancellable", {"request_id": target_id, "command": _active_session.request_command})
		return
	_active_session.cancellation_requested = true
	_audit_request("cancellation_requested", _active_session)
	_send_response_raw(session, {"jsonrpc": "2.0", "id": req_id, "result": {"cancelled": true, "request_id": target_id}})


# Send the active request's response only through the session that received it.
# Disconnected sessions retain their request state until this point, then their
# response is intentionally discarded rather than sent to a later connection.
func _send_response(data: Dictionary) -> void:
	var session: RuntimeSession = _active_session
	if session == null or not session.request_running:
		return
	var codec_error: Dictionary = _codec.take_error()
	if not codec_error.is_empty():
		data = {
			"error": codec_error.get("message", "Variant codec failed"),
			"error_data": codec_error,
		}
	_active_session = null
	session.request_running = false
	var id: Variant = session.request_id
	session.request_id = null
	if session.cancellation_requested:
		session.request_state = "cancelled"
		_audit_request("request_cancelled", session, -32003)
		_send_error(session, id, -32003, "Request cancelled", {"command": session.request_command})
	elif data.has("error"):
		session.request_state = "responded"
		_audit_request("request_failed", session, -32000)
		_send_error(session, id, -32000, str(data["error"]), data.get("error_data", null))
	else:
		session.request_state = "responded"
		_audit_request("request_completed", session)
		_send_response_raw(session, {"jsonrpc": "2.0", "id": id, "result": data})
	session.request_command = ""
	session.request_correlation_id = ""
	session.request_started_msec = 0
	session.cancellation_requested = false
	if not session.connected:
		@warning_ignore("return_value_discarded")
		_sessions.erase(session.id)


func _is_active_request_cancelled() -> bool:
	return _active_session != null and _active_session.cancellation_requested


func _send_timeout_response(message: String, details: Dictionary = {}) -> void:
	var session: RuntimeSession = _active_session
	if session == null or not session.request_running:
		return
	_active_session = null
	session.request_running = false
	var id: Variant = session.request_id
	session.request_id = null
	session.request_state = "timed_out"
	_audit_request("request_timed_out", session, -32004)
	session.request_command = ""
	session.request_correlation_id = ""
	session.request_started_msec = 0
	session.cancellation_requested = false
	_send_error(session, id, -32004, message, details)
	if not session.connected:
		@warning_ignore("return_value_discarded")
		_sessions.erase(session.id)


func _send_limit_response(message: String, details: Dictionary = {}) -> void:
	var session: RuntimeSession = _active_session
	if session == null or not session.request_running:
		return
	_active_session = null
	session.request_running = false
	var id: Variant = session.request_id
	session.request_id = null
	session.request_state = "responded"
	_audit_request("request_failed", session, ERROR_LIMIT_EXCEEDED)
	session.request_command = ""
	session.request_correlation_id = ""
	session.request_started_msec = 0
	session.cancellation_requested = false
	_send_error(session, id, ERROR_LIMIT_EXCEEDED, message, details)
	if not session.connected:
		@warning_ignore("return_value_discarded")
		_sessions.erase(session.id)


# Send response without clearing busy flag (used when rejecting during busy state)
func _send_response_raw(session: RuntimeSession, data: Dictionary) -> void:
	if not session.connected or session.peer == null:
		return
	var json_str: String = JSON.stringify(data) + "\n"
	var bytes: PackedByteArray = json_str.to_utf8_buffer()
	if bytes.size() > max_response_bytes:
		var fallback: Dictionary = {
			"jsonrpc": "2.0",
			"id": data.get("id", null),
			"error": {
				"code": ERROR_LIMIT_EXCEEDED,
				"message": "Response exceeds the configured limit",
				"data": {"limit_bytes": max_response_bytes},
			},
		}
		bytes = (JSON.stringify(fallback) + "\n").to_utf8_buffer()
		if bytes.size() > max_response_bytes:
			session.connected = false
			session.peer.disconnect_from_host()
			return
	@warning_ignore("return_value_discarded")
	session.peer.put_data(bytes)


func _send_error(session: RuntimeSession, id: Variant, code: int, message: String, details: Variant = null) -> void:
	var error: Dictionary = {"code": code, "message": message}
	if details != null:
		error["data"] = details
	_send_response_raw(session, {"jsonrpc": "2.0", "id": id, "error": error})


# --- Validated parameter helpers ---
# Handlers build a CommandParams reader, pull typed values, then call
# _params_invalid() once; on failure it sends the standardized -32000 error
# with structured details and the handler returns without doing any work.
func _params_invalid(reader: CommandParams) -> bool:
	if reader.failed():
		_send_params_error(reader)
		return true
	return false


# The same failure without the question: for a handler that failed the reader on
# a rule the accessors cannot express and is about to stop.
func _send_params_error(reader: CommandParams) -> void:
	if not reader.failed():
		return
	_send_response({"error": reader.error_message, "error_data": reader.error_details})


# Resolves a node parameter relative to the tree root. With a default_path the
# parameter is optional; either way a missing node records a structured failure.
func _require_node(reader: CommandParams, param_name: String = "node_path", default_path: String = "") -> Node:
	var path: String
	if default_path.is_empty():
		path = reader.required_node_path(param_name)
	else:
		path = reader.optional_string(param_name, default_path)
	if reader.failed():
		return null
	var node: Node = get_tree().root.get_node_or_null(NodePath(path))
	if node == null:
		reader.fail("Node not found: %s" % path, {"param": name, "reason": "node_not_found", "value": path})
	return node


# Structured details for command failures caused by a Godot Error value.
func _godot_error_data(err: int) -> Dictionary:
	return {"reason": "godot_error", "godot_error": err, "godot_error_string": error_string(err)}


# --- Screenshot ---
func _cmd_screenshot(_params: Dictionary) -> void:
	if not _has_rendering_context():
		_send_response({
			"error": "Screenshot requires a headed Godot session with a reachable rendering context",
			"error_data": {
				"reason": "rendering_context_unavailable",
				"display_driver": DisplayServer.get_name(),
				"remediation": "Run Godot with a desktop display or a virtual display such as Xvfb",
			},
		})
		return
	# Wait one frame so the viewport is fully rendered
	await get_tree().process_frame
	var viewport: Viewport = get_viewport()
	var viewport_size: Vector2i = viewport.get_visible_rect().size
	if viewport_size.x <= 0 or viewport_size.y <= 0 or viewport_size.x * viewport_size.y > max_screenshot_pixels:
		_send_limit_response("Screenshot dimensions exceed the configured limit", {"max_pixels": max_screenshot_pixels})
		return
	var image: Image = viewport.get_texture().get_image()
	if image == null:
		_send_response({"error": "Failed to capture screenshot"})
		return
	var png_buffer: PackedByteArray = image.save_png_to_buffer()
	if png_buffer.size() > max_screenshot_png_bytes:
		_send_limit_response("Screenshot payload exceeds the configured limit", {"limit_bytes": max_screenshot_png_bytes})
		return
	var base64_str: String = Marshalls.raw_to_base64(png_buffer)
	_send_response({
		"success": true,
		"data": base64_str,
		"width": image.get_width(),
		"height": image.get_height()
	})


# --- Get UI Elements ---
func _cmd_get_ui_elements(_params: Dictionary) -> void:
	var elements: Array = []
	_collect_ui_elements(get_tree().root, elements)
	_send_response({"success": true, "elements": elements})


func _collect_ui_elements(node: Node, elements: Array) -> void:
	if node is Control:
		var ctrl: Control = node as Control
		if ctrl.visible and ctrl.get_global_rect().size.x > 0:
			var info: Dictionary = {
				"name": ctrl.name,
				"type": ctrl.get_class(),
				"path": str(ctrl.get_path()),
				"position": {"x": ctrl.global_position.x, "y": ctrl.global_position.y},
				"size": {"width": ctrl.size.x, "height": ctrl.size.y},
			}
			# Get text content for common text-bearing nodes
			if ctrl is Label:
				info["text"] = (ctrl as Label).text
			elif ctrl is Button:
				info["text"] = (ctrl as Button).text
			elif ctrl is LineEdit:
				info["text"] = (ctrl as LineEdit).text
			elif ctrl is RichTextLabel:
				info["text"] = (ctrl as RichTextLabel).get_parsed_text()

			elements.append(info)

	for child in node.get_children():
		_collect_ui_elements(child, elements)


# --- Get Scene Tree ---
func _cmd_eval(params: Dictionary) -> void:
	var code: String = params.get("code", "")
	if code.is_empty():
		_send_response({"error": "No code provided"})
		return

	# Wrap user code in a function so we can capture the return value
	var script_source: String = """extends Node

func execute():
	var __result = null
	__result = await _run()
	return __result

func _run():
%s
""" % [_indent_code(code)]

	var script: GDScript = GDScript.new()
	script.source_code = script_source
	var err: int = script.reload()
	if err != OK:
		_send_response({"error": "Failed to compile GDScript (error %d). Check syntax." % err})
		return

	var temp_node: Node = Node.new()
	temp_node.set_script(script)
	# Allow eval to work even when game is paused
	temp_node.process_mode = Node.PROCESS_MODE_ALWAYS
	add_child(temp_node)

	var result: Variant = null
	if temp_node.has_method("execute"):
		# The eval source is compiled at request time, so this call is dynamic by
		# definition. It is gated by the privileged-command policy.
		@warning_ignore("unsafe_method_access")
		result = await temp_node.execute()

	temp_node.queue_free()
	_send_response({"success": true, "result": _variant_to_json(result)})


func _indent_code(code: String) -> String:
	var lines: PackedStringArray = code.split("\n")
	var indented: String = ""
	for line in lines:
		indented += "\t" + line + "\n"
	return indented


# --- Get Property ---
func _cmd_pause(params: Dictionary) -> void:
	var paused: bool = params.get("paused", true)
	get_tree().paused = paused
	_send_response({"success": true, "paused": paused})


# --- Get Performance ---
func _cmd_get_performance(params: Dictionary) -> void:
	var action: String = str(params.get("action", "sample"))
	if not ["sample", "start", "stop", "report", "stress", "leaks"].has(action):
		_send_response({"error": "action must be sample, start, stop, report, stress, or leaks"})
		return
	if action == "start":
		_profile_active = true
		_profile_samples.clear()
		_send_response({"success": true, "profiling": true, "sample_count": 0})
		return
	if action == "stop":
		_profile_active = false
		var stopped: Dictionary = _profile_report()
		stopped["profiling"] = false
		_send_response(stopped)
		return
	if action == "report":
		var report: Dictionary = _profile_report()
		report["profiling"] = _profile_active
		_send_response(report)
		return
	var sample_count: int = CommandParams.to_int(params.get("sample_count", params.get("sampleCount", 1)), 1)
	if sample_count < 1 or sample_count > 120:
		_send_response({"error": "sample_count must be between 1 and 120", "error_data": {"param": "sample_count", "reason": "out_of_range"}})
		return
	var samples: Array[Dictionary] = []
	for index: int in range(sample_count):
		var current: Dictionary = _performance_snapshot()
		samples.append(current)
		if _profile_active:
			_profile_samples.append(current)
		if index + 1 < sample_count:
			await get_tree().process_frame
	var result: Dictionary = samples[0].duplicate(true)
	result["success"] = true
	result["samples"] = samples
	result["profiling"] = _profile_active
	result["requested_sample_count"] = sample_count
	result["timing_mode"] = OS.get_environment("GODOT_MCP_TIMING_MODE") if not OS.get_environment("GODOT_MCP_TIMING_MODE").is_empty() else "external"
	result["distribution"] = _performance_distribution(samples)
	result["metric_availability"] = {
		"realtime_fps": {"available": true, "metric": "fps"},
		"process_time": {"available": true, "metric": "process_time_ms"},
		"rendering_time": {"available": true, "metric": "render_setup_cpu_ms", "scope": "CPU render setup only"},
		"gpu_time": {"available": false, "reason": "Renderer/platform does not expose a stable GPU frame timer through the Godot 4.4 public runtime API"},
	}
	if action == "stress":
		result["stress_window"] = _stress_comparison(samples)
	if action == "leaks":
		result["leak_diagnostics"] = {
			"object_count": result.get("object_count", 0),
			"object_node_count": result.get("object_node_count", 0),
			"object_orphan_node_count": result.get("object_orphan_node_count", 0),
			"static_memory_bytes": result.get("memory_static", 0),
			"tracked_profile_samples": _profile_samples.size(),
		}
	_send_response(result)


func _performance_snapshot() -> Dictionary:
	return {
		"fps": Performance.get_monitor(Performance.TIME_FPS),
		"frame_time": Performance.get_monitor(Performance.TIME_PROCESS),
		"process_time_ms": Performance.get_monitor(Performance.TIME_PROCESS) * 1000.0,
		"physics_frame_time": Performance.get_monitor(Performance.TIME_PHYSICS_PROCESS),
		"physics_process_time_ms": Performance.get_monitor(Performance.TIME_PHYSICS_PROCESS) * 1000.0,
		"render_setup_cpu_ms": RenderingServer.get_frame_setup_time_cpu() * 1000.0,
		"gpu_time_ms": null,
		"memory_static": Performance.get_monitor(Performance.MEMORY_STATIC),
		"memory_static_max": Performance.get_monitor(Performance.MEMORY_STATIC_MAX),
		"object_count": Performance.get_monitor(Performance.OBJECT_COUNT),
		"object_node_count": Performance.get_monitor(Performance.OBJECT_NODE_COUNT),
		"object_orphan_node_count": Performance.get_monitor(Performance.OBJECT_ORPHAN_NODE_COUNT),
		"render_total_objects": Performance.get_monitor(Performance.RENDER_TOTAL_OBJECTS_IN_FRAME),
		"render_total_draw_calls": Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME),
	}


func _profile_report() -> Dictionary:
	var report: Dictionary = {"success": true, "sample_count": _profile_samples.size(), "samples": _profile_samples.duplicate(true)}
	if _profile_samples.is_empty():
		report["summary"] = {}
		return report
	var latest: Dictionary = _profile_samples[_profile_samples.size() - 1]
	var fps_total: float = 0.0
	var frame_total: float = 0.0
	for sample: Dictionary in _profile_samples:
		fps_total += _metric_float(sample.get("fps", 0.0))
		frame_total += _metric_float(sample.get("frame_time", 0.0))
	report["summary"] = {
		"fps_average": fps_total / _profile_samples.size(),
		"frame_time_average": frame_total / _profile_samples.size(),
		"latest_object_count": latest.get("object_count", 0),
		"latest_orphan_node_count": latest.get("object_orphan_node_count", 0),
	}
	report["distribution"] = _performance_distribution(_profile_samples)
	report["metric_availability"] = {
		"gpu_time": {"available": false, "reason": "Unavailable from the public runtime API on this renderer/platform"},
		"render_setup_cpu": {"available": true},
	}
	return report


func _performance_distribution(samples: Array[Dictionary]) -> Dictionary:
	if samples.is_empty(): return {}
	var fps_values: Array[float] = []
	var frame_values: Array[float] = []
	for sample: Dictionary in samples:
		fps_values.append(_metric_float(sample.get("fps", 0.0)))
		frame_values.append(_metric_float(sample.get("process_time_ms", 0.0)))
	fps_values.sort()
	frame_values.sort()
	var percentile_index: int = mini(frame_values.size() - 1, floori(float(frame_values.size() - 1) * 0.95))
	return {
		"sample_count": samples.size(),
		"fps_min": fps_values[0], "fps_max": fps_values[fps_values.size() - 1],
		"fps_average": _array_average(fps_values),
		"process_time_ms_min": frame_values[0], "process_time_ms_max": frame_values[frame_values.size() - 1],
		"process_time_ms_average": _array_average(frame_values),
		"process_time_ms_p95": frame_values[percentile_index],
	}


func _stress_comparison(samples: Array[Dictionary]) -> Dictionary:
	if samples.size() < 3:
		return {"available": false, "reason": "stress comparison requires at least 3 samples"}
	var baseline: Dictionary = samples[0]
	var recovery: Dictionary = samples[samples.size() - 1]
	var peak_process_ms: float = 0.0
	var peak_objects: int = 0
	for sample: Dictionary in samples:
		peak_process_ms = maxf(peak_process_ms, _metric_float(sample.get("process_time_ms", 0.0)))
		peak_objects = maxi(peak_objects, _metric_int(sample.get("object_count", 0)))
	return {
		"available": true,
		"baseline": baseline,
		"peak": {"process_time_ms": peak_process_ms, "object_count": peak_objects},
		"recovery": recovery,
		"object_count_delta_recovery": _metric_int(recovery.get("object_count", 0)) - _metric_int(baseline.get("object_count", 0)),
		"process_time_ms_delta_recovery": _metric_float(recovery.get("process_time_ms", 0.0)) - _metric_float(baseline.get("process_time_ms", 0.0)),
	}


func _array_average(values: Array[float]) -> float:
	var total: float = 0.0
	for value: float in values: total += value
	return total / values.size()


func _metric_float(value: Variant) -> float:
	if value is int or value is float:
		return value
	return 0.0


func _metric_int(value: Variant) -> int:
	if value is int:
		return value
	if value is float:
		var float_value: float = value
		return roundi(float_value)
	return 0


# --- Wait N Frames ---
func _cmd_wait(params: Dictionary) -> void:
	var reader := CommandParams.new(params)
	var frames: int = reader.optional_int("frames", 1, 1)
	var frame_type: String = reader.optional_enum("frame_type", "render", ["render", "physics"])
	if _params_invalid(reader):
		return
	var use_physics: bool = frame_type == "physics" or CommandParams.to_bool(params.get("physics"), false)
	for i: int in frames:
		if use_physics:
			await get_tree().physics_frame
		else:
			await get_tree().process_frame
		if _active_session != null and _active_session.cancellation_requested:
			_send_response({})
			return
	_send_response({"success": true, "waited_frames": frames, "frame_type": "physics" if use_physics else "render"})


# --- Shared JSON/Variant codec boundary ---
func _variant_to_json(value: Variant) -> Variant:
	_codec.configure(max_json_nesting_depth, max_json_collection_items)
	return _codec.encode(value)


func _json_to_variant(value: Variant, type_hint: String = "") -> Variant:
	_codec.configure(max_json_nesting_depth, max_json_collection_items)
	return _codec.decode(value, type_hint)


func _json_to_variant_for_property(node: Node, property: String, value: Variant) -> Variant:
	_codec.configure(max_json_nesting_depth, max_json_collection_items)
	return _codec.decode_for_property(node, property, value)


# --- Connect Signal ---
func _cmd_play_animation(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	if node_path.is_empty():
		_send_response({"error": "node_path is required"})
		return

	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		_send_response({"error": "Node not found: %s" % node_path})
		return

	if not node is AnimationPlayer:
		_send_response({"error": "Node is not an AnimationPlayer: %s (is %s)" % [node_path, node.get_class()]})
		return

	var anim_player: AnimationPlayer = node as AnimationPlayer
	var action: String = params.get("action", "play")

	match action:
		"play":
			var animation: String = params.get("animation", "")
			if animation.is_empty():
				_send_response({"error": "animation name is required for play action"})
				return
			if not anim_player.has_animation(animation):
				_send_response({"error": "Animation '%s' not found. Available: %s" % [animation, str(anim_player.get_animation_list())]})
				return
			anim_player.play(animation)
			_send_response({"success": true, "action": "play", "animation": animation})
		"stop":
			anim_player.stop()
			_send_response({"success": true, "action": "stop"})
		"pause":
			anim_player.pause()
			_send_response({"success": true, "action": "pause"})
		"get_list":
			var anims: Array = []
			for anim_name in anim_player.get_animation_list():
				anims.append(str(anim_name))
			_send_response({"success": true, "animations": anims, "current": anim_player.current_animation, "playing": anim_player.is_playing()})
		_:
			_send_response({"error": "Unknown animation action: %s. Use play, stop, pause, or get_list" % action})


# --- Tween Property ---
func _cmd_tween_property(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	var property: String = params.get("property", "")
	if node_path.is_empty() or property.is_empty():
		_send_response({"error": "node_path and property are required"})
		return

	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		_send_response({"error": "Node not found: %s" % node_path})
		return

	var final_value: Variant = _json_to_variant_for_property(node, property, params.get("final_value", null))
	var duration: float = CommandParams.to_float(params.get("duration"), 1.0)
	var trans_type: int = CommandParams.to_int(params.get("trans_type"), 0)  # Tween.TRANS_LINEAR
	var ease_type: int = CommandParams.to_int(params.get("ease_type"), 2)  # Tween.EASE_IN_OUT

	var tween: Tween = create_tween()
	var tweener: PropertyTweener = tween.tween_property(node, property, final_value, duration)
	if tweener == null:
		tween.kill()
		_send_response({"error": "tween_property failed: value type does not match property '%s' on %s" % [property, node.get_class()]})
		return
	@warning_ignore("return_value_discarded")
	tweener.set_trans(trans_type).set_ease(ease_type)
	_send_response({"success": true, "node": node_path, "property": property, "duration": duration})


# --- Get Nodes In Group ---


func _cmd_create_timer(params: Dictionary) -> void:
	var parent_path: String = params.get("parent_path", "/root")
	var wait_time: float = CommandParams.to_float(params.get("wait_time"), 1.0)
	var one_shot: bool = params.get("one_shot", false)
	var autostart: bool = params.get("autostart", false)

	var parent: Node = get_tree().root.get_node_or_null(parent_path)
	if parent == null:
		_send_response({"error": "Parent node not found: %s" % parent_path})
		return

	var timer: Timer = Timer.new()
	timer.wait_time = wait_time
	timer.one_shot = one_shot
	timer.autostart = autostart
	var timer_name: String = CommandParams.json_string(params, "name")
	if not timer_name.is_empty():
		timer.name = timer_name
	parent.add_child(timer)
	if autostart:
		timer.start()
	_send_response({"success": true, "path": str(timer.get_path()), "name": timer.name, "wait_time": timer.wait_time, "one_shot": timer.one_shot, "autostart": autostart})


# --- Set Particles ---
func _cmd_serialize_state(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "/root")
	var action: String = params.get("action", "save")
	var max_depth: int = CommandParams.to_int(params.get("max_depth"), 5)

	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		_send_response({"error": "Node not found: %s" % node_path})
		return

	match action:
		"save":
			var state: Dictionary = _serialize_node(node, max_depth, 0)
			_send_response({"success": true, "action": "save", "state": state})
		"load":
			var data: Dictionary = params.get("data", {})
			if data.is_empty():
				_send_response({"error": "data is required for load action"})
				return
			var count: int = _deserialize_node(node, data)
			_send_response({"success": true, "action": "load", "restored_count": count})
		_:
			_send_response({"error": "Unknown serialize action: %s. Use save or load" % action})


func _serialize_node(node: Node, max_depth: int, depth: int) -> Dictionary:
	var result: Dictionary = {
		"class": node.get_class(),
		"name": node.name,
		"path": str(node.get_path()),
	}
	# Capture editor-visible properties
	var props: Dictionary = {}
	for prop in node.get_property_list():
		var prop_dict: Dictionary = prop
		if prop_dict.get("usage", 0) & PROPERTY_USAGE_STORAGE:
			var prop_name: String = prop_dict.get("name", "")
			if prop_name.is_empty() or prop_name.begins_with("_"):
				continue
			props[prop_name] = _variant_to_json(node.get(prop_name))
	result["properties"] = props

	if depth < max_depth:
		var children: Array = []
		for child in node.get_children():
			# Skip the MCP interaction server itself
			if child == self:
				continue
			children.append(_serialize_node(child, max_depth, depth + 1))
		result["children"] = children

	return result


func _deserialize_node(node: Node, data: Dictionary) -> int:
	var count: int = 0
	# Restore properties
	var props: Dictionary = CommandParams.json_dictionary(data, "properties")
	for prop_name: Variant in props:
		var property: String = str(prop_name)
		var value: Variant = _json_to_variant_for_property(node, property, props[prop_name])
		node.set(property, value)
	count += 1

	# Restore children
	var children_data: Array = CommandParams.json_array(data, "children")
	for child_data: Variant in children_data:
		if not child_data is Dictionary:
			continue
		var child_state: Dictionary = child_data
		var child_name: String = CommandParams.json_string(child_state, "name")
		var child: Node = null
		for c: Node in node.get_children():
			if c.name == child_name:
				child = c
				break
		if child != null:
			count += _deserialize_node(child, child_state)
	return count


# --- Bone Pose ---



func _cmd_script(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		_send_response({"error": "Node not found: %s" % node_path})
		return
	var action: String = params.get("action", "get_source")
	match action:
		"get_source":
			var attached: Variant = node.get_script()
			if attached == null:
				_send_response({"success": true, "has_script": false})
				return
			var script_resource: Script = attached
			var source_code: String = ""
			if script_resource is GDScript:
				var gdscript: GDScript = script_resource
				source_code = gdscript.source_code
			_send_response({"success": true, "has_script": true, "source": source_code, "path": script_resource.resource_path})
		"attach":
			var source: String = params.get("source", "")
			if source.is_empty():
				_send_response({"error": "source is required for attach"})
				return
			var s: GDScript = GDScript.new()
			s.source_code = source
			var err: int = s.reload()
			if err != OK:
				_send_response({"error": "Script compile error: %d" % err})
				return
			node.set_script(s)
			_send_response({"success": true, "action": "attach", "node_path": node_path})
		"detach":
			node.set_script(null)
			_send_response({"success": true, "action": "detach", "node_path": node_path})
		_:
			_send_response({"error": "Unknown script action: %s" % action})



# ==========================================================================
# Batch 2: 3D Rendering + Lighting + Sky + Physics
# ==========================================================================












func _exit_tree() -> void:
	if _active_session != null and _active_session.request_running:
		_active_session.request_state = "abandoned"
		_audit_request("request_abandoned", _active_session)
	for session: RuntimeSession in _sessions.values():
		if session.peer != null:
			session.peer.disconnect_from_host()
	_sessions.clear()
	_active_session = null
	if _server != null:
		_server.stop()
		_server = null
	print("McpInteractionServer: Stopped")
