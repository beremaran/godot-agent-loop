@tool
extends EditorPlugin

## Small, authenticated editor bridge used by editor-capable integrations.
## Mutations are recorded through EditorUndoRedoManager; the bridge never edits
## scene text directly and never evaluates arbitrary code in the editor.

var _server: TCPServer
var _peer: StreamPeerTCP
var _buffer: PackedByteArray = PackedByteArray()
var _port: int = 9091
var _secret: String = ""
var _activity_dock: VBoxContainer
var _activity_list: ItemList
var _connection_status: Label
var _compatibility_status: Label
var _driver_status: Label
var _driver_pause_button: Button
var _driver_paused: bool = false
var _session_authenticated: bool = false
var _server_version: String = ""
var _last_history_id: int = EditorUndoRedoManager.GLOBAL_HISTORY
var _activity_entries: Array[Dictionary] = []
var _last_filesystem_sync: Dictionary = {}
const MAX_ACTIVITY_ENTRIES: int = 200
const PROTOCOL_VERSION: String = "1"
const ADDON_VERSION: String = "1.0.0"

func _enter_tree() -> void:
	set_process(true)
	_port = _read_port()
	_secret = OS.get_environment("GODOT_MCP_EDITOR_SECRET")
	_driver_paused = OS.get_environment("GODOT_MCP_EDITOR_START_PAUSED").strip_edges().to_lower() in ["1", "true", "yes"]
	_server = TCPServer.new()
	_create_activity_dock()
	var error: int = _server.listen(_port, "127.0.0.1")
	if error != OK:
		push_error("Godot Agent Loop editor bridge could not listen on %d: %s" % [_port, error_string(error)])
		_set_connection_status("Unavailable — port %d: %s" % [_port, error_string(error)])
	elif _secret.is_empty():
		_set_connection_status("Waiting — relaunch the editor through Godot Agent Loop")
	else:
		_set_connection_status("Waiting for an authenticated agent")

func _exit_tree() -> void:
	set_process(false)
	if _peer != null:
		_peer.disconnect_from_host()
	_peer = null
	if _server != null:
		_server.stop()
	_server = null
	if _activity_dock != null:
		remove_control_from_docks(_activity_dock)
		_activity_dock.queue_free()
	_activity_dock = null
	_activity_list = null
	_connection_status = null
	_compatibility_status = null
	_driver_status = null
	_driver_pause_button = null

func _process(_delta: float) -> void:
	if _server != null and _server.is_connection_available():
		if _peer != null:
			_server.take_connection().disconnect_from_host()
		else:
			_peer = _server.take_connection()
			_session_authenticated = false
			_server_version = ""
			_set_connection_status("Connected — authenticating")
	if _peer == null:
		return
	var poll_error: Error = _peer.poll()
	if poll_error != OK:
		return
	if _peer.get_status() != StreamPeerTCP.STATUS_CONNECTED:
		_peer = null
		_buffer = PackedByteArray()
		_session_authenticated = false
		_server_version = ""
		_set_connection_status("Waiting for an authenticated agent")
		return
	var available: int = _peer.get_available_bytes()
	if available <= 0:
		return
	var incoming: Array = _peer.get_data(mini(available, 64 * 1024))
	if incoming[0] != OK:
		return
	var incoming_variant: Variant = incoming[1]
	if not incoming_variant is PackedByteArray:
		return
	var incoming_bytes: PackedByteArray = incoming_variant
	_buffer.append_array(incoming_bytes)
	while true:
		var newline: int = _buffer.find(10)
		if newline < 0:
			break
		var line: String = _buffer.slice(0, newline).get_string_from_utf8().strip_edges()
		_buffer = _buffer.slice(newline + 1)
		if line.is_empty():
			continue
		_handle_request(line)

func _handle_request(line: String) -> void:
	var parsed: Variant = JSON.parse_string(line)
	if not parsed is Dictionary:
		_send({"id": null, "error": "invalid_request"})
		return
	var request: Dictionary = parsed
	if _secret.is_empty() or str(request.get("secret", "")) != _secret:
		_send({"id": request.get("id", null), "error": "authentication_required"})
		return
	var command: String = str(request.get("command", ""))
	if command == "handshake":
		var handshake: Dictionary = _handshake(request.get("params", {}))
		handshake["id"] = request.get("id", null)
		_send(handshake)
		return
	if not _session_authenticated:
		_send({"id": request.get("id", null), "error": "handshake_required", "protocol_version": PROTOCOL_VERSION})
		return
	var result: Dictionary = _dispatch(command, request.get("params", {}))
	result["id"] = request.get("id", null)
	_send(result)

