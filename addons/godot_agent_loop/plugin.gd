@tool
extends EditorPlugin

## Small, authenticated editor bridge used by editor-capable integrations.
## Mutations are recorded through EditorUndoRedoManager; the bridge never edits
## scene text directly and never evaluates arbitrary code in the editor.

var _server: TCPServer
var _peer: StreamPeerTCP
var _buffer: PackedByteArray = PackedByteArray()
var _port: int = 0
var _secret: String = ""
var _project_path: String = ""
var _editor_pid: int = 0
var _editor_start_identity: String = ""
var _session_path: String = ""
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
var _activity_event_ids: Dictionary = {}
var _last_filesystem_sync: Dictionary = {}
var _saved_history_versions: Dictionary = {}
const MAX_ACTIVITY_ENTRIES: int = 200
const PROTOCOL_VERSION: String = "2"
const ADDON_VERSION: String = "1.1.4"
const SESSION_DIRECTORY: String = ".godot/godot_agent_loop"
const SESSION_FILE: String = "editor-session.json"
const PAUSE_BLOCKED_COMMANDS: Array[String] = [
	"filesystem_changed", "transaction", "resource_transaction", "select", "save", "reload",
	"open_scene", "set_property", "rename_node", "undo", "redo",
]

func _enter_tree() -> void:
	set_process(true)
	_port = _read_port()
	_secret = OS.get_environment("GODOT_MCP_EDITOR_SECRET")
	if _secret.is_empty():
		_secret = Marshalls.raw_to_base64(Crypto.new().generate_random_bytes(32))
	_project_path = ProjectSettings.globalize_path("res://").trim_suffix("/")
	_editor_pid = OS.get_process_id()
	_editor_start_identity = "%d-%d" % [_editor_pid, Time.get_ticks_usec()]
	_session_path = _project_path.path_join(SESSION_DIRECTORY).path_join(SESSION_FILE)
	_driver_paused = OS.get_environment("GODOT_MCP_EDITOR_START_PAUSED").strip_edges().to_lower() in ["1", "true", "yes"]
	_server = TCPServer.new()
	_create_activity_dock()
	var scene_changed_error: Error = scene_changed.connect(_on_scene_changed) as Error
	if scene_changed_error != OK:
		push_error("Godot Agent Loop could not observe scene changes: %s" % error_string(scene_changed_error))
	var scene_saved_error: Error = scene_saved.connect(_on_scene_saved) as Error
	if scene_saved_error != OK:
		push_error("Godot Agent Loop could not observe scene saves: %s" % error_string(scene_saved_error))
	var error: int = _server.listen(_port, "127.0.0.1")
	if error != OK:
		push_error("Godot Agent Loop editor bridge could not listen on %d: %s" % [_port, error_string(error)])
		_set_connection_status("Unavailable — port %d: %s" % [_port, error_string(error)])
	else:
		_port = _server.get_local_port()
		var discovery_error: Error = _write_discovery_record()
		if discovery_error != OK:
			push_error("Godot Agent Loop could not publish editor discovery: %s" % error_string(discovery_error))
			_set_connection_status("Unavailable — discovery record failed")
			_server.stop()
		else:
			_set_connection_status("Waiting for an authenticated agent")

func _exit_tree() -> void:
	set_process(false)
	_remove_owned_discovery_record()
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
	var result: Dictionary = await _dispatch(command, request.get("params", {}))
	result["id"] = request.get("id", null)
	_send(result)

func _dispatch(command: String, raw_params: Variant) -> Dictionary:
	var params: Dictionary = raw_params if raw_params is Dictionary else {}
	if _driver_paused and command in PAUSE_BLOCKED_COMMANDS:
		return {"error": "paused", "state": "paused", "blocked_command": command}
	match command:
		"inspect":
			return _inspect()
		"activity":
			return _record_activity(params)
		"driver_state":
			return _driver_state()
		"filesystem_changed":
			return await _sync_filesystem(params)
		"transaction":
			return await _editor_transaction(params)
		"resource_transaction":
			return _editor_resource_transaction(params)
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
			return {"error": "unknown_command", "allowed": ["inspect", "activity", "driver_state", "filesystem_changed", "transaction", "resource_transaction", "select", "save", "reload", "open_scene", "set_property", "rename_node", "undo", "redo"]}

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
		"project_path": _project_path,
		"editor_pid": _editor_pid,
		"editor_start_identity": _editor_start_identity,
		"paused": _driver_paused,
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
	setup_help.text = "Install and enable this addon once for interactive projects.\nOpen Godot normally before or after the MCP; this dock waits for the matching authenticated agent.\nUse launch_editor only when no editor is already open."
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
	var event_id: int = _variant_int(params.get("event_id", 0))
	if event_id > 0 and _activity_event_ids.has(event_id):
		return {"success": true, "deduplicated": true, "event_id": event_id, "activity_count": _activity_entries.size()}
	var event: String = str(params.get("event", params.get("phase", "state")))
	var command: String = str(params.get("command", params.get("tool", "unknown")))
	var target: String = str(params.get("target", params.get("target_backend", "unknown")))
	var outcome: String = str(params.get("outcome", "running"))
	var raw_duration_ms: Variant = params.get("duration_ms", 0)
	var duration_ms: int = 0
	if raw_duration_ms is int:
		duration_ms = raw_duration_ms
	elif raw_duration_ms is float:
		var float_duration_ms: float = raw_duration_ms
		duration_ms = roundi(float_duration_ms)
	var correlation_id: String = str(params.get("correlation_id", ""))
	var running: bool = outcome == "running" or event in ["request_started", "start"]
	var marker: String = "…" if running else "✓" if outcome == "success" else "↪" if outcome == "fallback" else "Ⅱ" if outcome == "paused" else "!" if outcome == "conflict" else "✗"
	var suffix: String = "" if running else " · %d ms" % duration_ms
	var text: String = "%s %s → %s%s" % [marker, command, target, suffix]
	var entry: Dictionary = {
		"event_id": event_id, "event": event, "correlation_id": correlation_id, "command": command,
		"target": target, "outcome": outcome, "duration_ms": duration_ms, "text": text,
	}
	_activity_entries.append(entry)
	if event_id > 0: _activity_event_ids[event_id] = true
	var item_index: int = _activity_list.add_item(text)
	_activity_list.set_item_tooltip(item_index, correlation_id)
	if not running:
		var color := Color(0.35, 0.85, 0.45) if outcome == "success" else Color(1.0, 0.75, 0.25) if outcome in ["fallback", "paused", "conflict"] else Color(1.0, 0.4, 0.35)
		_activity_list.set_item_custom_fg_color(item_index, color)
	if outcome == "paused": _set_connection_status("Paused — human editing")
	elif outcome == "conflict": _set_connection_status("Conflict — unsaved changes preserved")
	while _activity_entries.size() > MAX_ACTIVITY_ENTRIES:
		var removed: Dictionary = _activity_entries.pop_front()
		var removed_id: int = _variant_int(removed.get("event_id", 0))
		if removed_id > 0:
			@warning_ignore("return_value_discarded")
			_activity_event_ids.erase(removed_id)
		_activity_list.remove_item(0)
	return {"success": true, "activity_count": _activity_entries.size()}

