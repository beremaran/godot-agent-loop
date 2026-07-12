extends SceneTree

# Integration tests for mcp_interaction_server.gd over real loopback TCP.
#
# Run via tests/godot/run-integration-tests.sh, which copies the shipped
# server script into this fixture and launches:
#   godot --headless --path tests/godot/fixture --script res://test_runner.gd
#
# Covered transport/session behavior: handshake, response-ID correlation,
# malformed and oversized frames, invalid UTF-8, JSON depth/collection limits,
# two concurrent clients and busy rejection, disconnect during an awaited
# command, cooperative cancellation, await_signal timeout, and the oversized
# response fallback. Exit code is 0 only when every check passes.

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