func _dispatch(command: String, raw_params: Variant) -> Dictionary:
	var params: Dictionary = raw_params if raw_params is Dictionary else {}
	match command:
		"inspect":
			return _inspect()
		"activity":
			return _record_activity(params)
		"driver_state":
			return _driver_state()
		"filesystem_changed":
			return _sync_filesystem(params)
		"select":
			return _select(params)
		"save":
			var save_error: Error = EditorInterface.save_scene()
			return {"success": save_error == OK, "saved": save_error == OK, "error_code": save_error}
		"reload":
			var scene_path: String = str(params.get("scene_path", ""))
			EditorInterface.reload_scene_from_path(scene_path)
			return {"success": true, "scene_path": scene_path}
		"open_scene":
			var open_path: String = str(params.get("scene_path", ""))
			if open_path.is_empty():
				return {"error": "scene_path is required"}
			EditorInterface.open_scene_from_path(open_path)
			return {"success": true, "scene_path": open_path}
		"set_property":
			return _set_property(params)
		"rename_node":
			return _rename_node(params)
		"undo":
			var undo_redo: EditorUndoRedoManager = EditorInterface.get_editor_undo_redo()
			if undo_redo == null:
				return {"success": false, "action": "undo"}
			var undo_history: UndoRedo = undo_redo.get_history_undo_redo(_last_history_id)
			return {"success": undo_history.undo(), "action": "undo"}
		"redo":
			var redo_manager: EditorUndoRedoManager = EditorInterface.get_editor_undo_redo()
			if redo_manager == null:
				return {"success": false, "action": "redo"}
			var redo_history: UndoRedo = redo_manager.get_history_undo_redo(_last_history_id)
			return {"success": redo_history.redo(), "action": "redo"}
		_:
			return {"error": "unknown_command", "allowed": ["inspect", "activity", "driver_state", "filesystem_changed", "select", "save", "reload", "open_scene", "set_property", "rename_node", "undo", "redo"]}

func _handshake(raw_params: Variant) -> Dictionary:
	var params: Dictionary = raw_params if raw_params is Dictionary else {}
	var requested_protocol: String = str(params.get("protocol_version", ""))
	_server_version = str(params.get("server_version", ""))
	if requested_protocol != PROTOCOL_VERSION:
		_session_authenticated = false
		_set_connection_status("Incompatible protocol — server %s, addon %s" % [requested_protocol, PROTOCOL_VERSION])
		return {
			"error": "incompatible_protocol",
			"requested_protocol": requested_protocol,
			"protocol_version": PROTOCOL_VERSION,
			"addon_version": ADDON_VERSION,
		}
	_session_authenticated = true
	_set_connection_status("Authenticated — server %s" % (_server_version if not _server_version.is_empty() else "unknown"))
	return {
		"success": true,
		"product": "Godot Agent Loop",
		"protocol_version": PROTOCOL_VERSION,
		"addon_version": ADDON_VERSION,
		"server_version": _server_version,
		"godot_version": Engine.get_version_info().get("string", "unknown"),
	}

func _create_activity_dock() -> void:
	_activity_dock = VBoxContainer.new()
	_activity_dock.name = "Godot Agent Loop"
	var title := Label.new()
	title.text = "Agent Activity"
	title.tooltip_text = "Live authenticated MCP command lifecycle"
	_activity_dock.add_child(title)
	_connection_status = Label.new()
	_connection_status.name = "ConnectionStatus"
	_connection_status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_activity_dock.add_child(_connection_status)
	_compatibility_status = Label.new()
	_compatibility_status.name = "CompatibilityStatus"
	_compatibility_status.text = "Addon %s · protocol %s · Godot %s" % [ADDON_VERSION, PROTOCOL_VERSION, Engine.get_version_info().get("string", "unknown")]
	_compatibility_status.tooltip_text = "The MCP server and addon must use the same editor protocol version."
	_activity_dock.add_child(_compatibility_status)
	var driver_row := HBoxContainer.new()
	driver_row.name = "DriverControls"
	_driver_status = Label.new()
	_driver_status.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	driver_row.add_child(_driver_status)
	_driver_pause_button = Button.new()
	var connect_error: Error = _driver_pause_button.pressed.connect(_toggle_driver_pause) as Error
	if connect_error != OK:
		push_error("Godot Agent Loop could not connect its pause control: %s" % error_string(connect_error))
	driver_row.add_child(_driver_pause_button)
	_activity_dock.add_child(driver_row)
	_update_driver_controls()
	_activity_list = ItemList.new()
	_activity_list.name = "Activity"
	_activity_list.custom_minimum_size = Vector2(320, 180)
	_activity_list.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_activity_dock.add_child(_activity_list)
	var setup_title := Label.new()
	setup_title.text = "Setup help"
	_activity_dock.add_child(setup_title)
	var setup_help := RichTextLabel.new()
	setup_help.name = "SetupHelp"
	setup_help.fit_content = true
	setup_help.custom_minimum_size = Vector2(320, 96)
	setup_help.text = "Claude Code / Codex: install the Godot Agent Loop plugin\nOpenCode: godot-agent-loop setup opencode --write\nPi: pi install npm:@beremaran/godot-agent-loop\nRelaunch the editor through the MCP launch_editor tool to authenticate."
	_activity_dock.add_child(setup_help)
	add_control_to_dock(DOCK_SLOT_RIGHT_BL, _activity_dock)

