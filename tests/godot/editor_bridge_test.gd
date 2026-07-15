@tool
extends "res://addons/godot_agent_loop/plugin.gd"

## Strict, editor-runtime contract tests for the persistent bridge. This script
## deliberately calls the shipped EditorPlugin implementation rather than a
## test double so its discovery, authentication, transaction, synchronization,
## and activity semantics stay covered on the Godot side of the protocol.

var _failures: Array[String] = []


func _enter_tree() -> void:
	super._enter_tree()
	call_deferred("_run")


func _run() -> void:
	var plugin: EditorPlugin = self

	_test_dynamic_loopback_and_secret(plugin)
	_test_discovery_lifecycle(plugin)
	_test_authentication(plugin)
	_test_transaction_validation_and_values(plugin)
	_test_undo_redo_and_ownership(plugin)
	_test_activity_deduplication(plugin)
	await _test_synchronization_completion(plugin)

	_finish()


func _test_dynamic_loopback_and_secret(plugin: EditorPlugin) -> void:
	var first_secret: String = Marshalls.raw_to_base64(Crypto.new().generate_random_bytes(32))
	var second_secret: String = Marshalls.raw_to_base64(Crypto.new().generate_random_bytes(32))
	_assert_true(first_secret.length() >= 32, "a discovery secret has at least 256 bits of source entropy")
	_assert_true(first_secret != second_secret, "fresh discovery secrets differ")

	var original_port: Variant = plugin.get("_port")
	plugin.set("_port", 0)
	var selected_port_variant: Variant = plugin.call("_read_port")
	var selected_port: int = selected_port_variant if selected_port_variant is int else -1
	_assert_true(selected_port == 0, "an unset port requests dynamic binding")
	var server := TCPServer.new()
	var listen_error: Error = server.listen(0, "127.0.0.1")
	_assert_equal(listen_error, OK, "Godot binds a dynamic loopback port")
	_assert_true(server.get_local_port() > 0, "dynamic binding exposes the selected port")
	server.stop()
	plugin.set("_port", original_port)


func _test_discovery_lifecycle(plugin: EditorPlugin) -> void:
	var original_project_path: Variant = plugin.get("_project_path")
	var original_editor_pid: Variant = plugin.get("_editor_pid")
	var original_start_identity: Variant = plugin.get("_editor_start_identity")
	var original_port: Variant = plugin.get("_port")
	var original_secret: Variant = plugin.get("_secret")
	var original_session_path: Variant = plugin.get("_session_path")
	var temporary_root: String = OS.get_cache_dir().path_join("godot-agent-loop-editor-bridge-%d" % OS.get_process_id())
	var session_path: String = temporary_root.path_join(".godot/godot_agent_loop/editor-session.json")
	var cleanup_error: Error = _remove_tree(temporary_root)
	_assert_true(cleanup_error in [OK, ERR_DOES_NOT_EXIST], "the discovery fixture starts clean")
	plugin.set("_project_path", temporary_root)
	plugin.set("_editor_pid", OS.get_process_id())
	plugin.set("_editor_start_identity", "bridge-test-owned")
	plugin.set("_port", 43123)
	plugin.set("_secret", "bridge-test-secret")
	plugin.set("_session_path", session_path)

	var write_variant: Variant = plugin.call("_write_discovery_record")
	_assert_equal(write_variant, OK, "the bridge atomically publishes discovery")
	_assert_true(FileAccess.file_exists(session_path), "the discovery record exists")
	var record_file: FileAccess = FileAccess.open(session_path, FileAccess.READ)
	_assert_true(record_file != null, "the discovery record is readable")
	if record_file != null:
		var parsed_variant: Variant = JSON.parse_string(record_file.get_as_text())
		record_file.close()
		_assert_true(parsed_variant is Dictionary, "the discovery record is valid JSON")
		if parsed_variant is Dictionary:
			var record: Dictionary = parsed_variant
			_assert_equal(record.get("editor_start_identity"), "bridge-test-owned", "discovery records the editor start identity")
			_assert_equal(record.get("port"), 43123, "discovery records the dynamic endpoint")
			_assert_equal(record.get("token"), "bridge-test-secret", "discovery records the authentication token")
			_assert_equal(record.get("protocol_version"), "2", "discovery records protocol compatibility")
	if OS.get_name() not in ["Windows", "Web"]:
		_assert_equal(FileAccess.get_unix_permissions(session_path) & 511, 384, "discovery permissions are owner-only")

	plugin.call("_remove_owned_discovery_record")
	_assert_true(not FileAccess.file_exists(session_path), "owned discovery is removed on cleanup")

	var directory_error: Error = DirAccess.make_dir_recursive_absolute(session_path.get_base_dir())
	_assert_equal(directory_error, OK, "the ownership fixture directory exists")
	var foreign_file: FileAccess = FileAccess.open(session_path, FileAccess.WRITE)
	_assert_true(foreign_file != null, "a foreign discovery fixture can be written")
	if foreign_file != null:
		@warning_ignore("return_value_discarded")
		foreign_file.store_string(JSON.stringify({"editor_start_identity": "another-editor"}))
		foreign_file.close()
		foreign_file = null
	plugin.call("_remove_owned_discovery_record")
	_assert_true(FileAccess.file_exists(session_path), "cleanup preserves another editor's discovery record")
	var foreign_remove_error: Error = DirAccess.remove_absolute(session_path)
	_assert_equal(foreign_remove_error, OK, "the foreign discovery fixture can be removed explicitly")
	var session_directory_error: Error = DirAccess.remove_absolute(session_path.get_base_dir())
	_assert_equal(session_directory_error, OK, "the discovery session directory is removed")
	var godot_directory_error: Error = DirAccess.remove_absolute(temporary_root.path_join(".godot"))
	_assert_equal(godot_directory_error, OK, "the discovery metadata directory is removed")
	var root_directory_error: Error = DirAccess.remove_absolute(temporary_root)
	_assert_equal(root_directory_error, OK, "the discovery fixture root is removed")
	plugin.set("_project_path", original_project_path)
	plugin.set("_editor_pid", original_editor_pid)
	plugin.set("_editor_start_identity", original_start_identity)
	plugin.set("_port", original_port)
	plugin.set("_secret", original_secret)
	plugin.set("_session_path", original_session_path)


