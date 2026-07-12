extends "res://mcp_runtime/runtime_domain.gd"

# Input domain: synthesized mouse, keyboard, gamepad, and touch input, plus the
# input-map and mouse-state commands.
#
# This domain owns the two pieces of input state that used to sit beside
# unrelated handlers on the server: the key-name map and the set of keys and
# actions currently held down by key_hold.

var _key_map: Dictionary = {}
var _held_keys: Dictionary[String, int] = {}


func _init() -> void:
	_init_key_map()


# key_hold deliberately leaves a key or action pressed after responding, so the
# domain must undo that when it goes away: Input state is global and outlives
# the server, and a stuck key would keep driving the game.
func _exit_tree() -> void:
	_release_all_held()


func _release_all_held() -> void:
	for entry: String in _held_keys:
		if entry.begins_with("action:"):
			Input.action_release(entry.substr(7))
			continue
		var held_keycode: Key = _held_keys[entry] as Key
		var event: InputEventKey = InputEventKey.new()
		event.keycode = held_keycode
		event.physical_keycode = held_keycode
		event.pressed = false
		Input.parse_input_event(event)
	_held_keys.clear()


func register_commands() -> void:
	register_command("click", _cmd_click)
	register_command("key_press", _cmd_key_press)
	register_command("key_hold", _cmd_key_hold)
	register_command("key_release", _cmd_key_release)
	register_command("scroll", _cmd_scroll)
	register_command("mouse_move", _cmd_mouse_move)
	register_command("mouse_drag", _cmd_mouse_drag)
	register_command("gamepad", _cmd_gamepad)
	register_command("touch", _cmd_touch)
	register_command("input_state", _cmd_input_state)
	register_command("input_action", _cmd_input_action)


