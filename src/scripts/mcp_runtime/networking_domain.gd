extends "res://mcp_runtime/runtime_domain.gd"

# Networking and multiplayer runtime commands. This domain owns the persistent
# WebSocket peer so its lifetime follows the command domain rather than the
# transport composition root.

var _websocket: WebSocketPeer = null


func register_commands() -> void:
	register_command("http_request", _cmd_http_request)
	register_command("websocket", _cmd_websocket)
	register_command("multiplayer", _cmd_multiplayer)
	register_command("rpc", _cmd_rpc)


func _cmd_http_request(params: Dictionary) -> void:
	var reader := CommandParams.new(params)
	var url: String = reader.required_string("url")
	var method_str: String = reader.optional_enum("method", "GET", ["GET", "POST", "PUT", "DELETE"])
	var timeout: float = reader.optional_number("timeout", 30.0, 0.0)
	var header_values: Dictionary = reader.optional_dictionary("headers")
	var body: String = reader.optional_string("body")
	if params_invalid(reader):
		return
	if url.is_empty():
		reader.fail("url must be non-empty", {"param": "url", "reason": "invalid_value"})
		send_params_error(reader)
		return

	var http := HTTPRequest.new()
	http.timeout = timeout
	add_child(http)
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
		http.queue_free()
		reader.fail("HTTP request failed to start", godot_error_data(err))
		send_params_error(reader)
		return
	var result: Array = await http.request_completed
	http.queue_free()
	var body_bytes: PackedByteArray = result[3]
	respond({"success": true, "status_code": result[1], "body": body_bytes.get_string_from_utf8()})


func _cmd_websocket(params: Dictionary) -> void:
	var reader := CommandParams.new(params)
	var action: String = reader.required_enum("action", ["connect", "disconnect", "send", "status"])
	var url: String = reader.optional_string("url")
	var message: String = reader.optional_string("message")
	if params_invalid(reader):
		return
	if action == "connect" and url.is_empty():
		reader.fail("url is required for connect", {"param": "url", "reason": "missing"})
		send_params_error(reader)
		return

	match action:
		"connect":
			_websocket = WebSocketPeer.new()
			var err: int = _websocket.connect_to_url(url)
			if err != OK:
				_websocket = null
				reader.fail("WebSocket connection failed", godot_error_data(err))
				send_params_error(reader)
				return
			respond({"success": true, "action": action, "url": url})
		"disconnect":
			_close_websocket()
			respond({"success": true, "action": action})
		"send":
			if _websocket == null:
				respond({"error": "No WebSocket connection"})
				return
			_websocket.poll()
			var err: int = _websocket.send_text(message)
			if err != OK:
				reader.fail("WebSocket send failed", godot_error_data(err))
				send_params_error(reader)
				return
			respond({"success": true, "action": action})
		"status":
			if _websocket == null:
				respond({"success": true, "status": "disconnected"})
				return
			_websocket.poll()
			respond({"success": true, "status": _websocket.get_ready_state()})


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
			var peer := ENetMultiplayerPeer.new()
			var err: int = peer.create_server(port, max_clients)
			if err != OK:
				reader.fail("Failed to create multiplayer server", godot_error_data(err))
				send_params_error(reader)
				return
			multiplayer.multiplayer_peer = peer
			respond({"success": true, "action": action, "port": port})
		"create_client":
			var peer := ENetMultiplayerPeer.new()
			var err: int = peer.create_client(address, port)
			if err != OK:
				reader.fail("Failed to create multiplayer client", godot_error_data(err))
				send_params_error(reader)
				return
			multiplayer.multiplayer_peer = peer
			respond({"success": true, "action": action, "address": address, "port": port})
		"disconnect":
			multiplayer.multiplayer_peer = null
			respond({"success": true, "action": action})
		"status":
			var peer: MultiplayerPeer = multiplayer.multiplayer_peer
			if peer == null:
				respond({"success": true, "connected": false})
				return
			respond({"success": true, "connected": true, "unique_id": multiplayer.get_unique_id(), "is_server": multiplayer.is_server()})


func _cmd_rpc(params: Dictionary) -> void:
	var reader := CommandParams.new(params)
	var node: Node = require_node(reader)
	var action: String = reader.optional_enum("action", "call", ["call", "configure"])
	var method: String = reader.required_string("method")
	var args: Array = reader.optional_array("args")
	if params_invalid(reader):
		return
	if method.is_empty():
		reader.fail("method must be non-empty", {"param": "method", "reason": "invalid_value"})
		send_params_error(reader)
		return

	if action == "call":
		@warning_ignore("return_value_discarded")
		node.rpc(method, args)
		respond({"success": true, "action": action, "method": method})
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
		var sync: Variant = reader.raw("sync")
		if sync is String:
			var sync_text: String = sync
			config["call_local"] = sync_text.to_lower() == "call_local"
		elif sync is bool:
			config["call_local"] = sync
		else:
			reader.fail("sync must be a string or boolean", {"param": "sync", "reason": "invalid_type"})
	if reader.has_param("channel"):
		config["channel"] = reader.optional_int("channel", 0, 0)
	if params_invalid(reader):
		return
	node.rpc_config(method, config)
	respond({"success": true, "action": action, "method": method, "config": config})


func _close_websocket() -> void:
	if _websocket != null:
		_websocket.close()
		_websocket = null


func _exit_tree() -> void:
	_close_websocket()
	multiplayer.multiplayer_peer = null
