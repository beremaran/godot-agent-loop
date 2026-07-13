extends "res://mcp_runtime/runtime_domain.gd"

# Core scene, node, property, group, and signal commands. This domain owns
# scene-tree mutation and introspection while transport lifecycle stays in the
# composition root.

var _await_signal_received: bool = false
var _await_signal_args: Array = []

func register_commands() -> void:
	register_command("get_scene_tree", _cmd_get_scene_tree)
	register_command("get_property", _cmd_get_property)
	register_command("set_property", _cmd_set_property)
	register_command("call_method", _cmd_call_method)
	register_command("get_node_info", _cmd_get_node_info)
	register_command("instantiate_scene", _cmd_instantiate_scene)
	register_command("remove_node", _cmd_remove_node)
	register_command("change_scene", _cmd_change_scene)
	register_command("connect_signal", _cmd_connect_signal)
	register_command("disconnect_signal", _cmd_disconnect_signal)
	register_command("emit_signal", _cmd_emit_signal)
	register_command("get_nodes_in_group", _cmd_get_nodes_in_group)
	register_command("find_nodes_by_class", _cmd_find_nodes_by_class)
	register_command("reparent_node", _cmd_reparent_node)
	register_command("spawn_node", _cmd_spawn_node)
	register_command("manage_group", _cmd_manage_group)
	register_command("list_signals", _cmd_list_signals)
	register_command("await_signal", _cmd_await_signal)


func _cmd_get_scene_tree(_params: Dictionary) -> void:
	var tree: Dictionary = _build_tree_node(get_tree().root)
	respond({"success": true, "tree": tree})

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


