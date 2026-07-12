extends SceneTree

# Integration tests for mcp_interaction_server.gd over real loopback TCP.
#
# Run via tests/godot/run-integration-tests.sh, which copies the shipped server
# script and its mcp_runtime domain scripts into this fixture and launches:
#   godot --headless --path tests/godot/fixture --script res://test_runner.gd
#
# Covered transport/session behavior: handshake, response-ID correlation,
# malformed and oversized frames, invalid UTF-8, JSON depth/collection limits,
# two concurrent clients and busy rejection, disconnect during an awaited
# command, cooperative cancellation, await_signal timeout, the oversized
# response fallback, and validated-parameter failures with structured error
# details. Also covers the domain split: commands owned by a domain script
# dispatch, await, hold state, and fail through the same registry and session.
# Exit code is 0 only when every check passes.

const PORT: int = 9090
const READ_TIMEOUT_MS: int = 10000

var _server: Node
var _checks: int = 0
var _failures: int = 0


class Client:
	extends RefCounted

	var tree: SceneTree
	var peer: StreamPeerTCP = StreamPeerTCP.new()
	var buffer: PackedByteArray = PackedByteArray()

	func _init(test_tree: SceneTree) -> void:
		tree = test_tree

	func open(port: int, timeout_ms: int = 5000) -> bool:
		if peer.connect_to_host("127.0.0.1", port) != OK:
			return false
		var deadline: int = Time.get_ticks_msec() + timeout_ms
		while Time.get_ticks_msec() < deadline:
			peer.poll()
			var status: int = peer.get_status()
			if status == StreamPeerTCP.STATUS_CONNECTED:
				return true
			if status == StreamPeerTCP.STATUS_ERROR:
				return false
			await tree.process_frame
		return false

	func send_bytes(bytes: PackedByteArray) -> void:
		peer.poll()
		peer.put_data(bytes)

	func send_text(text: String) -> void:
		send_bytes(text.to_utf8_buffer())

	func send_request(id: Variant, method: String, params: Dictionary = {}) -> void:
		send_text(JSON.stringify({"jsonrpc": "2.0", "id": id, "method": method, "params": params}) + "\n")

	func _drain_socket() -> void:
		peer.poll()
		var status: int = peer.get_status()
		if status != StreamPeerTCP.STATUS_CONNECTED and status != StreamPeerTCP.STATUS_CONNECTING:
			return
		var available: int = peer.get_available_bytes()
		if available > 0:
			var data: Array = peer.get_data(available)
			if data[0] == OK:
				buffer.append_array(data[1])

	# Returns the next newline-delimited JSON message, or null on timeout.
	func read_message(timeout_ms: int = READ_TIMEOUT_MS) -> Variant:
		var deadline: int = Time.get_ticks_msec() + timeout_ms
		while true:
			var newline_pos: int = buffer.find(10)
			if newline_pos >= 0:
				var line: String = buffer.slice(0, newline_pos).get_string_from_utf8().strip_edges()
				buffer = buffer.slice(newline_pos + 1)
				if line.is_empty():
					continue
				return JSON.parse_string(line)
			if Time.get_ticks_msec() >= deadline:
				return null
			_drain_socket()
			if buffer.find(10) >= 0:
				continue
			await tree.process_frame
		return null

	func has_pending_data() -> bool:
		_drain_socket()
		return buffer.size() > 0

	# True once the server has closed this connection.
	func wait_until_closed(timeout_ms: int = 5000) -> bool:
		var deadline: int = Time.get_ticks_msec() + timeout_ms
		while Time.get_ticks_msec() < deadline:
			_drain_socket()
			var status: int = peer.get_status()
			if status != StreamPeerTCP.STATUS_CONNECTED and status != StreamPeerTCP.STATUS_CONNECTING:
				return true
			await tree.process_frame
		return false

	func close() -> void:
		peer.disconnect_from_host()


func _initialize() -> void:
	_run()


func _run() -> void:
	var server_script: GDScript = load("res://mcp_interaction_server.gd")
	_server = server_script.new()
	_server.name = "McpServer"
	root.add_child(_server)
	await process_frame
	await process_frame

	await _test_handshake_and_id_correlation()
	await _test_transport_errors()
	await _test_limit_rejections()
	await _test_busy_and_two_clients()
	await _test_disconnect_discards_response()
	await _test_cancellation()
	await _test_await_signal_timeout()
	await _test_oversized_response()
	await _test_visual_shader()
	await _test_parameter_validation()
	await _test_input_domain()
	await _test_ui_domain()
	await _test_scene_2d_domain()

	print("godot-runtime-integration: %d checks, %d failures" % [_checks, _failures])
	quit(1 if _failures > 0 else 0)


func _check(name: String, condition: bool, context: Variant = null) -> void:
	_checks += 1
	if condition:
		print("PASS %s" % name)
	else:
		_failures += 1
		printerr("FAIL %s%s" % [name, "" if context == null else " -- got: %s" % str(context)])


func _open_client(name: String) -> Client:
	var client: Client = Client.new(self)
	_check("%s: client connects" % name, await client.open(PORT))
	return client