func _test_authentication(plugin: EditorPlugin) -> void:
	var original_connection_status: Variant = plugin.get("_connection_status")
	var original_project_path: Variant = plugin.get("_project_path")
	var original_editor_pid: Variant = plugin.get("_editor_pid")
	var original_start_identity: Variant = plugin.get("_editor_start_identity")
	var connection_status := Label.new()
	plugin.set("_connection_status", connection_status)
	plugin.set("_project_path", ProjectSettings.globalize_path("res://").trim_suffix("/"))
	plugin.set("_editor_pid", OS.get_process_id())
	plugin.set("_editor_start_identity", "bridge-test-auth")
	var incompatible_variant: Variant = plugin.call("_handshake", {
		"protocol_version": "1", "server_version": "test-server",
	})
	_assert_true(incompatible_variant is Dictionary, "an incompatible handshake returns a result")
	if incompatible_variant is Dictionary:
		var incompatible: Dictionary = incompatible_variant
		_assert_equal(incompatible.get("error"), "incompatible_protocol", "protocol mismatch is explicit")
	_assert_equal(plugin.get("_session_authenticated"), false, "protocol mismatch is not authenticated")

	var compatible_variant: Variant = plugin.call("_handshake", {
		"protocol_version": "2", "server_version": "test-server",
	})
	_assert_true(compatible_variant is Dictionary, "a compatible handshake returns a result")
	if compatible_variant is Dictionary:
		var compatible: Dictionary = compatible_variant
		_assert_equal(compatible.get("success"), true, "matching protocol authenticates")
		_assert_equal(compatible.get("editor_start_identity"), "bridge-test-auth", "handshake proves editor identity")
		_assert_equal(compatible.get("server_version"), "test-server", "handshake records the server version")
	_assert_equal(plugin.get("_session_authenticated"), true, "compatible session remains authenticated")
	connection_status.free()
	plugin.set("_connection_status", original_connection_status)
	plugin.set("_project_path", original_project_path)
	plugin.set("_editor_pid", original_editor_pid)
	plugin.set("_editor_start_identity", original_start_identity)


