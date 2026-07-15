extends "res://mcp_runtime/runtime_domain.gd"

# Window, engine, localization, and resource/project-state commands.

const MAX_RESOURCE_PATH_BYTES: int = 4096
const MAX_THREADED_LOAD_FRAMES: int = 600

var _preloaded_resources: Dictionary = {}

func register_commands() -> void:
	register_command("window", _cmd_window)
	register_command("os_info", _cmd_os_info)
	register_command("time_scale", _cmd_time_scale)
	register_command("process_mode", _cmd_process_mode)
	register_command("world_settings", _cmd_world_settings)
	register_command("locale", _cmd_locale)
	register_command("resource", _cmd_resource)


func _cmd_window(params: Dictionary) -> void:
	var reader := CommandParams.new(params)
	var action: String = reader.optional_enum("action", "get", ["get", "set"])
	var width: int = reader.optional_int("width", -1, 1)
	var height: int = reader.optional_int("height", -1, 1)
	var fullscreen: bool = reader.optional_bool("fullscreen", false)
	var borderless: bool = reader.optional_bool("borderless", false)
	var title: String = reader.optional_string("title")
	var position: Dictionary = reader.optional_dictionary("position")
	var vsync: bool = reader.optional_bool("vsync", false)
	if params_invalid(reader):
		return
	var win: Window = get_tree().root
	if action == "get":
		respond({"success": true, "size": {"x": win.size.x, "y": win.size.y}, "position": {"x": win.position.x, "y": win.position.y}, "fullscreen": win.mode == Window.MODE_FULLSCREEN, "borderless": win.borderless, "title": win.title})
		return
	if DisplayServer.get_name() == "headless" and (reader.has_param("borderless") or reader.has_param("vsync")):
		respond_limit(
			"borderless and vsync changes are unavailable with Godot's headless display driver",
			{"reason": "display_feature_unavailable", "display_driver": DisplayServer.get_name()},
		)
		return
	if reader.has_param("width") != reader.has_param("height"):
		reader.fail("width and height must be provided together", {"param": "width", "reason": "missing_pair", "paired_with": "height"})
		send_params_error(reader)
		return
	if reader.has_param("width"):
		win.size = Vector2i(width, height)
	if reader.has_param("fullscreen"):
		win.mode = Window.MODE_FULLSCREEN if fullscreen else Window.MODE_WINDOWED
	if reader.has_param("borderless"):
		win.borderless = borderless
	if reader.has_param("title"):
		win.title = title
	if reader.has_param("position"):
		win.position = Vector2i(CommandParams.json_int(position, "x"), CommandParams.json_int(position, "y"))
	if reader.has_param("vsync"):
		DisplayServer.window_set_vsync_mode(DisplayServer.VSYNC_ENABLED if vsync else DisplayServer.VSYNC_DISABLED)
	respond({"success": true, "action": action, "size": {"x": win.size.x, "y": win.size.y}})


func _cmd_os_info(_params: Dictionary) -> void:
	var screen_size: Vector2i = DisplayServer.screen_get_size()
	respond({"success": true, "os_name": OS.get_name(), "locale": OS.get_locale(), "screen_size": {"x": screen_size.x, "y": screen_size.y}, "video_adapter": RenderingServer.get_video_adapter_name(), "rendering_method": RenderingServer.get_current_rendering_method(), "processor_count": OS.get_processor_count()})


func _cmd_time_scale(params: Dictionary) -> void:
	var reader := CommandParams.new(params)
	var action: String = reader.optional_enum("action", "get", ["get", "set"])
	var time_scale: float = reader.optional_number("time_scale", 1.0, 0.0)
	if action == "set" and not reader.has_param("time_scale"):
		reader.fail("time_scale is required for set", {"param": "time_scale", "reason": "missing"})
	if params_invalid(reader):
		return
	if action == "set":
		Engine.time_scale = time_scale
	respond({
		"success": true,
		"time_scale": Engine.time_scale,
		"fixed_fps": _configured_fixed_fps(),
		"timing_mode": OS.get_environment("GODOT_MCP_TIMING_MODE") if not OS.get_environment("GODOT_MCP_TIMING_MODE").is_empty() else "external",
		"display_pacing": OS.get_environment("GODOT_MCP_TIMING_MODE") == "realtime",
		"ticks_msec": Time.get_ticks_msec(),
		"fps": Engine.get_frames_per_second(),
	})


