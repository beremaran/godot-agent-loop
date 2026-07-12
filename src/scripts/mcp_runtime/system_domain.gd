extends "res://mcp_runtime/runtime_domain.gd"

# Window, engine, localization, and resource/project-state commands.

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
	respond({"success": true, "os_name": OS.get_name(), "locale": OS.get_locale(), "screen_size": {"x": screen_size.x, "y": screen_size.y}, "video_adapter": RenderingServer.get_video_adapter_name(), "processor_count": OS.get_processor_count()})


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
	respond({"success": true, "time_scale": Engine.time_scale, "ticks_msec": Time.get_ticks_msec(), "fps": Engine.get_frames_per_second()})


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
	var physics_fps: int = reader.optional_int("physics_fps", 60, 1)
	if params_invalid(reader):
		return
	if action == "set":
		if reader.has_param("gravity"):
			ProjectSettings.set_setting("physics/3d/default_gravity", gravity)
		if reader.has_param("physics_fps"):
			Engine.physics_ticks_per_second = physics_fps
	respond({"success": true, "gravity": ProjectSettings.get_setting("physics/3d/default_gravity"), "physics_fps": Engine.physics_ticks_per_second})


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
	var action: String = reader.optional_enum("action", "load", ["load", "save", "exists"])
	var resource_path: String = reader.required_resource_path("path")
	if params_invalid(reader):
		return
	match action:
		"load":
			if not ResourceLoader.exists(resource_path):
				reader.fail("Resource not found", {"param": "path", "reason": "resource_not_found", "value": resource_path})
				send_params_error(reader)
				return
			var resource: Resource = ResourceLoader.load(resource_path)
			if resource == null:
				respond({"error": "Failed to load resource: %s" % resource_path})
				return
			respond({"success": true, "action": action, "path": resource_path, "type": resource.get_class()})
		"save":
			var node: Node = require_node(reader)
			var property: String = reader.required_string("property")
			if params_invalid(reader):
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
			respond({"success": true, "action": action, "path": resource_path})
		"exists":
			respond({"success": true, "action": action, "path": resource_path, "exists": ResourceLoader.exists(resource_path)})