func _error_code(message: Variant) -> int:
	if message is Dictionary and message.get("error") is Dictionary:
		return int((message["error"] as Dictionary).get("code", 0))
	return 0


func _message_id(message: Variant) -> Variant:
	if message is Dictionary:
		return message.get("id")
	return null


func _error_data(message: Variant) -> Dictionary:
	if message is Dictionary and message.get("error") is Dictionary and (message["error"] as Dictionary).get("data") is Dictionary:
		return (message["error"] as Dictionary)["data"]
	return {}


func _result_of(message: Variant) -> Dictionary:
	if message is Dictionary and message.get("result") is Dictionary:
		return message["result"]
	return {}


func _wait_for_active_request(timeout_ms: int = 5000) -> bool:
	var deadline: int = Time.get_ticks_msec() + timeout_ms
	while Time.get_ticks_msec() < deadline:
		if _server.get("_active_session") != null:
			return true
		await process_frame
	return false


func _wait_for_idle_server(timeout_ms: int = READ_TIMEOUT_MS) -> bool:
	var deadline: int = Time.get_ticks_msec() + timeout_ms
	while Time.get_ticks_msec() < deadline:
		if _server.get("_active_session") == null:
			return true
		await process_frame
	return false


# --- Handshake, method routing, and response-ID correlation ---
func _test_handshake_and_id_correlation() -> void:
	var client: Client = await _open_client("handshake")

	client.send_request("hs-1", "godot.runtime.handshake", {"protocolVersion": "1.0"})
	var message: Variant = await client.read_message()
	_check("handshake: response correlates to request id", _message_id(message) == "hs-1", message)
	var result: Dictionary = _result_of(message)
	_check("handshake: reports protocol and capabilities",
		result.get("protocolVersion") == "1.0" and (result.get("capabilities") as Array).has("runtime-commands"), message)

	client.send_request("hs-2", "godot.runtime.handshake", {"protocolVersion": "999"})
	message = await client.read_message()
	_check("handshake: unsupported version rejected with -32002",
		_error_code(message) == -32002 and _message_id(message) == "hs-2", message)

	client.send_request(42, "godot.runtime.wait", {"frames": 2})
	message = await client.read_message()
	_check("wait: numeric request id echoed back", _message_id(message) == 42, message)
	_check("wait: render frames complete", _result_of(message).get("waited_frames") == 2, message)

	client.send_request("w-phys", "godot.runtime.wait", {"frames": 2, "frame_type": "physics"})
	message = await client.read_message()
	_check("wait: physics frames complete",
		_message_id(message) == "w-phys" and _result_of(message).get("frame_type") == "physics", message)

	client.send_text("\n   \n")
	client.send_request("w-blank", "godot.runtime.wait", {"frames": 1})
	message = await client.read_message()
	_check("framing: blank lines are ignored", _message_id(message) == "w-blank", message)

	client.send_request("unk-1", "bogus.method", {})
	message = await client.read_message()
	_check("routing: non-runtime method rejected with -32601",
		_error_code(message) == -32601 and _message_id(message) == "unk-1", message)

	client.send_request("unk-2", "godot.runtime.not_a_real_command", {})
	message = await client.read_message()
	_check("routing: unregistered runtime command rejected with -32601",
		_error_code(message) == -32601 and _message_id(message) == "unk-2", message)

	client.send_request("after-unk", "godot.runtime.wait", {"frames": 1})
	message = await client.read_message()
	_check("routing: unknown command does not occupy the server",
		_message_id(message) == "after-unk", message)

	client.close()


# --- Malformed frames ---
func _test_transport_errors() -> void:
	var client: Client = await _open_client("transport")

	client.send_text("this is not json\n")
	var message: Variant = await client.read_message()
	_check("transport: invalid JSON produces -32700 with null id",
		_error_code(message) == -32700 and _message_id(message) == null, message)

	client.send_text("[1,2,3]\n")
	message = await client.read_message()
	_check("transport: non-object payload produces -32600", _error_code(message) == -32600, message)

	client.send_text("{\"jsonrpc\":\"2.0\"}\n")
	message = await client.read_message()
	_check("transport: missing id/method produces -32600", _error_code(message) == -32600, message)

	client.send_request("after-errors", "godot.runtime.wait", {"frames": 1})
	message = await client.read_message()
	_check("transport: session survives protocol errors", _message_id(message) == "after-errors", message)

	var invalid_utf8: PackedByteArray = PackedByteArray([0xff, 0xfe, 0xfd, 10])
	client.send_bytes(invalid_utf8)
	message = await client.read_message()
	_check("transport: invalid UTF-8 rejected with -32006", _error_code(message) == -32006, message)
	_check("transport: invalid UTF-8 closes only that session", await client.wait_until_closed())

	var other: Client = await _open_client("transport-second")
	other.send_request("still-alive", "godot.runtime.wait", {"frames": 1})
	message = await other.read_message()
	_check("transport: new sessions unaffected after a rejected one",
		_message_id(message) == "still-alive", message)
	other.close()