func _sync_filesystem(params: Dictionary) -> Dictionary:
	var filesystem: EditorFileSystem = EditorInterface.get_resource_filesystem()
	var scene_path: String = str(params.get("scene_path", ""))
	var resource_path: String = str(params.get("resource_path", ""))
	var root_before: Node = EditorInterface.get_edited_scene_root()
	var open_scene_before: String = "" if root_before == null else root_before.scene_file_path
	var selection_before: Array[String] = []
	for selected_node: Node in EditorInterface.get_selection().get_selected_nodes():
		selection_before.append(str(selected_node.get_path()))
	if root_before != null and not scene_path.is_empty() and root_before.scene_file_path == scene_path and _scene_has_unsaved_changes(root_before):
		_last_filesystem_sync = {
			"success": false, "error": "unsaved_conflict", "state": "unsaved_conflict",
			"scene_path": scene_path, "resource_path": resource_path,
			"observed_target_state": {
				"edited_scene": open_scene_before, "selection": selection_before,
				"unsaved": true, "reloaded": false,
			},
		}
		_set_connection_status("Conflict — unsaved editor changes preserved")
		return _last_filesystem_sync.duplicate(true)
	_set_connection_status("Synchronizing filesystem")
	filesystem.scan()
	var frames_waited: int = 0
	while filesystem.is_scanning() and frames_waited < 600:
		await get_tree().process_frame
		frames_waited += 1
	if filesystem.is_scanning():
		_last_filesystem_sync = {
			"success": false, "error": "sync_timeout", "state": "syncing",
			"scene_path": scene_path, "resource_path": resource_path,
			"observed_target_state": {"scan_complete": false, "frames_waited": frames_waited},
		}
		_set_connection_status("Connected — filesystem synchronization timed out")
		return _last_filesystem_sync.duplicate(true)
	var root: Node = EditorInterface.get_edited_scene_root()
	var reloaded: bool = false
	if root != null and not scene_path.is_empty() and root.scene_file_path == scene_path:
		EditorInterface.reload_scene_from_path(scene_path)
		reloaded = true
	var focus_path: String = str(params.get("focus_path", ""))
	var focused: bool = false
	if reloaded and not focus_path.is_empty():
		focused = _focus_editor_node(focus_path)
	var root_after: Node = EditorInterface.get_edited_scene_root()
	var selection_after: Array[String] = []
	for selected_node: Node in EditorInterface.get_selection().get_selected_nodes():
		selection_after.append(str(selected_node.get_path()))
	var scene_readback: Dictionary = _readback_sync_target(scene_path, true)
	var resource_readback: Dictionary = _readback_sync_target(resource_path, false)
	var scene_visible: bool = scene_readback.get("readable", false) == true
	var resource_visible: bool = resource_readback.get("readable", false) == true
	var target_readable: bool = scene_visible and resource_visible
	var observed_target_state: Dictionary = {
		"scan_complete": true,
		"frames_waited": frames_waited,
		"edited_scene": "" if root_after == null else root_after.scene_file_path,
		"selection": selection_after,
		"scene_visible": scene_visible,
		"resource_visible": resource_visible,
		"scene_readback": scene_readback,
		"resource_readback": resource_readback,
		"independently_reopened": target_readable,
		"reloaded": reloaded,
		"focused": focused,
		"preserved_context": {
			"open_scene": open_scene_before == ("" if root_after == null else root_after.scene_file_path),
			"selection_before": selection_before,
			"viewport": "public_api_unavailable",
			"inspector": "restored_to_focus_target" if focused else "unchanged_or_unavailable",
		},
	}
	_last_filesystem_sync = {
		"success": target_readable, "rescanned": true, "scene_path": scene_path,
		"resource_path": resource_path, "reloaded": reloaded,
		"command": str(params.get("command", "")), "focus_path": focus_path,
		"focused": focused, "state": "connected",
		"observed_target_state": observed_target_state,
	}
	if not target_readable:
		_last_filesystem_sync["error"] = "target_not_editor_readable"
		_last_filesystem_sync["state"] = "target_unreadable"
		_set_connection_status("Connected — synchronized target is unreadable")
	else:
		_set_connection_status("Authenticated — synchronized")
	return _last_filesystem_sync.duplicate(true)

