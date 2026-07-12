extends Node

# MCP Interaction Server - newline-delimited JSON-RPC 2.0 server for game interaction.
# No class_name to avoid autoload conflict.
#
# This script is the composition root: it owns the socket lifecycle, sessions,
# the request lifecycle, and the command registry. Subsystem handlers live in
# domain scripts under res://mcp_runtime/, which register their own commands and
# reach the transport only through RuntimeDomain. Handlers not yet moved into a
# domain still live below; they migrate one domain at a time.

const CommandParams = preload("res://mcp_runtime/command_params.gd")
const DOMAIN_SCRIPTS: Array[String] = [
	"res://mcp_runtime/input_domain.gd",
	"res://mcp_runtime/ui_domain.gd",
	"res://mcp_runtime/scene_2d_domain.gd",
	"res://mcp_runtime/physics_domain.gd",
	"res://mcp_runtime/scene_3d_domain.gd",
	"res://mcp_runtime/rendering_domain.gd",
	"res://mcp_runtime/audio_animation_domain.gd",
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

	func _init(command_name: String, command_handler: Callable, is_cancellable: bool) -> void:
		command = command_name
		handler = command_handler
		cancellable = is_cancellable


var _server: TCPServer
var _sessions: Dictionary = {}
var _next_session_id: int = 1
# Exactly one runtime command executes at a time. Its session owns the request ID
# and peer until it responds, or disconnects and its eventual response is discarded.
var _active_session: RuntimeSession = null
const PORT: int = 9090
const PROTOCOL_VERSION: String = "1.0"
const CAPABILITIES: Array[String] = ["runtime-commands", "godot-json-values"]
const METHOD_PREFIX: String = "godot.runtime."
const CANCELLABLE_COMMANDS: Array[String] = ["wait", "await_signal"]
const ERROR_LIMIT_EXCEEDED: int = -32006

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

func _ready() -> void:
	# Ensure MCP server keeps processing even when game is paused
	process_mode = Node.PROCESS_MODE_ALWAYS
	_register_domains()
	_register_commands()
	_server = TCPServer.new()
	var err: int = _server.listen(PORT, "127.0.0.1")
	if err != OK:
		push_error("McpInteractionServer: Failed to listen on port %d, error: %d" % [PORT, err])
		return
	print("McpInteractionServer: Listening on 127.0.0.1:%d" % PORT)


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
		var session: RuntimeSession = _sessions.get(session_id) as RuntimeSession
		if session == null:
			continue
		_poll_session(session)
		if not session.connected and session != _active_session:
			_sessions.erase(session.id)


func _poll_session(session: RuntimeSession) -> void:
	if not session.connected or session.peer == null:
		return

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
		session.peer.poll()
		var pending: int = session.peer.get_available_bytes()
		while pending > 0 and drained < max_receive_buffer_bytes:
			var chunk: int = min(pending, max_receive_chunk_bytes)
			session.peer.get_data(chunk)
			drained += chunk
			session.peer.poll()
			pending = session.peer.get_available_bytes()
		session.peer.disconnect_from_host()
	if session != _active_session:
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

	var req_id: Variant = data.get("id", null)
	if data.get("jsonrpc", "") != "2.0" or req_id == null or not data.has("method"):
		_send_error(session, req_id, -32600, "Expected a JSON-RPC 2.0 request with id and method")
		return
	var method: String = str(data.get("method", ""))
	var raw_params: Variant = data.get("params", {})
	if not raw_params is Dictionary:
		_send_error(session, req_id, -32602, "params must be an object")
		return
	var params: Dictionary = raw_params
	if method == "godot.runtime.handshake":
		_handle_handshake(session, req_id, params)
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

	if _active_session != null:
		_send_error(session, req_id, -32001, "Server busy processing another command. Try again.")
		return
	session.request_running = true
	session.request_id = req_id
	session.request_command = command
	session.request_state = "running"
	session.cancellation_requested = false
	_active_session = session

	# Synchronous handlers complete before this await resumes; coroutine
	# handlers suspend here until their own awaits finish.
	await descriptor.handler.call(params)


func _register_command(command: String, handler: Callable) -> void:
	_commands[command] = CommandDescriptor.new(command, handler, CANCELLABLE_COMMANDS.has(command))


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
		domain.setup(self, _register_command)
		domain.register_commands()


func _register_commands() -> void:
	_register_command("screenshot", _cmd_screenshot)
	# Core scene/property/signal
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
	# Camera + rendering + environment
	# Audio + animation
	# Networking + multiplayer
	_register_command("http_request", _cmd_http_request)
	_register_command("websocket", _cmd_websocket)
	_register_command("multiplayer", _cmd_multiplayer)
	_register_command("rpc", _cmd_rpc)
	# System + project state
	_register_command("window", _cmd_window)
	_register_command("os_info", _cmd_os_info)
	_register_command("time_scale", _cmd_time_scale)
	_register_command("process_mode", _cmd_process_mode)
	_register_command("world_settings", _cmd_world_settings)
	_register_command("locale", _cmd_locale)
	_register_command("resource", _cmd_resource)


func _handle_handshake(session: RuntimeSession, req_id: Variant, params: Dictionary) -> void:
	if params.get("protocolVersion", "") != PROTOCOL_VERSION:
		_send_error(session, req_id, -32002, "Unsupported protocol version", {"supported": PROTOCOL_VERSION})
		return
	_send_response_raw(session, {"jsonrpc": "2.0", "id": req_id, "result": {
		"protocolVersion": PROTOCOL_VERSION,
		"capabilities": CAPABILITIES,
	}})


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
	_send_response_raw(session, {"jsonrpc": "2.0", "id": req_id, "result": {"cancelled": true, "request_id": target_id}})


# Send the active request's response only through the session that received it.
# Disconnected sessions retain their request state until this point, then their
# response is intentionally discarded rather than sent to a later connection.
func _send_response(data: Dictionary) -> void:
	var session: RuntimeSession = _active_session
	if session == null or not session.request_running:
		return
	_active_session = null
	session.request_running = false
	var id: Variant = session.request_id
	session.request_id = null
	if session.cancellation_requested:
		session.request_state = "cancelled"
		_send_error(session, id, -32003, "Request cancelled", {"command": session.request_command})
	elif data.has("error"):
		session.request_state = "responded"
		_send_error(session, id, -32000, str(data["error"]), data.get("error_data", null))
	else:
		session.request_state = "responded"
		_send_response_raw(session, {"jsonrpc": "2.0", "id": id, "result": data})
	session.request_command = ""
	session.cancellation_requested = false
	if not session.connected:
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
	session.request_command = ""
	session.cancellation_requested = false
	_send_error(session, id, -32004, message, details)
	if not session.connected:
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
	session.request_command = ""
	session.cancellation_requested = false
	_send_error(session, id, ERROR_LIMIT_EXCEEDED, message, details)
	if not session.connected:
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
		_send_response({"error": reader.error_message, "error_data": reader.error_details})
		return true
	return false


# Resolves a node parameter relative to the tree root. With a default_path the
# parameter is optional; either way a missing node records a structured failure.
func _require_node(reader: CommandParams, name: String = "node_path", default_path: String = "") -> Node:
	var path: String
	if default_path.is_empty():
		path = reader.required_node_path(name)
	else:
		path = reader.optional_string(name, default_path)
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
func _cmd_get_performance(_params: Dictionary) -> void:
	_send_response({
		"success": true,
		"fps": Performance.get_monitor(Performance.TIME_FPS),
		"frame_time": Performance.get_monitor(Performance.TIME_PROCESS),
		"physics_frame_time": Performance.get_monitor(Performance.TIME_PHYSICS_PROCESS),
		"memory_static": Performance.get_monitor(Performance.MEMORY_STATIC),
		"memory_static_max": Performance.get_monitor(Performance.MEMORY_STATIC_MAX),
		"object_count": Performance.get_monitor(Performance.OBJECT_COUNT),
		"object_node_count": Performance.get_monitor(Performance.OBJECT_NODE_COUNT),
		"object_orphan_node_count": Performance.get_monitor(Performance.OBJECT_ORPHAN_NODE_COUNT),
		"render_total_objects": Performance.get_monitor(Performance.RENDER_TOTAL_OBJECTS_IN_FRAME),
		"render_total_draw_calls": Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME)
	})