func _set_connection_status(message: String) -> void:
	if _connection_status != null:
		_connection_status.text = "Connection: %s" % message

func _toggle_driver_pause() -> void:
	_driver_paused = not _driver_paused
	_update_driver_controls()

func _update_driver_controls() -> void:
	if _driver_status != null:
		_driver_status.text = "Agent paused — human editing" if _driver_paused else "Agent is driving"
	if _driver_pause_button != null:
		_driver_pause_button.text = "Resume Agent" if _driver_paused else "Pause Agent"
		_driver_pause_button.tooltip_text = "Allow subsequent MCP mutations" if _driver_paused else "Refuse subsequent MCP mutations while you edit"

func _driver_state() -> Dictionary:
	return {"success": true, "paused": _driver_paused, "agent_driving": not _driver_paused}

func _record_activity(params: Dictionary) -> Dictionary:
	var event: String = str(params.get("event", ""))
	if not event in ["request_started", "request_finished", "request_timed_out"]:
		return {"error": "invalid_activity_event"}
	var command: String = str(params.get("command", "unknown"))
	var target: String = str(params.get("target", "game"))
	var outcome: String = str(params.get("outcome", "running"))
	var raw_duration_ms: Variant = params.get("duration_ms", 0)
	var duration_ms: int = 0
	if raw_duration_ms is int:
		duration_ms = raw_duration_ms
	elif raw_duration_ms is float:
		var float_duration_ms: float = raw_duration_ms
		duration_ms = roundi(float_duration_ms)
	var correlation_id: String = str(params.get("correlation_id", ""))
	var marker: String = "…" if event == "request_started" else "✓" if outcome == "success" else "✗"
	var suffix: String = "" if event == "request_started" else " · %d ms" % duration_ms
	var text: String = "%s %s → %s%s" % [marker, command, target, suffix]
	var entry: Dictionary = {
		"event": event, "correlation_id": correlation_id, "command": command,
		"target": target, "outcome": outcome, "duration_ms": duration_ms, "text": text,
	}
	_activity_entries.append(entry)
	var item_index: int = _activity_list.add_item(text)
	_activity_list.set_item_tooltip(item_index, correlation_id)
	if event != "request_started":
		var color := Color(0.35, 0.85, 0.45) if outcome == "success" else Color(1.0, 0.4, 0.35)
		_activity_list.set_item_custom_fg_color(item_index, color)
	while _activity_entries.size() > MAX_ACTIVITY_ENTRIES:
		_activity_entries.pop_front()
		_activity_list.remove_item(0)
	return {"success": true, "activity_count": _activity_entries.size()}

func _sync_filesystem(params: Dictionary) -> Dictionary:
	var filesystem: EditorFileSystem = EditorInterface.get_resource_filesystem()
	filesystem.scan()
	var scene_path: String = str(params.get("scene_path", ""))
	var root: Node = EditorInterface.get_edited_scene_root()
	var reloaded: bool = false
	if root != null and not scene_path.is_empty() and root.scene_file_path == scene_path:
		EditorInterface.reload_scene_from_path(scene_path)
		reloaded = true
	var focus_path: String = str(params.get("focus_path", ""))
	var focused: bool = false
	if reloaded and not focus_path.is_empty():
		focused = _focus_editor_node(focus_path)
	_last_filesystem_sync = {
		"success": true, "rescanned": true, "scene_path": scene_path,
		"resource_path": str(params.get("resource_path", "")), "reloaded": reloaded,
		"command": str(params.get("command", "")), "focus_path": focus_path,
		"focused": focused,
	}
	return _last_filesystem_sync.duplicate(true)

