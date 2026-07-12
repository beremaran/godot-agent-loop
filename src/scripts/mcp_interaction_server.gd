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
	_register_command("get_scene_tree", _cmd_get_scene_tree)
	_register_command("get_property", _cmd_get_property)
	_register_command("set_property", _cmd_set_property)
	_register_command("call_method", _cmd_call_method)
	_register_command("get_node_info", _cmd_get_node_info)
	_register_command("instantiate_scene", _cmd_instantiate_scene)
	_register_command("remove_node", _cmd_remove_node)
	_register_command("change_scene", _cmd_change_scene)
	_register_command("pause", _cmd_pause)
	_register_command("get_performance", _cmd_get_performance)
	_register_command("connect_signal", _cmd_connect_signal)
	_register_command("disconnect_signal", _cmd_disconnect_signal)
	_register_command("emit_signal", _cmd_emit_signal)
	_register_command("list_signals", _cmd_list_signals)
	_register_command("await_signal", _cmd_await_signal)
	_register_command("play_animation", _cmd_play_animation)
	_register_command("tween_property", _cmd_tween_property)
	_register_command("get_nodes_in_group", _cmd_get_nodes_in_group)
	_register_command("find_nodes_by_class", _cmd_find_nodes_by_class)
	_register_command("reparent_node", _cmd_reparent_node)
	_register_command("spawn_node", _cmd_spawn_node)
	_register_command("manage_group", _cmd_manage_group)
	_register_command("create_timer", _cmd_create_timer)
	_register_command("serialize_state", _cmd_serialize_state)
	_register_command("script", _cmd_script)
	# Camera + rendering + environment
	_register_command("get_camera", _cmd_get_camera)
	_register_command("set_camera", _cmd_set_camera)
	_register_command("camera_attributes", _cmd_camera_attributes)
	_register_command("set_shader_param", _cmd_set_shader_param)
	_register_command("visual_shader", _cmd_visual_shader)
	_register_command("environment", _cmd_environment)
	_register_command("set_particles", _cmd_set_particles)
	_register_command("viewport", _cmd_viewport)
	_register_command("debug_draw", _cmd_debug_draw)
	_register_command("render_settings", _cmd_render_settings)
	_register_command("sky", _cmd_sky)
	_register_command("gi", _cmd_gi)
	_register_command("video", _cmd_video)
	# Audio + animation
	_register_command("get_audio", _cmd_get_audio)
	_register_command("audio_play", _cmd_audio_play)
	_register_command("audio_bus", _cmd_audio_bus)
	_register_command("audio_effect", _cmd_audio_effect)
	_register_command("audio_bus_layout", _cmd_audio_bus_layout)
	_register_command("audio_spatial", _cmd_audio_spatial)
	_register_command("create_animation", _cmd_create_animation)
	_register_command("animation_tree", _cmd_animation_tree)
	_register_command("animation_control", _cmd_animation_control)
	_register_command("skeleton_ik", _cmd_skeleton_ik)
	_register_command("bone_pose", _cmd_bone_pose)
	# Physics + navigation
	_register_command("raycast", _cmd_raycast)
	_register_command("navigate_path", _cmd_navigate_path)
	_register_command("add_collision", _cmd_add_collision)
	_register_command("physics_body", _cmd_physics_body)
	_register_command("create_joint", _cmd_create_joint)
	_register_command("navigation_3d", _cmd_navigation_3d)
	_register_command("physics_3d", _cmd_physics_3d)
	_register_command("physics_2d", _cmd_physics_2d)
	# 3D rendering
	_register_command("csg", _cmd_csg)
	_register_command("multimesh", _cmd_multimesh)
	_register_command("procedural_mesh", _cmd_procedural_mesh)
	_register_command("light_3d", _cmd_light_3d)
	_register_command("mesh_instance", _cmd_mesh_instance)
	_register_command("gridmap", _cmd_gridmap)
	_register_command("3d_effects", _cmd_3d_effects)
	_register_command("path_3d", _cmd_path_3d)
	_register_command("terrain", _cmd_terrain)
	# 2D systems
	_register_command("tilemap", _cmd_tilemap)
	_register_command("canvas", _cmd_canvas)
	_register_command("canvas_draw", _cmd_canvas_draw)
	_register_command("light_2d", _cmd_light_2d)
	_register_command("parallax", _cmd_parallax)
	_register_command("shape_2d", _cmd_shape_2d)
	_register_command("path_2d", _cmd_path_2d)
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
func _cmd_get_scene_tree(_params: Dictionary) -> void:
	var tree: Dictionary = _build_tree_node(get_tree().root)
	_send_response({"success": true, "tree": tree})


func _build_tree_node(node: Node) -> Dictionary:
	var info: Dictionary = {
		"name": node.name,
		"type": node.get_class(),
	}
	var children_arr: Array = []
	for child in node.get_children():
		children_arr.append(_build_tree_node(child))
	if children_arr.size() > 0:
		info["children"] = children_arr
	return info