# --- Configurable transport limits ---
func _test_limit_rejections() -> void:
	var original_line_limit: int = _server.max_request_line_bytes
	_server.max_request_line_bytes = 512
	var client: Client = await _open_client("limit-line")
	client.send_text("a".repeat(2048) + "\n")
	var message: Variant = await client.read_message()
	_check("limits: oversized frame rejected with -32006", _error_code(message) == -32006, message)
	_check("limits: oversized frame closes the session", await client.wait_until_closed())
	_server.max_request_line_bytes = original_line_limit

	var original_buffer_limit: int = _server.max_receive_buffer_bytes
	_server.max_receive_buffer_bytes = 1024
	client = await _open_client("limit-buffer")
	client.send_text("b".repeat(4096))
	message = await client.read_message()
	_check("limits: oversized partial frame rejected with -32006", _error_code(message) == -32006, message)
	_check("limits: oversized partial frame closes the session", await client.wait_until_closed())
	_server.max_receive_buffer_bytes = original_buffer_limit

	var original_depth_limit: int = _server.max_json_nesting_depth
	_server.max_json_nesting_depth = 4
	client = await _open_client("limit-depth")
	var nested: String = "[".repeat(10) + "1" + "]".repeat(10)
	client.send_text('{"jsonrpc":"2.0","id":"depth-1","method":"godot.runtime.wait","params":{"nested":%s}}\n' % nested)
	message = await client.read_message()
	_check("limits: JSON nesting depth rejected with -32006", _error_code(message) == -32006, message)
	_check("limits: JSON nesting depth closes the session", await client.wait_until_closed())
	_server.max_json_nesting_depth = original_depth_limit

	var original_items_limit: int = _server.max_json_collection_items
	_server.max_json_collection_items = 8
	client = await _open_client("limit-items")
	var items: Array = []
	for i: int in 20:
		items.append(i)
	client.send_request("items-1", "godot.runtime.wait", {"items": items})
	message = await client.read_message()
	_check("limits: JSON collection size rejected with -32006", _error_code(message) == -32006, message)
	_check("limits: JSON collection size closes the session", await client.wait_until_closed())
	_server.max_json_collection_items = original_items_limit

	client = await _open_client("limit-restored")
	client.send_request("limits-restored", "godot.runtime.wait", {"frames": 1})
	message = await client.read_message()
	_check("limits: server serves normal requests after limit rejections",
		_message_id(message) == "limits-restored", message)
	client.close()


# --- Two clients: busy rejection and correlation ---
func _test_busy_and_two_clients() -> void:
	var first: Client = await _open_client("busy-first")
	var second: Client = await _open_client("busy-second")

	first.send_request("busy-a", "godot.runtime.wait", {"frames": 60})
	_check("busy: first request becomes active", await _wait_for_active_request())

	second.send_request("busy-b", "godot.runtime.wait", {"frames": 1})
	var message: Variant = await second.read_message()
	_check("busy: concurrent request rejected with -32001",
		_error_code(message) == -32001 and _message_id(message) == "busy-b", message)

	message = await first.read_message()
	_check("busy: original request still completes with its own id",
		_message_id(message) == "busy-a" and _result_of(message).get("waited_frames") == 60, message)

	second.send_request("busy-after", "godot.runtime.wait", {"frames": 1})
	message = await second.read_message()
	_check("busy: server accepts new work once idle", _message_id(message) == "busy-after", message)

	first.close()
	second.close()


# --- Disconnect during an awaited command ---
func _test_disconnect_discards_response() -> void:
	var first: Client = await _open_client("disconnect-first")
	first.send_request("orphan-1", "godot.runtime.wait", {"frames": 60})
	_check("disconnect: awaited request becomes active", await _wait_for_active_request())
	first.close()

	var second: Client = await _open_client("disconnect-second")
	second.send_request("hs-r", "godot.runtime.handshake", {"protocolVersion": "1.0"})
	var message: Variant = await second.read_message()
	_check("disconnect: reconnected client can handshake while orphan runs",
		_message_id(message) == "hs-r", message)

	_check("disconnect: orphaned request finishes and frees the server", await _wait_for_idle_server())
	await process_frame
	await process_frame
	_check("disconnect: orphaned response is discarded, not delivered to new session",
		not second.has_pending_data())

	second.send_request("after-orphan", "godot.runtime.wait", {"frames": 1})
	message = await second.read_message()
	_check("disconnect: new session gets its own correlated response",
		_message_id(message) == "after-orphan" and _result_of(message).get("success") == true, message)
	second.close()