# --- Wait N Frames ---
func _cmd_wait(params: Dictionary) -> void:
	var frames: int = int(params.get("frames", 1))
	var frame_type: String = str(params.get("frame_type", "render")).to_lower()
	var use_physics: bool = frame_type == "physics" or bool(params.get("physics", false))
	for i in frames:
		if use_physics:
			await get_tree().physics_frame
		else:
			await get_tree().process_frame
		if _active_session != null and _active_session.cancellation_requested:
			_send_response({})
			return
	_send_response({"success": true, "waited_frames": frames, "frame_type": "physics" if use_physics else "render"})


# --- Helper: Convert Godot Variant to JSON-safe value ---
func _variant_to_json(value: Variant) -> Variant:
	if value == null:
		return null
	if value is bool or value is int or value is float or value is String:
		return value
	if value is Vector2:
		return {"x": value.x, "y": value.y}
	if value is Vector3:
		return {"x": value.x, "y": value.y, "z": value.z}
	if value is Vector2i:
		return {"x": value.x, "y": value.y}
	if value is Vector3i:
		return {"x": value.x, "y": value.y, "z": value.z}
	if value is Color:
		return {"r": value.r, "g": value.g, "b": value.b, "a": value.a}
	if value is Quaternion:
		return {"x": value.x, "y": value.y, "z": value.z, "w": value.w}
	if value is Basis:
		return {
			"x": _variant_to_json(value.x),
			"y": _variant_to_json(value.y),
			"z": _variant_to_json(value.z)
		}
	if value is Transform3D:
		return {
			"basis": _variant_to_json(value.basis),
			"origin": _variant_to_json(value.origin)
		}
	if value is Transform2D:
		return {
			"x": _variant_to_json(value.x),
			"y": _variant_to_json(value.y),
			"origin": _variant_to_json(value.origin)
		}
	if value is Rect2:
		return {"position": _variant_to_json(value.position), "size": _variant_to_json(value.size)}
	if value is AABB:
		return {"position": _variant_to_json(value.position), "size": _variant_to_json(value.size)}
	if value is NodePath:
		return str(value)
	if value is StringName:
		return str(value)
	# Packed arrays - serialize as JSON arrays instead of str() fallback
	if value is PackedByteArray:
		var arr: Array = []
		for item in value:
			arr.append(item)
		return arr
	if value is PackedInt32Array or value is PackedInt64Array:
		var arr: Array = []
		for item in value:
			arr.append(item)
		return arr
	if value is PackedFloat32Array or value is PackedFloat64Array:
		var arr: Array = []
		for item in value:
			arr.append(item)
		return arr
	if value is PackedStringArray:
		var arr: Array = []
		for item in value:
			arr.append(item)
		return arr
	if value is PackedVector2Array:
		var arr: Array = []
		for item in value:
			arr.append({"x": item.x, "y": item.y})
		return arr
	if value is PackedVector3Array:
		var arr: Array = []
		for item in value:
			arr.append({"x": item.x, "y": item.y, "z": item.z})
		return arr
	if value is PackedColorArray:
		var arr: Array = []
		for item in value:
			arr.append({"r": item.r, "g": item.g, "b": item.b, "a": item.a})
		return arr
	if value is Array:
		var arr: Array = []
		for item in value:
			arr.append(_variant_to_json(item))
		return arr
	if value is Dictionary:
		var dict: Dictionary = {}
		for key in value:
			dict[str(key)] = _variant_to_json(value[key])
		return dict
	if value is Object:
		if value is Node:
			return {"_type": "Node", "class": value.get_class(), "name": (value as Node).name, "path": str((value as Node).get_path())}
		if value is Resource:
			return {"_type": "Resource", "class": value.get_class(), "path": (value as Resource).resource_path}
		return {"_type": "Object", "class": value.get_class(), "id": value.get_instance_id()}
	# Fallback: convert to string
	return str(value)