func _test_transaction_validation_and_values(plugin: EditorPlugin) -> void:
	var scene_root := Node2D.new()
	scene_root.name = "Root"
	var owned := Node2D.new()
	owned.name = "Owned"
	scene_root.add_child(owned)
	owned.owner = scene_root
	var foreign := Node2D.new()
	foreign.name = "Foreign"
	scene_root.add_child(foreign)

	var valid_variant: Variant = plugin.call("_validate_transaction", scene_root, [
		{
			"op": "add_node", "parent_path": ".", "node_type": "Node3D", "node_name": "World",
			"properties": {"position": {"type": "Vector3", "value": [1, 2, 3]}},
		},
		{"op": "set_properties", "node_path": "Owned", "properties": {"position": {"type": "Vector2", "value": [12, 34]} }},
	])
	_assert_true(valid_variant is Dictionary, "a valid compound transaction is validated")
	if valid_variant is Dictionary:
		var valid: Dictionary = valid_variant
		_assert_true(not valid.has("error"), "a valid compound transaction has no error")
		var stages_variant: Variant = valid.get("stages", [])
		var stages: Array = stages_variant if stages_variant is Array else []
		_assert_true(stages.size() == 2, "validation stages every operation before applying")
		for stage_variant: Variant in stages:
			if stage_variant is Dictionary:
				var stage: Dictionary = stage_variant
				var staged_node_variant: Variant = stage.get("node")
				if staged_node_variant is Node:
					var staged_node: Node = staged_node_variant
					if staged_node.get_parent() == null:
						staged_node.free()

	var root_removal_variant: Variant = plugin.call("_validate_transaction", scene_root, [{"op": "remove_node", "node_path": "."}])
	_assert_dictionary_error(root_removal_variant, "cannot_remove_scene_root", "the scene root cannot be removed")
	var foreign_edit_variant: Variant = plugin.call("_validate_transaction", scene_root, [{"op": "rename_node", "node_path": "Foreign", "name": "Changed"}])
	_assert_dictionary_error(foreign_edit_variant, "inherited_or_noneditable_node", "non-owned scene content is protected")
	var invalid_type_variant: Variant = plugin.call("_validate_transaction", scene_root, [{"op": "add_node", "node_type": "NotARealNode", "node_name": "Broken"}])
	_assert_dictionary_error(invalid_type_variant, "invalid_node_type", "invalid node types are rejected before mutation")

	var vector_variant: Variant = plugin.call("_decode_editor_value", {"type": "Vector2", "value": [5, 7]}, Vector2.ZERO)
	var vector_result: Dictionary = vector_variant if vector_variant is Dictionary else {}
	_assert_equal(vector_result.get("value"), Vector2(5, 7), "typed Vector2 values decode safely")
	var color_variant: Variant = plugin.call("_decode_editor_value", {"type": "Color", "value": "#336699"}, Color.WHITE)
	var color_result: Dictionary = color_variant if color_variant is Dictionary else {}
	_assert_true(color_result.get("value") is Color, "typed Color values decode safely")

	scene_root.free()


func _test_undo_redo_and_ownership(plugin: EditorPlugin) -> void:
	var scene_root := Node2D.new()
	scene_root.name = "UndoRoot"
	var scene_tree: SceneTree = get_tree()
	scene_tree.root.add_child(scene_root)
	var child := Node2D.new()
	child.name = "Before"
	scene_root.add_child(child)
	child.owner = scene_root
	var validation_variant: Variant = plugin.call("_validate_transaction", scene_root, [
		{"op": "rename_node", "node_path": "Before", "name": "After"},
	])
	_assert_true(validation_variant is Dictionary, "the undo fixture validates")
	if validation_variant is Dictionary:
		var validation: Dictionary = validation_variant
		var stages_variant: Variant = validation.get("stages", [])
		if stages_variant is Array:
			var stages: Array = stages_variant
			var manager: EditorUndoRedoManager = EditorInterface.get_editor_undo_redo()
			_assert_true(manager != null, "the editor provides an undo manager")
			if manager != null and not stages.is_empty() and stages[0] is Dictionary:
				manager.create_action("Bridge contract rename")
				plugin.call("_apply_transaction_stage", manager, scene_root, stages[0])
				manager.commit_action()
				var history_id: int = manager.get_object_history_id(scene_root)
				var history: UndoRedo = manager.get_history_undo_redo(history_id)
				_assert_equal(child.name, "After", "committing the transaction applies its stage")
				_assert_true(history.undo(), "one editor undo reverses the transaction")
				_assert_equal(child.name, "Before", "undo restores the prior state")
				_assert_true(history.redo(), "one editor redo reapplies the transaction")
				_assert_equal(child.name, "After", "redo restores the committed state")
				_assert_equal(child.owner, scene_root, "undo/redo preserves scene ownership")
	scene_root.free()