func _readback_sync_target(resource_path: String, require_packed_scene: bool) -> Dictionary:
	if resource_path.is_empty():
		return {"requested": false, "exists": true, "readable": true, "reader": "none"}
	var absolute_path: String = ProjectSettings.globalize_path(resource_path)
	var file_exists: bool = FileAccess.file_exists(absolute_path)
	var extension: String = resource_path.get_extension().to_lower()
	var recognized_extensions: PackedStringArray = ResourceLoader.get_recognized_extensions_for_type("Resource")
	var resource_format: bool = require_packed_scene or ResourceLoader.exists(resource_path) or extension in recognized_extensions
	if resource_format:
		var loaded: Resource = null
		if file_exists:
			loaded = ResourceLoader.load(resource_path, "PackedScene" if require_packed_scene else "", ResourceLoader.CACHE_MODE_IGNORE)
		var resource_readable: bool = loaded is PackedScene if require_packed_scene else loaded != null
		return {
			"requested": true, "exists": file_exists, "readable": resource_readable,
			"reader": "resource_loader", "resource_type": "" if loaded == null else loaded.get_class(),
		}
	var file: FileAccess = FileAccess.open(absolute_path, FileAccess.READ) if file_exists else null
	var file_readable: bool = file != null
	if file != null:
		file.close()
	return {
		"requested": true, "exists": file_exists, "readable": file_readable,
		"reader": "file_access", "resource_type": "",
	}

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

func _editor_transaction(params: Dictionary) -> Dictionary:
	if _driver_paused:
		return {"error": "paused", "state": "paused"}
	var scene_path: String = _resource_path(str(params.get("scene_path", "")))
	var action_name: String = str(params.get("name", "Godot Agent Loop transaction")).strip_edges()
	var operations_variant: Variant = params.get("operations", [])
	if scene_path.is_empty() or action_name.is_empty() or not operations_variant is Array:
		return {"error": "scene_path, name, and operations are required"}
	var operations: Array = operations_variant
	if operations.is_empty() or operations.size() > 256:
		return {"error": "operations must contain 1 to 256 items"}
	var created_scene: bool = false
	if not ResourceLoader.exists(scene_path):
		var root_type: String = str(params.get("root_type", "Node"))
		if not ClassDB.is_parent_class(root_type, "Node"):
			return {"error": "invalid_root_type", "root_type": root_type}
		var new_root_variant: Variant = ClassDB.instantiate(root_type)
		if not new_root_variant is Node:
			return {"error": "root_type_not_instantiable", "root_type": root_type}
		var new_root: Node = new_root_variant
		new_root.name = scene_path.get_file().get_basename().to_pascal_case()
		var preflight: Dictionary = _validate_transaction(new_root, operations)
		if preflight.has("error"):
			new_root.free()
			return preflight
		_discard_transaction_stages(preflight.get("stages", []))
		var initial_scene := PackedScene.new()
		var pack_error: Error = initial_scene.pack(new_root)
		if pack_error != OK:
			new_root.free()
			return {"error": "create_scene_pack_failed", "error_code": pack_error}
		var directory_error: Error = _ensure_resource_parent_directory(scene_path)
		if directory_error != OK:
			new_root.free()
			return {"error": "create_scene_directory_failed", "error_code": directory_error}
		var create_error: Error = ResourceSaver.save(initial_scene, scene_path)
		new_root.free()
		if create_error != OK:
			return {"error": "create_scene_save_failed", "error_code": create_error}
		created_scene = true
	EditorInterface.open_scene_from_path(scene_path)
	var open_frames: int = 0
	while open_frames < 120:
		var candidate: Node = EditorInterface.get_edited_scene_root()
		if candidate != null and candidate.scene_file_path == scene_path:
			break
		await get_tree().process_frame
		open_frames += 1
	var root: Node = EditorInterface.get_edited_scene_root()
	if root == null or root.scene_file_path != scene_path:
		return _rollback_created_transaction({"error": "scene_open_failed", "scene_path": scene_path}, scene_path, created_scene)
	if _scene_has_unsaved_changes(root):
		return _rollback_created_transaction({"error": "unsaved_conflict", "state": "unsaved_conflict", "scene_path": scene_path}, scene_path, created_scene)
	var validation: Dictionary = _validate_transaction(root, operations)
	if validation.has("error"):
		return _rollback_created_transaction(validation, scene_path, created_scene)
	var stages: Array = validation.get("stages", [])
	var undo_recorded: bool = not stages.is_empty()
	if undo_recorded:
		var manager: EditorUndoRedoManager = EditorInterface.get_editor_undo_redo()
		if manager == null:
			_discard_transaction_stages(stages)
			return _rollback_created_transaction({"error": "undo_redo_unavailable"}, scene_path, created_scene)
		manager.create_action(action_name)
		for stage_variant: Variant in stages:
			var stage: Dictionary = stage_variant
			_apply_transaction_stage(manager, root, stage)
		manager.commit_action()
		_last_history_id = manager.get_object_history_id(root)
	var focus_path: String = str(params.get("focus_path", validation.get("focus_path", "")))
	var focused: bool = false
	if not focus_path.is_empty():
		focused = _focus_editor_node(focus_path)
	var saved: bool = false
	var save_error: Error = OK
	if _variant_bool(params.get("save", true)):
		save_error = EditorInterface.save_scene()
		saved = save_error == OK
	if save_error != OK:
		return _rollback_created_transaction({"error": "scene_save_failed", "error_code": save_error, "undo_recorded": undo_recorded}, scene_path, created_scene)
	var persisted: Dictionary = _independent_scene_readback(scene_path)
	if persisted.has("error"):
		return _rollback_created_transaction({"error": "independent_readback_failed", "details": persisted, "undo_recorded": undo_recorded}, scene_path, created_scene)
	return {
		"success": true,
		"backend": "editor",
		"transaction_name": action_name,
		"operation_count": operations.size(),
		"undo_recorded": undo_recorded,
		"saved": saved,
		"scene_created": created_scene,
		"creation_fallback": _creation_fallback(created_scene, "initial PackedScene save required before opening"),
		"focused": focused,
		"focus_path": focus_path,
		"observed_target_state": persisted,
	}

func _rollback_created_transaction(result: Dictionary, scene_path: String, created_scene: bool) -> Dictionary:
	if not created_scene:
		return result
	var remove_error: Error = DirAccess.remove_absolute(ProjectSettings.globalize_path(scene_path))
	result["created_scene_rolled_back"] = remove_error in [OK, ERR_DOES_NOT_EXIST]
	if remove_error not in [OK, ERR_DOES_NOT_EXIST]:
		result["rollback_error_code"] = remove_error
	return result

