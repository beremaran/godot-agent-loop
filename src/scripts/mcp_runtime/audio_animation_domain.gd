extends "res://mcp_runtime/runtime_domain.gd"

# Audio and animation runtime commands.

func register_commands() -> void:
	register_command("get_audio", _cmd_get_audio)
	register_command("audio_play", _cmd_audio_play)
	register_command("audio_bus", _cmd_audio_bus)
	register_command("audio_effect", _cmd_audio_effect)
	register_command("audio_bus_layout", _cmd_audio_bus_layout)
	register_command("audio_spatial", _cmd_audio_spatial)
	register_command("create_animation", _cmd_create_animation)
	register_command("animation_tree", _cmd_animation_tree)
	register_command("animation_control", _cmd_animation_control)
	register_command("skeleton_ik", _cmd_skeleton_ik)
	register_command("bone_pose", _cmd_bone_pose)


func _cmd_get_audio(_params: Dictionary) -> void:
	var buses: Array = []
	for i in AudioServer.bus_count:
		buses.append({
			"name": AudioServer.get_bus_name(i),
			"volume_db": AudioServer.get_bus_volume_db(i),
			"mute": AudioServer.is_bus_mute(i),
			"solo": AudioServer.is_bus_solo(i),
		})

	var players: Array = []
	_find_audio_players(get_tree().root, players)

	respond({"success": true, "buses": buses, "players": players})


func _find_audio_players(node: Node, results: Array) -> void:
	if node is AudioStreamPlayer:
		var p: AudioStreamPlayer = node as AudioStreamPlayer
		results.append({"path": str(p.get_path()), "type": "AudioStreamPlayer", "playing": p.playing, "bus": p.bus})
	elif node is AudioStreamPlayer2D:
		var p: AudioStreamPlayer2D = node as AudioStreamPlayer2D
		results.append({"path": str(p.get_path()), "type": "AudioStreamPlayer2D", "playing": p.playing, "bus": p.bus})
	elif node is AudioStreamPlayer3D:
		var p: AudioStreamPlayer3D = node as AudioStreamPlayer3D
		results.append({"path": str(p.get_path()), "type": "AudioStreamPlayer3D", "playing": p.playing, "bus": p.bus})
	for child in node.get_children():
		_find_audio_players(child, results)


# --- Spawn Node ---


func _cmd_audio_play(params: Dictionary) -> void:
	var reader := CommandParams.new(params)
	var node: Node = require_node(reader)
	var action: String = reader.optional_enum("action", "play", ["play", "stop", "pause", "resume"])
	if params_invalid(reader):
		return
	var node_path: String = str(node.get_path())
	if not (node is AudioStreamPlayer or node is AudioStreamPlayer2D or node is AudioStreamPlayer3D):
		reader.fail("node_path must reference an AudioStreamPlayer", {"param": "node_path", "reason": "invalid_value", "value": node_path, "class": node.get_class()})
		send_params_error(reader)
		return

	# Optionally load a new stream
	if params.has("stream"):
		var stream_path: String = params["stream"]
		var stream: AudioStream = load(stream_path) as AudioStream
		if stream == null:
			respond({"error": "Failed to load audio stream: %s" % stream_path})
			return
		node.set("stream", stream)

	# Set optional properties
	if params.has("volume"):
		var linear_vol: float = CommandParams.to_float(params["volume"])
		node.set("volume_db", linear_to_db(clampf(linear_vol, 0.0, 1.0)))
	if params.has("pitch"):
		node.set("pitch_scale", CommandParams.to_float(params["pitch"]))
	if params.has("bus"):
		node.set("bus", params["bus"])

	match action:
		"play":
			var from_pos: float = CommandParams.json_float(params, "from_position", 0.0)
			node.call("play", from_pos)
			respond({"success": true, "action": "play", "node_path": node_path})
		"stop":
			node.call("stop")
			respond({"success": true, "action": "stop", "node_path": node_path})
		"pause":
			node.set("stream_paused", true)
			respond({"success": true, "action": "pause", "node_path": node_path})
		"resume":
			node.set("stream_paused", false)
			respond({"success": true, "action": "resume", "node_path": node_path})
		_:
			respond({"error": "Unknown audio action: %s. Use play, stop, pause, or resume" % action})


# --- Audio Bus ---