# --- Helper: Convert JSON value back to Godot Variant ---
func _json_to_variant(value: Variant, type_hint: String = "") -> Variant:
	if value == null:
		return null
	if value is String and type_hint != "" and type_hint != "String":
		var trimmed: String = (value as String).strip_edges()
		if trimmed.begins_with("{") or trimmed.begins_with("["):
			var parser: JSON = JSON.new()
			if parser.parse(trimmed) == OK:
				value = parser.data
	if value is Dictionary:
		var dict: Dictionary = value
		# Explicit type hints take priority
		match type_hint:
			"Vector2":
				return Vector2(float(dict.get("x", 0)), float(dict.get("y", 0)))
			"Vector2i":
				return Vector2i(int(dict.get("x", 0)), int(dict.get("y", 0)))
			"Vector3":
				return Vector3(float(dict.get("x", 0)), float(dict.get("y", 0)), float(dict.get("z", 0)))
			"Vector3i":
				return Vector3i(int(dict.get("x", 0)), int(dict.get("y", 0)), int(dict.get("z", 0)))
			"Color":
				return Color(float(dict.get("r", 0)), float(dict.get("g", 0)), float(dict.get("b", 0)), float(dict.get("a", 1)))
			"Quaternion":
				return Quaternion(float(dict.get("x", 0)), float(dict.get("y", 0)), float(dict.get("z", 0)), float(dict.get("w", 1)))
			"Rect2":
				var pos: Dictionary = dict.get("position", {"x": 0, "y": 0})
				var sz: Dictionary = dict.get("size", {"x": 0, "y": 0})
				return Rect2(float(pos.get("x", 0)), float(pos.get("y", 0)), float(sz.get("x", 0)), float(sz.get("y", 0)))
			"AABB":
				var aabb_pos: Dictionary = dict.get("position", {"x": 0, "y": 0, "z": 0})
				var aabb_sz: Dictionary = dict.get("size", {"x": 0, "y": 0, "z": 0})
				return AABB(
					Vector3(float(aabb_pos.get("x", 0)), float(aabb_pos.get("y", 0)), float(aabb_pos.get("z", 0))),
					Vector3(float(aabb_sz.get("x", 0)), float(aabb_sz.get("y", 0)), float(aabb_sz.get("z", 0)))
				)
			"Basis":
				var bx: Dictionary = dict.get("x", {"x": 1, "y": 0, "z": 0})
				var by: Dictionary = dict.get("y", {"x": 0, "y": 1, "z": 0})
				var bz: Dictionary = dict.get("z", {"x": 0, "y": 0, "z": 1})
				return Basis(
					Vector3(float(bx.get("x", 0)), float(bx.get("y", 0)), float(bx.get("z", 0))),
					Vector3(float(by.get("x", 0)), float(by.get("y", 0)), float(by.get("z", 0))),
					Vector3(float(bz.get("x", 0)), float(bz.get("y", 0)), float(bz.get("z", 0)))
				)
			"Transform3D":
				var basis_dict: Dictionary = dict.get("basis", {})
				var origin_dict: Dictionary = dict.get("origin", {"x": 0, "y": 0, "z": 0})
				var basis: Basis = _json_to_variant(basis_dict, "Basis") if basis_dict.size() > 0 else Basis.IDENTITY
				var origin: Vector3 = Vector3(float(origin_dict.get("x", 0)), float(origin_dict.get("y", 0)), float(origin_dict.get("z", 0)))
				return Transform3D(basis, origin)
			"Transform2D":
				var tx: Dictionary = dict.get("x", {"x": 1, "y": 0})
				var ty: Dictionary = dict.get("y", {"x": 0, "y": 1})
				var t_origin: Dictionary = dict.get("origin", {"x": 0, "y": 0})
				return Transform2D(
					Vector2(float(tx.get("x", 0)), float(tx.get("y", 0))),
					Vector2(float(ty.get("x", 0)), float(ty.get("y", 0))),
					Vector2(float(t_origin.get("x", 0)), float(t_origin.get("y", 0)))
				)
		# Auto-detect from dict keys
		if dict.has("basis") and dict.has("origin"):
			return _json_to_variant(dict, "Transform3D")
		if dict.has("r") and dict.has("g") and dict.has("b"):
			return Color(float(dict.get("r", 0)), float(dict.get("g", 0)), float(dict.get("b", 0)), float(dict.get("a", 1)))
		if dict.has("x") and dict.has("y") and dict.has("z") and dict.has("w"):
			return Quaternion(float(dict.get("x", 0)), float(dict.get("y", 0)), float(dict.get("z", 0)), float(dict.get("w", 1)))
		if dict.has("position") and dict.has("size"):
			var pos_dict: Dictionary = dict["position"]
			var size_dict: Dictionary = dict["size"]
			if pos_dict.has("z") or size_dict.has("z"):
				return _json_to_variant(dict, "AABB")
			return _json_to_variant(dict, "Rect2")
		if dict.has("x") and dict.has("y") and dict.has("z"):
			return Vector3(float(dict.get("x", 0)), float(dict.get("y", 0)), float(dict.get("z", 0)))
		if dict.has("x") and dict.has("y") and dict.size() == 2:
			return Vector2(float(dict.get("x", 0)), float(dict.get("y", 0)))
		return value
	return value