func _discard_transaction_stages(stages_variant: Variant) -> void:
	if not stages_variant is Array:
		return
	var nodes: Array[Node] = []
	for stage_variant: Variant in stages_variant:
		if not stage_variant is Dictionary:
			continue
		var stage: Dictionary = stage_variant
		if str(stage.get("op", "")) not in ["add_node", "instantiate_scene", "duplicate_node"]:
			continue
		var node_variant: Variant = stage.get("node")
		if not node_variant is Node:
			continue
		nodes.append(node_variant)
	_discard_transaction_nodes(nodes)

func _discard_transaction_nodes(nodes: Array[Node]) -> void:
	var discarded: Dictionary = {}
	for node: Node in nodes:
		var instance_id: int = node.get_instance_id()
		if discarded.has(instance_id):
			continue
		discarded[instance_id] = true
		if is_instance_valid(node) and node.get_parent() == null:
			node.free()

func _validate_transaction(root: Node, operations: Array) -> Dictionary:
	var allocated_nodes: Array[Node] = []
	var validation: Dictionary = _validate_transaction_operations(root, operations, allocated_nodes)
	if validation.has("error"):
		_discard_transaction_nodes(allocated_nodes)
	return validation

func _validate_transaction_operations(root: Node, operations: Array, allocated_nodes: Array[Node]) -> Dictionary:
	var stages: Array[Dictionary] = []
	var virtual_nodes: Dictionary = {}
	var virtual_paths: Dictionary = {}
	var staged_node_ids: Dictionary = {}
	_index_transaction_subtree(root, ".", virtual_nodes, virtual_paths)
	var virtual_root_name: String = str(root.name)
	var focus_path: String = ""
	for index: int in operations.size():
		var operation_variant: Variant = operations[index]
		if not operation_variant is Dictionary:
			return {"error": "invalid_operation", "operation_index": index}
		var operation: Dictionary = operation_variant
		var op: String = str(operation.get("op", ""))
		if op == "save":
			continue
		if op == "add_node":
			var parent_path: String = str(operation.get("parent_path", "."))
			var parent: Node = _transaction_node(root, parent_path, virtual_nodes)
			var node_type: String = str(operation.get("node_type", "Node"))
			var node_name: String = str(operation.get("node_name", node_type)).strip_edges()
			if parent == null: return {"error": "parent_not_found", "operation_index": index, "parent_path": parent_path}
			if node_name.is_empty() or node_name.contains("/"): return {"error": "invalid_node_name", "operation_index": index}
			var normalized_parent_path: String = str(virtual_paths.get(parent.get_instance_id(), ""))
			var node_path: String = _joined_node_path(normalized_parent_path, node_name)
			if virtual_nodes.has(node_path): return {"error": "duplicate_node_name", "operation_index": index, "node_name": node_name}
			if not ClassDB.is_parent_class(node_type, "Node"): return {"error": "invalid_node_type", "operation_index": index, "node_type": node_type}
			var node_variant: Variant = ClassDB.instantiate(node_type)
			if not node_variant is Node: return {"error": "node_type_not_instantiable", "operation_index": index}
			var node: Node = node_variant
			allocated_nodes.append(node)
			node.name = node_name
			var properties_variant: Variant = operation.get("properties", {})
			if not properties_variant is Dictionary: return {"error": "properties_must_be_object", "operation_index": index}
			for property_name_variant: Variant in properties_variant:
				var property_name: String = str(property_name_variant)
				if not property_name in node: return {"error": "property_not_found", "operation_index": index, "property": property_name}
				var decoded: Dictionary = _decode_editor_value(properties_variant[property_name_variant], node.get(property_name))
				if decoded.has("error"): return {"error": decoded.error, "operation_index": index, "property": property_name}
				node.set(property_name, decoded.value)
			_index_transaction_subtree(node, node_path, virtual_nodes, virtual_paths, staged_node_ids, true)
			stages.append({"op": op, "parent": parent, "node": node})
			focus_path = node_path
		elif op == "instantiate_scene":
			var instance_parent_path: String = str(operation.get("parent_path", "."))
			var instance_parent: Node = _transaction_node(root, instance_parent_path, virtual_nodes)
			var packed_path: String = _resource_path(str(operation.get("scene_path", "")))
			var packed: Resource = ResourceLoader.load(packed_path, "PackedScene")
			if instance_parent == null or not packed is PackedScene:
				return {"error": "packed_scene_or_parent_invalid", "operation_index": index}
			var packed_scene: PackedScene = packed
			var instance: Node = packed_scene.instantiate()
			allocated_nodes.append(instance)
			if operation.has("node_name"): instance.name = str(operation.node_name)
			var instance_name: String = str(instance.name).strip_edges()
			if instance_name.is_empty() or instance_name.contains("/"): return {"error": "invalid_node_name", "operation_index": index}
			var normalized_instance_parent_path: String = str(virtual_paths.get(instance_parent.get_instance_id(), ""))
			var instance_path: String = _joined_node_path(normalized_instance_parent_path, instance_name)
			if virtual_nodes.has(instance_path): return {"error": "duplicate_node_name", "operation_index": index, "node_name": instance_name}
			_index_transaction_subtree(instance, instance_path, virtual_nodes, virtual_paths, staged_node_ids, true)
			stages.append({"op": op, "parent": instance_parent, "node": instance})
			focus_path = instance_path
		else:
			var node_path: String = str(operation.get("node_path", "."))
			var target: Node = _transaction_node(root, node_path, virtual_nodes)
			if target == null: return {"error": "node_not_found", "operation_index": index, "node_path": node_path}
			if target != root and target.owner != root and not staged_node_ids.has(target.get_instance_id()):
				return {"error": "inherited_or_noneditable_node", "operation_index": index, "node_path": node_path}
			var current_path: String = str(virtual_paths.get(target.get_instance_id(), ""))
			if op == "remove_node":
				if target == root: return {"error": "cannot_remove_scene_root", "operation_index": index}
				var current_parent: Node = _transaction_node(root, current_path.get_base_dir(), virtual_nodes)
				stages.append({"op": op, "node": target, "parent": current_parent, "index": target.get_index(), "owner": target.owner})
				_remove_transaction_subtree(target, virtual_nodes, virtual_paths)
			elif op == "rename_node":
				var new_name: String = str(operation.get("name", operation.get("node_name", ""))).strip_edges()
				if new_name.is_empty() or new_name.contains("/"): return {"error": "invalid_node_name", "operation_index": index}
				var renamed_path: String = current_path if target == root else _joined_node_path(current_path.get_base_dir(), new_name)
				if target != root and virtual_nodes.has(renamed_path) and virtual_nodes[renamed_path] != target:
					return {"error": "duplicate_node_name", "operation_index": index, "node_name": new_name}
				var before_name: String = virtual_root_name if target == root else current_path.get_file()
				stages.append({"op": op, "node": target, "before": before_name, "after": new_name})
				if target == root:
					virtual_root_name = new_name
				else:
					_move_transaction_subtree(target, renamed_path, virtual_nodes, virtual_paths)
				focus_path = renamed_path
			elif op == "duplicate_node":
				if target == root: return {"error": "cannot_duplicate_scene_root", "operation_index": index}
				var duplicate_name: String = str(operation.get("node_name", "%sCopy" % current_path.get_file())).strip_edges()
				if duplicate_name.is_empty() or duplicate_name.contains("/"): return {"error": "invalid_node_name", "operation_index": index}
				var duplicate_path: String = _joined_node_path(current_path.get_base_dir(), duplicate_name)
				if virtual_nodes.has(duplicate_path): return {"error": "duplicate_node_name", "operation_index": index, "node_name": duplicate_name}
				var duplicated_node: Node = target.duplicate(Node.DUPLICATE_USE_INSTANTIATION)
				allocated_nodes.append(duplicated_node)
				duplicated_node.name = duplicate_name
				var duplicate_parent: Node = _transaction_node(root, current_path.get_base_dir(), virtual_nodes)
				_index_transaction_subtree(duplicated_node, duplicate_path, virtual_nodes, virtual_paths, staged_node_ids, true)
				stages.append({"op": op, "node": duplicated_node, "parent": duplicate_parent})
				focus_path = duplicate_path
			elif op == "reparent_node":
				if target == root: return {"error": "cannot_reparent_scene_root", "operation_index": index}
				var new_parent_path: String = str(operation.get("new_parent_path", ""))
				var new_parent: Node = _transaction_node(root, new_parent_path, virtual_nodes)
				if new_parent == null: return {"error": "invalid_reparent_target", "operation_index": index}
				var normalized_new_parent_path: String = str(virtual_paths.get(new_parent.get_instance_id(), ""))
				if new_parent == target or normalized_new_parent_path.begins_with(current_path + "/"):
					return {"error": "invalid_reparent_target", "operation_index": index}
				var reparented_path: String = _joined_node_path(normalized_new_parent_path, current_path.get_file())
				if virtual_nodes.has(reparented_path) and virtual_nodes[reparented_path] != target:
					return {"error": "duplicate_node_name", "operation_index": index, "node_name": current_path.get_file()}
				var before_parent: Node = _transaction_node(root, current_path.get_base_dir(), virtual_nodes)
				stages.append({"op": op, "node": target, "before_parent": before_parent, "after_parent": new_parent, "keep_global": _variant_bool(operation.get("keep_global_transform", true))})
				_move_transaction_subtree(target, reparented_path, virtual_nodes, virtual_paths)
				focus_path = reparented_path
			elif op == "set_properties":
				var set_properties_variant: Variant = operation.get("properties", {})
				if not set_properties_variant is Dictionary: return {"error": "properties_must_be_object", "operation_index": index}
				for property_variant: Variant in set_properties_variant:
					var property_name: String = str(property_variant)
					if not property_name in target: return {"error": "property_not_found", "operation_index": index, "property": property_name}
					var decoded: Dictionary = _decode_editor_value(set_properties_variant[property_variant], target.get(property_name))
					if decoded.has("error"): return {"error": decoded.error, "operation_index": index, "property": property_name}
					stages.append({"op": "set_property", "node": target, "property": property_name, "before": target.get(property_name), "after": decoded.value})
				focus_path = current_path
			elif op == "attach_script":
				var script: Resource = ResourceLoader.load(_resource_path(str(operation.get("script_path", ""))), "Script")
				if not script is Script: return {"error": "script_not_found", "operation_index": index}
				stages.append({"op": "set_property", "node": target, "property": "script", "before": target.get_script(), "after": script})
				focus_path = current_path
			elif op == "assign_resource":
				var resource_property: String = str(operation.get("property", ""))
				var resource: Resource = ResourceLoader.load(_resource_path(str(operation.get("resource_path", ""))))
				if resource_property.is_empty() or not resource_property in target or resource == null: return {"error": "resource_or_property_invalid", "operation_index": index}
				stages.append({"op": "set_property", "node": target, "property": resource_property, "before": target.get(resource_property), "after": resource})
				focus_path = current_path
			else:
				return {"error": "unsupported_operation", "operation_index": index, "op": op}
	return {"stages": stages, "focus_path": focus_path}