# --- Cooperative cancellation ---
func _test_cancellation() -> void:
	var owner_client: Client = await _open_client("cancel-owner")
	var intruder: Client = await _open_client("cancel-intruder")

	owner_client.send_request("c-wait", "godot.runtime.wait", {"frames": 100000})
	_check("cancel: long wait becomes active", await _wait_for_active_request())

	intruder.send_request("c-foreign", "godot.runtime.cancel", {"request_id": "c-wait"})
	var message: Variant = await intruder.read_message()
	_check("cancel: another session cannot cancel the request",
		_error_code(message) == -32004 and _message_id(message) == "c-foreign", message)

	owner_client.send_request("c-cancel", "godot.runtime.cancel", {"request_id": "c-wait"})
	var by_id: Dictionary = {}
	for i: int in 2:
		message = await owner_client.read_message()
		if message is Dictionary:
			by_id[_message_id(message)] = message
	_check("cancel: owner receives the cancel acknowledgement",
		_result_of(by_id.get("c-cancel")).get("cancelled") == true, by_id.get("c-cancel"))
	_check("cancel: original request resolves with -32003",
		_error_code(by_id.get("c-wait")) == -32003, by_id.get("c-wait"))

	owner_client.send_request("c-none", "godot.runtime.cancel", {"request_id": "nothing-running"})
	message = await owner_client.read_message()
	_check("cancel: cancelling an idle server yields -32004", _error_code(message) == -32004, message)

	owner_client.send_request("c-missing", "godot.runtime.cancel", {})
	message = await owner_client.read_message()
	_check("cancel: missing request_id yields -32602", _error_code(message) == -32602, message)

	owner_client.close()
	intruder.close()


# --- Timeout ---
func _test_await_signal_timeout() -> void:
	var client: Client = await _open_client("timeout")
	client.send_request("t-1", "godot.runtime.await_signal",
		{"node_path": "McpServer", "signal_name": "tree_exiting", "timeout": 0.3})
	var message: Variant = await client.read_message()
	_check("timeout: await_signal times out with -32004",
		_error_code(message) == -32004 and _message_id(message) == "t-1", message)

	client.send_request("t-2", "godot.runtime.wait", {"frames": 1})
	message = await client.read_message()
	_check("timeout: server serves new work after a timeout", _message_id(message) == "t-2", message)
	client.close()


# --- Oversized response fallback ---
func _test_oversized_response() -> void:
	var fillers: Array[Node] = []
	for i: int in 20:
		var filler: Node = Node.new()
		filler.name = "OversizeFiller%d" % i
		root.add_child(filler)
		fillers.append(filler)

	var original_response_limit: int = _server.max_response_bytes
	_server.max_response_bytes = 200
	var client: Client = await _open_client("oversize")
	client.send_request("big-1", "godot.runtime.get_scene_tree", {})
	var message: Variant = await client.read_message()
	_check("response limit: oversized result replaced by -32006 error",
		_error_code(message) == -32006 and _message_id(message) == "big-1", message)
	_server.max_response_bytes = original_response_limit

	client.send_request("big-2", "godot.runtime.wait", {"frames": 1})
	message = await client.read_message()
	_check("response limit: session stays usable after the fallback",
		_message_id(message) == "big-2", message)
	client.close()

	for filler: Node in fillers:
		filler.queue_free()


# --- Visual shader graph commands ---
func _test_visual_shader() -> void:
	var client: Client = await _open_client("visual-shader")

	client.send_request("vs-1", "godot.runtime.visual_shader", {"action": "create", "shader_type": "spatial"})
	var message: Variant = await client.read_message()
	var shader_id: int = int(_result_of(message).get("shader_id", -1))
	_check("visual_shader: create returns a shader id", shader_id >= 1, message)

	client.send_request("vs-2", "godot.runtime.visual_shader",
		{"action": "add_node", "node_class": "VisualShaderNodeFloatConstant", "position": {"x": 100, "y": 200}})
	message = await client.read_message()
	var from_node: int = int(_result_of(message).get("node_id", -1))
	_check("visual_shader: add_node returns a node id", from_node >= 0, message)

	client.send_request("vs-3", "godot.runtime.visual_shader",
		{"action": "add_node", "node_class": "VisualShaderNodeFloatOp"})
	message = await client.read_message()
	var to_node: int = int(_result_of(message).get("node_id", -1))

	client.send_request("vs-4", "godot.runtime.visual_shader",
		{"action": "connect", "from_node": from_node, "from_port": 0, "to_node": to_node, "to_port": 0})
	message = await client.read_message()
	_check("visual_shader: connect links compatible ports", _result_of(message).get("success") == true, message)

	client.send_request("vs-5", "godot.runtime.visual_shader", {"action": "get_nodes"})
	message = await client.read_message()
	var nodes: Array = _result_of(message).get("nodes", [])
	_check("visual_shader: get_nodes lists output and added nodes", nodes.size() >= 3, message)

	var target: Node = MeshInstance3D.new()
	target.name = "VisualShaderTarget"
	root.add_child(target)
	client.send_request("vs-6", "godot.runtime.visual_shader",
		{"action": "apply", "node_path": "/root/VisualShaderTarget"})
	message = await client.read_message()
	_check("visual_shader: apply assigns a ShaderMaterial",
		_result_of(message).get("success") == true and target.material_override is ShaderMaterial, message)
	target.queue_free()

	client.send_request("vs-7", "godot.runtime.visual_shader", {"action": "add_node", "node_class": "Node"})
	message = await client.read_message()
	_check("visual_shader: non-VisualShaderNode class rejected", _error_code(message) == -32000, message)

	client.send_request("vs-8", "godot.runtime.visual_shader", {"action": "explode"})
	message = await client.read_message()
	_check("visual_shader: unknown action rejected", _error_code(message) == -32000, message)
	client.close()