func _configured_fixed_fps() -> int:
	var configured: String = OS.get_environment("GODOT_MCP_FIXED_FPS")
	if configured.is_valid_int():
		return int(configured)
	return 0


func _cmd_process_mode(params: Dictionary) -> void:
	var reader := CommandParams.new(params)
	var node: Node = require_node(reader)
	var mode: String = reader.optional_enum("mode", "inherit", ["inherit", "pausable", "when_paused", "always", "disabled"])
	if params_invalid(reader):
		return
	var modes: Dictionary = {
		"inherit": Node.PROCESS_MODE_INHERIT,
		"pausable": Node.PROCESS_MODE_PAUSABLE,
		"when_paused": Node.PROCESS_MODE_WHEN_PAUSED,
		"always": Node.PROCESS_MODE_ALWAYS,
		"disabled": Node.PROCESS_MODE_DISABLED,
	}
	node.process_mode = modes[mode]
	respond({"success": true, "node_path": str(node.get_path()), "mode": mode})


func _cmd_world_settings(params: Dictionary) -> void:
	var reader := CommandParams.new(params)
	var action: String = reader.optional_enum("action", "get", ["get", "set"])
	var gravity: float = reader.optional_number("gravity", 9.8, 0.0)
	var gravity_direction: Dictionary = reader.optional_dictionary("gravity_direction")
	var physics_fps: int = reader.optional_int("physics_fps", 60, 1)
	if params_invalid(reader):
		return

	# ProjectSettings alone only seeds *new* worlds; the running space keeps the
	# gravity it was created with. Both are written so the change is observable
	# in the live simulation and still survives into any later-created world.
	var space: RID = get_viewport().find_world_3d().space
	if action == "set":
		if reader.has_param("gravity"):
			ProjectSettings.set_setting("physics/3d/default_gravity", gravity)
			PhysicsServer3D.area_set_param(space, PhysicsServer3D.AREA_PARAM_GRAVITY, gravity)
		if reader.has_param("gravity_direction"):
			var direction := Vector3(
				CommandParams.json_float(gravity_direction, "x"),
				CommandParams.json_float(gravity_direction, "y"),
				CommandParams.json_float(gravity_direction, "z"),
			)
			ProjectSettings.set_setting("physics/3d/default_gravity_vector", direction)
			PhysicsServer3D.area_set_param(space, PhysicsServer3D.AREA_PARAM_GRAVITY_VECTOR, direction)
		if reader.has_param("physics_fps"):
			Engine.physics_ticks_per_second = physics_fps

	var vector: Vector3 = ProjectSettings.get_setting("physics/3d/default_gravity_vector", Vector3(0, -1, 0))
	respond({
		"success": true,
		"gravity": ProjectSettings.get_setting("physics/3d/default_gravity"),
		"gravity_direction": {"x": vector.x, "y": vector.y, "z": vector.z},
		"physics_fps": Engine.physics_ticks_per_second,
	})


func _cmd_locale(params: Dictionary) -> void:
	var reader := CommandParams.new(params)
	var action: String = reader.optional_enum("action", "get", ["get", "set", "translate"])
	var locale_name: String = reader.optional_string("locale", "en")
	var key: String = reader.optional_string("key")
	if action == "translate" and not reader.has_param("key"):
		reader.fail("key is required for translate", {"param": "key", "reason": "missing"})
	if params_invalid(reader):
		return
	match action:
		"get":
			respond({"success": true, "locale": TranslationServer.get_locale()})
		"set":
			TranslationServer.set_locale(locale_name)
			respond({"success": true, "action": action, "locale": locale_name})
		"translate":
			respond({"success": true, "key": key, "translated": tr(key)})


