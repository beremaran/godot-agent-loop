extends "res://mcp_runtime/runtime_domain.gd"

# Engine and platform info commands. time_scale is retained for internal
# game_scenario cleanup that resets simulated timing.

func register_commands() -> void:
	register_command("os_info", _cmd_os_info)
	register_command("time_scale", _cmd_time_scale)


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