# --- Validated parameter helpers and standardized command failures ---
func _test_parameter_validation() -> void:
	var client: Client = await _open_client("params")

	client.send_request("p-missing", "godot.runtime.click", {"y": 10})
	var message: Variant = await client.read_message()
	_check("params: missing required field yields -32000 with structured details",
		_error_code(message) == -32000 and _error_data(message).get("param") == "x"
		and _error_data(message).get("reason") == "missing", message)

	client.send_request("p-type", "godot.runtime.click", {"x": "left", "y": 10})
	message = await client.read_message()
	_check("params: invalid parameter type yields reason invalid_type",
		_error_code(message) == -32000 and _error_data(message).get("param") == "x"
		and _error_data(message).get("reason") == "invalid_type", message)

	client.send_request("p-enum", "godot.runtime.touch", {"action": "hover", "x": 1, "y": 1})
	message = await client.read_message()
	_check("params: unknown enum action lists allowed values",
		_error_code(message) == -32000 and _error_data(message).get("reason") == "invalid_value"
		and (_error_data(message).get("allowed") as Array).has("drag"), message)

	client.send_request("p-range", "godot.runtime.scroll", {"x": 0, "y": 0, "amount": 0})
	message = await client.read_message()
	_check("params: out-of-range value yields reason out_of_range",
		_error_code(message) == -32000 and _error_data(message).get("reason") == "out_of_range", message)

	client.send_request("p-key-or-action", "godot.runtime.key_press", {})
	message = await client.read_message()
	_check("params: key_press requires key or action",
		_error_code(message) == -32000 and _error_data(message).get("reason") == "missing", message)

	client.send_request("p-bad-key", "godot.runtime.key_press", {"key": "NOTAKEY"})
	message = await client.read_message()
	_check("params: unknown key name yields reason invalid_value",
		_error_code(message) == -32000 and _error_data(message).get("reason") == "invalid_value", message)

	client.send_request("p-no-node", "godot.runtime.get_property",
		{"node_path": "/root/NoSuchNode", "property": "name"})
	message = await client.read_message()
	_check("params: missing node yields reason node_not_found",
		_error_code(message) == -32000 and _error_data(message).get("reason") == "node_not_found", message)

	client.send_request("p-node-ok", "godot.runtime.get_property",
		{"node_path": "McpServer", "property": "name"})
	message = await client.read_message()
	_check("params: validated node lookup still resolves existing nodes",
		_result_of(message).get("value") == "McpServer", message)

	client.send_request("p-res-path", "godot.runtime.instantiate_scene", {"scene_path": "nope.tscn"})
	message = await client.read_message()
	_check("params: non-resource path rejected before any work",
		_error_code(message) == -32000 and _error_data(message).get("param") == "scene_path"
		and _error_data(message).get("reason") == "invalid_value", message)

	client.send_request("p-godot-err", "godot.runtime.change_scene", {"scene_path": "res://missing.tscn"})
	message = await client.read_message()
	_check("params: Godot Error values are reported with error_string details",
		_error_code(message) == -32000 and _error_data(message).get("reason") == "godot_error"
		and _error_data(message).has("godot_error_string"), message)

	client.send_request("p-after", "godot.runtime.wait", {"frames": 1})
	message = await client.read_message()
	_check("params: server serves normal requests after validation failures",
		_message_id(message) == "p-after" and _result_of(message).get("success") == true, message)
	client.close()


