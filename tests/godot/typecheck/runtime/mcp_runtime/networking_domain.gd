extends "res://mcp_runtime/runtime_domain.gd"

# Networking and multiplayer runtime commands. This domain owns the persistent
# WebSocket peer so its lifetime follows the command domain rather than the
# transport composition root.

var _websocket: WebSocketPeer = null
const MAX_WEBSOCKET_MESSAGE_BYTES := 1024 * 1024
const MAX_HTTP_BODY_BYTES := 1024 * 1024
const MAX_HTTP_RESPONSE_BYTES := 4 * 1024 * 1024
const MAX_HTTP_HEADER_BYTES := 32 * 1024
const MAX_HTTP_HEADERS := 64
const MAX_HTTP_URL_BYTES := 8192
const MAX_RPC_ARGS := 64

var _active_http: HTTPRequest = null
var _http_result: Array = []
var _rpc_call_local: Dictionary = {}
var _rpc_authority_only: Dictionary = {}


func register_commands() -> void:
	register_command("http_request", _cmd_http_request)
	register_command("websocket", _cmd_websocket)
	register_command("multiplayer", _cmd_multiplayer)
	register_command("rpc", _cmd_rpc)


func _cmd_http_request(params: Dictionary) -> void:
	var reader := CommandParams.new(params)
	var url: String = reader.required_string("url")
	var method_str: String = reader.optional_enum("method", "GET", ["GET", "POST", "PUT", "DELETE"])
	var timeout: float = reader.optional_number("timeout", 30.0, 0.01, 30.0)
	var header_values: Dictionary = reader.optional_dictionary("headers")
	var body: String = reader.optional_string("body")
	if params_invalid(reader):
		return
	if url.is_empty():
		reader.fail("url must be non-empty", {"param": "url", "reason": "invalid_value"})
		send_params_error(reader)
		return
	if not (url.begins_with("http://") or url.begins_with("https://")):
		reader.fail("url must use http:// or https://", {"param": "url", "reason": "invalid_value"})
	if url.to_utf8_buffer().size() > MAX_HTTP_URL_BYTES:
		reader.fail("HTTP URL exceeds the configured limit", {"param": "url", "reason": "limit_exceeded", "max_bytes": MAX_HTTP_URL_BYTES})
	if body.to_utf8_buffer().size() > MAX_HTTP_BODY_BYTES:
		reader.fail("HTTP body exceeds the configured limit", {"param": "body", "reason": "payload_too_large", "max_bytes": MAX_HTTP_BODY_BYTES})
	if header_values.size() > MAX_HTTP_HEADERS:
		reader.fail("HTTP headers exceed the configured count limit", {"param": "headers", "reason": "limit_exceeded", "max_items": MAX_HTTP_HEADERS})
	var header_bytes: int = 0
	for key: Variant in header_values:
		if not key is String or not header_values[key] is String:
			reader.fail("HTTP header names and values must be strings", {"param": "headers", "reason": "invalid_type"})
			break
		header_bytes += (str(key) + ": " + str(header_values[key])).to_utf8_buffer().size()
	if header_bytes > MAX_HTTP_HEADER_BYTES:
		reader.fail("HTTP headers exceed the configured byte limit", {"param": "headers", "reason": "limit_exceeded", "max_bytes": MAX_HTTP_HEADER_BYTES})
	if params_invalid(reader):
		return

	_cleanup_http()
	var http := HTTPRequest.new()
	_active_http = http
	_http_result = []
	http.timeout = timeout
	add_child(http)
	@warning_ignore("return_value_discarded")
	http.request_completed.connect(_capture_http_result, CONNECT_ONE_SHOT)
	var headers := PackedStringArray()
	for key: Variant in header_values:
		@warning_ignore("return_value_discarded")
		headers.append("%s: %s" % [key, str(header_values[key])])
	var method_enum: int = {
		"GET": HTTPClient.METHOD_GET,
		"POST": HTTPClient.METHOD_POST,
		"PUT": HTTPClient.METHOD_PUT,
		"DELETE": HTTPClient.METHOD_DELETE,
	}[method_str]
	var err: int = http.request(url, headers, method_enum, body)
	if err != OK:
		_cleanup_http()
		reader.fail("HTTP request failed to start", godot_error_data(err))
		send_params_error(reader)
		return
	while _http_result.is_empty():
		if cancellation_requested():
			_cleanup_http()
			respond({})
			return
		await get_tree().process_frame
	var result: Array = _http_result.duplicate()
	_cleanup_http()
	var request_result: int = result[0]
	var status_code: int = result[1]
	var response_headers: PackedStringArray = result[2]
	var body_bytes: PackedByteArray = result[3]
	if request_result != HTTPRequest.RESULT_SUCCESS:
		respond({"error": "HTTP request did not complete successfully", "error_data": {"reason": "http_request_failed", "result": request_result, "status_code": status_code}})
		return
	if body_bytes.size() > MAX_HTTP_RESPONSE_BYTES:
		respond({"error": "HTTP response exceeds the configured payload limit", "error_data": {"reason": "payload_too_large", "bytes": body_bytes.size(), "max_bytes": MAX_HTTP_RESPONSE_BYTES, "status_code": status_code}})
		return
	respond({
		"success": true,
		"result": request_result,
		"status_code": status_code,
		"headers": Array(response_headers),
		"body": body_bytes.get_string_from_utf8(),
		"bytes": body_bytes.size(),
	})