func _cmd_audio_bus(params: Dictionary) -> void:
	var bus_name: String = params.get("bus_name", "Master")
	var bus_idx: int = AudioServer.get_bus_index(bus_name)
	if bus_idx == -1:
		respond({"error": "Audio bus not found: %s" % bus_name})
		return

	if params.has("volume"):
		var linear_vol: float = CommandParams.to_float(params["volume"])
		AudioServer.set_bus_volume_db(bus_idx, linear_to_db(clampf(linear_vol, 0.0, 1.0)))
	if params.has("mute"):
		AudioServer.set_bus_mute(bus_idx, CommandParams.to_bool(params["mute"]))
	if params.has("solo"):
		AudioServer.set_bus_solo(bus_idx, CommandParams.to_bool(params["solo"]))

	respond({
		"success": true,
		"bus_name": bus_name,
		"volume_db": AudioServer.get_bus_volume_db(bus_idx),
		"mute": AudioServer.is_bus_mute(bus_idx),
		"solo": AudioServer.is_bus_solo(bus_idx)
	})


# --- Environment / Post-Processing ---


func _cmd_create_animation(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	var anim_name: String = params.get("animation_name", "")
	if node_path.is_empty() or anim_name.is_empty():
		respond({"error": "node_path and animation_name are required"})
		return

	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		respond({"error": "Node not found: %s" % node_path})
		return

	if not node is AnimationPlayer:
		respond({"error": "Node is not an AnimationPlayer: %s (is %s)" % [node_path, node.get_class()]})
		return

	var anim_player: AnimationPlayer = node as AnimationPlayer
	var anim: Animation = Animation.new()
	anim.length = CommandParams.json_float(params, "length", 1.0)
	var loop_mode: int = CommandParams.json_int(params, "loop_mode", 0)
	anim.loop_mode = loop_mode as Animation.LoopMode

	var tracks: Array = CommandParams.json_array(params, "tracks")
	var track_count: int = 0
	for track_entry: Variant in tracks:
		var track_data: Dictionary = CommandParams.as_dictionary(track_entry)
		var track_type_str: String = CommandParams.json_string(track_data, "type", "value")
		var track_path: String = CommandParams.json_string(track_data, "path")
		if track_path.is_empty():
			continue

		var track_type: int = Animation.TYPE_VALUE
		match track_type_str:
			"value":
				track_type = Animation.TYPE_VALUE
			"method":
				track_type = Animation.TYPE_METHOD
			"bezier":
				track_type = Animation.TYPE_BEZIER
			"audio":
				track_type = Animation.TYPE_AUDIO

		var idx: int = anim.add_track(track_type)
		anim.track_set_path(idx, NodePath(track_path))

		var keys: Array = CommandParams.json_array(track_data, "keys")
		for key_entry: Variant in keys:
			var key_data: Dictionary = CommandParams.as_dictionary(key_entry)
			var time: float = CommandParams.json_float(key_data, "time", 0.0)
			match track_type:
				Animation.TYPE_VALUE:
					var value: Variant = json_to_variant(key_data.get("value"), CommandParams.json_string(key_data, "type_hint"))
					@warning_ignore("return_value_discarded")
					anim.track_insert_key(idx, time, value)
					if key_data.has("transition"):
						var key_idx: int = anim.track_find_key(idx, time, Animation.FIND_MODE_APPROX)
						if key_idx >= 0:
							anim.track_set_key_transition(idx, key_idx, CommandParams.to_float(key_data["transition"]))
				Animation.TYPE_METHOD:
					var method_name: String = CommandParams.json_string(key_data, "method")
					var args: Array = CommandParams.json_array(key_data, "args")
					@warning_ignore("return_value_discarded")
					anim.track_insert_key(idx, time, {"method": method_name, "args": args})
				Animation.TYPE_BEZIER:
					var value: float = CommandParams.json_float(key_data, "value", 0.0)
					@warning_ignore("return_value_discarded")
					anim.bezier_track_insert_key(idx, time, value)
				Animation.TYPE_AUDIO:
					var stream_path: String = CommandParams.json_string(key_data, "stream")
					if not stream_path.is_empty():
						var stream: AudioStream = load(stream_path) as AudioStream
						if stream != null:
							@warning_ignore("return_value_discarded")
							anim.audio_track_insert_key(idx, time, stream)
		track_count += 1

	# Add to library (use default "" library if it exists, otherwise create it)
	var lib_name: String = CommandParams.json_string(params, "library")
	var lib: AnimationLibrary = null
	if anim_player.has_animation_library(lib_name):
		lib = anim_player.get_animation_library(lib_name)
	else:
		lib = AnimationLibrary.new()
		@warning_ignore("return_value_discarded")
		anim_player.add_animation_library(lib_name, lib)
	@warning_ignore("return_value_discarded")
	lib.add_animation(anim_name, anim)

	respond({"success": true, "animation_name": anim_name, "length": anim.length, "loop_mode": loop_mode, "track_count": track_count})


# --- Serialize State ---


func _cmd_bone_pose(params: Dictionary) -> void:
	var reader := CommandParams.new(params)
	var node: Node = require_node(reader)
	var action: String = reader.optional_enum("action", "list", ["list", "get", "set"])
	if params_invalid(reader):
		return
	var node_path: String = str(node.get_path())
	if not node is Skeleton3D:
		reader.fail("node_path must reference a Skeleton3D", {"param": "node_path", "reason": "invalid_value", "value": node_path, "class": node.get_class()})
		send_params_error(reader)
		return

	var skel: Skeleton3D = node as Skeleton3D

	match action:
		"list":
			var bones: Array = []
			for i in skel.get_bone_count():
				bones.append({"index": i, "name": skel.get_bone_name(i), "parent": skel.get_bone_parent(i)})
			respond({"success": true, "action": "list", "bone_count": skel.get_bone_count(), "bones": bones})
		"get":
			var bone_idx: int = _resolve_bone_index(skel, params)
			if bone_idx < 0:
				respond({"error": "Bone not found"})
				return
			respond({
				"success": true, "action": "get", "bone_index": bone_idx,
				"bone_name": skel.get_bone_name(bone_idx),
				"position": variant_to_json(skel.get_bone_pose_position(bone_idx)),
				"rotation": variant_to_json(skel.get_bone_pose_rotation(bone_idx)),
				"scale": variant_to_json(skel.get_bone_pose_scale(bone_idx))
			})
		"set":
			var bone_idx: int = _resolve_bone_index(skel, params)
			if bone_idx < 0:
				respond({"error": "Bone not found"})
				return
			if params.has("position"):
				var p: Dictionary = params["position"]
				skel.set_bone_pose_position(bone_idx, Vector3(CommandParams.json_float(p, "x", 0), CommandParams.json_float(p, "y", 0), CommandParams.json_float(p, "z", 0)))
			if params.has("rotation"):
				var r: Dictionary = params["rotation"]
				skel.set_bone_pose_rotation(bone_idx, Quaternion(CommandParams.json_float(r, "x", 0), CommandParams.json_float(r, "y", 0), CommandParams.json_float(r, "z", 0), CommandParams.json_float(r, "w", 1)))
			if params.has("scale"):
				var s: Dictionary = params["scale"]
				skel.set_bone_pose_scale(bone_idx, Vector3(CommandParams.json_float(s, "x", 1), CommandParams.json_float(s, "y", 1), CommandParams.json_float(s, "z", 1)))
			respond({"success": true, "action": "set", "bone_index": bone_idx, "bone_name": skel.get_bone_name(bone_idx)})
		_:
			respond({"error": "Unknown bone action: %s. Use list, get, or set" % action})


# An AnimationTree only exposes a playback object when its root is a state
# machine; every other root reports the parameter as null.
func _state_machine_playback(tree: AnimationTree) -> AnimationNodeStateMachinePlayback:
	var playback: Variant = tree.get("parameters/playback")
	if playback is AnimationNodeStateMachinePlayback:
		return playback
	return null


func _resolve_bone_index(skel: Skeleton3D, params: Dictionary) -> int:
	if params.has("bone_index"):
		return CommandParams.to_int(params["bone_index"])
	if params.has("bone_name"):
		return skel.find_bone(CommandParams.json_string(params, "bone_name"))
	return -1


# --- Viewport ---
# ==========================================================================
# Batch 1: Networking + Input + System + Signals + Script
# ==========================================================================


func _cmd_animation_tree(params: Dictionary) -> void:
	var reader := CommandParams.new(params)
	var node: Node = require_node(reader)
	var action: String = reader.optional_enum("action", "get_state", ["travel", "set_param", "get_state"])
	if params_invalid(reader):
		return
	if not node is AnimationTree:
		reader.fail("node_path must reference an AnimationTree", {"param": "node_path", "reason": "invalid_value", "class": node.get_class()})
		send_params_error(reader)
		return
	var tree: AnimationTree = node as AnimationTree
	match action:
		"travel":
			var state_name: String = CommandParams.json_string(params, "state_name")
			var playback: AnimationNodeStateMachinePlayback = _state_machine_playback(tree)
			if playback != null:
				playback.travel(state_name)
			respond({"success": true, "action": "travel", "state": state_name})
		"set_param":
			var param_name: String = CommandParams.json_string(params, "param_name")
			var param_value: Variant = params.get("param_value", 0)
			tree.set("parameters/" + param_name, param_value)
			respond({"success": true, "action": "set_param", "param": param_name})
		"get_state":
			var playback: AnimationNodeStateMachinePlayback = _state_machine_playback(tree)
			var current: String = ""
			if playback != null:
				current = playback.get_current_node()
			respond({"success": true, "action": "get_state", "current": current})
		_:
			respond({"error": "Unknown animation_tree action: %s" % action})


func _cmd_animation_control(params: Dictionary) -> void:
	var reader := CommandParams.new(params)
	var node: Node = require_node(reader)
	var action: String = reader.optional_enum("action", "get_info", ["seek", "queue", "set_speed", "stop", "get_info"])
	if params_invalid(reader):
		return
	if not node is AnimationPlayer:
		reader.fail("node_path must reference an AnimationPlayer", {"param": "node_path", "reason": "invalid_value", "class": node.get_class()})
		send_params_error(reader)
		return
	var player: AnimationPlayer = node as AnimationPlayer
	match action:
		"seek":
			var pos: float = CommandParams.json_float(params, "position", 0)
			player.seek(pos)
			respond({"success": true, "action": "seek", "position": pos})
		"queue":
			var anim: String = params.get("animation_name", "")
			player.queue(anim)
			respond({"success": true, "action": "queue", "animation": anim})
		"set_speed":
			player.speed_scale = CommandParams.json_float(params, "speed", 1.0)
			respond({"success": true, "action": "set_speed", "speed": player.speed_scale})
		"stop":
			player.stop()
			respond({"success": true, "action": "stop"})
		"get_info":
			var anims: PackedStringArray = player.get_animation_list()
			respond({"success": true, "action": "get_info", "current": player.current_animation, "playing": player.is_playing(), "animations": Array(anims), "speed_scale": player.speed_scale, "position": player.current_animation_position})
		_:
			respond({"error": "Unknown animation_control action: %s" % action})


func _cmd_skeleton_ik(params: Dictionary) -> void:
	var reader := CommandParams.new(params)
	var node: Node = require_node(reader)
	var action: String = reader.optional_enum("action", "start", ["start", "stop", "set_target"])
	if params_invalid(reader):
		return
	if not node is SkeletonIK3D:
		reader.fail("node_path must reference a SkeletonIK3D", {"param": "node_path", "reason": "invalid_value", "class": node.get_class()})
		send_params_error(reader)
		return
	var ik: SkeletonIK3D = node as SkeletonIK3D
	match action:
		"start":
			ik.start()
			respond({"success": true, "action": "start"})
		"stop":
			ik.stop()
			respond({"success": true, "action": "stop"})
		"set_target":
			var t: Dictionary = params.get("target", {})
			var target_tf: Transform3D = Transform3D.IDENTITY
			target_tf.origin = Vector3(CommandParams.json_float(t, "x", 0), CommandParams.json_float(t, "y", 0), CommandParams.json_float(t, "z", 0))
			ik.target = target_tf
			respond({"success": true, "action": "set_target"})
		_:
			respond({"error": "Unknown skeleton_ik action: %s" % action})


func _cmd_audio_effect(params: Dictionary) -> void:
	var reader := CommandParams.new(params)
	var bus_name: String = params.get("bus_name", "Master")
	var action: String = reader.optional_enum("action", "list", ["list", "add", "remove", "configure"])
	if params_invalid(reader):
		return
	var bus_idx: int = AudioServer.get_bus_index(bus_name)
	if bus_idx < 0:
		respond({"error": "Audio bus not found: %s" % bus_name})
		return
	match action:
		"list":
			var effects: Array = []
			for i in AudioServer.get_bus_effect_count(bus_idx):
				var eff: AudioEffect = AudioServer.get_bus_effect(bus_idx, i)
				effects.append({"index": i, "type": eff.get_class(), "enabled": AudioServer.is_bus_effect_enabled(bus_idx, i)})
			respond({"success": true, "action": "list", "bus": bus_name, "effects": effects})
		"add":
			var effect_type: String = params.get("effect_type", "reverb")
			var effect: AudioEffect
			match effect_type:
				"reverb": effect = AudioEffectReverb.new()
				"delay": effect = AudioEffectDelay.new()
				"chorus": effect = AudioEffectChorus.new()
				"eq": effect = AudioEffectEQ6.new()
				"compressor": effect = AudioEffectCompressor.new()
				"limiter": effect = AudioEffectLimiter.new()
				_:
					respond({"error": "Unknown effect type: %s" % effect_type})
					return
			AudioServer.add_bus_effect(bus_idx, effect)
			respond({"success": true, "action": "add", "effect_type": effect_type, "index": AudioServer.get_bus_effect_count(bus_idx) - 1})
		"remove":
			var idx: int = CommandParams.json_int(params, "index", 0)
			AudioServer.remove_bus_effect(bus_idx, idx)
			respond({"success": true, "action": "remove", "index": idx})
		"configure":
			var idx: int = CommandParams.json_int(params, "index", 0)
			if idx < 0 or idx >= AudioServer.get_bus_effect_count(bus_idx):
				respond({"error": "Effect index out of range: %d" % idx})
				return
			var eff: AudioEffect = AudioServer.get_bus_effect(bus_idx, idx)
			var applied: Array = []
			var props: Dictionary = CommandParams.json_dictionary(params, "properties")
			for key: Variant in props:
				eff.set(StringName(str(key)), props[key])
				applied.append(str(key))
			if params.has("enabled"):
				AudioServer.set_bus_effect_enabled(bus_idx, idx, CommandParams.to_bool(params["enabled"]))
				applied.append("enabled")
			respond({"success": true, "action": "configure", "index": idx, "applied": applied})
		_:
			respond({"error": "Unknown audio_effect action: %s" % action})


func _cmd_audio_bus_layout(params: Dictionary) -> void:
	var reader := CommandParams.new(params)
	var action: String = reader.optional_enum("action", "list", ["list", "add", "remove", "set_send"])
	if params_invalid(reader):
		return
	match action:
		"list":
			var buses: Array = []
			for i in AudioServer.bus_count:
				buses.append({"index": i, "name": AudioServer.get_bus_name(i), "volume": AudioServer.get_bus_volume_db(i), "mute": AudioServer.is_bus_mute(i), "solo": AudioServer.is_bus_solo(i), "send": AudioServer.get_bus_send(i), "effect_count": AudioServer.get_bus_effect_count(i)})
			respond({"success": true, "action": "list", "buses": buses})
		"add":
			var bus_name: String = params.get("bus_name", "New Bus")
			AudioServer.add_bus()
			var idx: int = AudioServer.bus_count - 1
			AudioServer.set_bus_name(idx, bus_name)
			respond({"success": true, "action": "add", "bus_name": bus_name, "index": idx})
		"remove":
			var bus_name: String = params.get("bus_name", "")
			var idx: int = AudioServer.get_bus_index(bus_name)
			if idx <= 0:
				respond({"error": "Cannot remove bus: %s" % bus_name})
				return
			AudioServer.remove_bus(idx)
			respond({"success": true, "action": "remove", "bus_name": bus_name})
		"set_send":
			var bus_name: String = params.get("bus_name", "")
			var send_to: String = params.get("send_to", "Master")
			var idx: int = AudioServer.get_bus_index(bus_name)
			if idx < 0:
				respond({"error": "Bus not found: %s" % bus_name})
				return
			AudioServer.set_bus_send(idx, send_to)
			respond({"success": true, "action": "set_send", "bus": bus_name, "send_to": send_to})
		_:
			respond({"error": "Unknown audio_bus_layout action: %s" % action})


func _cmd_audio_spatial(params: Dictionary) -> void:
	var reader := CommandParams.new(params)
	var node: Node = require_node(reader)
	var action: String = reader.optional_enum("action", "get_info", ["get_info", "configure"])
	if params_invalid(reader):
		return
	if not node is AudioStreamPlayer3D:
		reader.fail("node_path must reference an AudioStreamPlayer3D", {"param": "node_path", "reason": "invalid_value", "class": node.get_class()})
		send_params_error(reader)
		return
	var player: AudioStreamPlayer3D = node as AudioStreamPlayer3D
	if action == "get_info":
		respond({"success": true, "max_distance": player.max_distance, "unit_size": player.unit_size, "max_db": player.max_db, "playing": player.playing})
		return
	if params.has("max_distance"):
		player.max_distance = CommandParams.to_float(params["max_distance"])
	if params.has("unit_size"):
		player.unit_size = CommandParams.to_float(params["unit_size"])
	if params.has("max_db"):
		player.max_db = CommandParams.to_float(params["max_db"])
	respond({"success": true, "action": "configure"})


# ==========================================================================
# Batch 4: Locale (runtime)
# ==========================================================================