func _editor_resource_transaction(params: Dictionary) -> Dictionary:
	if _driver_paused:
		return {"error": "paused", "state": "paused"}
	var resource_path: String = _resource_path(str(params.get("resource_path", "")))
	var resource_type: String = str(params.get("resource_type", ""))
	var properties_variant: Variant = params.get("properties", {})
	if resource_path.is_empty() or not properties_variant is Dictionary:
		return {"error": "resource_path and object properties are required"}
	var properties: Dictionary = properties_variant
	var resource: Resource
	var created: bool = false
	if ResourceLoader.exists(resource_path):
		resource = ResourceLoader.load(resource_path)
		if resource == null:
			return {"error": "resource_load_failed", "resource_path": resource_path}
	else:
		if not _is_supported_editor_resource_type(resource_type):
			return {"error": "unsupported_resource_type", "resource_type": resource_type}
		var instance: Variant = ClassDB.instantiate(resource_type)
		if not instance is Resource:
			return {"error": "resource_type_not_instantiable", "resource_type": resource_type}
		resource = instance
		created = true
	var stages: Array[Dictionary] = []
	for property_variant: Variant in properties:
		var property_name: String = str(property_variant)
		if not property_name in resource:
			return {"error": "property_not_found", "property": property_name}
		var decoded: Dictionary = _decode_editor_value(properties[property_variant], resource.get(property_name))
		if decoded.has("error"):
			return {"error": decoded.error, "property": property_name}
		stages.append({"property": property_name, "before": resource.get(property_name), "after": decoded.value})
	var undo_recorded: bool = not created and not stages.is_empty()
	if undo_recorded:
		var manager: EditorUndoRedoManager = EditorInterface.get_editor_undo_redo()
		if manager == null:
			return {"error": "undo_redo_unavailable"}
		manager.create_action(str(params.get("name", "Modify resource")))
		for stage: Dictionary in stages:
			var property_name: StringName = StringName(str(stage.get("property", "")))
			manager.add_do_property(resource, property_name, stage.get("after"))
			manager.add_undo_property(resource, property_name, stage.get("before"))
		manager.commit_action()
		_last_history_id = manager.get_object_history_id(resource)
	else:
		for stage: Dictionary in stages:
			var property_name: StringName = StringName(str(stage.get("property", "")))
			resource.set(property_name, stage.get("after"))
	var directory_error: Error = _ensure_resource_parent_directory(resource_path)
	if directory_error != OK:
		return {"error": "resource_directory_failed", "error_code": directory_error, "undo_recorded": undo_recorded}
	var save_error: Error = ResourceSaver.save(resource, resource_path)
	if save_error != OK:
		return {"error": "resource_save_failed", "error_code": save_error, "undo_recorded": undo_recorded}
	EditorInterface.edit_resource(resource)
	var readback: Resource = ResourceLoader.load(resource_path, "", ResourceLoader.CACHE_MODE_IGNORE)
	if readback == null:
		return {"error": "independent_resource_readback_failed", "undo_recorded": undo_recorded}
	var observed_properties: Dictionary = {}
	for property_variant: Variant in properties:
		var property_name: String = str(property_variant)
		observed_properties[property_name] = str(readback.get(property_name))
	return {
		"success": true,
		"backend": "editor",
		"resource_path": resource_path,
		"resource_type": readback.get_class(),
		"resource_uid": ResourceLoader.get_resource_uid(resource_path),
		"created": created,
		"undo_recorded": undo_recorded,
		"creation_fallback": _creation_fallback(created, "initial ResourceSaver save required before editor inspection"),
		"focused": true,
		"observed_target_state": {
			"resource_path": resource_path,
			"resource_type": readback.get_class(),
			"properties": observed_properties,
			"independently_reloaded": true,
		},
	}