func _capture_http_result(result: int, response_code: int, headers: PackedStringArray, body: PackedByteArray) -> void:
	_http_result = [result, response_code, headers, body]


func _cleanup_http() -> void:
	if _active_http != null:
		_active_http.cancel_request()
		_active_http.queue_free()
		_active_http = null
	_http_result = []


func _cmd_websocket(params: Dictionary) -> void:
	var reader := CommandParams.new(params)
	var action: String = reader.required_enum("action", ["connect", "disconnect", "send", "receive", "status"])
	var url: String = reader.optional_string("url")
	var message: String = reader.optional_string("message")
	var timeout: float = reader.optional_number("timeout", 5.0, 0.0, 10.0)
	if params_invalid(reader):
		return
	if action == "connect" and url.is_empty():
		reader.fail("url is required for connect", {"param": "url", "reason": "missing"})
		send_params_error(reader)
		return

	match action:
		"connect":
			_close_websocket()
			_websocket = WebSocketPeer.new()
			var err: int = _websocket.connect_to_url(url)
			if err != OK:
				_websocket = null
				reader.fail("WebSocket connection failed", godot_error_data(err))
				send_params_error(reader)
				return
			var deadline: int = Time.get_ticks_msec() + ceili(timeout * 1000.0)
			while _websocket != null and _websocket.get_ready_state() == WebSocketPeer.STATE_CONNECTING and Time.get_ticks_msec() <= deadline:
				_websocket.poll()
				await get_tree().process_frame
			if _websocket == null or _websocket.get_ready_state() != WebSocketPeer.STATE_OPEN:
				var state: String = _websocket_state_name(_websocket)
				_close_websocket()
				reader.fail("WebSocket connection did not open", {"param": "url", "reason": "connection_failed", "state": state})
				send_params_error(reader)
				return
			respond({"success": true, "action": action, "url": url, "status": "open"})
		"disconnect":
			_close_websocket()
			respond({"success": true, "action": action})
		"send":
			if not reader.has_param("message"):
				reader.fail("message is required for send", {"param": "message", "reason": "missing"})
			if message.to_utf8_buffer().size() > MAX_WEBSOCKET_MESSAGE_BYTES:
				reader.fail("WebSocket message exceeds the payload limit", {"param": "message", "reason": "payload_too_large", "max_bytes": MAX_WEBSOCKET_MESSAGE_BYTES})
			if _websocket == null or _websocket.get_ready_state() != WebSocketPeer.STATE_OPEN:
				reader.fail("No open WebSocket connection", {"reason": "invalid_state", "state": _websocket_state_name(_websocket)})
			if params_invalid(reader):
				return
			_websocket.poll()
			var err: int = _websocket.send_text(message)
			if err != OK:
				reader.fail("WebSocket send failed", godot_error_data(err))
				send_params_error(reader)
				return
			respond({"success": true, "action": action})
		"receive":
			if _websocket == null or _websocket.get_ready_state() != WebSocketPeer.STATE_OPEN:
				reader.fail("No open WebSocket connection", {"reason": "invalid_state", "state": _websocket_state_name(_websocket)})
				if params_invalid(reader):
					return
			var deadline: int = Time.get_ticks_msec() + ceili(timeout * 1000.0)
			while _websocket.get_available_packet_count() == 0 and Time.get_ticks_msec() <= deadline:
				_websocket.poll()
				if _websocket.get_ready_state() != WebSocketPeer.STATE_OPEN:
					reader.fail("WebSocket closed while waiting for a message", {"reason": "connection_closed", "state": _websocket_state_name(_websocket)})
					break
				await get_tree().process_frame
			if reader.failed():
				send_params_error(reader)
				return
			if _websocket.get_available_packet_count() == 0:
				reader.fail("WebSocket receive timed out", {"reason": "timeout", "timeout": timeout})
				send_params_error(reader)
				return
			var packet: PackedByteArray = _websocket.get_packet()
			if packet.size() > MAX_WEBSOCKET_MESSAGE_BYTES:
				reader.fail("Received WebSocket message exceeds the payload limit", {"reason": "payload_too_large", "max_bytes": MAX_WEBSOCKET_MESSAGE_BYTES, "bytes": packet.size()})
				send_params_error(reader)
				return
			respond({"success": true, "action": action, "message": packet.get_string_from_utf8(), "bytes": packet.size()})
		"status":
			if _websocket != null:
				_websocket.poll()
			respond({"success": true, "status": _websocket_state_name(_websocket)})