# --- Helper: Convert JSON value using node's property type info ---
func _json_to_variant_for_property(node: Node, property: String, value: Variant) -> Variant:
	for prop in node.get_property_list():
		if prop["name"] == property:
			var type_id: int = prop.get("type", 0)
			match type_id:
				TYPE_VECTOR2:
					return _json_to_variant(value, "Vector2")
				TYPE_VECTOR2I:
					return _json_to_variant(value, "Vector2i")
				TYPE_VECTOR3:
					return _json_to_variant(value, "Vector3")
				TYPE_VECTOR3I:
					return _json_to_variant(value, "Vector3i")
				TYPE_COLOR:
					return _json_to_variant(value, "Color")
				TYPE_QUATERNION:
					return _json_to_variant(value, "Quaternion")
				TYPE_RECT2:
					return _json_to_variant(value, "Rect2")
				TYPE_AABB:
					return _json_to_variant(value, "AABB")
				TYPE_BASIS:
					return _json_to_variant(value, "Basis")
				TYPE_TRANSFORM3D:
					return _json_to_variant(value, "Transform3D")
				TYPE_TRANSFORM2D:
					return _json_to_variant(value, "Transform2D")
				TYPE_BOOL:
					if value is String:
						return value.to_lower() == "true"
					return bool(value)
				TYPE_INT:
					return int(value)
				TYPE_FLOAT:
					return float(value)
			break
	# No type info found, use raw value or auto-detect
	return _json_to_variant(value)


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
	var duration: float = float(params.get("duration", 1.0))
	var trans_type: int = int(params.get("trans_type", 0))  # Tween.TRANS_LINEAR
	var ease_type: int = int(params.get("ease_type", 2))  # Tween.EASE_IN_OUT

	var tween: Tween = create_tween()
	var tweener: PropertyTweener = tween.tween_property(node, property, final_value, duration)
	if tweener == null:
		tween.kill()
		_send_response({"error": "tween_property failed: value type does not match property '%s' on %s" % [property, node.get_class()]})
		return
	tweener.set_trans(trans_type).set_ease(ease_type)
	_send_response({"success": true, "node": node_path, "property": property, "duration": duration})