func _is_supported_editor_resource_type(resource_type: String) -> bool:
	if resource_type.is_empty() or not ClassDB.class_exists(resource_type) or not ClassDB.can_instantiate(resource_type):
		return false
	for base_type: String in ["BaseMaterial3D", "Mesh", "Shape2D", "Shape3D", "Theme", "AudioStream", "Gradient", "Curve", "Environment"]:
		if ClassDB.is_parent_class(resource_type, base_type):
			return true
	return false

func _apply_transaction_stage(manager: EditorUndoRedoManager, root: Node, stage: Dictionary) -> void:
	var op: String = str(stage.get("op", ""))
	var stage_node_variant: Variant = stage.get("node")
	if not stage_node_variant is Node:
		return
	var stage_node: Node = stage_node_variant
	if op in ["add_node", "instantiate_scene", "duplicate_node"]:
		var parent_variant: Variant = stage.get("parent")
		if not parent_variant is Node:
			return
		var parent: Node = parent_variant
		manager.add_do_method(parent, "add_child", stage_node, true)
		manager.add_do_method(self, "_set_scene_owner_recursive", stage_node, root)
		manager.add_do_reference(stage_node)
		manager.add_undo_method(parent, "remove_child", stage_node)
	elif op == "remove_node":
		var parent_variant: Variant = stage.get("parent")
		if not parent_variant is Node:
			return
		var parent: Node = parent_variant
		manager.add_do_method(parent, "remove_child", stage_node)
		manager.add_undo_method(parent, "add_child", stage_node, true)
		manager.add_undo_method(parent, "move_child", stage_node, _variant_int(stage.get("index", 0)))
		manager.add_undo_property(stage_node, "owner", stage.get("owner"))
	elif op == "rename_node":
		manager.add_do_property(stage_node, "name", stage.get("after"))
		manager.add_undo_property(stage_node, "name", stage.get("before"))
	elif op == "reparent_node":
		var after_parent_variant: Variant = stage.get("after_parent")
		var before_parent_variant: Variant = stage.get("before_parent")
		if not after_parent_variant is Node or not before_parent_variant is Node:
			return
		var after_parent: Node = after_parent_variant
		var before_parent: Node = before_parent_variant
		var keep_global: bool = _variant_bool(stage.get("keep_global", true))
		manager.add_do_method(stage_node, "reparent", after_parent, keep_global)
		manager.add_undo_method(stage_node, "reparent", before_parent, keep_global)
	elif op == "set_property":
		var property_name: StringName = StringName(str(stage.get("property", "")))
		manager.add_do_property(stage_node, property_name, stage.get("after"))
		manager.add_undo_property(stage_node, property_name, stage.get("before"))

func _set_scene_owner_recursive(node: Node, scene_owner: Node) -> void:
	node.owner = scene_owner
	for child: Node in node.get_children(true):
		_set_scene_owner_recursive(child, scene_owner)

func _transaction_node(root: Node, path: String, staged_nodes: Dictionary) -> Node:
	var normalized: String = _normalize_transaction_path(path)
	if normalized == ".": return root
	if staged_nodes.has(normalized): return staged_nodes[normalized]
	return null