# --- Input domain ---
# The input commands live in res://mcp_runtime/input_domain.gd rather than on the
# server. These checks assert the behavior survived the move: the domain is
# reachable through the same registry, its awaited handlers still resume and
# respond on the requesting session, and the held-key state it now owns is
# observable across separate requests.
func _test_input_domain() -> void:
	var client: Client = await _open_client("input")

	_check("input domain: server attaches the domain node as a child",
		_server.get_node_or_null("input_domain") != null, _server.get_children())

	client.send_request("in-click", "godot.runtime.click", {"x": 12, "y": 34})
	var message: Variant = await client.read_message()
	_check("input domain: awaited click responds on the requesting session",
		_message_id(message) == "in-click" and _result_of(message).get("success") == true
		and (_result_of(message).get("clicked") as Dictionary).get("x") == 12, message)

	client.send_request("in-add", "godot.runtime.input_action",
		{"action": "add_action", "action_name": "mcp_test_action"})
	message = await client.read_message()
	_check("input domain: add_action registers a Godot input action",
		_result_of(message).get("success") == true and InputMap.has_action("mcp_test_action"), message)

	client.send_request("in-list", "godot.runtime.input_action", {"action": "list"})
	message = await client.read_message()
	_check("input domain: list reports the registered action",
		(_result_of(message).get("actions") as Array).has("mcp_test_action"), message)

	# Held state lives in the domain now; it must persist between requests.
	client.send_request("in-hold", "godot.runtime.key_hold", {"action": "mcp_test_action"})
	message = await client.read_message()
	_check("input domain: key_hold keeps the action pressed after responding",
		_result_of(message).get("held") == "mcp_test_action"
		and Input.is_action_pressed("mcp_test_action"), message)

	client.send_request("in-release", "godot.runtime.key_release", {"action": "mcp_test_action"})
	message = await client.read_message()
	_check("input domain: key_release clears the held action",
		_result_of(message).get("released") == "mcp_test_action"
		and not Input.is_action_pressed("mcp_test_action"), message)

	client.send_request("in-remove", "godot.runtime.input_action",
		{"action": "remove_action", "action_name": "mcp_test_action"})
	message = await client.read_message()
	_check("input domain: remove_action erases the input action",
		_result_of(message).get("success") == true and not InputMap.has_action("mcp_test_action"), message)

	# A multi-frame awaited handler inside a domain must still produce exactly one
	# response, correlated to its own request.
	client.send_request("in-drag", "godot.runtime.mouse_drag",
		{"from_x": 0, "from_y": 0, "to_x": 40, "to_y": 20, "steps": 3})
	message = await client.read_message()
	_check("input domain: multi-frame mouse_drag responds once with its own id",
		_message_id(message) == "in-drag" and _result_of(message).get("steps") == 3
		and (_result_of(message).get("to") as Dictionary).get("x") == 40, message)

	client.send_request("in-state", "godot.runtime.input_state", {"action": "query"})
	message = await client.read_message()
	_check("input domain: input_state query reports mouse position",
		_result_of(message).get("success") == true
		and (_result_of(message).get("mouse_position") as Dictionary).has("x"), message)

	client.send_request("in-bad", "godot.runtime.touch", {"action": "hover"})
	message = await client.read_message()
	_check("input domain: domain handlers still fail with standardized -32000 errors",
		_error_code(message) == -32000 and _error_data(message).get("reason") == "invalid_value", message)

	client.send_request("in-after", "godot.runtime.wait", {"frames": 1})
	message = await client.read_message()
	_check("input domain: server keeps serving after domain commands",
		_message_id(message) == "in-after" and _result_of(message).get("success") == true, message)
	client.close()

# --- UI domain ---
# The ui_* commands live in res://mcp_runtime/ui_domain.gd rather than on the
# server. These checks assert the behavior survived the move: handlers mutate
# and read real Control nodes through the same registry and session, and
# invalid parameters still fail with the standardized -32000 structured errors.
func _test_ui_domain() -> void:
	var fixture: Node = Node.new()
	fixture.name = "UiFixture"
	var line_edit: LineEdit = LineEdit.new()
	line_edit.name = "Line"
	fixture.add_child(line_edit)
	var item_list: ItemList = ItemList.new()
	item_list.name = "Items"
	fixture.add_child(item_list)
	var slider: HSlider = HSlider.new()
	slider.name = "Slider"
	fixture.add_child(slider)
	root.add_child(fixture)
	await process_frame

	var client: Client = await _open_client("ui")

	_check("ui domain: server attaches the domain node as a child",
		_server.get_node_or_null("ui_domain") != null, _server.get_children())

	client.send_request("ui-set", "godot.runtime.ui_text",
		{"node_path": "UiFixture/Line", "action": "set", "text": "hello"})
	var message: Variant = await client.read_message()
	_check("ui domain: ui_text set writes the LineEdit text",
		_result_of(message).get("success") == true and line_edit.text == "hello", message)

	client.send_request("ui-get", "godot.runtime.ui_text", {"node_path": "UiFixture/Line"})
	message = await client.read_message()
	_check("ui domain: ui_text get reads the text back on its own request id",
		_message_id(message) == "ui-get" and _result_of(message).get("text") == "hello", message)

	client.send_request("ui-add", "godot.runtime.ui_item_list",
		{"node_path": "UiFixture/Items", "action": "add", "text": "first"})
	message = await client.read_message()
	_check("ui domain: ui_item_list add appends an item",
		_result_of(message).get("success") == true and item_list.item_count == 1, message)

	client.send_request("ui-sel", "godot.runtime.ui_item_list",
		{"node_path": "UiFixture/Items", "action": "select", "index": 0})
	message = await client.read_message()
	client.send_request("ui-items", "godot.runtime.ui_item_list", {"node_path": "UiFixture/Items"})
	message = await client.read_message()
	var items: Array = _result_of(message).get("items", [])
	_check("ui domain: ui_item_list get_items reports the selected item",
		items.size() == 1 and (items[0] as Dictionary).get("text") == "first"
		and (items[0] as Dictionary).get("selected") == true, message)

	client.send_request("ui-conf", "godot.runtime.ui_control",
		{"node_path": "UiFixture/Line", "action": "configure", "tooltip": "tip", "min_size": {"x": 120, "y": 30}})
	message = await client.read_message()
	_check("ui domain: ui_control configure applies tooltip and min_size",
		(_result_of(message).get("applied") as Array).has("tooltip")
		and line_edit.custom_minimum_size == Vector2(120, 30), message)

	client.send_request("ui-info", "godot.runtime.ui_control", {"node_path": "UiFixture/Line", "action": "get_info"})
	message = await client.read_message()
	_check("ui domain: ui_control get_info serializes size through the codec",
		_result_of(message).get("tooltip") == "tip" and _result_of(message).get("size") is Dictionary, message)

	client.send_request("ui-range", "godot.runtime.ui_range",
		{"node_path": "UiFixture/Slider", "action": "set", "min_value": 0.0, "max_value": 10.0, "value": 4.0})
	message = await client.read_message()
	_check("ui domain: ui_range set drives the Range value",
		_result_of(message).get("value") == 4.0 and slider.value == 4.0, message)

	client.send_request("ui-theme", "godot.runtime.ui_theme",
		{"node_path": "UiFixture/Line", "overrides": {"colors": {"font_color": {"r": 1, "g": 0, "b": 0, "a": 1}}}})
	message = await client.read_message()
	_check("ui domain: ui_theme applies a color override",
		(_result_of(message).get("applied") as Array).has("color:font_color")
		and line_edit.has_theme_color_override("font_color"), message)

	client.send_request("ui-missing", "godot.runtime.ui_text", {})
	message = await client.read_message()
	_check("ui domain: missing node_path fails with a structured -32000 error",
		_error_code(message) == -32000 and _error_data(message).get("reason") == "missing", message)

	client.send_request("ui-class", "godot.runtime.ui_menu", {"node_path": "UiFixture/Line"})
	message = await client.read_message()
	_check("ui domain: wrong node class fails with invalid_value details",
		_error_code(message) == -32000 and _error_data(message).get("reason") == "invalid_value", message)

	client.send_request("ui-action", "godot.runtime.ui_text",
		{"node_path": "UiFixture/Line", "action": "explode"})
	message = await client.read_message()
	_check("ui domain: unknown action fails with the allowed action list",
		_error_code(message) == -32000 and (_error_data(message).get("allowed") as Array).has("set"), message)

	client.send_request("ui-after", "godot.runtime.wait", {"frames": 1})
	message = await client.read_message()
	_check("ui domain: server keeps serving after domain commands",
		_message_id(message) == "ui-after" and _result_of(message).get("success") == true, message)

	client.close()
	fixture.queue_free()
	await process_frame