# --- Get Nodes In Group ---


func _cmd_create_timer(params: Dictionary) -> void:
	var parent_path: String = params.get("parent_path", "/root")
	var wait_time: float = float(params.get("wait_time", 1.0))
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
	if params.has("name") and params["name"] is String and not (params["name"] as String).is_empty():
		timer.name = params["name"]
	parent.add_child(timer)
	if autostart:
		timer.start()
	_send_response({"success": true, "path": str(timer.get_path()), "name": timer.name, "wait_time": timer.wait_time, "one_shot": timer.one_shot, "autostart": autostart})


# --- Set Particles ---
func _cmd_serialize_state(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "/root")
	var action: String = params.get("action", "save")
	var max_depth: int = int(params.get("max_depth", 5))

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
	var props: Dictionary = data.get("properties", {})
	for prop_name in props:
		var value: Variant = _json_to_variant_for_property(node, prop_name, props[prop_name])
		node.set(prop_name, value)
	count += 1

	# Restore children
	var children_data: Array = data.get("children", [])
	for child_data in children_data:
		var child_name: String = child_data.get("name", "")
		var child: Node = null
		for c in node.get_children():
			if c.name == child_name:
				child = c
				break
		if child != null:
			count += _deserialize_node(child, child_data)
	return count


# --- Bone Pose ---