func _cmd_get_property(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var node_path: String = reader.required_node_path()
	var property: String = reader.required_string("property")
	var node: Node = require_node(reader)
	if params_invalid(reader):
		return
	if not property in node:
		reader.fail("Property not found: %s on node %s" % [property, node_path], {"param": "property", "reason": "property_not_found", "value": property})
		send_params_error(reader)
		return

	var value: Variant = node.get(property)
	respond({"success": true, "value": variant_to_json(value), "property": property, "node_path": node_path})


# --- Set Property ---

func _cmd_set_property(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var node_path: String = reader.required_node_path()
	var property: String = reader.required_string("property")
	var type_hint: String = reader.optional_string("type_hint", "")
	var node: Node = require_node(reader)
	if params_invalid(reader):
		return

	var raw_value: Variant = reader.raw("value")
	var value: Variant
	if type_hint.is_empty():
		value = json_to_variant_for_property(node, property, raw_value)
	else:
		value = json_to_variant(raw_value, type_hint)
	node.set(property, value)
	respond({"success": true, "node_path": node_path, "property": property, "value": variant_to_json(node.get(property))})


# --- Call Method ---

func _cmd_call_method(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var node_path: String = reader.required_node_path()
	var method_name: String = reader.required_string("method")
	var args: Array = reader.optional_array("args")
	var node: Node = require_node(reader)
	if not reader.failed() and not node.has_method(method_name):
		reader.fail("Method not found: %s on node %s" % [method_name, node_path], {"param": "method", "reason": "method_not_found", "value": method_name})
	if params_invalid(reader):
		return

	var result: Variant = node.callv(method_name, args)
	respond({"success": true, "result": variant_to_json(result)})


# --- Get Node Info ---

func _cmd_get_node_info(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	if node_path.is_empty():
		respond({"error": "node_path is required"})
		return

	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		respond({"error": "Node not found: %s" % node_path})
		return

	var properties: Array = []
	for prop in node.get_property_list():
		var prop_dict: Dictionary = prop
		if prop_dict.get("usage", 0) & PROPERTY_USAGE_EDITOR:
			var property_name: String = CommandParams.json_string(prop_dict, "name")
			properties.append({
				"name": property_name,
				"type": prop_dict.get("type", 0),
				"value": variant_to_json(node.get(property_name))
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

	respond({
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
	var parent: Node = require_node(reader, "parent_path", "/root")
	if params_invalid(reader):
		return

	var packed: PackedScene = load(scene_path) as PackedScene
	if packed == null:
		respond({"error": "Failed to load scene: %s" % scene_path, "error_data": {"param": "scene_path", "reason": "resource_not_found", "value": scene_path}})
		return

	var instance: Node = packed.instantiate()
	parent.add_child(instance)
	respond({"success": true, "instance_name": instance.name, "instance_path": str(instance.get_path())})


# --- Remove Node ---

func _cmd_remove_node(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	if node_path.is_empty():
		respond({"error": "node_path is required"})
		return

	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		respond({"error": "Node not found: %s" % node_path})
		return

	var node_name: String = node.name
	node.queue_free()
	respond({"success": true, "removed": node_name})


# --- Change Scene ---

func _cmd_change_scene(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var scene_path: String = reader.required_resource_path("scene_path")
	if params_invalid(reader):
		return

	var err: int = get_tree().change_scene_to_file(scene_path)
	if err != OK:
		respond({"error": "Failed to change scene to %s: %s" % [scene_path, error_string(err)], "error_data": godot_error_data(err)})
		return

	respond({"success": true, "scene": scene_path})


# --- Pause ---

func _cmd_connect_signal(params: Dictionary) -> void:
	var reader := CommandParams.new(params)
	var node_path: String = reader.required_node_path()
	var signal_name: String = reader.required_string("signal_name")
	var target_path: String = reader.required_node_path("target_path")
	var method_name: String = reader.required_string("method")
	var binds: Array = reader.optional_array("binds")
	var deferred: bool = reader.optional_bool("deferred", false)
	var one_shot: bool = reader.optional_bool("one_shot", false)
	var reference_counted: bool = reader.optional_bool("reference_counted", false)
	if params_invalid(reader):
		return

	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		respond({"error": "Source node not found: %s" % node_path})
		return

	var target: Node = get_tree().root.get_node_or_null(target_path)
	if target == null:
		respond({"error": "Target node not found: %s" % target_path})
		return

	if not node.has_signal(signal_name):
		respond({"error": "Signal '%s' not found on node %s" % [signal_name, node_path]})
		return

	if not target.has_method(method_name):
		respond({"error": "Method '%s' not found on target %s" % [method_name, target_path]})
		return

	var callable: Callable = Callable(target, method_name).bindv(binds)
	if node.is_connected(signal_name, callable) and not reference_counted:
		respond({"error": "Signal already connected"})
		return

	var flags: int = 0
	if deferred:
		flags |= CONNECT_DEFERRED
	if one_shot:
		flags |= CONNECT_ONE_SHOT
	if reference_counted:
		flags |= CONNECT_REFERENCE_COUNTED
	var err: int = node.connect(signal_name, callable, flags)
	if err != OK:
		respond({"error": "Failed to connect signal: %s" % error_string(err), "error_data": godot_error_data(err)})
		return
	respond({"success": true, "signal": signal_name, "from": node_path, "to": target_path, "method": method_name, "bind_count": binds.size(), "flags": flags})


# --- Disconnect Signal ---

func _cmd_disconnect_signal(params: Dictionary) -> void:
	var reader := CommandParams.new(params)
	var node_path: String = reader.required_node_path()
	var signal_name: String = reader.required_string("signal_name")
	var target_path: String = reader.required_node_path("target_path")
	var method_name: String = reader.required_string("method")
	var binds: Array = reader.optional_array("binds")
	if params_invalid(reader):
		return

	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		respond({"error": "Source node not found: %s" % node_path})
		return

	var target: Node = get_tree().root.get_node_or_null(target_path)
	if target == null:
		respond({"error": "Target node not found: %s" % target_path})
		return

	var callable: Callable = Callable(target, method_name).bindv(binds)
	if not node.is_connected(signal_name, callable):
		respond({"error": "Signal is not connected"})
		return

	node.disconnect(signal_name, callable)
	respond({"success": true, "disconnected": signal_name, "from": node_path, "to": target_path, "method": method_name})


# --- Emit Signal ---

func _cmd_emit_signal(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	var signal_name: String = params.get("signal_name", "")
	if node_path.is_empty() or signal_name.is_empty():
		respond({"error": "node_path and signal_name are required"})
		return

	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		respond({"error": "Node not found: %s" % node_path})
		return

	if not node.has_signal(signal_name):
		respond({"error": "Signal '%s' not found on node %s" % [signal_name, node_path]})
		return

	var args: Array = params.get("args", [])
	var call_args: Array = [signal_name]
	call_args.append_array(args)
	node.callv("emit_signal", call_args)
	respond({"success": true, "emitted": signal_name, "node": node_path, "arg_count": args.size()})


# --- Play Animation ---

func _cmd_get_nodes_in_group(params: Dictionary) -> void:
	var group_name: String = params.get("group", "")
	if group_name.is_empty():
		respond({"error": "group is required"})
		return

	var nodes: Array = get_tree().get_nodes_in_group(group_name)
	var result: Array = []
	for node: Node in nodes:
		result.append({
			"name": node.name,
			"type": node.get_class(),
			"path": str(node.get_path())
		})
	respond({"success": true, "group": group_name, "count": result.size(), "nodes": result})


# --- Find Nodes By Class ---

func _cmd_find_nodes_by_class(params: Dictionary) -> void:
	var class_filter: String = params.get("class_name", "")
	if class_filter.is_empty():
		respond({"error": "class_name is required"})
		return

	var root_path: String = params.get("root_path", "/root")
	var root_node: Node = get_tree().root.get_node_or_null(root_path)
	if root_node == null:
		respond({"error": "Root node not found: %s" % root_path})
		return

	var found: Array = []
	_find_by_class_recursive(root_node, class_filter, found)
	respond({"success": true, "class_name": class_filter, "count": found.size(), "nodes": found})

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
		respond({"error": "node_path and new_parent_path are required"})
		return

	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		respond({"error": "Node not found: %s" % node_path})
		return

	var new_parent: Node = get_tree().root.get_node_or_null(new_parent_path)
	if new_parent == null:
		respond({"error": "New parent not found: %s" % new_parent_path})
		return

	var keep_global: bool = params.get("keep_global_transform", true)
	node.reparent(new_parent, keep_global)
	respond({"success": true, "node": node.name, "new_parent": new_parent_path, "new_path": str(node.get_path())})


# --- Get Camera ---

func _cmd_spawn_node(params: Dictionary) -> void:
	var type_name: String = params.get("type", "")
	var node_name: String = params.get("name", "")
	var parent_path: String = params.get("parent_path", "/root")

	if type_name.is_empty():
		respond({"error": "type is required"})
		return

	if not ClassDB.class_exists(type_name):
		respond({"error": "Unknown class: %s" % type_name})
		return

	if not ClassDB.is_parent_class(type_name, "Node") and type_name != "Node":
		respond({"error": "Class '%s' is not a Node type" % type_name})
		return

	var parent: Node = get_tree().root.get_node_or_null(parent_path)
	if parent == null:
		respond({"error": "Parent node not found: %s" % parent_path})
		return

	# A class that is not a Node (or does not exist) instantiates to a value this
	# command cannot add to the tree.
	var instantiated: Variant = ClassDB.instantiate(type_name)
	if not instantiated is Node:
		respond({"error": "Failed to instantiate: %s" % type_name})
		return
	var instance: Node = instantiated

	if node_name.length() > 0:
		instance.name = node_name

	# Apply properties if provided
	var properties: Dictionary = CommandParams.json_dictionary(params, "properties")
	for prop_name: Variant in properties:
		var property: String = str(prop_name)
		var raw_value: Variant = properties[prop_name]
		var value: Variant = json_to_variant_for_property(instance, property, raw_value)
		instance.set(property, value)

	parent.add_child(instance)
	respond({"success": true, "name": instance.name, "type": type_name, "path": str(instance.get_path())})


# --- Set Shader Parameter ---

func _cmd_manage_group(params: Dictionary) -> void:
	var action: String = params.get("action", "")
	var group_name: String = params.get("group", "")

	if action == "clear_group":
		if group_name.is_empty():
			respond({"error": "group is required for clear_group"})
			return
		var nodes: Array = get_tree().get_nodes_in_group(group_name)
		for node: Node in nodes:
			node.remove_from_group(group_name)
		respond({"success": true, "action": "clear_group", "group": group_name, "removed_count": nodes.size()})
		return

	var node_path: String = params.get("node_path", "")
	if node_path.is_empty():
		respond({"error": "node_path is required"})
		return

	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		respond({"error": "Node not found: %s" % node_path})
		return

	match action:
		"add":
			if group_name.is_empty():
				respond({"error": "group is required for add"})
				return
			node.add_to_group(group_name)
			respond({"success": true, "action": "add", "node_path": node_path, "group": group_name})
		"remove":
			if group_name.is_empty():
				respond({"error": "group is required for remove"})
				return
			node.remove_from_group(group_name)
			respond({"success": true, "action": "remove", "node_path": node_path, "group": group_name})
		"get_groups":
			var groups: Array = []
			for g in node.get_groups():
				groups.append(str(g))
			respond({"success": true, "action": "get_groups", "node_path": node_path, "groups": groups})
		_:
			respond({"error": "Unknown group action: %s. Use add, remove, get_groups, or clear_group" % action})


# --- Create Timer ---

func _cmd_list_signals(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var node_path: String = reader.required_node_path()
	var node: Node = require_node(reader)
	if params_invalid(reader):
		return
	var signals: Array = []
	for sig: Dictionary in node.get_signal_list():
		var sig_name: String = CommandParams.json_string(sig, "name")
		var connections: Array = []
		for conn: Dictionary in node.get_signal_connection_list(sig_name):
			connections.append({"callable": str(conn["callable"]), "flags": conn["flags"]})
		signals.append({"name": sig_name, "args": str(sig["args"]), "connections": connections})
	respond({"success": true, "node_path": node_path, "signals": signals})

func _cmd_await_signal(params: Dictionary) -> void:
	var reader := CommandParams.new(params)
	var node_path: String = reader.required_node_path()
	var signal_name: String = reader.required_string("signal_name")
	var timeout: float = reader.optional_number("timeout", 10.0, 0.01, 30.0)
	var node: Node = require_node(reader)
	if params_invalid(reader):
		return
	if not node.has_signal(signal_name):
		reader.fail("Signal not found", {"param": "signal_name", "reason": "signal_not_found", "value": signal_name})
		send_params_error(reader)
		return
	var argument_count: int = 0
	for signal_info: Dictionary in node.get_signal_list():
		if CommandParams.json_string(signal_info, "name") == signal_name:
			argument_count = CommandParams.json_array(signal_info, "args").size()
			break
	if argument_count > 8:
		reader.fail("Signal has too many arguments to await", {"param": "signal_name", "reason": "limit_exceeded", "max_args": 8, "actual_args": argument_count})
		send_params_error(reader)
		return
	var timer: SceneTreeTimer = get_tree().create_timer(timeout)
	_await_signal_received = false
	_await_signal_args = []
	var cb := Callable(self, "_capture_signal_%d" % argument_count)
	@warning_ignore("return_value_discarded")
	node.connect(signal_name, cb, CONNECT_ONE_SHOT)
	while not _await_signal_received and timer.time_left > 0:
		await get_tree().process_frame
		if cancellation_requested():
			break
		if not is_instance_valid(node):
			respond({"error": "Node was freed while awaiting signal", "error_data": {"reason": "node_freed", "node_path": node_path, "signal_name": signal_name}})
			return
	if is_instance_valid(node) and node.is_connected(signal_name, cb):
		node.disconnect(signal_name, cb)
	if cancellation_requested():
		respond({})
		return
	if _await_signal_received:
		respond({"success": true, "signal_name": signal_name, "received": true, "args": variant_to_json(_await_signal_args)})
	else:
		respond_timeout("Signal wait timed out", {"command": "await_signal", "timeout_seconds": timeout})


func _capture_signal_0() -> void:
	_capture_signal_args([])

func _capture_signal_1(a: Variant) -> void:
	_capture_signal_args([a])

func _capture_signal_2(a: Variant, b: Variant) -> void:
	_capture_signal_args([a, b])

func _capture_signal_3(a: Variant, b: Variant, c: Variant) -> void:
	_capture_signal_args([a, b, c])

func _capture_signal_4(a: Variant, b: Variant, c: Variant, d: Variant) -> void:
	_capture_signal_args([a, b, c, d])

func _capture_signal_5(a: Variant, b: Variant, c: Variant, d: Variant, e: Variant) -> void:
	_capture_signal_args([a, b, c, d, e])

func _capture_signal_6(a: Variant, b: Variant, c: Variant, d: Variant, e: Variant, f: Variant) -> void:
	_capture_signal_args([a, b, c, d, e, f])

func _capture_signal_7(a: Variant, b: Variant, c: Variant, d: Variant, e: Variant, f: Variant, g: Variant) -> void:
	_capture_signal_args([a, b, c, d, e, f, g])

func _capture_signal_8(a: Variant, b: Variant, c: Variant, d: Variant, e: Variant, f: Variant, g: Variant, h: Variant) -> void:
	_capture_signal_args([a, b, c, d, e, f, g, h])

func _capture_signal_args(args: Array) -> void:
	_await_signal_received = true
	_await_signal_args = args