func _test_activity_deduplication(plugin: EditorPlugin) -> void:
	var original_activity_list: Variant = plugin.get("_activity_list")
	var activity_list := ItemList.new()
	plugin.set("_activity_list", activity_list)
	plugin.set("_activity_entries", [])
	plugin.set("_activity_event_ids", {})
	for event_id: int in range(1, 206):
		plugin.call("_record_activity", {
			"event_id": event_id, "event": "completed", "command": "test_command",
			"target": "editor", "outcome": "success", "duration_ms": event_id,
		})
	var entries_variant: Variant = plugin.get("_activity_entries")
	var entries: Array = entries_variant if entries_variant is Array else []
	_assert_true(entries.size() == 200, "the activity dock keeps a bounded 200-event ring")
	var duplicate_variant: Variant = plugin.call("_record_activity", {
		"event_id": 205, "event": "completed", "command": "test_command",
		"target": "editor", "outcome": "success",
	})
	var duplicate_result: Dictionary = duplicate_variant if duplicate_variant is Dictionary else {}
	_assert_equal(duplicate_result.get("deduplicated"), true, "replayed lifecycle events are deduplicated")
	entries_variant = plugin.get("_activity_entries")
	entries = entries_variant if entries_variant is Array else []
	_assert_true(entries.size() == 200, "deduplication does not grow the activity ring")
	activity_list.free()
	plugin.set("_activity_list", original_activity_list)


func _test_synchronization_completion(plugin: EditorPlugin) -> void:
	var sync_variant: Variant = await plugin.call("_sync_filesystem", {"command": "bridge_contract"})
	_assert_true(sync_variant is Dictionary, "filesystem synchronization returns a structured acknowledgement")
	if sync_variant is Dictionary:
		var sync: Dictionary = sync_variant
		_assert_equal(sync.get("success"), true, "filesystem synchronization completes")
		_assert_equal(sync.get("state"), "connected", "completed synchronization returns to connected state")
		var observed_variant: Variant = sync.get("observed_target_state", {})
		var observed: Dictionary = observed_variant if observed_variant is Dictionary else {}
		_assert_equal(observed.get("scan_complete"), true, "synchronization independently observes scan completion")


func _assert_dictionary_error(value: Variant, expected: String, message: String) -> void:
	var result: Dictionary = value if value is Dictionary else {}
	_assert_equal(result.get("error"), expected, message)


func _assert_equal(actual: Variant, expected: Variant, message: String) -> void:
	if actual != expected:
		_failures.append("%s (expected %s, got %s)" % [message, str(expected), str(actual)])


func _assert_true(condition: bool, message: String) -> void:
	if not condition:
		_failures.append(message)


func _remove_tree(path: String) -> Error:
	if not DirAccess.dir_exists_absolute(path):
		return ERR_DOES_NOT_EXIST
	var directory: DirAccess = DirAccess.open(path)
	if directory == null:
		return DirAccess.get_open_error()
	var list_error: Error = directory.list_dir_begin()
	if list_error != OK:
		return list_error
	var entry_name: String = directory.get_next()
	while not entry_name.is_empty():
		if entry_name not in [".", ".."]:
			var entry_path: String = path.path_join(entry_name)
			if directory.current_is_dir():
				var child_error: Error = _remove_tree(entry_path)
				if child_error != OK:
					directory.list_dir_end()
					return child_error
			else:
				var remove_file_error: Error = DirAccess.remove_absolute(entry_path)
				if remove_file_error != OK:
					directory.list_dir_end()
					return remove_file_error
		entry_name = directory.get_next()
	directory.list_dir_end()
	directory = null
	return DirAccess.remove_absolute(path)


func _finish() -> void:
	if _failures.is_empty():
		print("EDITOR_BRIDGE_TESTS_PASSED")
		return
	for failure: String in _failures:
		push_error("EDITOR_BRIDGE_TEST_FAILED: %s" % failure)