func _inspect() -> Dictionary:
	var root: Node = EditorInterface.get_edited_scene_root()
	var selected: Array[String] = []
	var selection: EditorSelection = EditorInterface.get_selection()
	for node: Node in selection.get_selected_nodes():
		selected.append(str(node.get_path()))
	var open_scenes: Array = []
	var open_result: Variant = EditorInterface.get_open_scenes()
	if open_result is PackedStringArray:
		var packed_open_scenes: PackedStringArray = open_result
		open_scenes.assign(packed_open_scenes)
	var edited_root: Variant = null
	if root != null:
		edited_root = {"name": root.name, "type": root.get_class(), "path": str(root.get_path())}
	return {"success": true, "edited_scene": "" if root == null else str(root.scene_file_path),
		"edited_root": edited_root,
		"selection": selected, "open_scenes": open_scenes,
		"has_undo_redo": EditorInterface.get_editor_undo_redo() != null,
		"activity_dock": _activity_dock != null, "activity": _activity_entries.duplicate(true),
		"driver_paused": _driver_paused, "agent_driving": not _driver_paused,
		"authenticated": _session_authenticated, "server_version": _server_version,
		"addon_version": ADDON_VERSION, "protocol_version": PROTOCOL_VERSION,
		"godot_version": Engine.get_version_info().get("string", "unknown"),
		"last_filesystem_sync": _last_filesystem_sync.duplicate(true)}

func _select(params: Dictionary) -> Dictionary:
	var selection: EditorSelection = EditorInterface.get_selection()
	selection.clear()
	var root: Node = EditorInterface.get_edited_scene_root()
	if root == null:
		return {"error": "no_edited_scene"}
	var selected: Array[String] = []
	var paths: Variant = params.get("node_paths", [])
	if not paths is Array:
		return {"error": "node_paths must be an array"}
	for raw_path: Variant in paths:
		var node: Node = root.get_node_or_null(NodePath(str(raw_path)))
		if node == null:
			return {"error": "node_not_found", "node_path": str(raw_path)}
		selection.add_node(node)
		selected.append(str(node.get_path()))
		if selected.size() == 1:
			EditorInterface.edit_node(node)
	return {"success": true, "selection": selected}

func _focus_editor_node(path: String) -> bool:
	var root: Node = EditorInterface.get_edited_scene_root()
	if root == null:
		return false
	var normalized: String = path.trim_prefix("root/")
	var node: Node = root if normalized == "." or normalized == "root" or normalized.is_empty() else root.get_node_or_null(NodePath(normalized))
	if node == null:
		return false
	var selection: EditorSelection = EditorInterface.get_selection()
	selection.clear()
	selection.add_node(node)
	EditorInterface.edit_node(node)
	return true

func _set_property(params: Dictionary) -> Dictionary:
	var target: Node = _edited_node(params)
	var property: String = str(params.get("property", ""))
	if target == null: return {"error": "node_not_found"}
	if property.is_empty() or not property in target: return {"error": "property_not_found", "property": property}
	var before: Variant = target.get(property)
	var after: Variant = params.get("value")
	return _commit_property_action(target, property, before, after)

func _rename_node(params: Dictionary) -> Dictionary:
	var target: Node = _edited_node(params)
	var new_name: String = str(params.get("name", ""))
	if target == null: return {"error": "node_not_found"}
	if new_name.is_empty() or not NodePath(new_name).is_absolute() and new_name.contains("/"):
		return {"error": "invalid_name"}
	var before: String = target.name
	return _commit_property_action(target, "name", before, new_name)

func _edited_node(params: Dictionary) -> Node:
	var root: Node = EditorInterface.get_edited_scene_root()
	if root == null: return null
	var path: String = str(params.get("node_path", "."))
	return root if path == "." or path.is_empty() else root.get_node_or_null(NodePath(path))

func _commit_property_action(target: Node, property: String, before: Variant, after: Variant) -> Dictionary:
	var manager: EditorUndoRedoManager = EditorInterface.get_editor_undo_redo()
	if manager == null: return {"error": "undo_redo_unavailable"}
	manager.create_action("MCP %s" % property)
	manager.add_do_property(target, property, after)
	manager.add_undo_property(target, property, before)
	manager.commit_action()
	_last_history_id = manager.get_object_history_id(target)
	return {"success": true, "property": property, "before": before, "after": target.get(property), "undo_recorded": true}

func _send(response: Dictionary) -> void:
	if _peer == null:
		return
	var send_error: Error = _peer.put_data((JSON.stringify(response) + "\n").to_utf8_buffer())
	if send_error != OK:
		push_warning("Godot Agent Loop editor bridge send failed: %s" % error_string(send_error))

func _read_port() -> int:
	var configured: String = OS.get_environment("GODOT_MCP_EDITOR_PORT")
	if configured.is_valid_int():
		var value: int = int(configured)
		if value > 0 and value < 65536: return value
	return _port