func _normalize_transaction_path(path: String) -> String:
	var normalized: String = path.strip_edges().trim_prefix("root/").trim_prefix("./").trim_suffix("/")
	return "." if normalized in ["", ".", "root"] else normalized

func _index_transaction_subtree(
	node: Node,
	path: String,
	virtual_nodes: Dictionary,
	virtual_paths: Dictionary,
	staged_node_ids: Dictionary = {},
	mark_staged: bool = false,
) -> void:
	var normalized_path: String = _normalize_transaction_path(path)
	virtual_nodes[normalized_path] = node
	virtual_paths[node.get_instance_id()] = normalized_path
	if mark_staged:
		staged_node_ids[node.get_instance_id()] = true
	for child: Node in node.get_children():
		_index_transaction_subtree(child, _joined_node_path(normalized_path, str(child.name)), virtual_nodes, virtual_paths, staged_node_ids, mark_staged)

func _remove_transaction_subtree(node: Node, virtual_nodes: Dictionary, virtual_paths: Dictionary) -> void:
	var root_path: String = str(virtual_paths.get(node.get_instance_id(), ""))
	if root_path.is_empty():
		return
	for path_variant: Variant in virtual_nodes.keys():
		var path: String = str(path_variant)
		if path == root_path or path.begins_with(root_path + "/"):
			var removed_node_variant: Variant = virtual_nodes.get(path)
			if removed_node_variant is Node:
				var removed_node: Node = removed_node_variant
				@warning_ignore("return_value_discarded")
				virtual_paths.erase(removed_node.get_instance_id())
			@warning_ignore("return_value_discarded")
			virtual_nodes.erase(path)

func _move_transaction_subtree(node: Node, new_path: String, virtual_nodes: Dictionary, virtual_paths: Dictionary) -> void:
	var old_path: String = str(virtual_paths.get(node.get_instance_id(), ""))
	var normalized_new_path: String = _normalize_transaction_path(new_path)
	if old_path.is_empty() or old_path == normalized_new_path:
		return
	var moved_nodes: Array[Dictionary] = []
	for path_variant: Variant in virtual_nodes.keys():
		var path: String = str(path_variant)
		if path == old_path or path.begins_with(old_path + "/"):
			var moved_node_variant: Variant = virtual_nodes.get(path)
			if moved_node_variant is Node:
				var suffix: String = path.trim_prefix(old_path)
				moved_nodes.append({"node": moved_node_variant, "path": normalized_new_path + suffix})
			@warning_ignore("return_value_discarded")
			virtual_nodes.erase(path)
	for moved: Dictionary in moved_nodes:
		var moved_node: Node = moved.node
		var moved_path: String = str(moved.path)
		virtual_nodes[moved_path] = moved_node
		virtual_paths[moved_node.get_instance_id()] = moved_path

func _joined_node_path(parent_path: String, node_name: String) -> String:
	var normalized: String = _normalize_transaction_path(parent_path)
	return node_name if normalized in ["", ".", "root"] else normalized.path_join(node_name)

func _resource_path(path: String) -> String:
	return path if path.begins_with("res://") else "res://" + path.trim_prefix("/")

func _ensure_resource_parent_directory(resource_path: String) -> Error:
	var parent: String = resource_path.get_base_dir()
	if parent in ["", "res://"]:
		return OK
	return DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(parent))

func _decode_editor_value(value: Variant, current: Variant) -> Dictionary:
	if value is Dictionary:
		var typed: Dictionary = value
		if not typed.has("type"):
			return _decode_untyped_editor_value(typed, current)
		var type_name: String = str(typed.get("type", ""))
		var data: Variant = typed.get("value")
		var data_array: Array = data if data is Array else []
		if type_name == "Vector2" and data_array.size() == 2: return {"value": Vector2(_variant_float(data_array[0]), _variant_float(data_array[1]))}
		if type_name == "Vector2i" and data_array.size() == 2: return {"value": Vector2i(_variant_int(data_array[0]), _variant_int(data_array[1]))}
		if type_name == "Vector3" and data_array.size() == 3: return {"value": Vector3(_variant_float(data_array[0]), _variant_float(data_array[1]), _variant_float(data_array[2]))}
		if type_name == "Vector3i" and data_array.size() == 3: return {"value": Vector3i(_variant_int(data_array[0]), _variant_int(data_array[1]), _variant_int(data_array[2]))}
		if type_name == "Color": return {"value": Color(str(data))}
		if type_name == "NodePath": return {"value": NodePath(str(data))}
		if type_name == "StringName": return {"value": StringName(str(data))}
		if type_name == "Resource":
			var resource: Resource = ResourceLoader.load(_resource_path(str(data)))
			return {"error": "resource_not_found"} if resource == null else {"value": resource}
		return {"error": "unsupported_typed_value"}
	match typeof(current):
		TYPE_INT: return {"value": _variant_int(value)}
		TYPE_FLOAT: return {"value": _variant_float(value)}
		TYPE_BOOL: return {"value": _variant_bool(value)}
		TYPE_STRING: return {"value": str(value)}
		TYPE_STRING_NAME: return {"value": StringName(str(value))}
		TYPE_NODE_PATH: return {"value": NodePath(str(value))}
		TYPE_OBJECT:
			if current is Resource and value is String:
				var referenced: Resource = ResourceLoader.load(_resource_path(str(value)))
				return {"error": "resource_not_found"} if referenced == null else {"value": referenced}
	return {"value": value}

func _decode_untyped_editor_value(value: Dictionary, current: Variant) -> Dictionary:
	match typeof(current):
		TYPE_VECTOR2:
			if value.has("x") and value.has("y"): return {"value": Vector2(_variant_float(value.get("x")), _variant_float(value.get("y")))}
		TYPE_VECTOR2I:
			if value.has("x") and value.has("y"): return {"value": Vector2i(_variant_int(value.get("x")), _variant_int(value.get("y")))}
		TYPE_VECTOR3:
			if value.has("x") and value.has("y") and value.has("z"): return {"value": Vector3(_variant_float(value.get("x")), _variant_float(value.get("y")), _variant_float(value.get("z")))}
		TYPE_VECTOR3I:
			if value.has("x") and value.has("y") and value.has("z"): return {"value": Vector3i(_variant_int(value.get("x")), _variant_int(value.get("y")), _variant_int(value.get("z")))}
		TYPE_COLOR:
			if value.has("r") and value.has("g") and value.has("b"): return {"value": Color(_variant_float(value.get("r")), _variant_float(value.get("g")), _variant_float(value.get("b")), _variant_float(value.get("a", 1.0)))}
	return {"value": value}