# --- Eval: Execute arbitrary GDScript at runtime ---
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
func _cmd_get_property(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var node_path: String = reader.required_node_path()
	var property: String = reader.required_string("property")
	var node: Node = _require_node(reader)
	if _params_invalid(reader):
		return

	var value: Variant = node.get(property)
	_send_response({"success": true, "value": _variant_to_json(value), "property": property, "node_path": node_path})


# --- Set Property ---
func _cmd_set_property(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var node_path: String = reader.required_node_path()
	var property: String = reader.required_string("property")
	var type_hint: String = reader.optional_string("type_hint", "")
	var node: Node = _require_node(reader)
	if _params_invalid(reader):
		return

	var raw_value: Variant = reader.raw("value")
	var value: Variant
	if type_hint.is_empty():
		value = _json_to_variant_for_property(node, property, raw_value)
	else:
		value = _json_to_variant(raw_value, type_hint)
	node.set(property, value)
	_send_response({"success": true, "node_path": node_path, "property": property, "value": _variant_to_json(node.get(property))})


# --- Call Method ---
func _cmd_call_method(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var node_path: String = reader.required_node_path()
	var method_name: String = reader.required_string("method")
	var args: Array = reader.optional_array("args")
	var node: Node = _require_node(reader)
	if not reader.failed() and not node.has_method(method_name):
		reader.fail("Method not found: %s on node %s" % [method_name, node_path], {"param": "method", "reason": "method_not_found", "value": method_name})
	if _params_invalid(reader):
		return

	var result: Variant = node.callv(method_name, args)
	_send_response({"success": true, "result": _variant_to_json(result)})


# --- Get Node Info ---
func _cmd_get_node_info(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	if node_path.is_empty():
		_send_response({"error": "node_path is required"})
		return

	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		_send_response({"error": "Node not found: %s" % node_path})
		return

	var properties: Array = []
	for prop in node.get_property_list():
		var prop_dict: Dictionary = prop
		if prop_dict.get("usage", 0) & PROPERTY_USAGE_EDITOR:
			properties.append({
				"name": prop_dict.get("name", ""),
				"type": prop_dict.get("type", 0),
				"value": _variant_to_json(node.get(prop_dict.get("name", "")))
			})

	var signals: Array = []
	for sig in node.get_signal_list():
		var sig_dict: Dictionary = sig
		signals.append(sig_dict.get("name", ""))

	var methods: Array = []
	for m in node.get_method_list():
		var m_dict: Dictionary = m
		if not str(m_dict.get("name", "")).begins_with("_"):
			methods.append(m_dict.get("name", ""))

	var children: Array = []
	for child in node.get_children():
		children.append({
			"name": child.name,
			"type": child.get_class(),
			"path": str(child.get_path())
		})

	_send_response({
		"success": true,
		"class": node.get_class(),
		"name": node.name,
		"path": str(node.get_path()),
		"properties": properties,
		"signals": signals,
		"methods": methods,
		"children": children
	})


# --- Instantiate Scene ---
func _cmd_instantiate_scene(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var scene_path: String = reader.required_resource_path("scene_path")
	var parent: Node = _require_node(reader, "parent_path", "/root")
	if _params_invalid(reader):
		return

	var packed: PackedScene = load(scene_path) as PackedScene
	if packed == null:
		_send_response({"error": "Failed to load scene: %s" % scene_path, "error_data": {"param": "scene_path", "reason": "resource_not_found", "value": scene_path}})
		return

	var instance: Node = packed.instantiate()
	parent.add_child(instance)
	_send_response({"success": true, "instance_name": instance.name, "instance_path": str(instance.get_path())})


# --- Remove Node ---
func _cmd_remove_node(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	if node_path.is_empty():
		_send_response({"error": "node_path is required"})
		return

	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		_send_response({"error": "Node not found: %s" % node_path})
		return

	var node_name: String = node.name
	node.queue_free()
	_send_response({"success": true, "removed": node_name})


# --- Change Scene ---
func _cmd_change_scene(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var scene_path: String = reader.required_resource_path("scene_path")
	if _params_invalid(reader):
		return

	var err: int = get_tree().change_scene_to_file(scene_path)
	if err != OK:
		_send_response({"error": "Failed to change scene to %s: %s" % [scene_path, error_string(err)], "error_data": _godot_error_data(err)})
		return

	_send_response({"success": true, "scene": scene_path})


# --- Pause ---
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
func _cmd_connect_signal(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	var signal_name: String = params.get("signal_name", "")
	var target_path: String = params.get("target_path", "")
	var method_name: String = params.get("method", "")
	if node_path.is_empty() or signal_name.is_empty() or target_path.is_empty() or method_name.is_empty():
		_send_response({"error": "node_path, signal_name, target_path, and method are required"})
		return

	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		_send_response({"error": "Source node not found: %s" % node_path})
		return

	var target: Node = get_tree().root.get_node_or_null(target_path)
	if target == null:
		_send_response({"error": "Target node not found: %s" % target_path})
		return

	if not node.has_signal(signal_name):
		_send_response({"error": "Signal '%s' not found on node %s" % [signal_name, node_path]})
		return

	if not target.has_method(method_name):
		_send_response({"error": "Method '%s' not found on target %s" % [method_name, target_path]})
		return

	if node.is_connected(signal_name, Callable(target, method_name)):
		_send_response({"error": "Signal already connected"})
		return

	node.connect(signal_name, Callable(target, method_name))
	_send_response({"success": true, "signal": signal_name, "from": node_path, "to": target_path, "method": method_name})


# --- Disconnect Signal ---
func _cmd_disconnect_signal(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	var signal_name: String = params.get("signal_name", "")
	var target_path: String = params.get("target_path", "")
	var method_name: String = params.get("method", "")
	if node_path.is_empty() or signal_name.is_empty() or target_path.is_empty() or method_name.is_empty():
		_send_response({"error": "node_path, signal_name, target_path, and method are required"})
		return

	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		_send_response({"error": "Source node not found: %s" % node_path})
		return

	var target: Node = get_tree().root.get_node_or_null(target_path)
	if target == null:
		_send_response({"error": "Target node not found: %s" % target_path})
		return

	var callable: Callable = Callable(target, method_name)
	if not node.is_connected(signal_name, callable):
		_send_response({"error": "Signal is not connected"})
		return

	node.disconnect(signal_name, callable)
	_send_response({"success": true, "disconnected": signal_name, "from": node_path, "to": target_path, "method": method_name})


# --- Emit Signal ---
func _cmd_emit_signal(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	var signal_name: String = params.get("signal_name", "")
	if node_path.is_empty() or signal_name.is_empty():
		_send_response({"error": "node_path and signal_name are required"})
		return

	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		_send_response({"error": "Node not found: %s" % node_path})
		return

	if not node.has_signal(signal_name):
		_send_response({"error": "Signal '%s' not found on node %s" % [signal_name, node_path]})
		return

	var args: Array = params.get("args", [])
	var call_args: Array = [signal_name]
	call_args.append_array(args)
	node.callv("emit_signal", call_args)
	_send_response({"success": true, "emitted": signal_name, "node": node_path, "arg_count": args.size()})


# --- Play Animation ---
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
func _cmd_get_nodes_in_group(params: Dictionary) -> void:
	var group_name: String = params.get("group", "")
	if group_name.is_empty():
		_send_response({"error": "group is required"})
		return

	var nodes: Array = get_tree().get_nodes_in_group(group_name)
	var result: Array = []
	for node in nodes:
		result.append({
			"name": node.name,
			"type": node.get_class(),
			"path": str(node.get_path())
		})
	_send_response({"success": true, "group": group_name, "count": result.size(), "nodes": result})


# --- Find Nodes By Class ---
func _cmd_find_nodes_by_class(params: Dictionary) -> void:
	var class_filter: String = params.get("class_name", "")
	if class_filter.is_empty():
		_send_response({"error": "class_name is required"})
		return

	var root_path: String = params.get("root_path", "/root")
	var root_node: Node = get_tree().root.get_node_or_null(root_path)
	if root_node == null:
		_send_response({"error": "Root node not found: %s" % root_path})
		return

	var found: Array = []
	_find_by_class_recursive(root_node, class_filter, found)
	_send_response({"success": true, "class_name": class_filter, "count": found.size(), "nodes": found})


func _find_by_class_recursive(node: Node, class_filter: String, results: Array) -> void:
	if node.get_class() == class_filter or node.is_class(class_filter):
		results.append({
			"name": node.name,
			"type": node.get_class(),
			"path": str(node.get_path())
		})
	for child in node.get_children():
		_find_by_class_recursive(child, class_filter, results)


# --- Reparent Node ---
func _cmd_reparent_node(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	var new_parent_path: String = params.get("new_parent_path", "")
	if node_path.is_empty() or new_parent_path.is_empty():
		_send_response({"error": "node_path and new_parent_path are required"})
		return

	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		_send_response({"error": "Node not found: %s" % node_path})
		return

	var new_parent: Node = get_tree().root.get_node_or_null(new_parent_path)
	if new_parent == null:
		_send_response({"error": "New parent not found: %s" % new_parent_path})
		return

	var keep_global: bool = params.get("keep_global_transform", true)
	node.reparent(new_parent, keep_global)
	_send_response({"success": true, "node": node.name, "new_parent": new_parent_path, "new_path": str(node.get_path())})


# --- Get Camera ---
func _cmd_get_camera(_params: Dictionary) -> void:
	var result: Dictionary = {"success": true}

	var cam2d: Camera2D = get_viewport().get_camera_2d()
	if cam2d != null:
		result["camera_2d"] = {
			"position": {"x": cam2d.global_position.x, "y": cam2d.global_position.y},
			"rotation": cam2d.global_rotation,
			"zoom": {"x": cam2d.zoom.x, "y": cam2d.zoom.y},
			"path": str(cam2d.get_path())
		}

	var cam3d: Camera3D = get_viewport().get_camera_3d()
	if cam3d != null:
		result["camera_3d"] = {
			"position": {"x": cam3d.global_position.x, "y": cam3d.global_position.y, "z": cam3d.global_position.z},
			"rotation": {"x": rad_to_deg(cam3d.global_rotation.x), "y": rad_to_deg(cam3d.global_rotation.y), "z": rad_to_deg(cam3d.global_rotation.z)},
			"fov": cam3d.fov,
			"path": str(cam3d.get_path())
		}

	if cam2d == null and cam3d == null:
		result["error"] = "No active camera found"
		result["success"] = false

	_send_response(result)


# --- Set Camera ---
func _cmd_set_camera(params: Dictionary) -> void:
	var cam2d: Camera2D = get_viewport().get_camera_2d()
	var cam3d: Camera3D = get_viewport().get_camera_3d()

	if cam2d == null and cam3d == null:
		_send_response({"error": "No active camera found"})
		return

	if cam2d != null:
		if params.has("position"):
			var pos: Dictionary = params["position"]
			cam2d.global_position = Vector2(float(pos.get("x", cam2d.global_position.x)), float(pos.get("y", cam2d.global_position.y)))
		if params.has("rotation"):
			var rot: Dictionary = params["rotation"]
			cam2d.global_rotation = deg_to_rad(float(rot.get("z", rad_to_deg(cam2d.global_rotation))))
		if params.has("zoom"):
			var z: Dictionary = params["zoom"]
			cam2d.zoom = Vector2(float(z.get("x", cam2d.zoom.x)), float(z.get("y", cam2d.zoom.y)))
		_send_response({"success": true, "camera": "2d", "position": _variant_to_json(cam2d.global_position), "zoom": _variant_to_json(cam2d.zoom)})
		return

	if cam3d != null:
		if params.has("position"):
			var pos: Dictionary = params["position"]
			cam3d.global_position = Vector3(float(pos.get("x", cam3d.global_position.x)), float(pos.get("y", cam3d.global_position.y)), float(pos.get("z", cam3d.global_position.z)))
		if params.has("rotation"):
			var rot: Dictionary = params["rotation"]
			cam3d.global_rotation = Vector3(deg_to_rad(float(rot.get("x", rad_to_deg(cam3d.global_rotation.x)))), deg_to_rad(float(rot.get("y", rad_to_deg(cam3d.global_rotation.y)))), deg_to_rad(float(rot.get("z", rad_to_deg(cam3d.global_rotation.z)))))
		if params.has("fov"):
			cam3d.fov = float(params["fov"])
		_send_response({"success": true, "camera": "3d", "position": _variant_to_json(cam3d.global_position), "rotation": _variant_to_json(cam3d.global_rotation)})
		return


# --- Raycast ---
func _cmd_raycast(params: Dictionary) -> void:
	var from_dict: Dictionary = params.get("from", {})
	var to_dict: Dictionary = params.get("to", {})
	var collision_mask: int = int(params.get("collision_mask", 0xFFFFFFFF))

	# Determine 2D vs 3D based on whether z is present
	var is_3d: bool = from_dict.has("z") or to_dict.has("z")

	if is_3d:
		var from_pos: Vector3 = Vector3(float(from_dict.get("x", 0)), float(from_dict.get("y", 0)), float(from_dict.get("z", 0)))
		var to_pos: Vector3 = Vector3(float(to_dict.get("x", 0)), float(to_dict.get("y", 0)), float(to_dict.get("z", 0)))

		# Wait a frame to ensure physics state is available
		await get_tree().process_frame

		var space_state: PhysicsDirectSpaceState3D = get_viewport().world_3d.direct_space_state
		var query: PhysicsRayQueryParameters3D = PhysicsRayQueryParameters3D.create(from_pos, to_pos, collision_mask)
		var result: Dictionary = space_state.intersect_ray(query)

		if result.is_empty():
			_send_response({"success": true, "hit": false, "mode": "3d"})
		else:
			_send_response({
				"success": true, "hit": true, "mode": "3d",
				"position": _variant_to_json(result["position"]),
				"normal": _variant_to_json(result["normal"]),
				"collider_path": str(result["collider"].get_path()) if result.has("collider") and result["collider"] is Node else "",
				"collider_class": result["collider"].get_class() if result.has("collider") else "",
			})
	else:
		var from_pos: Vector2 = Vector2(float(from_dict.get("x", 0)), float(from_dict.get("y", 0)))
		var to_pos: Vector2 = Vector2(float(to_dict.get("x", 0)), float(to_dict.get("y", 0)))

		await get_tree().process_frame

		var space_state: PhysicsDirectSpaceState2D = get_viewport().world_2d.direct_space_state
		var query: PhysicsRayQueryParameters2D = PhysicsRayQueryParameters2D.create(from_pos, to_pos, collision_mask)
		var result: Dictionary = space_state.intersect_ray(query)

		if result.is_empty():
			_send_response({"success": true, "hit": false, "mode": "2d"})
		else:
			_send_response({
				"success": true, "hit": true, "mode": "2d",
				"position": _variant_to_json(result["position"]),
				"normal": _variant_to_json(result["normal"]),
				"collider_path": str(result["collider"].get_path()) if result.has("collider") and result["collider"] is Node else "",
				"collider_class": result["collider"].get_class() if result.has("collider") else "",
			})


# --- Get Audio ---
func _cmd_get_audio(_params: Dictionary) -> void:
	var buses: Array = []
	for i in AudioServer.bus_count:
		buses.append({
			"name": AudioServer.get_bus_name(i),
			"volume_db": AudioServer.get_bus_volume_db(i),
			"mute": AudioServer.is_bus_mute(i),
			"solo": AudioServer.is_bus_solo(i),
		})

	var players: Array = []
	_find_audio_players(get_tree().root, players)

	_send_response({"success": true, "buses": buses, "players": players})


func _find_audio_players(node: Node, results: Array) -> void:
	if node is AudioStreamPlayer:
		var p: AudioStreamPlayer = node as AudioStreamPlayer
		results.append({"path": str(p.get_path()), "type": "AudioStreamPlayer", "playing": p.playing, "bus": p.bus})
	elif node is AudioStreamPlayer2D:
		var p: AudioStreamPlayer2D = node as AudioStreamPlayer2D
		results.append({"path": str(p.get_path()), "type": "AudioStreamPlayer2D", "playing": p.playing, "bus": p.bus})
	elif node is AudioStreamPlayer3D:
		var p: AudioStreamPlayer3D = node as AudioStreamPlayer3D
		results.append({"path": str(p.get_path()), "type": "AudioStreamPlayer3D", "playing": p.playing, "bus": p.bus})
	for child in node.get_children():
		_find_audio_players(child, results)


# --- Spawn Node ---
func _cmd_spawn_node(params: Dictionary) -> void:
	var type_name: String = params.get("type", "")
	var node_name: String = params.get("name", "")
	var parent_path: String = params.get("parent_path", "/root")

	if type_name.is_empty():
		_send_response({"error": "type is required"})
		return

	if not ClassDB.class_exists(type_name):
		_send_response({"error": "Unknown class: %s" % type_name})
		return

	if not ClassDB.is_parent_class(type_name, "Node") and type_name != "Node":
		_send_response({"error": "Class '%s' is not a Node type" % type_name})
		return

	var parent: Node = get_tree().root.get_node_or_null(parent_path)
	if parent == null:
		_send_response({"error": "Parent node not found: %s" % parent_path})
		return

	var instance: Node = ClassDB.instantiate(type_name) as Node
	if instance == null:
		_send_response({"error": "Failed to instantiate: %s" % type_name})
		return

	if node_name.length() > 0:
		instance.name = node_name

	# Apply properties if provided
	var properties: Dictionary = params.get("properties", {})
	for prop_name in properties:
		var raw_value: Variant = properties[prop_name]
		var value: Variant = _json_to_variant_for_property(instance, prop_name, raw_value)
		instance.set(prop_name, value)

	parent.add_child(instance)
	_send_response({"success": true, "name": instance.name, "type": type_name, "path": str(instance.get_path())})


# --- Set Shader Parameter ---
func _cmd_set_shader_param(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	var param_name: String = params.get("param_name", "")
	if node_path.is_empty() or param_name.is_empty():
		_send_response({"error": "node_path and param_name are required"})
		return

	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		_send_response({"error": "Node not found: %s" % node_path})
		return

	var material: Material = null
	# Try material_override first (MeshInstance3D/2D)
	if node.get("material_override") != null:
		material = node.get("material_override")
	# Try surface override material (MeshInstance3D)
	elif node.has_method("get_surface_override_material"):
		material = node.get_surface_override_material(0)
	# Try material property (CanvasItem, e.g. Sprite2D)
	elif node.get("material") != null:
		material = node.get("material")

	if material == null or not material is ShaderMaterial:
		_send_response({"error": "No ShaderMaterial found on node: %s" % node_path})
		return

	var shader_mat: ShaderMaterial = material as ShaderMaterial
	var raw_value: Variant = params.get("value", null)
	var type_hint: String = params.get("type_hint", "")
	var value: Variant = _json_to_variant(raw_value, type_hint)
	shader_mat.set_shader_parameter(param_name, value)
	_send_response({"success": true, "node_path": node_path, "param_name": param_name, "value": _variant_to_json(shader_mat.get_shader_parameter(param_name))})


# --- Visual Shader ---
# Shaders built through the visual_shader command live here until applied to a
# node; ids let a client build several graphs. Edits target the fragment
# function, which is where the tool's node/connection workflow operates.
var _visual_shaders: Dictionary = {}
var _next_visual_shader_id: int = 1

const VISUAL_SHADER_MODES: Dictionary = {
	"spatial": Shader.MODE_SPATIAL,
	"canvas_item": Shader.MODE_CANVAS_ITEM,
	"particles": Shader.MODE_PARTICLES,
	"sky": Shader.MODE_SKY,
	"fog": Shader.MODE_FOG,
}

func _cmd_visual_shader(params: Dictionary) -> void:
	var action: String = params.get("action", "")
	if action.is_empty():
		_send_response({"error": "action is required"})
		return

	if action == "create":
		var shader_type: String = params.get("shader_type", "spatial")
		if not VISUAL_SHADER_MODES.has(shader_type):
			_send_response({"error": "Unknown shader_type: %s" % shader_type})
			return
		var shader: VisualShader = VisualShader.new()
		shader.set_mode(VISUAL_SHADER_MODES[shader_type])
		var shader_id: int = _next_visual_shader_id
		_next_visual_shader_id += 1
		_visual_shaders[shader_id] = shader
		_send_response({"success": true, "shader_id": shader_id, "shader_type": shader_type})
		return

	# Every other action edits an existing graph: the one named by shader_id,
	# or the most recently created one.
	var target_id: int = int(params.get("shader_id", _next_visual_shader_id - 1))
	var shader: VisualShader = _visual_shaders.get(target_id)
	if shader == null:
		_send_response({"error": "No visual shader with id %s; use action create first" % target_id})
		return

	match action:
		"add_node":
			var node_class: String = params.get("node_class", "")
			if node_class.is_empty():
				_send_response({"error": "node_class is required for add_node"})
				return
			if not ClassDB.class_exists(node_class) or not ClassDB.is_parent_class(node_class, "VisualShaderNode"):
				_send_response({"error": "Class '%s' is not a VisualShaderNode type" % node_class})
				return
			var graph_node: VisualShaderNode = ClassDB.instantiate(node_class) as VisualShaderNode
			if graph_node == null:
				_send_response({"error": "Failed to instantiate: %s" % node_class})
				return
			var position: Dictionary = params.get("position", {})
			var node_id: int = shader.get_valid_node_id(VisualShader.TYPE_FRAGMENT)
			shader.add_node(VisualShader.TYPE_FRAGMENT, graph_node, Vector2(position.get("x", 0.0), position.get("y", 0.0)), node_id)
			_send_response({"success": true, "shader_id": target_id, "node_id": node_id, "node_class": node_class})
		"connect":
			var err: int = shader.connect_nodes(VisualShader.TYPE_FRAGMENT, int(params.get("from_node", -1)), int(params.get("from_port", 0)), int(params.get("to_node", -1)), int(params.get("to_port", 0)))
			if err != OK:
				_send_response({"error": "Failed to connect nodes (error %d)" % err})
				return
			_send_response({"success": true, "shader_id": target_id})
		"disconnect":
			shader.disconnect_nodes(VisualShader.TYPE_FRAGMENT, int(params.get("from_node", -1)), int(params.get("from_port", 0)), int(params.get("to_node", -1)), int(params.get("to_port", 0)))
			_send_response({"success": true, "shader_id": target_id})
		"get_nodes":
			var nodes: Array = []
			for node_id in shader.get_node_list(VisualShader.TYPE_FRAGMENT):
				var graph_node: VisualShaderNode = shader.get_node(VisualShader.TYPE_FRAGMENT, node_id)
				var node_position: Vector2 = shader.get_node_position(VisualShader.TYPE_FRAGMENT, node_id)
				nodes.append({"id": node_id, "class": graph_node.get_class(), "position": {"x": node_position.x, "y": node_position.y}})
			_send_response({"success": true, "shader_id": target_id, "nodes": nodes})
		"apply":
			var node_path: String = params.get("node_path", "")
			if node_path.is_empty():
				_send_response({"error": "node_path is required for apply"})
				return
			var node: Node = get_tree().root.get_node_or_null(node_path)
			if node == null:
				_send_response({"error": "Node not found: %s" % node_path})
				return
			var material: ShaderMaterial = ShaderMaterial.new()
			material.shader = shader
			if "material_override" in node:
				node.set("material_override", material)
			elif "material" in node:
				node.set("material", material)
			else:
				_send_response({"error": "Node has no material property: %s" % node_path})
				return
			_send_response({"success": true, "shader_id": target_id, "node_path": node_path})
		_:
			_send_response({"error": "Unknown action: %s" % action})


# --- Audio Play ---
func _cmd_audio_play(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	var action: String = params.get("action", "play")
	if node_path.is_empty():
		_send_response({"error": "node_path is required"})
		return

	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		_send_response({"error": "Node not found: %s" % node_path})
		return

	if not (node is AudioStreamPlayer or node is AudioStreamPlayer2D or node is AudioStreamPlayer3D):
		_send_response({"error": "Node is not an AudioStreamPlayer: %s (is %s)" % [node_path, node.get_class()]})
		return

	# Optionally load a new stream
	if params.has("stream"):
		var stream_path: String = params["stream"]
		var stream: AudioStream = load(stream_path) as AudioStream
		if stream == null:
			_send_response({"error": "Failed to load audio stream: %s" % stream_path})
			return
		node.set("stream", stream)

	# Set optional properties
	if params.has("volume"):
		var linear_vol: float = float(params["volume"])
		node.set("volume_db", linear_to_db(clampf(linear_vol, 0.0, 1.0)))
	if params.has("pitch"):
		node.set("pitch_scale", float(params["pitch"]))
	if params.has("bus"):
		node.set("bus", params["bus"])

	match action:
		"play":
			var from_pos: float = float(params.get("from_position", 0.0))
			node.call("play", from_pos)
			_send_response({"success": true, "action": "play", "node_path": node_path})
		"stop":
			node.call("stop")
			_send_response({"success": true, "action": "stop", "node_path": node_path})
		"pause":
			node.set("stream_paused", true)
			_send_response({"success": true, "action": "pause", "node_path": node_path})
		"resume":
			node.set("stream_paused", false)
			_send_response({"success": true, "action": "resume", "node_path": node_path})
		_:
			_send_response({"error": "Unknown audio action: %s. Use play, stop, pause, or resume" % action})


# --- Audio Bus ---
func _cmd_audio_bus(params: Dictionary) -> void:
	var bus_name: String = params.get("bus_name", "Master")
	var bus_idx: int = AudioServer.get_bus_index(bus_name)
	if bus_idx == -1:
		_send_response({"error": "Audio bus not found: %s" % bus_name})
		return

	if params.has("volume"):
		var linear_vol: float = float(params["volume"])
		AudioServer.set_bus_volume_db(bus_idx, linear_to_db(clampf(linear_vol, 0.0, 1.0)))
	if params.has("mute"):
		AudioServer.set_bus_mute(bus_idx, bool(params["mute"]))
	if params.has("solo"):
		AudioServer.set_bus_solo(bus_idx, bool(params["solo"]))

	_send_response({
		"success": true,
		"bus_name": bus_name,
		"volume_db": AudioServer.get_bus_volume_db(bus_idx),
		"mute": AudioServer.is_bus_mute(bus_idx),
		"solo": AudioServer.is_bus_solo(bus_idx)
	})


# --- Navigate Path ---
func _cmd_navigate_path(params: Dictionary) -> void:
	var start_dict: Dictionary = params.get("start", {})
	var end_dict: Dictionary = params.get("end", {})
	var optimize: bool = params.get("optimize", true)

	if start_dict.is_empty() or end_dict.is_empty():
		_send_response({"error": "start and end are required"})
		return

	# Wait a frame to ensure navigation map is ready
	await get_tree().process_frame

	var is_3d: bool = start_dict.has("z") or end_dict.has("z")

	if is_3d:
		var start_pos: Vector3 = Vector3(float(start_dict.get("x", 0)), float(start_dict.get("y", 0)), float(start_dict.get("z", 0)))
		var end_pos: Vector3 = Vector3(float(end_dict.get("x", 0)), float(end_dict.get("y", 0)), float(end_dict.get("z", 0)))
		var map_rid: RID = get_tree().root.get_world_3d().get_navigation_map()
		var path: PackedVector3Array = NavigationServer3D.map_get_path(map_rid, start_pos, end_pos, optimize)
		var total_length: float = 0.0
		for i in range(1, path.size()):
			total_length += path[i - 1].distance_to(path[i])
		_send_response({"success": true, "mode": "3d", "path": _variant_to_json(path), "point_count": path.size(), "total_length": total_length})
	else:
		var start_pos: Vector2 = Vector2(float(start_dict.get("x", 0)), float(start_dict.get("y", 0)))
		var end_pos: Vector2 = Vector2(float(end_dict.get("x", 0)), float(end_dict.get("y", 0)))
		var map_rid: RID = get_tree().root.get_world_2d().get_navigation_map()
		var path: PackedVector2Array = NavigationServer2D.map_get_path(map_rid, start_pos, end_pos, optimize)
		var total_length: float = 0.0
		for i in range(1, path.size()):
			total_length += path[i - 1].distance_to(path[i])
		_send_response({"success": true, "mode": "2d", "path": _variant_to_json(path), "point_count": path.size(), "total_length": total_length})


# --- TileMap ---
func _cmd_tilemap(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	var action: String = params.get("action", "get_cell")
	if node_path.is_empty():
		_send_response({"error": "node_path is required"})
		return

	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		_send_response({"error": "Node not found: %s" % node_path})
		return

	if not node is TileMapLayer:
		_send_response({"error": "Node is not a TileMapLayer: %s (is %s)" % [node_path, node.get_class()]})
		return

	var tilemap: TileMapLayer = node as TileMapLayer

	match action:
		"set_cells":
			var cells: Array = params.get("cells", [])
			var count: int = 0
			for cell in cells:
				var pos: Vector2i = Vector2i(int(cell.get("x", 0)), int(cell.get("y", 0)))
				var source_id: int = int(cell.get("source_id", 0))
				var atlas_coords: Vector2i = Vector2i(int(cell.get("atlas_x", 0)), int(cell.get("atlas_y", 0)))
				var alt_tile: int = int(cell.get("alt_tile", 0))
				tilemap.set_cell(pos, source_id, atlas_coords, alt_tile)
				count += 1
			_send_response({"success": true, "action": "set_cells", "count": count})
		"get_cell":
			var x: int = int(params.get("x", 0))
			var y: int = int(params.get("y", 0))
			var pos: Vector2i = Vector2i(x, y)
			_send_response({
				"success": true, "action": "get_cell",
				"x": x, "y": y,
				"source_id": tilemap.get_cell_source_id(pos),
				"atlas_coords": _variant_to_json(tilemap.get_cell_atlas_coords(pos)),
				"alt_tile": tilemap.get_cell_alternative_tile(pos)
			})
		"erase_cells":
			var cells: Array = params.get("cells", [])
			var count: int = 0
			for cell in cells:
				tilemap.erase_cell(Vector2i(int(cell.get("x", 0)), int(cell.get("y", 0))))
				count += 1
			_send_response({"success": true, "action": "erase_cells", "count": count})
		"get_used_cells":
			var source_filter: int = int(params.get("source_id", -1))
			var used: Array
			if source_filter >= 0:
				used = tilemap.get_used_cells_by_id(source_filter)
			else:
				used = tilemap.get_used_cells()
			_send_response({"success": true, "action": "get_used_cells", "cells": _variant_to_json(used), "count": used.size()})
		_:
			_send_response({"error": "Unknown tilemap action: %s. Use set_cells, get_cell, erase_cells, or get_used_cells" % action})


# --- Add Collision Shape ---
func _cmd_add_collision(params: Dictionary) -> void:
	var parent_path: String = params.get("parent_path", "")
	var shape_type: String = params.get("shape_type", "")
	if parent_path.is_empty() or shape_type.is_empty():
		_send_response({"error": "parent_path and shape_type are required"})
		return

	var parent: Node = get_tree().root.get_node_or_null(parent_path)
	if parent == null:
		_send_response({"error": "Parent node not found: %s" % parent_path})
		return

	var is_3d: bool = parent.get_class().ends_with("3D") or parent is PhysicsBody3D or parent is Area3D
	var shape_params: Dictionary = params.get("shape_params", {})
	var shape: Resource = null

	if is_3d:
		match shape_type:
			"box":
				var s: BoxShape3D = BoxShape3D.new()
				s.size = Vector3(float(shape_params.get("size_x", 1)), float(shape_params.get("size_y", 1)), float(shape_params.get("size_z", 1)))
				shape = s
			"sphere":
				var s: SphereShape3D = SphereShape3D.new()
				s.radius = float(shape_params.get("radius", 0.5))
				shape = s
			"capsule":
				var s: CapsuleShape3D = CapsuleShape3D.new()
				s.radius = float(shape_params.get("radius", 0.5))
				s.height = float(shape_params.get("height", 2.0))
				shape = s
			"cylinder":
				var s: CylinderShape3D = CylinderShape3D.new()
				s.radius = float(shape_params.get("radius", 0.5))
				s.height = float(shape_params.get("height", 2.0))
				shape = s
			"ray":
				var s: SeparationRayShape3D = SeparationRayShape3D.new()
				s.length = float(shape_params.get("length", 1.0))
				shape = s
			_:
				_send_response({"error": "Unknown 3D shape type: %s. Use box, sphere, capsule, cylinder, or ray" % shape_type})
				return
		var col_shape: CollisionShape3D = CollisionShape3D.new()
		col_shape.shape = shape as Shape3D
		if params.has("disabled"):
			col_shape.disabled = bool(params["disabled"])
		parent.add_child(col_shape)
		col_shape.owner = get_tree().edited_scene_root if get_tree().edited_scene_root else get_tree().root
		if params.has("collision_layer"):
			parent.set("collision_layer", int(params["collision_layer"]))
		if params.has("collision_mask"):
			parent.set("collision_mask", int(params["collision_mask"]))
		_send_response({"success": true, "name": col_shape.name, "path": str(col_shape.get_path()), "shape_type": shape_type, "mode": "3d"})
	else:
		match shape_type:
			"box":
				var s: RectangleShape2D = RectangleShape2D.new()
				s.size = Vector2(float(shape_params.get("size_x", 1)), float(shape_params.get("size_y", 1)))
				shape = s
			"circle":
				var s: CircleShape2D = CircleShape2D.new()
				s.radius = float(shape_params.get("radius", 0.5))
				shape = s
			"capsule":
				var s: CapsuleShape2D = CapsuleShape2D.new()
				s.radius = float(shape_params.get("radius", 0.5))
				s.height = float(shape_params.get("height", 2.0))
				shape = s
			"segment":
				var s: SegmentShape2D = SegmentShape2D.new()
				s.a = Vector2(float(shape_params.get("a_x", 0)), float(shape_params.get("a_y", 0)))
				s.b = Vector2(float(shape_params.get("b_x", 1)), float(shape_params.get("b_y", 0)))
				shape = s
			_:
				_send_response({"error": "Unknown 2D shape type: %s. Use box, circle, capsule, or segment" % shape_type})
				return
		var col_shape: CollisionShape2D = CollisionShape2D.new()
		col_shape.shape = shape as Shape2D
		if params.has("disabled"):
			col_shape.disabled = bool(params["disabled"])
		parent.add_child(col_shape)
		col_shape.owner = get_tree().edited_scene_root if get_tree().edited_scene_root else get_tree().root
		if params.has("collision_layer"):
			parent.set("collision_layer", int(params["collision_layer"]))
		if params.has("collision_mask"):
			parent.set("collision_mask", int(params["collision_mask"]))
		_send_response({"success": true, "name": col_shape.name, "path": str(col_shape.get_path()), "shape_type": shape_type, "mode": "2d"})


# --- Environment / Post-Processing ---
func _cmd_environment(params: Dictionary) -> void:
	var action: String = params.get("action", "set")

	# Find existing WorldEnvironment or Camera3D environment
	var env: Environment = null
	var world_env: Node = null

	# Search for WorldEnvironment node
	var found: Array = []
	_find_by_class_recursive(get_tree().root, "WorldEnvironment", found)
	if found.size() > 0:
		world_env = get_tree().root.get_node_or_null(found[0]["path"])
		if world_env != null:
			env = world_env.get("environment") as Environment

	# Fallback: check Camera3D
	if env == null:
		var cam3d: Camera3D = get_viewport().get_camera_3d()
		if cam3d != null and cam3d.get("environment") != null:
			env = cam3d.get("environment") as Environment

	if action == "get":
		if env == null:
			_send_response({"error": "No Environment resource found"})
			return
		_send_response(_get_environment_state(env))
		return

	# action == "set": create if needed
	if env == null:
		env = Environment.new()
		var we: WorldEnvironment = WorldEnvironment.new()
		we.environment = env
		get_tree().root.add_child(we)
		world_env = we

	# Apply settings
	if params.has("background_mode"):
		env.background_mode = int(params["background_mode"]) as Environment.BGMode
	if params.has("background_color"):
		var c: Dictionary = params["background_color"]
		env.background_color = Color(float(c.get("r", 0)), float(c.get("g", 0)), float(c.get("b", 0)), float(c.get("a", 1)))
	if params.has("ambient_light_color"):
		var c: Dictionary = params["ambient_light_color"]
		env.ambient_light_color = Color(float(c.get("r", 0)), float(c.get("g", 0)), float(c.get("b", 0)), float(c.get("a", 1)))
	if params.has("ambient_light_energy"):
		env.ambient_light_energy = float(params["ambient_light_energy"])
	if params.has("fog_enabled"):
		env.fog_enabled = bool(params["fog_enabled"])
	if params.has("fog_density"):
		env.fog_density = float(params["fog_density"])
	if params.has("fog_light_color"):
		var c: Dictionary = params["fog_light_color"]
		env.fog_light_color = Color(float(c.get("r", 0)), float(c.get("g", 0)), float(c.get("b", 0)), float(c.get("a", 1)))
	if params.has("glow_enabled"):
		env.glow_enabled = bool(params["glow_enabled"])
	if params.has("glow_intensity"):
		env.glow_intensity = float(params["glow_intensity"])
	if params.has("glow_bloom"):
		env.glow_bloom = float(params["glow_bloom"])
	if params.has("tonemap_mode"):
		env.tonemap_mode = int(params["tonemap_mode"]) as Environment.ToneMapper
	if params.has("ssao_enabled"):
		env.ssao_enabled = bool(params["ssao_enabled"])
	if params.has("ssao_radius"):
		env.ssao_radius = float(params["ssao_radius"])
	if params.has("ssao_intensity"):
		env.ssao_intensity = float(params["ssao_intensity"])
	if params.has("ssr_enabled"):
		env.ssr_enabled = bool(params["ssr_enabled"])
	if params.has("brightness"):
		env.adjustment_enabled = true
		env.adjustment_brightness = float(params["brightness"])
	if params.has("contrast"):
		env.adjustment_enabled = true
		env.adjustment_contrast = float(params["contrast"])
	if params.has("saturation"):
		env.adjustment_enabled = true
		env.adjustment_saturation = float(params["saturation"])

	_send_response(_get_environment_state(env))


func _get_environment_state(env: Environment) -> Dictionary:
	return {
		"success": true,
		"background_mode": env.background_mode,
		"background_color": _variant_to_json(env.background_color),
		"ambient_light_color": _variant_to_json(env.ambient_light_color),
		"ambient_light_energy": env.ambient_light_energy,
		"fog_enabled": env.fog_enabled,
		"fog_density": env.fog_density,
		"fog_light_color": _variant_to_json(env.fog_light_color),
		"glow_enabled": env.glow_enabled,
		"glow_intensity": env.glow_intensity,
		"glow_bloom": env.glow_bloom,
		"tonemap_mode": env.tonemap_mode,
		"ssao_enabled": env.ssao_enabled,
		"ssao_radius": env.ssao_radius,
		"ssao_intensity": env.ssao_intensity,
		"ssr_enabled": env.ssr_enabled,
		"brightness": env.adjustment_brightness,
		"contrast": env.adjustment_contrast,
		"saturation": env.adjustment_saturation
	}


# --- Manage Group ---
func _cmd_manage_group(params: Dictionary) -> void:
	var action: String = params.get("action", "")
	var group_name: String = params.get("group", "")

	if action == "clear_group":
		if group_name.is_empty():
			_send_response({"error": "group is required for clear_group"})
			return
		var nodes: Array = get_tree().get_nodes_in_group(group_name)
		for node in nodes:
			node.remove_from_group(group_name)
		_send_response({"success": true, "action": "clear_group", "group": group_name, "removed_count": nodes.size()})
		return

	var node_path: String = params.get("node_path", "")
	if node_path.is_empty():
		_send_response({"error": "node_path is required"})
		return

	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		_send_response({"error": "Node not found: %s" % node_path})
		return

	match action:
		"add":
			if group_name.is_empty():
				_send_response({"error": "group is required for add"})
				return
			node.add_to_group(group_name)
			_send_response({"success": true, "action": "add", "node_path": node_path, "group": group_name})
		"remove":
			if group_name.is_empty():
				_send_response({"error": "group is required for remove"})
				return
			node.remove_from_group(group_name)
			_send_response({"success": true, "action": "remove", "node_path": node_path, "group": group_name})
		"get_groups":
			var groups: Array = []
			for g in node.get_groups():
				groups.append(str(g))
			_send_response({"success": true, "action": "get_groups", "node_path": node_path, "groups": groups})
		_:
			_send_response({"error": "Unknown group action: %s. Use add, remove, get_groups, or clear_group" % action})


# --- Create Timer ---
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
func _cmd_set_particles(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	if node_path.is_empty():
		_send_response({"error": "node_path is required"})
		return

	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		_send_response({"error": "Node not found: %s" % node_path})
		return

	if not (node is GPUParticles2D or node is GPUParticles3D):
		_send_response({"error": "Node is not a GPUParticles node: %s (is %s)" % [node_path, node.get_class()]})
		return

	# Set direct particle properties
	if params.has("emitting"):
		node.set("emitting", bool(params["emitting"]))
	if params.has("amount"):
		node.set("amount", int(params["amount"]))
	if params.has("lifetime"):
		node.set("lifetime", float(params["lifetime"]))
	if params.has("one_shot"):
		node.set("one_shot", bool(params["one_shot"]))
	if params.has("speed_scale"):
		node.set("speed_scale", float(params["speed_scale"]))
	if params.has("explosiveness"):
		node.set("explosiveness", float(params["explosiveness"]))
	if params.has("randomness"):
		node.set("randomness", float(params["randomness"]))

	# Configure process material
	if params.has("process_material"):
		var mat_params: Dictionary = params["process_material"]
		var mat: ParticleProcessMaterial = node.get("process_material") as ParticleProcessMaterial
		if mat == null:
			mat = ParticleProcessMaterial.new()
			node.set("process_material", mat)
		if mat_params.has("direction"):
			var d: Dictionary = mat_params["direction"]
			mat.direction = Vector3(float(d.get("x", 0)), float(d.get("y", -1)), float(d.get("z", 0)))
		if mat_params.has("spread"):
			mat.spread = float(mat_params["spread"])
		if mat_params.has("gravity"):
			var g: Dictionary = mat_params["gravity"]
			mat.gravity = Vector3(float(g.get("x", 0)), float(g.get("y", -9.8)), float(g.get("z", 0)))
		if mat_params.has("initial_velocity_min"):
			mat.initial_velocity_min = float(mat_params["initial_velocity_min"])
		if mat_params.has("initial_velocity_max"):
			mat.initial_velocity_max = float(mat_params["initial_velocity_max"])
		if mat_params.has("color"):
			var c: Dictionary = mat_params["color"]
			mat.color = Color(float(c.get("r", 1)), float(c.get("g", 1)), float(c.get("b", 1)), float(c.get("a", 1)))
		if mat_params.has("scale_min"):
			mat.scale_min = float(mat_params["scale_min"])
		if mat_params.has("scale_max"):
			mat.scale_max = float(mat_params["scale_max"])

	_send_response({
		"success": true, "node_path": node_path,
		"emitting": node.get("emitting"), "amount": node.get("amount"),
		"lifetime": node.get("lifetime"), "one_shot": node.get("one_shot"),
		"speed_scale": node.get("speed_scale")
	})


# --- Create Animation ---
func _cmd_create_animation(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	var anim_name: String = params.get("animation_name", "")
	if node_path.is_empty() or anim_name.is_empty():
		_send_response({"error": "node_path and animation_name are required"})
		return

	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		_send_response({"error": "Node not found: %s" % node_path})
		return

	if not node is AnimationPlayer:
		_send_response({"error": "Node is not an AnimationPlayer: %s (is %s)" % [node_path, node.get_class()]})
		return

	var anim_player: AnimationPlayer = node as AnimationPlayer
	var anim: Animation = Animation.new()
	anim.length = float(params.get("length", 1.0))
	var loop_mode: int = int(params.get("loop_mode", 0))
	anim.loop_mode = loop_mode as Animation.LoopMode

	var tracks: Array = params.get("tracks", [])
	var track_count: int = 0
	for track_data in tracks:
		var track_type_str: String = track_data.get("type", "value")
		var track_path: String = track_data.get("path", "")
		if track_path.is_empty():
			continue

		var track_type: int = Animation.TYPE_VALUE
		match track_type_str:
			"value":
				track_type = Animation.TYPE_VALUE
			"method":
				track_type = Animation.TYPE_METHOD
			"bezier":
				track_type = Animation.TYPE_BEZIER
			"audio":
				track_type = Animation.TYPE_AUDIO

		var idx: int = anim.add_track(track_type)
		anim.track_set_path(idx, NodePath(track_path))

		var keys: Array = track_data.get("keys", [])
		for key_data in keys:
			var time: float = float(key_data.get("time", 0.0))
			match track_type:
				Animation.TYPE_VALUE:
					var value: Variant = _json_to_variant(key_data.get("value", null), key_data.get("type_hint", ""))
					anim.track_insert_key(idx, time, value)
					if key_data.has("transition"):
						var key_idx: int = anim.track_find_key(idx, time, Animation.FIND_MODE_APPROX)
						if key_idx >= 0:
							anim.track_set_key_transition(idx, key_idx, float(key_data["transition"]))
				Animation.TYPE_METHOD:
					var method_name: String = key_data.get("method", "")
					var args: Array = key_data.get("args", [])
					anim.track_insert_key(idx, time, {"method": method_name, "args": args})
				Animation.TYPE_BEZIER:
					var value: float = float(key_data.get("value", 0.0))
					anim.bezier_track_insert_key(idx, time, value)
				Animation.TYPE_AUDIO:
					var stream_path: String = key_data.get("stream", "")
					if not stream_path.is_empty():
						var stream: AudioStream = load(stream_path) as AudioStream
						if stream != null:
							anim.audio_track_insert_key(idx, time, stream)
		track_count += 1

	# Add to library (use default "" library if it exists, otherwise create it)
	var lib_name: String = params.get("library", "")
	var lib: AnimationLibrary = null
	if anim_player.has_animation_library(lib_name):
		lib = anim_player.get_animation_library(lib_name)
	else:
		lib = AnimationLibrary.new()
		anim_player.add_animation_library(lib_name, lib)
	lib.add_animation(anim_name, anim)

	_send_response({"success": true, "animation_name": anim_name, "length": anim.length, "loop_mode": loop_mode, "track_count": track_count})


# --- Serialize State ---
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


# --- Physics Body ---
func _cmd_physics_body(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	if node_path.is_empty():
		_send_response({"error": "node_path is required"})
		return

	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		_send_response({"error": "Node not found: %s" % node_path})
		return

	if not (node is PhysicsBody2D or node is PhysicsBody3D):
		_send_response({"error": "Node is not a PhysicsBody: %s (is %s)" % [node_path, node.get_class()]})
		return

	# Set common physics properties
	if params.has("gravity_scale") and node.get("gravity_scale") != null:
		node.set("gravity_scale", float(params["gravity_scale"]))
	if params.has("mass") and node.get("mass") != null:
		node.set("mass", float(params["mass"]))
	if params.has("freeze") and node.get("freeze") != null:
		node.set("freeze", bool(params["freeze"]))
	if params.has("sleeping") and node.get("sleeping") != null:
		node.set("sleeping", bool(params["sleeping"]))
	if params.has("linear_damp") and node.get("linear_damp") != null:
		node.set("linear_damp", float(params["linear_damp"]))
	if params.has("angular_damp") and node.get("angular_damp") != null:
		node.set("angular_damp", float(params["angular_damp"]))

	# Velocity (2D vs 3D)
	if params.has("linear_velocity"):
		var lv: Dictionary = params["linear_velocity"]
		if node is PhysicsBody3D:
			node.set("linear_velocity", Vector3(float(lv.get("x", 0)), float(lv.get("y", 0)), float(lv.get("z", 0))))
		else:
			node.set("linear_velocity", Vector2(float(lv.get("x", 0)), float(lv.get("y", 0))))
	if params.has("angular_velocity"):
		var av: Variant = params["angular_velocity"]
		if node is PhysicsBody3D and av is Dictionary:
			node.set("angular_velocity", Vector3(float(av.get("x", 0)), float(av.get("y", 0)), float(av.get("z", 0))))
		else:
			node.set("angular_velocity", float(av))

	# Physics material (friction, bounce)
	if params.has("friction") or params.has("bounce"):
		var phys_mat: PhysicsMaterial = node.get("physics_material_override") as PhysicsMaterial
		if phys_mat == null:
			phys_mat = PhysicsMaterial.new()
			node.set("physics_material_override", phys_mat)
		if params.has("friction"):
			phys_mat.friction = float(params["friction"])
		if params.has("bounce"):
			phys_mat.bounce = float(params["bounce"])

	# Build response
	var result: Dictionary = {"success": true, "node_path": node_path, "class": node.get_class()}
	if node.get("mass") != null:
		result["mass"] = node.get("mass")
	if node.get("gravity_scale") != null:
		result["gravity_scale"] = node.get("gravity_scale")
	if node.get("linear_velocity") != null:
		result["linear_velocity"] = _variant_to_json(node.get("linear_velocity"))
	if node.get("angular_velocity") != null:
		result["angular_velocity"] = _variant_to_json(node.get("angular_velocity"))
	_send_response(result)


# --- Create Joint ---
func _cmd_create_joint(params: Dictionary) -> void:
	var parent_path: String = params.get("parent_path", "")
	var joint_type: String = params.get("joint_type", "")
	if parent_path.is_empty() or joint_type.is_empty():
		_send_response({"error": "parent_path and joint_type are required"})
		return

	var parent: Node = get_tree().root.get_node_or_null(parent_path)
	if parent == null:
		_send_response({"error": "Parent node not found: %s" % parent_path})
		return

	var node_a: String = params.get("node_a_path", "")
	var node_b: String = params.get("node_b_path", "")
	var joint: Node = null

	match joint_type:
		"pin_2d":
			var j: PinJoint2D = PinJoint2D.new()
			if not node_a.is_empty():
				j.node_a = NodePath(node_a)
			if not node_b.is_empty():
				j.node_b = NodePath(node_b)
			if params.has("softness"):
				j.softness = float(params["softness"])
			joint = j
		"spring_2d":
			var j: DampedSpringJoint2D = DampedSpringJoint2D.new()
			if not node_a.is_empty():
				j.node_a = NodePath(node_a)
			if not node_b.is_empty():
				j.node_b = NodePath(node_b)
			if params.has("length"):
				j.length = float(params["length"])
			if params.has("rest_length"):
				j.rest_length = float(params["rest_length"])
			if params.has("stiffness"):
				j.stiffness = float(params["stiffness"])
			if params.has("damping"):
				j.damping = float(params["damping"])
			joint = j
		"groove_2d":
			var j: GrooveJoint2D = GrooveJoint2D.new()
			if not node_a.is_empty():
				j.node_a = NodePath(node_a)
			if not node_b.is_empty():
				j.node_b = NodePath(node_b)
			if params.has("length"):
				j.length = float(params["length"])
			if params.has("initial_offset"):
				j.initial_offset = float(params["initial_offset"])
			joint = j
		"pin_3d":
			var j: PinJoint3D = PinJoint3D.new()
			if not node_a.is_empty():
				j.node_a = NodePath(node_a)
			if not node_b.is_empty():
				j.node_b = NodePath(node_b)
			joint = j
		"hinge_3d":
			var j: HingeJoint3D = HingeJoint3D.new()
			if not node_a.is_empty():
				j.node_a = NodePath(node_a)
			if not node_b.is_empty():
				j.node_b = NodePath(node_b)
			joint = j
		"cone_3d":
			var j: ConeTwistJoint3D = ConeTwistJoint3D.new()
			if not node_a.is_empty():
				j.node_a = NodePath(node_a)
			if not node_b.is_empty():
				j.node_b = NodePath(node_b)
			joint = j
		"slider_3d":
			var j: SliderJoint3D = SliderJoint3D.new()
			if not node_a.is_empty():
				j.node_a = NodePath(node_a)
			if not node_b.is_empty():
				j.node_b = NodePath(node_b)
			joint = j
		_:
			_send_response({"error": "Unknown joint type: %s. Use pin_2d, spring_2d, groove_2d, pin_3d, hinge_3d, cone_3d, or slider_3d" % joint_type})
			return

	parent.add_child(joint)
	_send_response({"success": true, "joint_type": joint_type, "name": joint.name, "path": str(joint.get_path())})


# --- Bone Pose ---
func _cmd_bone_pose(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	var action: String = params.get("action", "list")
	if node_path.is_empty():
		_send_response({"error": "node_path is required"})
		return

	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		_send_response({"error": "Node not found: %s" % node_path})
		return

	if not node is Skeleton3D:
		_send_response({"error": "Node is not a Skeleton3D: %s (is %s)" % [node_path, node.get_class()]})
		return

	var skel: Skeleton3D = node as Skeleton3D

	match action:
		"list":
			var bones: Array = []
			for i in skel.get_bone_count():
				bones.append({"index": i, "name": skel.get_bone_name(i), "parent": skel.get_bone_parent(i)})
			_send_response({"success": true, "action": "list", "bone_count": skel.get_bone_count(), "bones": bones})
		"get":
			var bone_idx: int = _resolve_bone_index(skel, params)
			if bone_idx < 0:
				_send_response({"error": "Bone not found"})
				return
			_send_response({
				"success": true, "action": "get", "bone_index": bone_idx,
				"bone_name": skel.get_bone_name(bone_idx),
				"position": _variant_to_json(skel.get_bone_pose_position(bone_idx)),
				"rotation": _variant_to_json(skel.get_bone_pose_rotation(bone_idx)),
				"scale": _variant_to_json(skel.get_bone_pose_scale(bone_idx))
			})
		"set":
			var bone_idx: int = _resolve_bone_index(skel, params)
			if bone_idx < 0:
				_send_response({"error": "Bone not found"})
				return
			if params.has("position"):
				var p: Dictionary = params["position"]
				skel.set_bone_pose_position(bone_idx, Vector3(float(p.get("x", 0)), float(p.get("y", 0)), float(p.get("z", 0))))
			if params.has("rotation"):
				var r: Dictionary = params["rotation"]
				skel.set_bone_pose_rotation(bone_idx, Quaternion(float(r.get("x", 0)), float(r.get("y", 0)), float(r.get("z", 0)), float(r.get("w", 1))))
			if params.has("scale"):
				var s: Dictionary = params["scale"]
				skel.set_bone_pose_scale(bone_idx, Vector3(float(s.get("x", 1)), float(s.get("y", 1)), float(s.get("z", 1))))
			_send_response({"success": true, "action": "set", "bone_index": bone_idx, "bone_name": skel.get_bone_name(bone_idx)})
		_:
			_send_response({"error": "Unknown bone action: %s. Use list, get, or set" % action})


func _resolve_bone_index(skel: Skeleton3D, params: Dictionary) -> int:
	if params.has("bone_index"):
		return int(params["bone_index"])
	if params.has("bone_name"):
		return skel.find_bone(params["bone_name"])
	return -1


# --- Viewport ---
func _cmd_viewport(params: Dictionary) -> void:
	var action: String = params.get("action", "create")

	match action:
		"create":
			var parent_path: String = params.get("parent_path", "/root")
			var parent: Node = get_tree().root.get_node_or_null(parent_path)
			if parent == null:
				_send_response({"error": "Parent node not found: %s" % parent_path})
				return
			var viewport: SubViewport = SubViewport.new()
			if params.has("width") and params.has("height"):
				viewport.size = Vector2i(int(params["width"]), int(params["height"]))
			if params.has("transparent_bg"):
				viewport.transparent_bg = bool(params["transparent_bg"])
			if params.has("msaa"):
				viewport.msaa_2d = int(params["msaa"]) as Viewport.MSAA
				viewport.msaa_3d = int(params["msaa"]) as Viewport.MSAA
			if params.has("name") and params["name"] is String and not (params["name"] as String).is_empty():
				viewport.name = params["name"]
			var container: SubViewportContainer = SubViewportContainer.new()
			container.add_child(viewport)
			parent.add_child(container)
			_send_response({"success": true, "action": "create", "viewport_path": str(viewport.get_path()), "container_path": str(container.get_path()), "size": _variant_to_json(viewport.size)})
		"configure":
			var node_path: String = params.get("node_path", "")
			if node_path.is_empty():
				_send_response({"error": "node_path is required for configure"})
				return
			var vp: Node = get_tree().root.get_node_or_null(node_path)
			if vp == null or not vp is SubViewport:
				_send_response({"error": "SubViewport not found: %s" % node_path})
				return
			var sv: SubViewport = vp as SubViewport
			if params.has("width") and params.has("height"):
				sv.size = Vector2i(int(params["width"]), int(params["height"]))
			if params.has("transparent_bg"):
				sv.transparent_bg = bool(params["transparent_bg"])
			if params.has("msaa"):
				sv.msaa_2d = int(params["msaa"]) as Viewport.MSAA
				sv.msaa_3d = int(params["msaa"]) as Viewport.MSAA
			_send_response({"success": true, "action": "configure", "size": _variant_to_json(sv.size), "transparent_bg": sv.transparent_bg})
		"get":
			var node_path: String = params.get("node_path", "")
			if node_path.is_empty():
				_send_response({"error": "node_path is required for get"})
				return
			var vp: Node = get_tree().root.get_node_or_null(node_path)
			if vp == null or not vp is SubViewport:
				_send_response({"error": "SubViewport not found: %s" % node_path})
				return
			var sv: SubViewport = vp as SubViewport
			_send_response({"success": true, "action": "get", "size": _variant_to_json(sv.size), "transparent_bg": sv.transparent_bg, "msaa_2d": sv.msaa_2d, "msaa_3d": sv.msaa_3d})
		_:
			_send_response({"error": "Unknown viewport action: %s. Use create, configure, or get" % action})


# --- Debug Draw ---
var _debug_draw_node: Node = null
var _debug_meshes: Array = []

func _cmd_debug_draw(params: Dictionary) -> void:
	var action: String = params.get("action", "line")
	var color_dict: Dictionary = params.get("color", {"r": 1.0, "g": 0.0, "b": 0.0})
	var color: Color = Color(float(color_dict.get("r", 1)), float(color_dict.get("g", 0)), float(color_dict.get("b", 0)), float(color_dict.get("a", 1)))
	var duration: int = int(params.get("duration", 0))

	if action == "clear":
		_clear_debug_draw()
		_send_response({"success": true, "action": "clear"})
		return

	# Ensure we have a debug draw parent
	if _debug_draw_node == null or not is_instance_valid(_debug_draw_node):
		_debug_draw_node = Node3D.new()
		_debug_draw_node.name = "_McpDebugDraw"
		get_tree().root.add_child(_debug_draw_node)

	var mat: StandardMaterial3D = StandardMaterial3D.new()
	mat.albedo_color = color
	mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	mat.no_depth_test = true
	mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA if color.a < 1.0 else BaseMaterial3D.TRANSPARENCY_DISABLED

	match action:
		"line":
			var from_dict: Dictionary = params.get("from", {})
			var to_dict: Dictionary = params.get("to", {})
			var from_pos: Vector3 = Vector3(float(from_dict.get("x", 0)), float(from_dict.get("y", 0)), float(from_dict.get("z", 0)))
			var to_pos: Vector3 = Vector3(float(to_dict.get("x", 0)), float(to_dict.get("y", 0)), float(to_dict.get("z", 0)))
			var im: ImmediateMesh = ImmediateMesh.new()
			im.surface_begin(Mesh.PRIMITIVE_LINES, mat)
			im.surface_add_vertex(from_pos)
			im.surface_add_vertex(to_pos)
			im.surface_end()
			var mi: MeshInstance3D = MeshInstance3D.new()
			mi.mesh = im
			_debug_draw_node.add_child(mi)
			_debug_meshes.append({"node": mi, "frames_left": duration})
			_send_response({"success": true, "action": "line"})
		"sphere":
			var center_dict: Dictionary = params.get("center", {})
			var center: Vector3 = Vector3(float(center_dict.get("x", 0)), float(center_dict.get("y", 0)), float(center_dict.get("z", 0)))
			var radius: float = float(params.get("radius", 0.5))
			var sphere_mesh: SphereMesh = SphereMesh.new()
			sphere_mesh.radius = radius
			sphere_mesh.height = radius * 2.0
			sphere_mesh.material = mat
			var mi: MeshInstance3D = MeshInstance3D.new()
			mi.mesh = sphere_mesh
			mi.global_position = center
			_debug_draw_node.add_child(mi)
			_debug_meshes.append({"node": mi, "frames_left": duration})
			_send_response({"success": true, "action": "sphere"})
		"box":
			var center_dict: Dictionary = params.get("center", {})
			var center: Vector3 = Vector3(float(center_dict.get("x", 0)), float(center_dict.get("y", 0)), float(center_dict.get("z", 0)))
			var size_dict: Dictionary = params.get("size", {"x": 1, "y": 1, "z": 1})
			var box_size: Vector3 = Vector3(float(size_dict.get("x", 1)), float(size_dict.get("y", 1)), float(size_dict.get("z", 1)))
			var box_mesh: BoxMesh = BoxMesh.new()
			box_mesh.size = box_size
			box_mesh.material = mat
			var mi: MeshInstance3D = MeshInstance3D.new()
			mi.mesh = box_mesh
			mi.global_position = center
			_debug_draw_node.add_child(mi)
			_debug_meshes.append({"node": mi, "frames_left": duration})
			_send_response({"success": true, "action": "box"})
		_:
			_send_response({"error": "Unknown debug draw action: %s. Use line, sphere, box, or clear" % action})


func _clear_debug_draw() -> void:
	for entry in _debug_meshes:
		if is_instance_valid(entry["node"]):
			entry["node"].queue_free()
	_debug_meshes.clear()
	if _debug_draw_node != null and is_instance_valid(_debug_draw_node):
		_debug_draw_node.queue_free()
		_debug_draw_node = null


# ==========================================================================
# Batch 1: Networking + Input + System + Signals + Script
# ==========================================================================

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


func _cmd_list_signals(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var node_path: String = reader.required_node_path()
	var node: Node = _require_node(reader)
	if _params_invalid(reader):
		return
	var signals: Array = []
	for sig in node.get_signal_list():
		var connections: Array = []
		for conn in node.get_signal_connection_list(sig["name"]):
			connections.append({"callable": str(conn["callable"]), "flags": conn["flags"]})
		signals.append({"name": sig["name"], "args": str(sig["args"]), "connections": connections})
	_send_response({"success": true, "node_path": node_path, "signals": signals})


func _cmd_await_signal(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	var signal_name: String = params.get("signal_name", "")
	var timeout: float = float(params.get("timeout", 10))
	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		_send_response({"error": "Node not found: %s" % node_path})
		return
	if not node.has_signal(signal_name):
		_send_response({"error": "Signal not found: %s on %s" % [signal_name, node_path]})
		return
	var timer: SceneTreeTimer = get_tree().create_timer(timeout)
	var result: Array = [false, []]
	var cb: Callable = func():
		result[0] = true
	node.connect(signal_name, cb, CONNECT_ONE_SHOT)
	while not result[0] and timer.time_left > 0:
		await get_tree().process_frame
		if _active_session != null and _active_session.cancellation_requested:
			break
	if node.is_connected(signal_name, cb):
		node.disconnect(signal_name, cb)
	if _active_session != null and _active_session.cancellation_requested:
		_send_response({})
		return
	if result[0]:
		_send_response({"success": true, "signal_name": signal_name, "received": true})
	else:
		_send_timeout_response("Signal wait timed out", {"command": "await_signal", "timeout_seconds": timeout})


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

func _cmd_csg(params: Dictionary) -> void:
	var action: String = params.get("action", "create")
	if action == "create":
		var parent_path: String = params.get("parent_path", "/root")
		var parent: Node = get_tree().root.get_node_or_null(parent_path)
		if parent == null:
			_send_response({"error": "Parent not found: %s" % parent_path})
			return
		var csg_type: String = params.get("csg_type", "box")
		var node: CSGShape3D
		match csg_type:
			"box": node = CSGBox3D.new()
			"sphere": node = CSGSphere3D.new()
			"cylinder": node = CSGCylinder3D.new()
			"mesh": node = CSGMesh3D.new()
			"combiner": node = CSGCombiner3D.new()
			_:
				_send_response({"error": "Unknown CSG type: %s" % csg_type})
				return
		if params.has("operation"):
			match params["operation"]:
				"union": node.operation = CSGShape3D.OPERATION_UNION
				"intersection": node.operation = CSGShape3D.OPERATION_INTERSECTION
				"subtraction": node.operation = CSGShape3D.OPERATION_SUBTRACTION
		if params.has("name") and not (params["name"] as String).is_empty():
			node.name = params["name"]
		if node is CSGBox3D and params.has("size"):
			var box_size: Variant = _json_to_variant(params["size"], "Vector3")
			if box_size is Vector3:
				(node as CSGBox3D).size = box_size
		if node is CSGSphere3D and params.has("radius"):
			(node as CSGSphere3D).radius = float(params["radius"])
		if node is CSGCylinder3D:
			if params.has("radius"):
				(node as CSGCylinder3D).radius = float(params["radius"])
			if params.has("height"):
				(node as CSGCylinder3D).height = float(params["height"])
		parent.add_child(node)
		node.owner = get_tree().edited_scene_root if get_tree().edited_scene_root else get_tree().root
		_send_response({"success": true, "action": "create", "path": str(node.get_path()), "type": csg_type})
	elif action == "configure":
		var node_path: String = params.get("node_path", "")
		var node: Node = get_tree().root.get_node_or_null(node_path)
		if node == null or not node is CSGShape3D:
			_send_response({"error": "CSGShape3D not found: %s" % node_path})
			return
		if params.has("operation"):
			match params["operation"]:
				"union": (node as CSGShape3D).operation = CSGShape3D.OPERATION_UNION
				"intersection": (node as CSGShape3D).operation = CSGShape3D.OPERATION_INTERSECTION
				"subtraction": (node as CSGShape3D).operation = CSGShape3D.OPERATION_SUBTRACTION
		_send_response({"success": true, "action": "configure", "path": str(node.get_path())})
	else:
		_send_response({"error": "Unknown csg action: %s" % action})


func _cmd_multimesh(params: Dictionary) -> void:
	var action: String = params.get("action", "create")
	match action:
		"create":
			var parent_path: String = params.get("parent_path", "/root")
			var parent: Node = get_tree().root.get_node_or_null(parent_path)
			if parent == null:
				_send_response({"error": "Parent not found: %s" % parent_path})
				return
			var mmi: MultiMeshInstance3D = MultiMeshInstance3D.new()
			var mm: MultiMesh = MultiMesh.new()
			mm.transform_format = MultiMesh.TRANSFORM_3D
			mm.instance_count = int(params.get("count", 1))
			var mesh_type: String = params.get("mesh_type", "box")
			match mesh_type:
				"box": mm.mesh = BoxMesh.new()
				"sphere": mm.mesh = SphereMesh.new()
				"cylinder": mm.mesh = CylinderMesh.new()
				_: mm.mesh = BoxMesh.new()
			mmi.multimesh = mm
			if params.has("name") and not (params["name"] as String).is_empty():
				mmi.name = params["name"]
			parent.add_child(mmi)
			_send_response({"success": true, "action": "create", "path": str(mmi.get_path()), "count": mm.instance_count})
		"set_instance":
			var node_path: String = params.get("node_path", "")
			var node: Node = get_tree().root.get_node_or_null(node_path)
			if node == null or not node is MultiMeshInstance3D:
				_send_response({"error": "MultiMeshInstance3D not found: %s" % node_path})
				return
			var idx: int = int(params.get("index", 0))
			var tf: Dictionary = params.get("transform", {})
			var origin: Dictionary = tf.get("origin", {})
			var xform: Transform3D = Transform3D.IDENTITY
			xform.origin = Vector3(float(origin.get("x", 0)), float(origin.get("y", 0)), float(origin.get("z", 0)))
			(node as MultiMeshInstance3D).multimesh.set_instance_transform(idx, xform)
			_send_response({"success": true, "action": "set_instance", "index": idx})
		"get_info":
			var node_path: String = params.get("node_path", "")
			var node: Node = get_tree().root.get_node_or_null(node_path)
			if node == null or not node is MultiMeshInstance3D:
				_send_response({"error": "MultiMeshInstance3D not found: %s" % node_path})
				return
			var mm = (node as MultiMeshInstance3D).multimesh
			_send_response({"success": true, "count": mm.instance_count if mm else 0, "visible_count": mm.visible_instance_count if mm else 0})
		_:
			_send_response({"error": "Unknown multimesh action: %s" % action})


func _cmd_procedural_mesh(params: Dictionary) -> void:
	var parent_path: String = params.get("parent_path", "/root")
	var parent: Node = get_tree().root.get_node_or_null(parent_path)
	if parent == null:
		_send_response({"error": "Parent not found: %s" % parent_path})
		return
	var verts_arr: Array = params.get("vertices", [])
	var verts: PackedVector3Array = PackedVector3Array()
	for v in verts_arr:
		verts.append(Vector3(float(v[0]), float(v[1]), float(v[2])))
	var arrays: Array = []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = verts
	if params.has("normals"):
		var norms: PackedVector3Array = PackedVector3Array()
		for n in params["normals"]:
			norms.append(Vector3(float(n[0]), float(n[1]), float(n[2])))
		arrays[Mesh.ARRAY_NORMAL] = norms
	if params.has("uvs"):
		var uvs: PackedVector2Array = PackedVector2Array()
		for uv in params["uvs"]:
			uvs.append(Vector2(float(uv[0]), float(uv[1])))
		arrays[Mesh.ARRAY_TEX_UV] = uvs
	if params.has("indices"):
		var indices: PackedInt32Array = PackedInt32Array()
		for idx in params["indices"]:
			indices.append(int(idx))
		arrays[Mesh.ARRAY_INDEX] = indices
	var mesh: ArrayMesh = ArrayMesh.new()
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	var mi: MeshInstance3D = MeshInstance3D.new()
	mi.mesh = mesh
	if params.has("name") and not (params["name"] as String).is_empty():
		mi.name = params["name"]
	parent.add_child(mi)
	_send_response({"success": true, "path": str(mi.get_path()), "vertex_count": verts.size()})


func _cmd_light_3d(params: Dictionary) -> void:
	var action: String = params.get("action", "create")
	if action == "create":
		var parent_path: String = params.get("parent_path", "/root")
		var parent: Node = get_tree().root.get_node_or_null(parent_path)
		if parent == null:
			_send_response({"error": "Parent not found: %s" % parent_path})
			return
		var light_type: String = params.get("light_type", "omni")
		var light: Light3D
		match light_type:
			"directional": light = DirectionalLight3D.new()
			"omni": light = OmniLight3D.new()
			"spot": light = SpotLight3D.new()
			_:
				_send_response({"error": "Unknown light type: %s" % light_type})
				return
		if params.has("color"):
			var c: Dictionary = params["color"]
			light.light_color = Color(float(c.get("r", 1)), float(c.get("g", 1)), float(c.get("b", 1)))
		if params.has("energy"):
			light.light_energy = float(params["energy"])
		if params.has("shadows"):
			light.shadow_enabled = bool(params["shadows"])
		if light is OmniLight3D and params.has("range"):
			(light as OmniLight3D).omni_range = float(params["range"])
		if light is SpotLight3D:
			if params.has("range"):
				(light as SpotLight3D).spot_range = float(params["range"])
			if params.has("spot_angle"):
				(light as SpotLight3D).spot_angle = float(params["spot_angle"])
		if params.has("name") and not (params["name"] as String).is_empty():
			light.name = params["name"]
		parent.add_child(light)
		_send_response({"success": true, "action": "create", "path": str(light.get_path()), "type": light_type})
	elif action == "configure":
		var node_path: String = params.get("node_path", "")
		var node: Node = get_tree().root.get_node_or_null(node_path)
		if node == null or not node is Light3D:
			_send_response({"error": "Light3D not found: %s" % node_path})
			return
		var light: Light3D = node as Light3D
		if params.has("color"):
			var c: Dictionary = params["color"]
			light.light_color = Color(float(c.get("r", 1)), float(c.get("g", 1)), float(c.get("b", 1)))
		if params.has("energy"):
			light.light_energy = float(params["energy"])
		if params.has("shadows"):
			light.shadow_enabled = bool(params["shadows"])
		_send_response({"success": true, "action": "configure", "path": str(node.get_path())})
	else:
		_send_response({"error": "Unknown light_3d action: %s" % action})


func _cmd_mesh_instance(params: Dictionary) -> void:
	var parent_path: String = params.get("parent_path", "/root")
	var parent: Node = get_tree().root.get_node_or_null(parent_path)
	if parent == null:
		_send_response({"error": "Parent not found: %s" % parent_path})
		return
	var mesh_type: String = params.get("mesh_type", "box")
	var mesh: Mesh
	match mesh_type:
		"box": mesh = BoxMesh.new()
		"sphere": mesh = SphereMesh.new()
		"cylinder": mesh = CylinderMesh.new()
		"capsule": mesh = CapsuleMesh.new()
		"plane": mesh = PlaneMesh.new()
		"quad": mesh = QuadMesh.new()
		_:
			_send_response({"error": "Unknown mesh type: %s" % mesh_type})
			return
	if params.has("size") and mesh is BoxMesh:
		var s: Dictionary = params["size"]
		(mesh as BoxMesh).size = Vector3(float(s.get("x", 1)), float(s.get("y", 1)), float(s.get("z", 1)))
	if params.has("radius"):
		if mesh is SphereMesh: (mesh as SphereMesh).radius = float(params["radius"])
		elif mesh is CylinderMesh: (mesh as CylinderMesh).top_radius = float(params["radius"])
		elif mesh is CapsuleMesh: (mesh as CapsuleMesh).radius = float(params["radius"])
	if params.has("height"):
		if mesh is CylinderMesh: (mesh as CylinderMesh).height = float(params["height"])
		elif mesh is CapsuleMesh: (mesh as CapsuleMesh).height = float(params["height"])
		elif mesh is SphereMesh: (mesh as SphereMesh).height = float(params["height"])
	var mi: MeshInstance3D = MeshInstance3D.new()
	mi.mesh = mesh
	if params.has("material") and params["material"] is String:
		var mat: StandardMaterial3D = StandardMaterial3D.new()
		var hex: String = params["material"]
		if hex.begins_with("#") or hex.length() == 6 or hex.length() == 8:
			mat.albedo_color = Color.from_string(hex, Color.WHITE)
		mi.material_override = mat
	if params.has("name") and not (params["name"] as String).is_empty():
		mi.name = params["name"]
	parent.add_child(mi)
	_send_response({"success": true, "path": str(mi.get_path()), "mesh_type": mesh_type})


func _cmd_gridmap(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null or not node is GridMap:
		_send_response({"error": "GridMap not found: %s" % node_path})
		return
	var gm: GridMap = node as GridMap
	var action: String = params.get("action", "get_used")
	match action:
		"set_cell":
			gm.set_cell_item(Vector3i(int(params.get("x", 0)), int(params.get("y", 0)), int(params.get("z", 0))), int(params.get("item", 0)), int(params.get("orientation", 0)))
			_send_response({"success": true, "action": "set_cell"})
		"get_cell":
			var item: int = gm.get_cell_item(Vector3i(int(params.get("x", 0)), int(params.get("y", 0)), int(params.get("z", 0))))
			_send_response({"success": true, "action": "get_cell", "item": item})
		"clear":
			gm.clear()
			_send_response({"success": true, "action": "clear"})
		"get_used":
			var cells: Array = gm.get_used_cells()
			var result: Array = []
			for c in cells.slice(0, 100):
				result.append({"x": c.x, "y": c.y, "z": c.z})
			_send_response({"success": true, "action": "get_used", "cells": result, "total": cells.size()})
		_:
			_send_response({"error": "Unknown gridmap action: %s" % action})


func _cmd_3d_effects(params: Dictionary) -> void:
	var parent_path: String = params.get("parent_path", "/root")
	var parent: Node = get_tree().root.get_node_or_null(parent_path)
	if parent == null:
		_send_response({"error": "Parent not found: %s" % parent_path})
		return
	var effect_type: String = params.get("effect_type", "")
	var node: Node3D
	match effect_type:
		"reflection_probe": node = ReflectionProbe.new()
		"decal": node = Decal.new()
		"fog_volume": node = FogVolume.new()
		_:
			_send_response({"error": "Unknown effect type: %s" % effect_type})
			return
	if params.has("size"):
		var s: Dictionary = params["size"]
		var size_v: Vector3 = Vector3(float(s.get("x", 1)), float(s.get("y", 1)), float(s.get("z", 1)))
		if node is ReflectionProbe: (node as ReflectionProbe).size = size_v
		elif node is Decal: (node as Decal).size = size_v
		elif node is FogVolume: (node as FogVolume).size = size_v
	if params.has("name") and not (params["name"] as String).is_empty():
		node.name = params["name"]
	parent.add_child(node)
	_send_response({"success": true, "path": str(node.get_path()), "effect_type": effect_type})


func _cmd_gi(params: Dictionary) -> void:
	var parent_path: String = params.get("parent_path", "/root")
	var parent: Node = get_tree().root.get_node_or_null(parent_path)
	if parent == null:
		_send_response({"error": "Parent not found: %s" % parent_path})
		return
	var gi_type: String = params.get("gi_type", "voxel_gi")
	var node: VisualInstance3D
	match gi_type:
		"voxel_gi": node = VoxelGI.new()
		"lightmap_gi": node = LightmapGI.new()
		_:
			_send_response({"error": "Unknown GI type: %s" % gi_type})
			return
	if params.has("size") and node is VoxelGI:
		var s: Dictionary = params["size"]
		(node as VoxelGI).size = Vector3(float(s.get("x", 10)), float(s.get("y", 10)), float(s.get("z", 10)))
	if params.has("name") and not (params["name"] as String).is_empty():
		node.name = params["name"]
	parent.add_child(node)
	_send_response({"success": true, "path": str(node.get_path()), "gi_type": gi_type})


func _cmd_path_3d(params: Dictionary) -> void:
	var action: String = params.get("action", "create")
	match action:
		"create":
			var parent_path: String = params.get("parent_path", "/root")
			var parent: Node = get_tree().root.get_node_or_null(parent_path)
			if parent == null:
				_send_response({"error": "Parent not found: %s" % parent_path})
				return
			var path_node: Path3D = Path3D.new()
			path_node.curve = Curve3D.new()
			if params.has("name") and not (params["name"] as String).is_empty():
				path_node.name = params["name"]
			if params.has("points"):
				for p in params["points"]:
					path_node.curve.add_point(Vector3(float(p.get("x", 0)), float(p.get("y", 0)), float(p.get("z", 0))))
			parent.add_child(path_node)
			_send_response({"success": true, "action": "create", "path": str(path_node.get_path()), "point_count": path_node.curve.point_count})
		"add_point":
			var node_path: String = params.get("node_path", "")
			var node: Node = get_tree().root.get_node_or_null(node_path)
			if node == null or not node is Path3D:
				_send_response({"error": "Path3D not found: %s" % node_path})
				return
			var p: Dictionary = params.get("point", {})
			(node as Path3D).curve.add_point(Vector3(float(p.get("x", 0)), float(p.get("y", 0)), float(p.get("z", 0))))
			_send_response({"success": true, "action": "add_point", "point_count": (node as Path3D).curve.point_count})
		"get_points":
			var node_path: String = params.get("node_path", "")
			var node: Node = get_tree().root.get_node_or_null(node_path)
			if node == null or not node is Path3D:
				_send_response({"error": "Path3D not found: %s" % node_path})
				return
			var pts: Array = []
			for i in (node as Path3D).curve.point_count:
				var pt: Vector3 = (node as Path3D).curve.get_point_position(i)
				pts.append({"x": pt.x, "y": pt.y, "z": pt.z})
			_send_response({"success": true, "action": "get_points", "points": pts})
		"set_points":
			var node_path: String = params.get("node_path", "")
			var node: Node = get_tree().root.get_node_or_null(node_path)
			if node == null or not node is Path3D:
				_send_response({"error": "Path3D not found: %s" % node_path})
				return
			var curve: Curve3D = (node as Path3D).curve
			if curve == null:
				curve = Curve3D.new()
				(node as Path3D).curve = curve
			curve.clear_points()
			for p in params.get("points", []):
				curve.add_point(Vector3(float(p.get("x", 0)), float(p.get("y", 0)), float(p.get("z", 0))))
			_send_response({"success": true, "action": "set_points", "point_count": curve.point_count})
		_:
			_send_response({"error": "Unknown path_3d action: %s" % action})


func _cmd_sky(params: Dictionary) -> void:
	var action: String = params.get("action", "create")
	var env: Environment = _get_or_create_environment()
	if env == null:
		_send_response({"error": "Could not get or create environment"})
		return
	var sky_type: String = params.get("sky_type", "procedural")
	if action == "create" or env.sky == null:
		env.sky = Sky.new()
		env.background_mode = Environment.BG_SKY
	var sky_mat: ProceduralSkyMaterial = env.sky.sky_material as ProceduralSkyMaterial
	if sky_mat == null:
		sky_mat = ProceduralSkyMaterial.new()
	if params.has("top_color"):
		var c: Dictionary = params["top_color"]
		sky_mat.sky_top_color = Color(float(c.get("r", 0.4)), float(c.get("g", 0.6)), float(c.get("b", 1.0)))
	if params.has("bottom_color"):
		var c: Dictionary = params["bottom_color"]
		sky_mat.sky_horizon_color = Color(float(c.get("r", 0.7)), float(c.get("g", 0.8)), float(c.get("b", 0.9)))
	if params.has("ground_color"):
		var c: Dictionary = params["ground_color"]
		sky_mat.ground_bottom_color = Color(float(c.get("r", 0.1)), float(c.get("g", 0.1)), float(c.get("b", 0.1)))
	if params.has("sun_energy"):
		sky_mat.sun_curve = float(params["sun_energy"])
	env.sky.sky_material = sky_mat
	_send_response({"success": true, "action": action, "sky_type": sky_type})


func _get_or_create_environment() -> Environment:
	var cam: Camera3D = get_viewport().get_camera_3d()
	if cam != null and cam.get_environment() != null:
		return cam.get_environment()
	var we: WorldEnvironment = null
	for child in get_tree().root.get_children():
		if child is WorldEnvironment:
			we = child as WorldEnvironment
			break
	if we != null and we.environment != null:
		return we.environment
	# Create one
	we = WorldEnvironment.new()
	we.environment = Environment.new()
	get_tree().root.add_child(we)
	return we.environment


func _cmd_camera_attributes(params: Dictionary) -> void:
	var action: String = params.get("action", "get")
	var cam: Camera3D = get_viewport().get_camera_3d()
	if cam == null:
		_send_response({"error": "No Camera3D found in viewport"})
		return
	if action == "get":
		var info: Dictionary = {"success": true, "action": "get"}
		if cam.attributes != null:
			info["has_attributes"] = true
		else:
			info["has_attributes"] = false
		_send_response(info)
		return
	# set
	if cam.attributes == null:
		cam.attributes = CameraAttributesPractical.new()
	var attr: CameraAttributesPractical = cam.attributes as CameraAttributesPractical
	if attr == null:
		_send_response({"error": "Camera attributes is not CameraAttributesPractical"})
		return
	if params.has("dof_blur_far"):
		attr.dof_blur_far_enabled = true
		attr.dof_blur_far_distance = float(params["dof_blur_far"])
	if params.has("dof_blur_near"):
		attr.dof_blur_near_enabled = true
		attr.dof_blur_near_distance = float(params["dof_blur_near"])
	if params.has("dof_blur_amount"):
		attr.dof_blur_amount = float(params["dof_blur_amount"])
	if params.has("auto_exposure"):
		attr.auto_exposure_enabled = bool(params["auto_exposure"])
	_send_response({"success": true, "action": "set"})


func _cmd_navigation_3d(params: Dictionary) -> void:
	var action: String = params.get("action", "create")
	match action:
		"create":
			var parent_path: String = params.get("parent_path", "/root")
			var parent: Node = get_tree().root.get_node_or_null(parent_path)
			if parent == null:
				_send_response({"error": "Parent not found: %s" % parent_path})
				return
			var region: NavigationRegion3D = NavigationRegion3D.new()
			region.navigation_mesh = NavigationMesh.new()
			if params.has("cell_size"):
				region.navigation_mesh.cell_size = float(params["cell_size"])
			if params.has("agent_radius"):
				region.navigation_mesh.agent_radius = float(params["agent_radius"])
			if params.has("agent_height"):
				region.navigation_mesh.agent_height = float(params["agent_height"])
			if params.has("name") and not (params["name"] as String).is_empty():
				region.name = params["name"]
			parent.add_child(region)
			_send_response({"success": true, "action": "create", "path": str(region.get_path())})
		"bake":
			var node_path: String = params.get("node_path", "")
			var node: Node = get_tree().root.get_node_or_null(node_path)
			if node == null or not node is NavigationRegion3D:
				_send_response({"error": "NavigationRegion3D not found: %s" % node_path})
				return
			(node as NavigationRegion3D).bake_navigation_mesh()
			await get_tree().process_frame
			await get_tree().process_frame
			_send_response({"success": true, "action": "bake"})
		_:
			_send_response({"error": "Unknown navigation_3d action: %s" % action})


func _cmd_physics_3d(params: Dictionary) -> void:
	var action: String = params.get("action", "ray")
	await get_tree().physics_frame
	var space: PhysicsDirectSpaceState3D = get_viewport().world_3d.direct_space_state
	match action:
		"ray":
			var from_d: Dictionary = params.get("from", {})
			var to_d: Dictionary = params.get("to", {})
			var from: Vector3 = Vector3(float(from_d.get("x", 0)), float(from_d.get("y", 0)), float(from_d.get("z", 0)))
			var to: Vector3 = Vector3(float(to_d.get("x", 0)), float(to_d.get("y", 0)), float(to_d.get("z", 0)))
			var query: PhysicsRayQueryParameters3D = PhysicsRayQueryParameters3D.create(from, to)
			if params.has("collision_mask"):
				query.collision_mask = int(params["collision_mask"])
			var result: Dictionary = space.intersect_ray(query)
			if result.is_empty():
				_send_response({"success": true, "action": "ray", "hit": false})
			else:
				_send_response({"success": true, "action": "ray", "hit": true, "position": _variant_to_json(result["position"]), "normal": _variant_to_json(result["normal"]), "collider": str(result.get("collider", ""))})
		"overlap":
			var node_path: String = params.get("node_path", "")
			var node: Node = get_tree().root.get_node_or_null(node_path)
			if node == null or not node is Area3D:
				_send_response({"error": "Area3D not found: %s" % node_path})
				return
			var bodies: Array = (node as Area3D).get_overlapping_bodies()
			var result: Array = []
			for b in bodies:
				result.append({"name": b.name, "path": str(b.get_path())})
			_send_response({"success": true, "action": "overlap", "bodies": result})
		_:
			_send_response({"error": "Unknown physics_3d action: %s" % action})


# ==========================================================================
# Batch 3: 2D Systems + Animation Advanced + Audio Effects
# ==========================================================================

func _cmd_canvas(params: Dictionary) -> void:
	var action: String = params.get("action", "create_layer")
	match action:
		"create_layer":
			var parent_path: String = params.get("parent_path", "/root")
			var parent: Node = get_tree().root.get_node_or_null(parent_path)
			if parent == null:
				_send_response({"error": "Parent not found: %s" % parent_path})
				return
			var cl: CanvasLayer = CanvasLayer.new()
			if params.has("layer"):
				cl.layer = int(params["layer"])
			if params.has("name") and not (params["name"] as String).is_empty():
				cl.name = params["name"]
			parent.add_child(cl)
			_send_response({"success": true, "action": "create_layer", "path": str(cl.get_path())})
		"create_modulate":
			var parent_path: String = params.get("parent_path", "/root")
			var parent: Node = get_tree().root.get_node_or_null(parent_path)
			if parent == null:
				_send_response({"error": "Parent not found: %s" % parent_path})
				return
			var cm: CanvasModulate = CanvasModulate.new()
			if params.has("color"):
				var c: Dictionary = params["color"]
				cm.color = Color(float(c.get("r", 1)), float(c.get("g", 1)), float(c.get("b", 1)), float(c.get("a", 1)))
			if params.has("name") and not (params["name"] as String).is_empty():
				cm.name = params["name"]
			parent.add_child(cm)
			_send_response({"success": true, "action": "create_modulate", "path": str(cm.get_path())})
		"configure":
			var node_path: String = params.get("node_path", "")
			var node: Node = get_tree().root.get_node_or_null(node_path)
			if node == null:
				_send_response({"error": "Node not found: %s" % node_path})
				return
			var applied: Array = []
			if node is CanvasLayer:
				var cl2: CanvasLayer = node as CanvasLayer
				if params.has("layer"):
					cl2.layer = int(params["layer"])
					applied.append("layer")
				if params.has("offset"):
					var o: Dictionary = params["offset"]
					cl2.offset = Vector2(float(o.get("x", 0)), float(o.get("y", 0)))
					applied.append("offset")
				if params.has("visible"):
					cl2.visible = bool(params["visible"])
					applied.append("visible")
			elif node is CanvasModulate:
				if params.has("color"):
					var c: Dictionary = params["color"]
					(node as CanvasModulate).color = Color(float(c.get("r", 1)), float(c.get("g", 1)), float(c.get("b", 1)), float(c.get("a", 1)))
					applied.append("color")
			else:
				_send_response({"error": "Node is not a CanvasLayer or CanvasModulate: %s" % node.get_class()})
				return
			_send_response({"success": true, "action": "configure", "applied": applied})
		_:
			_send_response({"error": "Unknown canvas action: %s" % action})


var _canvas_draw_node: Node2D = null
var _draw_commands: Array = []

func _cmd_canvas_draw(params: Dictionary) -> void:
	var action: String = params.get("action", "line")
	if action == "clear":
		_draw_commands.clear()
		if _canvas_draw_node != null and is_instance_valid(_canvas_draw_node):
			_canvas_draw_node.queue_redraw()
		_send_response({"success": true, "action": "clear"})
		return
	if not action in ["line", "rect", "circle", "polygon", "text"]:
		_send_response({"error": "Unknown canvas_draw action: %s" % action})
		return
	# Ensure draw node
	if _canvas_draw_node == null or not is_instance_valid(_canvas_draw_node):
		var parent_path: String = params.get("parent_path", "/root")
		var parent: Node = get_tree().root.get_node_or_null(parent_path)
		if parent == null:
			_send_response({"error": "Parent not found: %s" % parent_path})
			return
		_canvas_draw_node = Node2D.new()
		_canvas_draw_node.name = "_McpCanvasDraw"
		_canvas_draw_node.set_script(_create_draw_script())
		parent.add_child(_canvas_draw_node)
		_canvas_draw_node.set("draw_commands", _draw_commands)
	var color_d: Dictionary = params.get("color", {"r": 1.0, "g": 1.0, "b": 1.0, "a": 1.0})
	var color: Color = Color(float(color_d.get("r", 1)), float(color_d.get("g", 1)), float(color_d.get("b", 1)), float(color_d.get("a", 1)))
	_draw_commands.append({"action": action, "params": params, "color": color})
	_canvas_draw_node.set("draw_commands", _draw_commands)
	_canvas_draw_node.queue_redraw()
	_send_response({"success": true, "action": action})

func _create_draw_script() -> GDScript:
	var s: GDScript = GDScript.new()
	s.source_code = """extends Node2D
var draw_commands: Array = []
func _draw():
	for cmd in draw_commands:
		var p = cmd.params
		var c = cmd.color
		match cmd.action:
			"line":
				var f = p.get("from", {})
				var t = p.get("to", {})
				draw_line(Vector2(float(f.get("x",0)),float(f.get("y",0))),Vector2(float(t.get("x",0)),float(t.get("y",0))),c,float(p.get("width",2)))
			"rect":
				var r = p.get("rect", {})
				draw_rect(Rect2(float(r.get("x",0)),float(r.get("y",0)),float(r.get("w",10)),float(r.get("h",10))),c,bool(p.get("filled",true)))
			"circle":
				var ct = p.get("center", {})
				draw_circle(Vector2(float(ct.get("x",0)),float(ct.get("y",0))),float(p.get("radius",10)),c)
			"polygon":
				var pts = p.get("points", [])
				var pv = PackedVector2Array()
				for pt in pts:
					pv.append(Vector2(float(pt.get("x",0)),float(pt.get("y",0))))
				if pv.size() >= 3:
					draw_colored_polygon(pv, c)
			"text":
				var pos = p.get("position", p.get("pos", {}))
				draw_string(ThemeDB.fallback_font, Vector2(float(pos.get("x",0)),float(pos.get("y",0))), str(p.get("text","")), HORIZONTAL_ALIGNMENT_LEFT, -1, int(p.get("font_size",16)), c)
"""
	s.reload()
	return s


func _cmd_light_2d(params: Dictionary) -> void:
	var action: String = params.get("action", "create_point")
	var parent_path: String = params.get("parent_path", "/root")
	var parent: Node = get_tree().root.get_node_or_null(parent_path)
	if parent == null:
		_send_response({"error": "Parent not found: %s" % parent_path})
		return
	match action:
		"create_point":
			var light: PointLight2D = PointLight2D.new()
			if params.has("color"):
				var c: Dictionary = params["color"]
				light.color = Color(float(c.get("r", 1)), float(c.get("g", 1)), float(c.get("b", 1)), float(c.get("a", 1)))
			if params.has("energy"):
				light.energy = float(params["energy"])
			# Create a simple gradient texture for the light
			var tex: GradientTexture2D = GradientTexture2D.new()
			tex.width = 128
			tex.height = 128
			tex.fill = GradientTexture2D.FILL_RADIAL
			tex.gradient = Gradient.new()
			light.texture = tex
			if params.has("range"):
				light.texture_scale = float(params["range"])
			if params.has("name") and not (params["name"] as String).is_empty():
				light.name = params["name"]
			parent.add_child(light)
			_send_response({"success": true, "action": "create_point", "path": str(light.get_path())})
		"create_directional":
			var light: DirectionalLight2D = DirectionalLight2D.new()
			if params.has("color"):
				var c: Dictionary = params["color"]
				light.color = Color(float(c.get("r", 1)), float(c.get("g", 1)), float(c.get("b", 1)), float(c.get("a", 1)))
			if params.has("energy"):
				light.energy = float(params["energy"])
			if params.has("name") and not (params["name"] as String).is_empty():
				light.name = params["name"]
			parent.add_child(light)
			_send_response({"success": true, "action": "create_directional", "path": str(light.get_path())})
		"create_occluder":
			var occ: LightOccluder2D = LightOccluder2D.new()
			var poly: OccluderPolygon2D = OccluderPolygon2D.new()
			var packed: PackedVector2Array = PackedVector2Array()
			for p in params.get("points", []):
				packed.append(Vector2(float(p.get("x", 0)), float(p.get("y", 0))))
			poly.polygon = packed
			occ.occluder = poly
			if params.has("name") and not (params["name"] as String).is_empty():
				occ.name = params["name"]
			parent.add_child(occ)
			_send_response({"success": true, "action": "create_occluder", "path": str(occ.get_path()), "point_count": packed.size()})
		_:
			_send_response({"error": "Unknown light_2d action: %s" % action})


func _cmd_parallax(params: Dictionary) -> void:
	var action: String = params.get("action", "create_background")
	match action:
		"create_background":
			var parent_path: String = params.get("parent_path", "/root")
			var parent: Node = get_tree().root.get_node_or_null(parent_path)
			if parent == null:
				_send_response({"error": "Parent not found: %s" % parent_path})
				return
			var bg: ParallaxBackground = ParallaxBackground.new()
			if params.has("name") and not (params["name"] as String).is_empty():
				bg.name = params["name"]
			parent.add_child(bg)
			_send_response({"success": true, "action": "create_background", "path": str(bg.get_path())})
		"add_layer":
			var parent_path: String = params.get("parent_path", "")
			var parent: Node = get_tree().root.get_node_or_null(parent_path)
			if parent == null or not parent is ParallaxBackground:
				_send_response({"error": "ParallaxBackground not found: %s" % parent_path})
				return
			var layer: ParallaxLayer = ParallaxLayer.new()
			if params.has("motion_scale"):
				var ms: Dictionary = params["motion_scale"]
				layer.motion_scale = Vector2(float(ms.get("x", 1)), float(ms.get("y", 1)))
			if params.has("motion_offset"):
				var mo: Dictionary = params["motion_offset"]
				layer.motion_offset = Vector2(float(mo.get("x", 0)), float(mo.get("y", 0)))
			if params.has("mirroring"):
				var mi: Dictionary = params["mirroring"]
				layer.motion_mirroring = Vector2(float(mi.get("x", 0)), float(mi.get("y", 0)))
			if params.has("name") and not (params["name"] as String).is_empty():
				layer.name = params["name"]
			parent.add_child(layer)
			_send_response({"success": true, "action": "add_layer", "path": str(layer.get_path())})
		"configure":
			var node_path: String = params.get("node_path", "")
			var node: Node = get_tree().root.get_node_or_null(node_path)
			if node == null:
				_send_response({"error": "Node not found: %s" % node_path})
				return
			var applied: Array = []
			if node is ParallaxBackground:
				var pbg: ParallaxBackground = node as ParallaxBackground
				if params.has("scroll_offset"):
					var so: Dictionary = params["scroll_offset"]
					pbg.scroll_offset = Vector2(float(so.get("x", 0)), float(so.get("y", 0)))
					applied.append("scroll_offset")
				if params.has("scroll_base_offset"):
					var sbo: Dictionary = params["scroll_base_offset"]
					pbg.scroll_base_offset = Vector2(float(sbo.get("x", 0)), float(sbo.get("y", 0)))
					applied.append("scroll_base_offset")
			elif node is ParallaxLayer:
				var pl: ParallaxLayer = node as ParallaxLayer
				if params.has("motion_scale"):
					var ms2: Dictionary = params["motion_scale"]
					pl.motion_scale = Vector2(float(ms2.get("x", 1)), float(ms2.get("y", 1)))
					applied.append("motion_scale")
				if params.has("motion_offset"):
					var mo2: Dictionary = params["motion_offset"]
					pl.motion_offset = Vector2(float(mo2.get("x", 0)), float(mo2.get("y", 0)))
					applied.append("motion_offset")
				if params.has("mirroring"):
					var mi2: Dictionary = params["mirroring"]
					pl.motion_mirroring = Vector2(float(mi2.get("x", 0)), float(mi2.get("y", 0)))
					applied.append("mirroring")
			else:
				_send_response({"error": "Node is not a ParallaxBackground or ParallaxLayer: %s" % node.get_class()})
				return
			_send_response({"success": true, "action": "configure", "applied": applied})
		_:
			_send_response({"error": "Unknown parallax action: %s" % action})


func _cmd_shape_2d(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		_send_response({"error": "Node not found: %s" % node_path})
		return
	var action: String = params.get("action", "get_points")
	match action:
		"add_point":
			var p: Dictionary = params.get("point", {})
			var pt: Vector2 = Vector2(float(p.get("x", 0)), float(p.get("y", 0)))
			if node is Line2D:
				(node as Line2D).add_point(pt)
			elif node is Polygon2D:
				var polygon: PackedVector2Array = (node as Polygon2D).polygon
				polygon.append(pt)
				(node as Polygon2D).polygon = polygon
			_send_response({"success": true, "action": "add_point"})
		"set_points":
			var pts: Array = params.get("points", [])
			var packed: PackedVector2Array = PackedVector2Array()
			for p in pts:
				packed.append(Vector2(float(p.get("x", 0)), float(p.get("y", 0))))
			if node is Line2D:
				(node as Line2D).points = packed
			elif node is Polygon2D:
				(node as Polygon2D).polygon = packed
			_send_response({"success": true, "action": "set_points", "count": packed.size()})
		"clear":
			if node is Line2D:
				(node as Line2D).clear_points()
			elif node is Polygon2D:
				(node as Polygon2D).polygon = PackedVector2Array()
			_send_response({"success": true, "action": "clear"})
		"get_points":
			var pts: PackedVector2Array
			if node is Line2D:
				pts = (node as Line2D).points
			elif node is Polygon2D:
				pts = (node as Polygon2D).polygon
			else:
				_send_response({"error": "Node is not Line2D or Polygon2D"})
				return
			var result: Array = []
			for p in pts:
				result.append({"x": p.x, "y": p.y})
			_send_response({"success": true, "action": "get_points", "points": result})
		_:
			_send_response({"error": "Unknown shape_2d action: %s" % action})


func _cmd_path_2d(params: Dictionary) -> void:
	var action: String = params.get("action", "create")
	match action:
		"create":
			var parent_path: String = params.get("parent_path", "/root")
			var parent: Node = get_tree().root.get_node_or_null(parent_path)
			if parent == null:
				_send_response({"error": "Parent not found: %s" % parent_path})
				return
			var path_node: Path2D = Path2D.new()
			path_node.curve = Curve2D.new()
			if params.has("name") and not (params["name"] as String).is_empty():
				path_node.name = params["name"]
			if params.has("points"):
				for p in params["points"]:
					path_node.curve.add_point(Vector2(float(p.get("x", 0)), float(p.get("y", 0))))
			parent.add_child(path_node)
			_send_response({"success": true, "action": "create", "path": str(path_node.get_path()), "point_count": path_node.curve.point_count})
		"add_point":
			var node_path: String = params.get("node_path", "")
			var node: Node = get_tree().root.get_node_or_null(node_path)
			if node == null or not node is Path2D:
				_send_response({"error": "Path2D not found: %s" % node_path})
				return
			var p: Dictionary = params.get("point", {})
			(node as Path2D).curve.add_point(Vector2(float(p.get("x", 0)), float(p.get("y", 0))))
			_send_response({"success": true, "action": "add_point", "point_count": (node as Path2D).curve.point_count})
		"get_points":
			var node_path: String = params.get("node_path", "")
			var node: Node = get_tree().root.get_node_or_null(node_path)
			if node == null or not node is Path2D:
				_send_response({"error": "Path2D not found: %s" % node_path})
				return
			var pts: Array = []
			for i in (node as Path2D).curve.point_count:
				var pt: Vector2 = (node as Path2D).curve.get_point_position(i)
				pts.append({"x": pt.x, "y": pt.y})
			_send_response({"success": true, "action": "get_points", "points": pts})
		_:
			_send_response({"error": "Unknown path_2d action: %s" % action})


func _cmd_physics_2d(params: Dictionary) -> void:
	var action: String = params.get("action", "ray")
	await get_tree().physics_frame
	var space: PhysicsDirectSpaceState2D = get_viewport().world_2d.direct_space_state
	match action:
		"ray":
			var from_d: Dictionary = params.get("from", {})
			var to_d: Dictionary = params.get("to", {})
			var from: Vector2 = Vector2(float(from_d.get("x", 0)), float(from_d.get("y", 0)))
			var to: Vector2 = Vector2(float(to_d.get("x", 0)), float(to_d.get("y", 0)))
			var query: PhysicsRayQueryParameters2D = PhysicsRayQueryParameters2D.create(from, to)
			if params.has("collision_mask"):
				query.collision_mask = int(params["collision_mask"])
			var result: Dictionary = space.intersect_ray(query)
			if result.is_empty():
				_send_response({"success": true, "action": "ray", "hit": false})
			else:
				_send_response({"success": true, "action": "ray", "hit": true, "position": _variant_to_json(result["position"]), "normal": _variant_to_json(result["normal"]), "collider": str(result.get("collider", ""))})
		"overlap":
			var node_path: String = params.get("node_path", "")
			var node: Node = get_tree().root.get_node_or_null(node_path)
			if node == null or not node is Area2D:
				_send_response({"error": "Area2D not found: %s" % node_path})
				return
			var bodies: Array = (node as Area2D).get_overlapping_bodies()
			var result: Array = []
			for b in bodies:
				result.append({"name": b.name, "path": str(b.get_path())})
			_send_response({"success": true, "action": "overlap", "bodies": result})
		"point_query":
			var pos_d: Dictionary = params.get("position", params.get("point", {}))
			var query: PhysicsPointQueryParameters2D = PhysicsPointQueryParameters2D.new()
			query.position = Vector2(float(pos_d.get("x", 0)), float(pos_d.get("y", 0)))
			query.collide_with_areas = bool(params.get("collide_with_areas", true))
			query.collide_with_bodies = bool(params.get("collide_with_bodies", true))
			if params.has("collision_mask"):
				query.collision_mask = int(params["collision_mask"])
			var hits: Array = space.intersect_point(query, int(params.get("max_results", 32)))
			var out: Array = []
			for h in hits:
				out.append({"collider": str(h.get("collider", "")), "rid": str(h.get("rid", ""))})
			_send_response({"success": true, "action": "point_query", "count": out.size(), "results": out})
		"shape_query":
			var shape_type: String = params.get("shape_type", "circle")
			var shape: Shape2D = null
			if shape_type == "rectangle":
				var rect: RectangleShape2D = RectangleShape2D.new()
				var sz: Dictionary = params.get("size", {"x": 10, "y": 10})
				rect.size = Vector2(float(sz.get("x", 10)), float(sz.get("y", 10)))
				shape = rect
			else:
				var circ: CircleShape2D = CircleShape2D.new()
				circ.radius = float(params.get("radius", 10.0))
				shape = circ
			var sq: PhysicsShapeQueryParameters2D = PhysicsShapeQueryParameters2D.new()
			sq.shape = shape
			var spos_d: Dictionary = params.get("position", {})
			var xf: Transform2D = Transform2D.IDENTITY
			xf.origin = Vector2(float(spos_d.get("x", 0)), float(spos_d.get("y", 0)))
			sq.transform = xf
			sq.collide_with_areas = bool(params.get("collide_with_areas", true))
			sq.collide_with_bodies = bool(params.get("collide_with_bodies", true))
			if params.has("collision_mask"):
				sq.collision_mask = int(params["collision_mask"])
			var shits: Array = space.intersect_shape(sq, int(params.get("max_results", 32)))
			var sout: Array = []
			for h in shits:
				sout.append({"collider": str(h.get("collider", "")), "rid": str(h.get("rid", ""))})
			_send_response({"success": true, "action": "shape_query", "count": sout.size(), "results": sout})
		_:
			_send_response({"error": "Unknown physics_2d action: %s" % action})


func _cmd_animation_tree(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null or not node is AnimationTree:
		_send_response({"error": "AnimationTree not found: %s" % node_path})
		return
	var tree: AnimationTree = node as AnimationTree
	var action: String = params.get("action", "get_state")
	match action:
		"travel":
			var state_name: String = params.get("state_name", "")
			var playback = tree.get("parameters/playback")
			if playback != null:
				playback.travel(state_name)
			_send_response({"success": true, "action": "travel", "state": state_name})
		"set_param":
			var param_name: String = params.get("param_name", "")
			var param_value = params.get("param_value", 0)
			tree.set("parameters/" + param_name, param_value)
			_send_response({"success": true, "action": "set_param", "param": param_name})
		"get_state":
			var playback = tree.get("parameters/playback")
			var current: String = ""
			if playback != null:
				current = playback.get_current_node()
			_send_response({"success": true, "action": "get_state", "current": current})
		_:
			_send_response({"error": "Unknown animation_tree action: %s" % action})


func _cmd_animation_control(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null or not node is AnimationPlayer:
		_send_response({"error": "AnimationPlayer not found: %s" % node_path})
		return
	var player: AnimationPlayer = node as AnimationPlayer
	var action: String = params.get("action", "get_info")
	match action:
		"seek":
			var pos: float = float(params.get("position", 0))
			player.seek(pos)
			_send_response({"success": true, "action": "seek", "position": pos})
		"queue":
			var anim: String = params.get("animation_name", "")
			player.queue(anim)
			_send_response({"success": true, "action": "queue", "animation": anim})
		"set_speed":
			player.speed_scale = float(params.get("speed", 1.0))
			_send_response({"success": true, "action": "set_speed", "speed": player.speed_scale})
		"stop":
			player.stop()
			_send_response({"success": true, "action": "stop"})
		"get_info":
			var anims: PackedStringArray = player.get_animation_list()
			_send_response({"success": true, "action": "get_info", "current": player.current_animation, "playing": player.is_playing(), "animations": Array(anims), "speed_scale": player.speed_scale, "position": player.current_animation_position})
		_:
			_send_response({"error": "Unknown animation_control action: %s" % action})


func _cmd_skeleton_ik(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null or not node is SkeletonIK3D:
		_send_response({"error": "SkeletonIK3D not found: %s" % node_path})
		return
	var ik: SkeletonIK3D = node as SkeletonIK3D
	var action: String = params.get("action", "start")
	match action:
		"start":
			ik.start()
			_send_response({"success": true, "action": "start"})
		"stop":
			ik.stop()
			_send_response({"success": true, "action": "stop"})
		"set_target":
			var t: Dictionary = params.get("target", {})
			var target_tf: Transform3D = Transform3D.IDENTITY
			target_tf.origin = Vector3(float(t.get("x", 0)), float(t.get("y", 0)), float(t.get("z", 0)))
			ik.target = target_tf
			_send_response({"success": true, "action": "set_target"})
		_:
			_send_response({"error": "Unknown skeleton_ik action: %s" % action})


func _cmd_audio_effect(params: Dictionary) -> void:
	var bus_name: String = params.get("bus_name", "Master")
	var bus_idx: int = AudioServer.get_bus_index(bus_name)
	if bus_idx < 0:
		_send_response({"error": "Audio bus not found: %s" % bus_name})
		return
	var action: String = params.get("action", "list")
	match action:
		"list":
			var effects: Array = []
			for i in AudioServer.get_bus_effect_count(bus_idx):
				var eff: AudioEffect = AudioServer.get_bus_effect(bus_idx, i)
				effects.append({"index": i, "type": eff.get_class(), "enabled": AudioServer.is_bus_effect_enabled(bus_idx, i)})
			_send_response({"success": true, "action": "list", "bus": bus_name, "effects": effects})
		"add":
			var effect_type: String = params.get("effect_type", "reverb")
			var effect: AudioEffect
			match effect_type:
				"reverb": effect = AudioEffectReverb.new()
				"delay": effect = AudioEffectDelay.new()
				"chorus": effect = AudioEffectChorus.new()
				"eq": effect = AudioEffectEQ6.new()
				"compressor": effect = AudioEffectCompressor.new()
				"limiter": effect = AudioEffectLimiter.new()
				_:
					_send_response({"error": "Unknown effect type: %s" % effect_type})
					return
			AudioServer.add_bus_effect(bus_idx, effect)
			_send_response({"success": true, "action": "add", "effect_type": effect_type, "index": AudioServer.get_bus_effect_count(bus_idx) - 1})
		"remove":
			var idx: int = int(params.get("index", 0))
			AudioServer.remove_bus_effect(bus_idx, idx)
			_send_response({"success": true, "action": "remove", "index": idx})
		"configure":
			var idx: int = int(params.get("index", 0))
			if idx < 0 or idx >= AudioServer.get_bus_effect_count(bus_idx):
				_send_response({"error": "Effect index out of range: %d" % idx})
				return
			var eff: AudioEffect = AudioServer.get_bus_effect(bus_idx, idx)
			var applied: Array = []
			var props: Dictionary = params.get("properties", {})
			for key in props:
				eff.set(key, props[key])
				applied.append(str(key))
			if params.has("enabled"):
				AudioServer.set_bus_effect_enabled(bus_idx, idx, bool(params["enabled"]))
				applied.append("enabled")
			_send_response({"success": true, "action": "configure", "index": idx, "applied": applied})
		_:
			_send_response({"error": "Unknown audio_effect action: %s" % action})


func _cmd_audio_bus_layout(params: Dictionary) -> void:
	var action: String = params.get("action", "list")
	match action:
		"list":
			var buses: Array = []
			for i in AudioServer.bus_count:
				buses.append({"index": i, "name": AudioServer.get_bus_name(i), "volume": AudioServer.get_bus_volume_db(i), "mute": AudioServer.is_bus_mute(i), "solo": AudioServer.is_bus_solo(i), "send": AudioServer.get_bus_send(i), "effect_count": AudioServer.get_bus_effect_count(i)})
			_send_response({"success": true, "action": "list", "buses": buses})
		"add":
			var bus_name: String = params.get("bus_name", "New Bus")
			AudioServer.add_bus()
			var idx: int = AudioServer.bus_count - 1
			AudioServer.set_bus_name(idx, bus_name)
			_send_response({"success": true, "action": "add", "bus_name": bus_name, "index": idx})
		"remove":
			var bus_name: String = params.get("bus_name", "")
			var idx: int = AudioServer.get_bus_index(bus_name)
			if idx <= 0:
				_send_response({"error": "Cannot remove bus: %s" % bus_name})
				return
			AudioServer.remove_bus(idx)
			_send_response({"success": true, "action": "remove", "bus_name": bus_name})
		"set_send":
			var bus_name: String = params.get("bus_name", "")
			var send_to: String = params.get("send_to", "Master")
			var idx: int = AudioServer.get_bus_index(bus_name)
			if idx < 0:
				_send_response({"error": "Bus not found: %s" % bus_name})
				return
			AudioServer.set_bus_send(idx, send_to)
			_send_response({"success": true, "action": "set_send", "bus": bus_name, "send_to": send_to})
		_:
			_send_response({"error": "Unknown audio_bus_layout action: %s" % action})


func _cmd_audio_spatial(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null or not node is AudioStreamPlayer3D:
		_send_response({"error": "AudioStreamPlayer3D not found: %s" % node_path})
		return
	var player: AudioStreamPlayer3D = node as AudioStreamPlayer3D
	var action: String = params.get("action", "get_info")
	if action == "get_info":
		_send_response({"success": true, "max_distance": player.max_distance, "unit_size": player.unit_size, "max_db": player.max_db, "playing": player.playing})
		return
	if params.has("max_distance"):
		player.max_distance = float(params["max_distance"])
	if params.has("unit_size"):
		player.unit_size = float(params["unit_size"])
	if params.has("max_db"):
		player.max_db = float(params["max_db"])
	_send_response({"success": true, "action": "configure"})


# ==========================================================================
# Batch 4: Locale (runtime)
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

func _cmd_render_settings(params: Dictionary) -> void:
	var vp: Viewport = get_viewport()
	var action: String = params.get("action", "get")
	if action == "get":
		_send_response({"success": true, "msaa_2d": vp.msaa_2d, "msaa_3d": vp.msaa_3d, "screen_space_aa": vp.screen_space_aa, "use_taa": vp.use_taa, "scaling_3d_mode": vp.scaling_3d_mode, "scaling_3d_scale": vp.scaling_3d_scale})
		return
	if params.has("msaa_2d"):
		vp.msaa_2d = int(params["msaa_2d"]) as Viewport.MSAA
	if params.has("msaa_3d"):
		vp.msaa_3d = int(params["msaa_3d"]) as Viewport.MSAA
	if params.has("fxaa"):
		vp.screen_space_aa = Viewport.SCREEN_SPACE_AA_FXAA if bool(params["fxaa"]) else Viewport.SCREEN_SPACE_AA_DISABLED
	if params.has("taa"):
		vp.use_taa = bool(params["taa"])
	if params.has("scaling_mode"):
		vp.scaling_3d_mode = int(params["scaling_mode"]) as Viewport.Scaling3DMode
	if params.has("scaling_scale"):
		vp.scaling_3d_scale = float(params["scaling_scale"])
	_send_response({"success": true, "action": "set"})


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


func _cmd_video(params: Dictionary) -> void:
	var action: String = params.get("action", "play")
	if action == "create":
		var parent_path: String = params.get("parent_path", "/root")
		var parent: Node = get_tree().root.get_node_or_null(parent_path)
		if parent == null:
			_send_response({"error": "Parent not found: %s" % parent_path})
			return
		var vp: VideoStreamPlayer = VideoStreamPlayer.new()
		var video_path: String = params.get("video_path", "")
		if not video_path.is_empty():
			if not ResourceLoader.exists(video_path):
				_send_response({"error": "Video resource not found: %s" % video_path})
				return
			var stream: Resource = ResourceLoader.load(video_path)
			if not stream is VideoStream:
				_send_response({"error": "Resource is not a VideoStream: %s" % video_path})
				return
			vp.stream = stream
		if params.has("volume"):
			vp.volume = float(params["volume"])
		if params.has("autoplay"):
			vp.autoplay = bool(params["autoplay"])
		if params.has("loop") and "loop" in vp:
			vp.set("loop", bool(params["loop"]))
		if params.has("name") and not (params["name"] as String).is_empty():
			vp.name = params["name"]
		parent.add_child(vp)
		if vp.autoplay:
			vp.play()
		_send_response({"success": true, "action": "create", "path": str(vp.get_path())})
		return
	var node_path: String = params.get("node_path", "")
	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null or not node is VideoStreamPlayer:
		_send_response({"error": "VideoStreamPlayer not found: %s" % node_path})
		return
	var player: VideoStreamPlayer = node as VideoStreamPlayer
	match action:
		"play":
			player.play()
			_send_response({"success": true, "action": "play"})
		"pause":
			player.paused = true
			_send_response({"success": true, "action": "pause"})
		"resume":
			player.paused = false
			_send_response({"success": true, "action": "resume"})
		"stop":
			player.stop()
			_send_response({"success": true, "action": "stop"})
		"seek":
			player.stream_position = float(params.get("position", 0.0))
			_send_response({"success": true, "action": "seek", "position": player.stream_position})
		"get_status":
			_send_response({"success": true, "action": "get_status", "is_playing": player.is_playing(), "paused": player.paused, "position": player.stream_position, "length": player.get_stream_length()})
		_:
			_send_response({"error": "Unknown video action: %s" % action})


func _cmd_terrain(params: Dictionary) -> void:
	var action: String = params.get("action", "create")
	if action == "create":
		var parent_path: String = params.get("parent_path", "/root")
		var parent: Node = get_tree().root.get_node_or_null(parent_path)
		if parent == null:
			_send_response({"error": "Parent not found: %s" % parent_path})
			return
		var width: int = max(2, int(params.get("width", 16)))
		var depth: int = max(2, int(params.get("depth", 16)))
		var max_height: float = float(params.get("max_height", 1.0))
		var height_data: Array = params.get("height_data", [])
		var heights: Array = []
		for i in range(width * depth):
			var h: float = float(height_data[i]) * max_height if i < height_data.size() else 0.0
			heights.append(h)
		var colors: Array = []
		for i in range(width * depth):
			colors.append(Color.WHITE)
		var mi: MeshInstance3D = MeshInstance3D.new()
		if params.has("name") and not (params["name"] as String).is_empty():
			mi.name = params["name"]
		mi.set_meta("terrain_width", width)
		mi.set_meta("terrain_depth", depth)
		mi.set_meta("terrain_heights", heights)
		mi.set_meta("terrain_colors", colors)
		parent.add_child(mi)
		_terrain_rebuild(mi)
		_send_response({"success": true, "action": "create", "path": str(mi.get_path()), "width": width, "depth": depth})
		return
	var node_path: String = params.get("node_path", "")
	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null or not node is MeshInstance3D or not node.has_meta("terrain_width"):
		_send_response({"error": "Terrain node not found: %s" % node_path})
		return
	var mesh_node: MeshInstance3D = node as MeshInstance3D
	var t_width: int = mesh_node.get_meta("terrain_width")
	var t_depth: int = mesh_node.get_meta("terrain_depth")
	var t_heights: Array = mesh_node.get_meta("terrain_heights")
	var t_colors: Array = mesh_node.get_meta("terrain_colors")
	match action:
		"get_height":
			var gx: int = int(params.get("x", 0))
			var gz: int = int(params.get("z", 0))
			if gx < 0 or gx >= t_width or gz < 0 or gz >= t_depth:
				_send_response({"error": "Coordinate out of bounds"})
				return
			_send_response({"success": true, "action": "get_height", "x": gx, "z": gz, "height": t_heights[gz * t_width + gx]})
		"modify":
			var cx: float = float(params.get("x", 0))
			var cz: float = float(params.get("z", 0))
			var radius: float = float(params.get("radius", 1.0))
			var delta: float = float(params.get("height_delta", 0.0))
			for z in range(t_depth):
				for x in range(t_width):
					var d: float = Vector2(x - cx, z - cz).length()
					if d <= radius:
						var falloff: float = 1.0 - (d / radius) if radius > 0.0 else 1.0
						t_heights[z * t_width + x] += delta * falloff
			mesh_node.set_meta("terrain_heights", t_heights)
			_terrain_rebuild(mesh_node)
			_send_response({"success": true, "action": "modify"})
		"paint":
			var cx: float = float(params.get("x", 0))
			var cz: float = float(params.get("z", 0))
			var radius: float = float(params.get("radius", 1.0))
			var col_d: Dictionary = params.get("color", {"r": 1, "g": 1, "b": 1, "a": 1})
			var col: Color = Color(float(col_d.get("r", 1)), float(col_d.get("g", 1)), float(col_d.get("b", 1)), float(col_d.get("a", 1)))
			for z in range(t_depth):
				for x in range(t_width):
					if Vector2(x - cx, z - cz).length() <= radius:
						t_colors[z * t_width + x] = col
			mesh_node.set_meta("terrain_colors", t_colors)
			_terrain_rebuild(mesh_node)
			_send_response({"success": true, "action": "paint"})
		_:
			_send_response({"error": "Unknown terrain action: %s" % action})


func _terrain_rebuild(mi: MeshInstance3D) -> void:
	var width: int = mi.get_meta("terrain_width")
	var depth: int = mi.get_meta("terrain_depth")
	var heights: Array = mi.get_meta("terrain_heights")
	var colors: Array = mi.get_meta("terrain_colors")
	var st: SurfaceTool = SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)
	for z in range(depth - 1):
		for x in range(width - 1):
			var i00: int = z * width + x
			var i10: int = z * width + (x + 1)
			var i01: int = (z + 1) * width + x
			var i11: int = (z + 1) * width + (x + 1)
			var v00: Vector3 = Vector3(x, heights[i00], z)
			var v10: Vector3 = Vector3(x + 1, heights[i10], z)
			var v01: Vector3 = Vector3(x, heights[i01], z + 1)
			var v11: Vector3 = Vector3(x + 1, heights[i11], z + 1)
			for tri in [[i00, v00], [i10, v10], [i01, v01], [i10, v10], [i11, v11], [i01, v01]]:
				st.set_color(colors[tri[0]])
				st.add_vertex(tri[1])
	st.generate_normals()
	var mat: StandardMaterial3D = StandardMaterial3D.new()
	mat.vertex_color_use_as_albedo = true
	st.set_material(mat)
	mi.mesh = st.commit()


func _exit_tree() -> void:
	_clear_debug_draw()
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
