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

func _enter_tree() -> void:
	set_process(true)
	_port = _read_port()
	_secret = OS.get_environment("GODOT_MCP_EDITOR_SECRET")
	_server = TCPServer.new()
	var error: int = _server.listen(_port, "127.0.0.1")
	if error != OK:
		push_error("Godot MCP editor bridge could not listen on %d: %s" % [_port, error_string(error)])

func _exit_tree() -> void:
	set_process(false)
	if _peer != null:
		_peer.disconnect_from_host()
	_peer = null
	if _server != null:
		_server.stop()
	_server = null

func _process(_delta: float) -> void:
	if _server != null and _server.is_connection_available():
		if _peer != null:
			_server.take_connection().disconnect_from_host()
		else:
			_peer = _server.take_connection()
	if _peer == null:
		return
	_peer.poll()
	if _peer.get_status() != StreamPeerTCP.STATUS_CONNECTED:
		_peer = null
		_buffer = PackedByteArray()
		return
	var available: int = _peer.get_available_bytes()
	if available <= 0:
		return
	var incoming: Array = _peer.get_data(min(available, 64 * 1024))
	if incoming[0] != OK:
		return
	_buffer.append_array(incoming[1])
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
	var result: Dictionary = _dispatch(command, request.get("params", {}))
	result["id"] = request.get("id", null)
	_send(result)

func _dispatch(command: String, raw_params: Variant) -> Dictionary:
	var params: Dictionary = raw_params if raw_params is Dictionary else {}
	match command:
		"inspect":
			return _inspect()
		"select":
			return _select(params)
		"save":
			get_editor_interface().save_scene()
			return {"success": true, "saved": true}
		"reload":
			var scene_path: String = str(params.get("scene_path", ""))
			var reload_result: Variant = get_editor_interface().call("reload_scene_from_path", scene_path)
			return {"success": reload_result != false, "scene_path": scene_path}
		"open_scene":
			var open_path: String = str(params.get("scene_path", ""))
			if open_path.is_empty():
				return {"error": "scene_path is required"}
			var open_result: Variant = get_editor_interface().call("open_scene_from_path", open_path)
			return {"success": open_result != false, "scene_path": open_path}
		"set_property":
			return _set_property(params)
		"rename_node":
			return _rename_node(params)
		"undo":
			var undo_redo: Variant = get_editor_interface().call("get_editor_undo_redo")
			if undo_redo != null: undo_redo.call("undo")
			return {"success": undo_redo != null, "action": "undo"}
		"redo":
			var redo_manager: Variant = get_editor_interface().call("get_editor_undo_redo")
			if redo_manager != null: redo_manager.call("redo")
			return {"success": redo_manager != null, "action": "redo"}
		_:
			return {"error": "unknown_command", "allowed": ["inspect", "select", "save", "reload", "open_scene", "set_property", "rename_node", "undo", "redo"]}

func _inspect() -> Dictionary:
	var interface: EditorInterface = get_editor_interface()
	var root: Node = interface.get_edited_scene_root()
	var selected: Array[String] = []
	var selection: EditorSelection = interface.get_selection()
	for node: Node in selection.get_selected_nodes():
		selected.append(str(node.get_path()))
	var open_scenes: Array = []
	var open_result: Variant = interface.call("get_open_scenes")
	if open_result is PackedStringArray:
		open_scenes = Array(open_result)
	return {"success": true, "edited_scene": "" if root == null else str(root.scene_file_path),
		"edited_root": null if root == null else {"name": root.name, "type": root.get_class(), "path": str(root.get_path())},
		"selection": selected, "open_scenes": open_scenes,
		"has_undo_redo": interface.call("get_editor_undo_redo") != null}

func _select(params: Dictionary) -> Dictionary:
	var selection: EditorSelection = get_editor_interface().get_selection()
	selection.clear()
	var root: Node = get_editor_interface().get_edited_scene_root()
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
	return {"success": true, "selection": selected}

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
	var root: Node = get_editor_interface().get_edited_scene_root()
	if root == null: return null
	var path: String = str(params.get("node_path", "."))
	return root if path == "." or path.is_empty() else root.get_node_or_null(NodePath(path))

func _commit_property_action(target: Node, property: String, before: Variant, after: Variant) -> Dictionary:
	var manager: Variant = get_editor_interface().call("get_editor_undo_redo")
	if manager == null: return {"error": "undo_redo_unavailable"}
	manager.call("create_action", "MCP %s" % property)
	manager.call("add_do_property", target, property, after)
	manager.call("add_undo_property", target, property, before)
	manager.call("commit_action")
	return {"success": true, "property": property, "before": before, "after": target.get(property), "undo_recorded": true}

func _send(response: Dictionary) -> void:
	if _peer == null:
		return
	_peer.put_data((JSON.stringify(response) + "\n").to_utf8_buffer())

func _read_port() -> int:
	var configured: String = OS.get_environment("GODOT_MCP_EDITOR_PORT")
	if configured.is_valid_int():
		var value: int = int(configured)
		if value > 0 and value < 65536: return value
	return _port