func _cmd_multiplayer(params: Dictionary) -> void:
	var reader := CommandParams.new(params)
	var action: String = reader.required_enum("action", ["create_server", "create_client", "disconnect", "status"])
	var port: int = reader.optional_int("port", 7000, 1, 65535)
	var max_clients: int = reader.optional_int("max_clients", 32, 1)
	var address: String = reader.optional_string("address", "127.0.0.1")
	if params_invalid(reader):
		return

	match action:
		"create_server":
			_close_multiplayer()
			var peer := ENetMultiplayerPeer.new()
			var err: int = peer.create_server(port, max_clients)
			if err != OK:
				reader.fail("Failed to create multiplayer server", godot_error_data(err))
				send_params_error(reader)
				return
			multiplayer.multiplayer_peer = peer
			respond({"success": true, "action": action, "port": port})
		"create_client":
			_close_multiplayer()
			var peer := ENetMultiplayerPeer.new()
			var err: int = peer.create_client(address, port)
			if err != OK:
				reader.fail("Failed to create multiplayer client", godot_error_data(err))
				send_params_error(reader)
				return
			multiplayer.multiplayer_peer = peer
			respond({"success": true, "action": action, "address": address, "port": port})
		"disconnect":
			_close_multiplayer()
			respond({"success": true, "action": action})
		"status":
			var peer: MultiplayerPeer = multiplayer.multiplayer_peer
			if peer == null:
				respond({"success": true, "connected": false, "status": "disconnected", "peer_count": 0})
				return
			var connection_status: MultiplayerPeer.ConnectionStatus = peer.get_connection_status()
			var status_name: String = {MultiplayerPeer.CONNECTION_DISCONNECTED: "disconnected", MultiplayerPeer.CONNECTION_CONNECTING: "connecting", MultiplayerPeer.CONNECTION_CONNECTED: "connected"}.get(connection_status, "unknown")
			respond({"success": true, "connected": connection_status == MultiplayerPeer.CONNECTION_CONNECTED, "status": status_name, "unique_id": multiplayer.get_unique_id(), "is_server": multiplayer.is_server(), "peer_count": multiplayer.get_peers().size()})