func _cmd_http_request(params: Dictionary) -> void:
	var url: String = params.get("url", "")
	if url.is_empty():
		_send_response({"error": "url is required"})
		return
	var method_str: String = params.get("method", "GET").to_upper()
	var http: HTTPRequest = HTTPRequest.new()
	http.timeout = float(params.get("timeout", 30))
	add_child(http)
	var headers: PackedStringArray = PackedStringArray()
	if params.has("headers"):
		var h: Dictionary = params["headers"]
		for k in h:
			headers.append("%s: %s" % [k, str(h[k])])
	var method_enum: int = HTTPClient.METHOD_GET
	match method_str:
		"POST": method_enum = HTTPClient.METHOD_POST
		"PUT": method_enum = HTTPClient.METHOD_PUT
		"DELETE": method_enum = HTTPClient.METHOD_DELETE
	var body: String = params.get("body", "")
	var err: int = http.request(url, headers, method_enum, body)
	if err != OK:
		http.queue_free()
		_send_response({"error": "HTTP request failed to start: %d" % err})
		return
	var result: Array = await http.request_completed
	http.queue_free()
	_send_response({"success": true, "status_code": result[1], "body": result[3].get_string_from_utf8()})


var _websocket: WebSocketPeer = null

func _cmd_websocket(params: Dictionary) -> void:
	var action: String = params.get("action", "")
	match action:
		"connect":
			var url: String = params.get("url", "")
			if url.is_empty():
				_send_response({"error": "url is required for connect"})
				return
			_websocket = WebSocketPeer.new()
			var err: int = _websocket.connect_to_url(url)
			if err != OK:
				_send_response({"error": "WebSocket connect failed: %d" % err})
				_websocket = null
				return
			_send_response({"success": true, "action": "connect", "url": url})
		"disconnect":
			if _websocket != null:
				_websocket.close()
				_websocket = null
			_send_response({"success": true, "action": "disconnect"})
		"send":
			if _websocket == null:
				_send_response({"error": "No WebSocket connection"})
				return
			_websocket.poll()
			var msg: String = params.get("message", "")
			_websocket.send_text(msg)
			_send_response({"success": true, "action": "send"})
		"status":
			if _websocket == null:
				_send_response({"success": true, "status": "disconnected"})
				return
			_websocket.poll()
			_send_response({"success": true, "status": _websocket.get_ready_state()})
		_:
			_send_response({"error": "Unknown websocket action: %s" % action})


func _cmd_multiplayer(params: Dictionary) -> void:
	var action: String = params.get("action", "")
	match action:
		"create_server":
			var peer: ENetMultiplayerPeer = ENetMultiplayerPeer.new()
			var port: int = int(params.get("port", 7000))
			var max_cl: int = int(params.get("max_clients", 32))
			var err: int = peer.create_server(port, max_cl)
			if err != OK:
				_send_response({"error": "Failed to create server: %d" % err})
				return
			multiplayer.multiplayer_peer = peer
			_send_response({"success": true, "action": "create_server", "port": port})
		"create_client":
			var peer: ENetMultiplayerPeer = ENetMultiplayerPeer.new()
			var address: String = params.get("address", "127.0.0.1")
			var port: int = int(params.get("port", 7000))
			var err: int = peer.create_client(address, port)
			if err != OK:
				_send_response({"error": "Failed to create client: %d" % err})
				return
			multiplayer.multiplayer_peer = peer
			_send_response({"success": true, "action": "create_client", "address": address, "port": port})
		"disconnect":
			multiplayer.multiplayer_peer = null
			_send_response({"success": true, "action": "disconnect"})
		"status":
			var peer = multiplayer.multiplayer_peer
			if peer == null:
				_send_response({"success": true, "connected": false})
				return
			_send_response({"success": true, "connected": true, "unique_id": multiplayer.get_unique_id(), "is_server": multiplayer.is_server()})
		_:
			_send_response({"error": "Unknown multiplayer action: %s" % action})