func _cmd_resource(params: Dictionary) -> void:
	var reader := CommandParams.new(params)
	var action: String = reader.optional_enum("action", "load", ["load", "preload", "save", "exists"])
	var resource_path: String = reader.required_resource_path("path")
	_validate_project_resource_path(reader, resource_path)
	if params_invalid(reader):
		return
	match action:
		"load":
			if not _require_existing_resource(reader, resource_path):
				return
			var cached_before: bool = ResourceLoader.has_cached(resource_path)
			var resource: Resource = ResourceLoader.load(resource_path)
			if resource == null:
				respond({"error": "Failed to load resource: %s" % resource_path})
				return
			respond(_resource_result(action, resource_path, resource, cached_before))
		"preload":
			if not _require_existing_resource(reader, resource_path):
				return
			var cached_before: bool = ResourceLoader.has_cached(resource_path)
			var request_error: int = ResourceLoader.load_threaded_request(
				resource_path, "", true, ResourceLoader.CACHE_MODE_REUSE
			)
			if request_error != OK:
				reader.fail("Failed to start threaded resource load", godot_error_data(request_error))
				send_params_error(reader)
				return
			var status: int = ResourceLoader.load_threaded_get_status(resource_path)
			var waited_frames: int = 0
			while status == ResourceLoader.THREAD_LOAD_IN_PROGRESS and waited_frames < MAX_THREADED_LOAD_FRAMES:
				if cancellation_requested():
					respond({"error": "Resource preload cancelled", "error_data": {"path": resource_path}})
					return
				await get_tree().process_frame
				waited_frames += 1
				status = ResourceLoader.load_threaded_get_status(resource_path)
			if status == ResourceLoader.THREAD_LOAD_IN_PROGRESS:
				respond_timeout("Resource preload timed out", {"path": resource_path})
				return
			if status != ResourceLoader.THREAD_LOAD_LOADED:
				respond({"error": "Failed to preload resource: %s" % resource_path, "error_data": {"path": resource_path, "status": status}})
				return
			var resource: Resource = ResourceLoader.load_threaded_get(resource_path)
			if resource == null:
				respond({"error": "Failed to preload resource: %s" % resource_path})
				return
			_preloaded_resources[resource_path] = resource
			var result: Dictionary = _resource_result(action, resource_path, resource, cached_before)
			result["waited_frames"] = waited_frames
			respond(result)
		"save":
			var node: Node = require_node(reader)
			var property: String = reader.required_string("property")
			if params_invalid(reader):
				return
			if not _object_has_property(node, property):
				reader.fail("Property not found", {"param": "property", "reason": "property_not_found", "value": property})
				send_params_error(reader)
				return
			var property_value: Variant = node.get(property)
			if not property_value is Resource:
				reader.fail("Property is not a Resource", {"param": "property", "reason": "invalid_value", "value": property})
				send_params_error(reader)
				return
			var resource: Resource = property_value
			var err: int = ResourceSaver.save(resource, resource_path)
			if err != OK:
				reader.fail("Failed to save resource", godot_error_data(err))
				send_params_error(reader)
				return
			respond(_resource_result(action, resource_path, resource, ResourceLoader.has_cached(resource_path)))
		"exists":
			respond({"success": true, "action": action, "path": resource_path, "exists": ResourceLoader.exists(resource_path)})


func _validate_project_resource_path(reader: CommandParams, resource_path: String) -> void:
	if reader.failed():
		return
	var relative_path: String = resource_path.trim_prefix("res://")
	var segments: PackedStringArray = relative_path.replace("\\", "/").split("/", false)
	if not resource_path.begins_with("res://") or relative_path.is_empty() or segments.has(".."):
		reader.fail("path must stay within the project", {"param": "path", "reason": "path_outside_project", "value": resource_path})
		return
	if resource_path.to_utf8_buffer().size() > MAX_RESOURCE_PATH_BYTES:
		reader.fail("path exceeds the resource path limit", {"param": "path", "reason": "limit_exceeded", "max_bytes": MAX_RESOURCE_PATH_BYTES})


func _require_existing_resource(reader: CommandParams, resource_path: String) -> bool:
	if ResourceLoader.exists(resource_path):
		return true
	reader.fail("Resource not found", {"param": "path", "reason": "resource_not_found", "value": resource_path})
	send_params_error(reader)
	return false


func _object_has_property(object: Object, property: String) -> bool:
	for property_info: Dictionary in object.get_property_list():
		if str(property_info.get("name", "")) == property:
			return true
	return false


func _resource_result(action: String, resource_path: String, resource: Resource, cached_before: bool) -> Dictionary:
	return {
		"success": true,
		"action": action,
		"path": resource_path,
		"type": resource.get_class(),
		"resource_name": resource.resource_name,
		"cached_before": cached_before,
		"cached_after": ResourceLoader.has_cached(resource_path),
	}