func _cmd_rpc(params: Dictionary) -> void:
	var reader := CommandParams.new(params)
	var node: Node = require_node(reader)
	var action: String = reader.optional_enum("action", "call", ["call", "configure"])
	var method: String = reader.required_string("method")
	var args: Array = reader.optional_array("args")
	var peer_id: int = reader.optional_int("peer_id", 0, 0)
	if params_invalid(reader):
		return
	if method.is_empty():
		reader.fail("method must be non-empty", {"param": "method", "reason": "invalid_value"})
		send_params_error(reader)
		return
	if args.size() > MAX_RPC_ARGS:
		reader.fail("RPC arguments exceed the configured limit", {"param": "args", "reason": "limit_exceeded", "max_items": MAX_RPC_ARGS})
	if not node.has_method(method):
		reader.fail("RPC method not found", {"param": "method", "reason": "method_not_found", "value": method})
	if params_invalid(reader):
		return

	if action == "call":
		var call_config_key: String = "%s:%s" % [node.get_instance_id(), method]
		if _rpc_authority_only.get(call_config_key, false) and not node.is_multiplayer_authority():
			reader.fail("Only the multiplayer authority may call this RPC method", {"param": "method", "reason": "not_multiplayer_authority", "value": method})
			send_params_error(reader)
			return
		if _rpc_call_local.get(call_config_key, false):
			Callable(node, method).callv(args)
		var call_args: Array = [method]
		call_args.append_array(args)
		var call_result: Variant
		if peer_id == 0:
			call_result = Callable(node, "rpc").callv(call_args)
		else:
			call_args.push_front(peer_id)
			call_result = Callable(node, "rpc_id").callv(call_args)
		var rpc_error: int = CommandParams.to_int(call_result, FAILED)
		if rpc_error != OK:
			reader.fail("RPC call failed", godot_error_data(rpc_error))
			send_params_error(reader)
			return
		respond({"success": true, "action": action, "method": method, "peer_id": peer_id, "argument_count": args.size()})
		return

	var config: Dictionary = {}
	if reader.has_param("mode"):
		var mode: Variant = reader.raw("mode")
		if mode is String:
			var mode_text: String = mode
			var mode_name: String = mode_text.to_lower()
			if not ["any_peer", "authority"].has(mode_name):
				reader.fail("mode must be one of: any_peer, authority", {"param": "mode", "reason": "invalid_value", "allowed": ["any_peer", "authority"], "value": mode})
			else:
				config["rpc_mode"] = MultiplayerAPI.RPC_MODE_ANY_PEER if mode_name == "any_peer" else MultiplayerAPI.RPC_MODE_AUTHORITY
		elif mode is int or mode is float:
			config["rpc_mode"] = CommandParams.to_int(mode)
		else:
			reader.fail("mode must be a string or integer", {"param": "mode", "reason": "invalid_type"})
	if reader.has_param("sync"):
		var sync: String = reader.optional_enum("sync", "call_remote", ["call_local", "call_remote"])
		config["call_local"] = sync == "call_local"
	if reader.has_param("transfer_mode"):
		var transfer_mode: String = reader.optional_enum("transfer_mode", "unreliable", ["unreliable", "unreliable_ordered", "reliable"])
		config["transfer_mode"] = {
			"unreliable": MultiplayerPeer.TRANSFER_MODE_UNRELIABLE,
			"unreliable_ordered": MultiplayerPeer.TRANSFER_MODE_UNRELIABLE_ORDERED,
			"reliable": MultiplayerPeer.TRANSFER_MODE_RELIABLE,
		}[transfer_mode]
	if reader.has_param("channel"):
		config["channel"] = reader.optional_int("channel", 0, 0)
	if params_invalid(reader):
		return
	var requested_config: Dictionary = config.duplicate()
	var config_key: String = "%s:%s" % [node.get_instance_id(), method]
	_rpc_call_local[config_key] = config.get("call_local", false)
	_rpc_authority_only[config_key] = config.get("rpc_mode", MultiplayerAPI.RPC_MODE_AUTHORITY) == MultiplayerAPI.RPC_MODE_AUTHORITY
	# Invoke locally ourselves so broadcast and rpc_id have identical semantics.
	config["call_local"] = false
	node.rpc_config(method, config)
	respond({"success": true, "action": action, "method": method, "config": requested_config})


func _close_websocket() -> void:
	if _websocket != null:
		_websocket.close()
		_websocket = null


func _websocket_state_name(peer: WebSocketPeer) -> String:
	if peer == null:
		return "disconnected"
	return {WebSocketPeer.STATE_CONNECTING: "connecting", WebSocketPeer.STATE_OPEN: "open", WebSocketPeer.STATE_CLOSING: "closing", WebSocketPeer.STATE_CLOSED: "closed"}.get(peer.get_ready_state(), "unknown")


func _close_multiplayer() -> void:
	var peer: MultiplayerPeer = multiplayer.multiplayer_peer
	if peer != null:
		peer.close()
	multiplayer.multiplayer_peer = null


func _exit_tree() -> void:
	_cleanup_http()
	_close_websocket()
	_close_multiplayer()