func _cmd_rpc(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		_send_response({"error": "Node not found: %s" % node_path})
		return
	var action: String = params.get("action", "call")
	var method: String = params.get("method", "")
	if method.is_empty():
		_send_response({"error": "method is required"})
		return
	if action == "call":
		var args: Array = params.get("args", [])
		node.rpc(method, args)
		_send_response({"success": true, "action": "call", "method": method})
	elif action == "configure":
		var config: Dictionary = {}
		if params.has("mode"):
			var m: Variant = params["mode"]
			if m is String:
				match (m as String).to_lower():
					"any_peer": config["rpc_mode"] = MultiplayerAPI.RPC_MODE_ANY_PEER
					"authority": config["rpc_mode"] = MultiplayerAPI.RPC_MODE_AUTHORITY
			else:
				config["rpc_mode"] = int(m)
		if params.has("sync"):
			var sync_val: Variant = params["sync"]
			if sync_val is String:
				config["call_local"] = (sync_val as String).to_lower() == "call_local"
			else:
				config["call_local"] = bool(sync_val)
		if params.has("channel"):
			config["channel"] = int(params["channel"])
		node.rpc_config(method, config)
		_send_response({"success": true, "action": "configure", "method": method, "config": config})
	else:
		_send_response({"error": "Unknown rpc action: %s" % action})


func _cmd_script(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		_send_response({"error": "Node not found: %s" % node_path})
		return
	var action: String = params.get("action", "get_source")
	match action:
		"get_source":
			var s = node.get_script()
			if s == null:
				_send_response({"success": true, "has_script": false})
				return
			_send_response({"success": true, "has_script": true, "source": s.source_code if s is GDScript else "", "path": s.resource_path})
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


func _cmd_window(params: Dictionary) -> void:
	var action: String = params.get("action", "get")
	var win: Window = get_tree().root
	if action == "get":
		_send_response({"success": true, "size": {"x": win.size.x, "y": win.size.y}, "position": {"x": win.position.x, "y": win.position.y}, "fullscreen": win.mode == Window.MODE_FULLSCREEN, "borderless": win.borderless, "title": win.title})
		return
	if params.has("width") and params.has("height"):
		win.size = Vector2i(int(params["width"]), int(params["height"]))
	if params.has("fullscreen"):
		win.mode = Window.MODE_FULLSCREEN if bool(params["fullscreen"]) else Window.MODE_WINDOWED
	if params.has("borderless"):
		win.borderless = bool(params["borderless"])
	if params.has("title"):
		win.title = str(params["title"])
	if params.has("position"):
		var p: Dictionary = params["position"]
		win.position = Vector2i(int(p.get("x", 0)), int(p.get("y", 0)))
	if params.has("vsync"):
		DisplayServer.window_set_vsync_mode(DisplayServer.VSYNC_ENABLED if bool(params["vsync"]) else DisplayServer.VSYNC_DISABLED)
	_send_response({"success": true, "action": "set", "size": {"x": win.size.x, "y": win.size.y}})


func _cmd_os_info(_params: Dictionary) -> void:
	var screen_size: Vector2i = DisplayServer.screen_get_size()
	_send_response({"success": true, "os_name": OS.get_name(), "locale": OS.get_locale(), "screen_size": {"x": screen_size.x, "y": screen_size.y}, "video_adapter": RenderingServer.get_video_adapter_name(), "processor_count": OS.get_processor_count()})


func _cmd_time_scale(params: Dictionary) -> void:
	var action: String = params.get("action", "get")
	if action == "set":
		Engine.time_scale = float(params.get("time_scale", 1.0))
	_send_response({"success": true, "time_scale": Engine.time_scale, "ticks_msec": Time.get_ticks_msec(), "fps": Engine.get_frames_per_second()})


func _cmd_process_mode(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		_send_response({"error": "Node not found: %s" % node_path})
		return
	var mode_str: String = params.get("mode", "inherit")
	var mode_val: int = Node.PROCESS_MODE_INHERIT
	match mode_str:
		"pausable": mode_val = Node.PROCESS_MODE_PAUSABLE
		"when_paused": mode_val = Node.PROCESS_MODE_WHEN_PAUSED
		"always": mode_val = Node.PROCESS_MODE_ALWAYS
		"disabled": mode_val = Node.PROCESS_MODE_DISABLED
	node.process_mode = mode_val
	_send_response({"success": true, "node_path": node_path, "mode": mode_str})


func _cmd_world_settings(params: Dictionary) -> void:
	var action: String = params.get("action", "get")
	if action == "set":
		if params.has("gravity"):
			ProjectSettings.set_setting("physics/3d/default_gravity", float(params["gravity"]))
		if params.has("physics_fps"):
			Engine.physics_ticks_per_second = int(params["physics_fps"])
	_send_response({"success": true, "gravity": ProjectSettings.get_setting("physics/3d/default_gravity"), "physics_fps": Engine.physics_ticks_per_second})


# ==========================================================================
# Batch 2: 3D Rendering + Lighting + Sky + Physics
# ==========================================================================












func _cmd_locale(params: Dictionary) -> void:
	var action: String = params.get("action", "get")
	match action:
		"get":
			_send_response({"success": true, "locale": TranslationServer.get_locale()})
		"set":
			var locale: String = params.get("locale", "en")
			TranslationServer.set_locale(locale)
			_send_response({"success": true, "action": "set", "locale": locale})
		"translate":
			var key: String = params.get("key", "")
			var translated: String = tr(key)
			_send_response({"success": true, "key": key, "translated": translated})
		_:
			_send_response({"error": "Unknown locale action: %s" % action})


# ==========================================================================
# Batch 5: Rendering + Resource Runtime
# ==========================================================================

func _cmd_resource(params: Dictionary) -> void:
	var action: String = params.get("action", "load")
	var res_path: String = params.get("path", "")
	match action:
		"load":
			if not ResourceLoader.exists(res_path):
				_send_response({"error": "Resource not found: %s" % res_path})
				return
			var res: Resource = ResourceLoader.load(res_path)
			if res == null:
				_send_response({"error": "Failed to load resource: %s" % res_path})
				return
			_send_response({"success": true, "action": "load", "path": res_path, "type": res.get_class()})
		"save":
			var node_path: String = params.get("node_path", "")
			var prop: String = params.get("property", "")
			if node_path.is_empty():
				_send_response({"error": "node_path is required for save"})
				return
			var node: Node = get_tree().root.get_node_or_null(node_path)
			if node == null:
				_send_response({"error": "Node not found: %s" % node_path})
				return
			var res = node.get(prop) if not prop.is_empty() else null
			if res is Resource:
				var err: int = ResourceSaver.save(res, res_path)
				_send_response({"success": err == OK, "action": "save", "path": res_path})
			else:
				_send_response({"error": "Property is not a Resource"})
		"exists":
			_send_response({"success": true, "action": "exists", "path": res_path, "exists": ResourceLoader.exists(res_path)})
		_:
			_send_response({"error": "Unknown resource action: %s" % action})


func _exit_tree() -> void:
	if _websocket != null:
		_websocket.close()
		_websocket = null
	for session: RuntimeSession in _sessions.values():
		if session.peer != null:
			session.peer.disconnect_from_host()
	_sessions.clear()
	_active_session = null
	if _server != null:
		_server.stop()
		_server = null
	print("McpInteractionServer: Stopped")