func _independent_scene_readback(scene_path: String) -> Dictionary:
	var packed: Resource = ResourceLoader.load(scene_path, "PackedScene", ResourceLoader.CACHE_MODE_IGNORE)
	if not packed is PackedScene:
		return {"error": "packed_scene_reload_failed"}
	var packed_scene: PackedScene = packed
	var instance: Node = packed_scene.instantiate()
	if instance == null:
		return {"error": "packed_scene_instantiate_failed"}
	var node_count: int = _count_scene_nodes(instance)
	var hierarchy: Array[String] = []
	_collect_scene_paths(instance, instance, hierarchy, 256)
	var result: Dictionary = {
		"scene_path": scene_path,
		"root_name": str(instance.name),
		"root_type": instance.get_class(),
		"node_count": node_count,
		"hierarchy": hierarchy,
		"independently_reopened": true,
	}
	instance.free()
	return result

func _count_scene_nodes(node: Node) -> int:
	var count: int = 1
	for child: Node in node.get_children(): count += _count_scene_nodes(child)
	return count

func _collect_scene_paths(root: Node, node: Node, paths: Array[String], limit: int) -> void:
	if paths.size() >= limit: return
	paths.append("." if node == root else str(root.get_path_to(node)))
	for child: Node in node.get_children(): _collect_scene_paths(root, child, paths, limit)

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

func _on_scene_changed(scene_root: Node) -> void:
	if scene_root != null and not scene_root.scene_file_path.is_empty():
		_saved_history_versions[scene_root.scene_file_path] = _history_version(scene_root)

func _on_scene_saved(filepath: String) -> void:
	var root: Node = EditorInterface.get_edited_scene_root()
	if root != null and root.scene_file_path == filepath:
		_saved_history_versions[filepath] = _history_version(root)

func _history_version(root: Node) -> int:
	var manager: EditorUndoRedoManager = EditorInterface.get_editor_undo_redo()
	if manager == null:
		return 0
	var history_id: int = manager.get_object_history_id(root)
	var history: UndoRedo = manager.get_history_undo_redo(history_id)
	return 0 if history == null else history.get_version()

func _scene_has_unsaved_changes(root: Node) -> bool:
	var path: String = root.scene_file_path
	if path.is_empty():
		return true
	var current_version: int = _history_version(root)
	if not _saved_history_versions.has(path):
		_saved_history_versions[path] = current_version
		return false
	return _variant_int(_saved_history_versions[path]) != current_version

func _variant_int(value: Variant) -> int:
	if value is int:
		return value
	if value is float:
		var float_value: float = value
		return roundi(float_value)
	if value is bool:
		return 1 if value else 0
	return 0

func _variant_float(value: Variant) -> float:
	if value is float:
		return value
	if value is int:
		var int_value: int = value
		return float(int_value)
	if value is bool:
		return 1.0 if value else 0.0
	return 0.0

func _variant_bool(value: Variant) -> bool:
	if value is bool:
		return value
	if value is int:
		return value != 0
	if value is float:
		var float_value: float = value
		return not is_zero_approx(float_value)
	return false

func _creation_fallback(created: bool, message: String) -> Variant:
	if created:
		return message
	return null

func _write_discovery_record() -> Error:
	var directory: String = _project_path.path_join(SESSION_DIRECTORY)
	var directory_error: Error = DirAccess.make_dir_recursive_absolute(directory)
	if directory_error != OK:
		return directory_error
	var record: Dictionary = {
		"project_path": _project_path,
		"editor_pid": _editor_pid,
		"editor_start_identity": _editor_start_identity,
		"port": _port,
		"token": _secret,
		"protocol_version": PROTOCOL_VERSION,
		"addon_version": ADDON_VERSION,
		"godot_version": str(Engine.get_version_info().get("string", "unknown")),
		"created_at": str(Time.get_unix_time_from_system()),
	}
	var temporary_path: String = _session_path + ".tmp-%d" % _editor_pid
	var file: FileAccess = FileAccess.open(temporary_path, FileAccess.WRITE)
	if file == null:
		return FileAccess.get_open_error()
	@warning_ignore("return_value_discarded")
	file.store_string(JSON.stringify(record) + "\n")
	file.flush()
	file.close()
	var permission_error: Error = FileAccess.set_unix_permissions(temporary_path, 384)
	if permission_error != OK and OS.get_name() not in ["Windows", "Web"]:
		@warning_ignore("return_value_discarded")
		DirAccess.remove_absolute(temporary_path)
		return permission_error
	if FileAccess.file_exists(_session_path):
		@warning_ignore("return_value_discarded")
		DirAccess.remove_absolute(_session_path)
	var rename_error: Error = DirAccess.rename_absolute(temporary_path, _session_path)
	if rename_error != OK:
		@warning_ignore("return_value_discarded")
		DirAccess.remove_absolute(temporary_path)
	return rename_error

func _remove_owned_discovery_record() -> void:
	if _session_path.is_empty() or not FileAccess.file_exists(_session_path):
		return
	var file: FileAccess = FileAccess.open(_session_path, FileAccess.READ)
	if file == null:
		return
	var parsed: Variant = JSON.parse_string(file.get_as_text())
	file.close()
	var parsed_record: Dictionary = parsed if parsed is Dictionary else {}
	if not parsed_record.is_empty() and str(parsed_record.get("editor_start_identity", "")) == _editor_start_identity:
		var remove_error: Error = DirAccess.remove_absolute(_session_path)
		if remove_error != OK:
			push_warning("Godot Agent Loop could not remove editor discovery record: %s" % error_string(remove_error))