# --- 2D domain ---
# The 2D commands live in res://mcp_runtime/scene_2d_domain.gd rather than on
# the server. These checks assert the behavior survived the move: handlers
# create and mutate real 2D nodes through the same registry and session, the
# canvas-draw node and command list the domain now owns persist across
# requests, and invalid parameters still fail with standardized -32000 errors.
func _test_scene_2d_domain() -> void:
	var fixture: Node = Node.new()
	fixture.name = "Scene2DFixture"
	var line: Line2D = Line2D.new()
	line.name = "Line"
	fixture.add_child(line)
	var tilemap: TileMapLayer = TileMapLayer.new()
	tilemap.name = "Tiles"
	fixture.add_child(tilemap)
	root.add_child(fixture)
	await process_frame

	var client: Client = await _open_client("2d")

	_check("2d domain: server attaches the domain node as a child",
		_server.get_node_or_null("scene_2d_domain") != null, _server.get_children())

	client.send_request("2d-layer", "godot.runtime.canvas",
		{"action": "create_layer", "parent_path": "Scene2DFixture", "layer": 3, "name": "McpLayer"})
	var message: Variant = await client.read_message()
	var layer_node: CanvasLayer = fixture.get_node_or_null("McpLayer") as CanvasLayer
	_check("2d domain: canvas create_layer adds a CanvasLayer with its own id",
		_message_id(message) == "2d-layer" and layer_node != null and layer_node.layer == 3, message)

	client.send_request("2d-conf", "godot.runtime.canvas",
		{"action": "configure", "node_path": "Scene2DFixture/McpLayer", "layer": 7, "visible": false})
	message = await client.read_message()
	_check("2d domain: canvas configure applies layer and visibility",
		(_result_of(message).get("applied") as Array).has("layer")
		and layer_node.layer == 7 and layer_node.visible == false, message)

	client.send_request("2d-draw", "godot.runtime.canvas_draw",
		{"action": "line", "parent_path": "Scene2DFixture", "from": {"x": 0, "y": 0}, "to": {"x": 10, "y": 10}})
	message = await client.read_message()
	var draw_node: Node = fixture.get_node_or_null("_McpCanvasDraw")
	_check("2d domain: canvas_draw creates the draw node it owns",
		_result_of(message).get("success") == true and draw_node != null, message)

	client.send_request("2d-draw2", "godot.runtime.canvas_draw",
		{"action": "circle", "center": {"x": 5, "y": 5}, "radius": 4})
	message = await client.read_message()
	_check("2d domain: draw commands accumulate on the domain-owned node",
		(draw_node.get("draw_commands") as Array).size() == 2, message)

	client.send_request("2d-clear", "godot.runtime.canvas_draw", {"action": "clear"})
	message = await client.read_message()
	_check("2d domain: canvas_draw clear empties the command list",
		_result_of(message).get("success") == true
		and (draw_node.get("draw_commands") as Array).is_empty(), message)

	client.send_request("2d-light", "godot.runtime.light_2d",
		{"action": "create_point", "parent_path": "Scene2DFixture", "energy": 2.0, "name": "McpLight"})
	message = await client.read_message()
	var light: PointLight2D = fixture.get_node_or_null("McpLight") as PointLight2D
	_check("2d domain: light_2d create_point adds a configured PointLight2D",
		light != null and light.energy == 2.0 and light.texture != null, message)

	client.send_request("2d-bg", "godot.runtime.parallax",
		{"action": "create_background", "parent_path": "Scene2DFixture", "name": "McpParallax"})
	message = await client.read_message()
	client.send_request("2d-pl", "godot.runtime.parallax",
		{"action": "add_layer", "parent_path": "Scene2DFixture/McpParallax", "motion_scale": {"x": 0.5, "y": 0.25}})
	message = await client.read_message()
	var parallax_layer: ParallaxLayer = null
	var background: Node = fixture.get_node_or_null("McpParallax")
	if background != null and background.get_child_count() > 0:
		parallax_layer = background.get_child(0) as ParallaxLayer
	_check("2d domain: parallax add_layer attaches a layer with motion_scale",
		parallax_layer != null and parallax_layer.motion_scale == Vector2(0.5, 0.25), message)

	client.send_request("2d-pts", "godot.runtime.shape_2d",
		{"node_path": "Scene2DFixture/Line", "action": "set_points",
			"points": [{"x": 0, "y": 0}, {"x": 10, "y": 0}, {"x": 10, "y": 10}]})
	message = await client.read_message()
	_check("2d domain: shape_2d set_points writes the Line2D points",
		_result_of(message).get("count") == 3 and line.points.size() == 3, message)

	client.send_request("2d-get", "godot.runtime.shape_2d",
		{"node_path": "Scene2DFixture/Line", "action": "get_points"})
	message = await client.read_message()
	var points: Array = _result_of(message).get("points", [])
	_check("2d domain: shape_2d get_points reads them back on its own request id",
		_message_id(message) == "2d-get" and points.size() == 3
		and (points[1] as Dictionary).get("x") == 10.0, message)

	client.send_request("2d-path", "godot.runtime.path_2d",
		{"action": "create", "parent_path": "Scene2DFixture", "name": "McpPath",
			"points": [{"x": 0, "y": 0}, {"x": 20, "y": 20}]})
	message = await client.read_message()
	client.send_request("2d-path-add", "godot.runtime.path_2d",
		{"action": "add_point", "node_path": "Scene2DFixture/McpPath", "point": {"x": 40, "y": 0}})
	message = await client.read_message()
	_check("2d domain: path_2d create and add_point build the curve",
		_result_of(message).get("point_count") == 3, message)

	client.send_request("2d-cell", "godot.runtime.tilemap",
		{"node_path": "Scene2DFixture/Tiles", "action": "get_cell", "x": 1, "y": 1})
	message = await client.read_message()
	_check("2d domain: tilemap get_cell reports an empty cell",
		_result_of(message).get("source_id") == -1, message)

	client.send_request("2d-used", "godot.runtime.tilemap",
		{"node_path": "Scene2DFixture/Tiles", "action": "get_used_cells"})
	message = await client.read_message()
	_check("2d domain: tilemap get_used_cells returns an empty list",
		_result_of(message).get("count") == 0, message)

	client.send_request("2d-class", "godot.runtime.tilemap",
		{"node_path": "Scene2DFixture/Line", "action": "get_cell"})
	message = await client.read_message()
	_check("2d domain: wrong node class fails with invalid_value details",
		_error_code(message) == -32000 and _error_data(message).get("reason") == "invalid_value", message)

	client.send_request("2d-action", "godot.runtime.canvas", {"action": "explode"})
	message = await client.read_message()
	_check("2d domain: unknown action fails with the allowed action list",
		_error_code(message) == -32000
		and (_error_data(message).get("allowed") as Array).has("create_layer"), message)

	client.send_request("2d-missing", "godot.runtime.shape_2d", {"action": "get_points"})
	message = await client.read_message()
	_check("2d domain: missing node_path fails with a structured -32000 error",
		_error_code(message) == -32000 and _error_data(message).get("reason") == "missing", message)

	client.send_request("2d-no-parent", "godot.runtime.parallax",
		{"action": "add_layer", "parent_path": "/root/NoSuchParallax"})
	message = await client.read_message()
	_check("2d domain: missing parent fails with node_not_found details",
		_error_code(message) == -32000 and _error_data(message).get("reason") == "node_not_found", message)

	client.send_request("2d-after", "godot.runtime.wait", {"frames": 1})
	message = await client.read_message()
	_check("2d domain: server keeps serving after domain commands",
		_message_id(message) == "2d-after" and _result_of(message).get("success") == true, message)

	client.close()
	fixture.queue_free()
	await process_frame