# --- Click ---
func _cmd_click(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var x: float = reader.required_number("x")
	var y: float = reader.required_number("y")
	var button: int = reader.optional_int("button", MOUSE_BUTTON_LEFT, MOUSE_BUTTON_LEFT, MOUSE_BUTTON_XBUTTON2)
	if params_invalid(reader):
		return

	var pos: Vector2 = Vector2(x, y)

	# Mouse button press
	var press_event: InputEventMouseButton = InputEventMouseButton.new()
	press_event.position = pos
	press_event.global_position = pos
	press_event.button_index = button as MouseButton
	press_event.pressed = true
	Input.parse_input_event(press_event)

	# Wait a frame then release
	await get_tree().process_frame

	var release_event: InputEventMouseButton = InputEventMouseButton.new()
	release_event.position = pos
	release_event.global_position = pos
	release_event.button_index = button as MouseButton
	release_event.pressed = false
	Input.parse_input_event(release_event)

	respond({"success": true, "clicked": {"x": x, "y": y, "button": button}})


# --- Key Press ---
# key_press/key_hold/key_release accept exactly one of `action` (a Godot input
# action) or `key` (a key name resolvable through the key map).
func _read_key_or_action(reader: CommandParams) -> Dictionary:
	var action: String = reader.optional_string("action", "")
	var key: String = reader.optional_string("key", "")
	if reader.failed():
		return {}
	if action.is_empty() and key.is_empty():
		reader.fail("Must provide 'key' or 'action' parameter", {"param": "key", "reason": "missing"})
		return {}
	if not action.is_empty():
		return {"mode": "action", "action": action}
	var keycode: int = _string_to_keycode(key)
	if keycode == KEY_NONE:
		reader.fail("Unknown key: %s" % key, {"param": "key", "reason": "invalid_value", "value": key})
		return {}
	return {"mode": "key", "key": key, "keycode": keycode}


func _cmd_key_press(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var pressed: bool = reader.optional_bool("pressed", true)
	var input: Dictionary = _read_key_or_action(reader)
	if params_invalid(reader):
		return

	if input["mode"] == "action":
		var action: String = input["action"]
		if pressed:
			Input.action_press(action)
		else:
			Input.action_release(action)
		respond({"success": true, "action": action, "pressed": pressed})
		return

	var key: String = input["key"]
	var keycode: int = input["keycode"]
	var event: InputEventKey = InputEventKey.new()
	event.keycode = keycode as Key
	event.physical_keycode = keycode as Key
	event.pressed = pressed
	Input.parse_input_event(event)

	if pressed:
		# Auto-release after a frame
		await get_tree().process_frame
		var release_event: InputEventKey = InputEventKey.new()
		release_event.keycode = keycode as Key
		release_event.physical_keycode = keycode as Key
		release_event.pressed = false
		Input.parse_input_event(release_event)

	respond({"success": true, "key": key, "pressed": pressed})


# --- Key Hold (no auto-release) ---
func _cmd_key_hold(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var input: Dictionary = _read_key_or_action(reader)
	if params_invalid(reader):
		return

	if input["mode"] == "action":
		var action: String = input["action"]
		Input.action_press(action)
		_held_keys["action:" + action] = true
		respond({"success": true, "held": action, "type": "action"})
		return

	var key: String = input["key"]
	var keycode: int = input["keycode"]
	var event: InputEventKey = InputEventKey.new()
	event.keycode = keycode as Key
	event.physical_keycode = keycode as Key
	event.pressed = true
	Input.parse_input_event(event)
	_held_keys["key:" + key.to_upper()] = keycode
	respond({"success": true, "held": key, "type": "key"})


# --- Key Release ---
func _cmd_key_release(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var input: Dictionary = _read_key_or_action(reader)
	if params_invalid(reader):
		return

	if input["mode"] == "action":
		var action: String = input["action"]
		Input.action_release(action)
		@warning_ignore("return_value_discarded")
		_held_keys.erase("action:" + action)
		respond({"success": true, "released": action, "type": "action"})
		return

	var key: String = input["key"]
	var keycode: int = input["keycode"]
	var event: InputEventKey = InputEventKey.new()
	event.keycode = keycode as Key
	event.physical_keycode = keycode as Key
	event.pressed = false
	Input.parse_input_event(event)
	@warning_ignore("return_value_discarded")
	_held_keys.erase("key:" + key.to_upper())
	respond({"success": true, "released": key, "type": "key"})


# --- Scroll ---
func _cmd_scroll(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var x: float = reader.optional_number("x", 0.0)
	var y: float = reader.optional_number("y", 0.0)
	var direction: String = reader.optional_enum("direction", "up", ["up", "down", "left", "right"])
	var amount: int = reader.optional_int("amount", 1, 1, 1000)
	if params_invalid(reader):
		return

	var button_index: int = MOUSE_BUTTON_WHEEL_UP
	match direction:
		"down":
			button_index = MOUSE_BUTTON_WHEEL_DOWN
		"left":
			button_index = MOUSE_BUTTON_WHEEL_LEFT
		"right":
			button_index = MOUSE_BUTTON_WHEEL_RIGHT

	for i in amount:
		var press_event: InputEventMouseButton = InputEventMouseButton.new()
		press_event.position = Vector2(x, y)
		press_event.global_position = Vector2(x, y)
		press_event.button_index = button_index as MouseButton
		press_event.pressed = true
		press_event.factor = 1.0
		Input.parse_input_event(press_event)

		var release_event: InputEventMouseButton = InputEventMouseButton.new()
		release_event.position = Vector2(x, y)
		release_event.global_position = Vector2(x, y)
		release_event.button_index = button_index as MouseButton
		release_event.pressed = false
		Input.parse_input_event(release_event)

	respond({"success": true, "direction": direction, "amount": amount, "position": {"x": x, "y": y}})


# --- Mouse Move ---
func _cmd_mouse_move(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var x: float = reader.required_number("x")
	var y: float = reader.required_number("y")
	var relative_x: float = reader.optional_number("relative_x", 0.0)
	var relative_y: float = reader.optional_number("relative_y", 0.0)
	if params_invalid(reader):
		return

	var event: InputEventMouseMotion = InputEventMouseMotion.new()
	event.position = Vector2(x, y)
	event.global_position = Vector2(x, y)
	event.relative = Vector2(relative_x, relative_y)
	Input.parse_input_event(event)

	respond({"success": true, "position": {"x": x, "y": y}})


# --- Mouse Drag ---
func _cmd_mouse_drag(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var from_x: float = reader.required_number("from_x")
	var from_y: float = reader.required_number("from_y")
	var to_x: float = reader.required_number("to_x")
	var to_y: float = reader.required_number("to_y")
	var button: int = reader.optional_int("button", MOUSE_BUTTON_LEFT, MOUSE_BUTTON_LEFT, MOUSE_BUTTON_XBUTTON2)
	var steps: int = reader.optional_int("steps", 10, 1, 1000)
	if params_invalid(reader):
		return

	var from_pos: Vector2 = Vector2(from_x, from_y)
	var to_pos: Vector2 = Vector2(to_x, to_y)

	# Press at start position
	var press_event: InputEventMouseButton = InputEventMouseButton.new()
	press_event.position = from_pos
	press_event.global_position = from_pos
	press_event.button_index = button as MouseButton
	press_event.pressed = true
	Input.parse_input_event(press_event)

	# Lerp position over steps frames
	for i in steps:
		await get_tree().process_frame
		var t: float = float(i + 1) / float(steps)
		var current_pos: Vector2 = from_pos.lerp(to_pos, t)
		var move_event: InputEventMouseMotion = InputEventMouseMotion.new()
		move_event.position = current_pos
		move_event.global_position = current_pos
		move_event.relative = (to_pos - from_pos) / float(steps)
		move_event.button_mask = MOUSE_BUTTON_MASK_LEFT if button == MOUSE_BUTTON_LEFT else 0
		Input.parse_input_event(move_event)

	# Release at end position
	var release_event: InputEventMouseButton = InputEventMouseButton.new()
	release_event.position = to_pos
	release_event.global_position = to_pos
	release_event.button_index = button as MouseButton
	release_event.pressed = false
	Input.parse_input_event(release_event)

	respond({"success": true, "from": {"x": from_x, "y": from_y}, "to": {"x": to_x, "y": to_y}, "steps": steps})


# --- Gamepad ---
func _cmd_gamepad(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var input_type: String = reader.optional_enum("type", "button", ["button", "axis"])
	var index: int = reader.optional_int("index", 0, 0)
	var value: float = reader.optional_number("value", 0.0, -1.0, 1.0)
	var device: int = reader.optional_int("device", 0, 0)
	if params_invalid(reader):
		return

	if input_type == "button":
		var event: InputEventJoypadButton = InputEventJoypadButton.new()
		event.device = device
		event.button_index = index as JoyButton
		event.pressed = value > 0.5
		event.pressure = value
		Input.parse_input_event(event)
		respond({"success": true, "type": "button", "index": index, "pressed": event.pressed, "device": device})
	else:
		var event: InputEventJoypadMotion = InputEventJoypadMotion.new()
		event.device = device
		event.axis = index as JoyAxis
		event.axis_value = value
		Input.parse_input_event(event)
		respond({"success": true, "type": "axis", "index": index, "value": value, "device": device})


# --- Touch ---
func _cmd_touch(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var action: String = reader.optional_enum("action", "press", ["press", "release", "drag"])
	var x: float = reader.optional_number("x", 0.0)
	var y: float = reader.optional_number("y", 0.0)
	var idx: int = reader.optional_int("index", 0, 0)
	if params_invalid(reader):
		return
	match action:
		"press":
			var ev: InputEventScreenTouch = InputEventScreenTouch.new()
			ev.index = idx
			ev.position = Vector2(x, y)
			ev.pressed = true
			Input.parse_input_event(ev)
			await get_tree().process_frame
			respond({"success": true, "action": "press", "x": x, "y": y})
		"release":
			var ev: InputEventScreenTouch = InputEventScreenTouch.new()
			ev.index = idx
			ev.position = Vector2(x, y)
			ev.pressed = false
			Input.parse_input_event(ev)
			await get_tree().process_frame
			respond({"success": true, "action": "release", "x": x, "y": y})
		"drag":
			var to_x: float = reader.optional_number("to_x", x)
			var to_y: float = reader.optional_number("to_y", y)
			var steps: int = reader.optional_int("steps", 10, 1, 1000)
			if params_invalid(reader):
				return
			var press_ev: InputEventScreenTouch = InputEventScreenTouch.new()
			press_ev.index = idx
			press_ev.position = Vector2(x, y)
			press_ev.pressed = true
			Input.parse_input_event(press_ev)
			for i in range(steps):
				var t: float = float(i + 1) / float(steps)
				var drag_ev: InputEventScreenDrag = InputEventScreenDrag.new()
				drag_ev.index = idx
				drag_ev.position = Vector2(lerpf(x, to_x, t), lerpf(y, to_y, t))
				Input.parse_input_event(drag_ev)
				await get_tree().process_frame
			var rel_ev: InputEventScreenTouch = InputEventScreenTouch.new()
			rel_ev.index = idx
			rel_ev.position = Vector2(to_x, to_y)
			rel_ev.pressed = false
			Input.parse_input_event(rel_ev)
			await get_tree().process_frame
			respond({"success": true, "action": "drag", "from": {"x": x, "y": y}, "to": {"x": to_x, "y": to_y}})


# --- Input State ---
func _cmd_input_state(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var action: String = reader.optional_enum("action", "query", ["query", "warp_mouse", "set_mouse_mode"])
	if params_invalid(reader):
		return
	match action:
		"query":
			var mouse_pos: Vector2 = get_viewport().get_mouse_position()
			var joypads: Array = Input.get_connected_joypads()
			respond({"success": true, "mouse_position": {"x": mouse_pos.x, "y": mouse_pos.y}, "connected_joypads": joypads.size()})
		"warp_mouse":
			var x: float = reader.required_number("x")
			var y: float = reader.required_number("y")
			if params_invalid(reader):
				return
			var pos: Vector2 = Vector2(x, y)
			Input.warp_mouse(pos)
			respond({"success": true, "action": "warp_mouse", "position": {"x": pos.x, "y": pos.y}})
		"set_mouse_mode":
			var mode_str: String = reader.optional_enum("mouse_mode", "visible", ["visible", "hidden", "captured", "confined"])
			if params_invalid(reader):
				return
			var mode_val: Input.MouseMode = Input.MOUSE_MODE_VISIBLE
			match mode_str:
				"hidden": mode_val = Input.MOUSE_MODE_HIDDEN
				"captured": mode_val = Input.MOUSE_MODE_CAPTURED
				"confined": mode_val = Input.MOUSE_MODE_CONFINED
			Input.mouse_mode = mode_val
			respond({"success": true, "action": "set_mouse_mode", "mode": mode_str})


# --- Input Action ---
func _cmd_input_action(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var action: String = reader.required_enum("action", ["set_strength", "add_action", "remove_action", "list"])
	if params_invalid(reader):
		return
	match action:
		"set_strength":
			var action_name: String = reader.required_string("action_name")
			var strength: float = reader.optional_number("strength", 1.0, 0.0, 1.0)
			if params_invalid(reader):
				return
			Input.action_press(action_name, strength)
			respond({"success": true, "action": "set_strength", "action_name": action_name, "strength": strength})
		"add_action":
			var action_name: String = reader.required_string("action_name")
			var key: String = reader.optional_string("key", "")
			if params_invalid(reader):
				return
			if not InputMap.has_action(action_name):
				InputMap.add_action(action_name)
			if not key.is_empty():
				var ev: InputEventKey = InputEventKey.new()
				ev.keycode = OS.find_keycode_from_string(key)
				InputMap.action_add_event(action_name, ev)
			respond({"success": true, "action": "add_action", "action_name": action_name})
		"remove_action":
			var action_name: String = reader.required_string("action_name")
			if params_invalid(reader):
				return
			if InputMap.has_action(action_name):
				InputMap.erase_action(action_name)
			respond({"success": true, "action": "remove_action", "action_name": action_name})
		"list":
			var actions: Array = InputMap.get_actions()
			respond({"success": true, "actions": actions})


# --- Key String to Keycode ---
func _init_key_map() -> void:
	_key_map = {
		"A": KEY_A, "B": KEY_B, "C": KEY_C, "D": KEY_D,
		"E": KEY_E, "F": KEY_F, "G": KEY_G, "H": KEY_H,
		"I": KEY_I, "J": KEY_J, "K": KEY_K, "L": KEY_L,
		"M": KEY_M, "N": KEY_N, "O": KEY_O, "P": KEY_P,
		"Q": KEY_Q, "R": KEY_R, "S": KEY_S, "T": KEY_T,
		"U": KEY_U, "V": KEY_V, "W": KEY_W, "X": KEY_X,
		"Y": KEY_Y, "Z": KEY_Z,
		"0": KEY_0, "1": KEY_1, "2": KEY_2, "3": KEY_3,
		"4": KEY_4, "5": KEY_5, "6": KEY_6, "7": KEY_7,
		"8": KEY_8, "9": KEY_9,
		"SPACE": KEY_SPACE, "ENTER": KEY_ENTER, "RETURN": KEY_ENTER,
		"ESCAPE": KEY_ESCAPE, "ESC": KEY_ESCAPE,
		"TAB": KEY_TAB, "BACKSPACE": KEY_BACKSPACE,
		"DELETE": KEY_DELETE, "INSERT": KEY_INSERT,
		"HOME": KEY_HOME, "END": KEY_END,
		"PAGEUP": KEY_PAGEUP, "PAGE_UP": KEY_PAGEUP,
		"PAGEDOWN": KEY_PAGEDOWN, "PAGE_DOWN": KEY_PAGEDOWN,
		"UP": KEY_UP, "DOWN": KEY_DOWN, "LEFT": KEY_LEFT, "RIGHT": KEY_RIGHT,
		"SHIFT": KEY_SHIFT, "CTRL": KEY_CTRL, "CONTROL": KEY_CTRL,
		"ALT": KEY_ALT, "CAPSLOCK": KEY_CAPSLOCK, "CAPS_LOCK": KEY_CAPSLOCK,
		"F1": KEY_F1, "F2": KEY_F2, "F3": KEY_F3, "F4": KEY_F4,
		"F5": KEY_F5, "F6": KEY_F6, "F7": KEY_F7, "F8": KEY_F8,
		"F9": KEY_F9, "F10": KEY_F10, "F11": KEY_F11, "F12": KEY_F12,
	}


func _string_to_keycode(key_str: String) -> int:
	var upper: String = key_str.to_upper()
	if _key_map.has(upper):
		return _key_map[upper]
	if key_str.length() == 1:
		return key_str.unicode_at(0)
	return KEY_NONE
