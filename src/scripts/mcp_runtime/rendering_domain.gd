extends "res://mcp_runtime/runtime_domain.gd"

# Rendering and environment domain. Stateful visual-shader graphs and debug-draw
# objects live here with the handlers that own them.

func register_commands() -> void:
	register_command("get_camera", _cmd_get_camera)
	register_command("set_camera", _cmd_set_camera)
	register_command("camera_attributes", _cmd_camera_attributes)
	register_command("set_shader_param", _cmd_set_shader_param)
	register_command("visual_shader", _cmd_visual_shader)
	register_command("environment", _cmd_environment)
	register_command("set_particles", _cmd_set_particles)
	register_command("viewport", _cmd_viewport)
	register_command("debug_draw", _cmd_debug_draw)
	register_command("render_settings", _cmd_render_settings)
	register_command("sky", _cmd_sky)
	register_command("gi", _cmd_gi)
	register_command("video", _cmd_video)


func _exit_tree() -> void:
	_clear_debug_draw()


func _clear_debug_draw() -> void:
	for entry: Dictionary in _debug_meshes:
		var node: Node = entry.get("node") as Node
		if is_instance_valid(node):
			node.queue_free()
	_debug_meshes.clear()
	if _debug_draw_node != null and is_instance_valid(_debug_draw_node):
		_debug_draw_node.queue_free()
		_debug_draw_node = null

func _cmd_get_camera(_params: Dictionary) -> void:
	var result: Dictionary = {"success": true}

	var cam2d: Camera2D = get_viewport().get_camera_2d()
	if cam2d != null:
		result["camera_2d"] = {
			"position": {"x": cam2d.global_position.x, "y": cam2d.global_position.y},
			"rotation": cam2d.global_rotation,
			"zoom": {"x": cam2d.zoom.x, "y": cam2d.zoom.y},
			"path": str(cam2d.get_path())
		}

	var cam3d: Camera3D = get_viewport().get_camera_3d()
	if cam3d != null:
		result["camera_3d"] = {
			"position": {"x": cam3d.global_position.x, "y": cam3d.global_position.y, "z": cam3d.global_position.z},
			"rotation": {"x": rad_to_deg(cam3d.global_rotation.x), "y": rad_to_deg(cam3d.global_rotation.y), "z": rad_to_deg(cam3d.global_rotation.z)},
			"fov": cam3d.fov,
			"path": str(cam3d.get_path())
		}

	if cam2d == null and cam3d == null:
		result["error"] = "No active camera found"
		result["success"] = false

	respond(result)


# --- Set Camera ---
func _cmd_set_camera(params: Dictionary) -> void:
	var cam2d: Camera2D = get_viewport().get_camera_2d()
	var cam3d: Camera3D = get_viewport().get_camera_3d()

	if cam2d == null and cam3d == null:
		respond({"error": "No active camera found"})
		return

	if cam2d != null:
		if params.has("position"):
			var pos: Dictionary = params["position"]
			cam2d.global_position = Vector2(float(pos.get("x", cam2d.global_position.x)), float(pos.get("y", cam2d.global_position.y)))
		if params.has("rotation"):
			var rot: Dictionary = params["rotation"]
			cam2d.global_rotation = deg_to_rad(float(rot.get("z", rad_to_deg(cam2d.global_rotation))))
		if params.has("zoom"):
			var z: Dictionary = params["zoom"]
			cam2d.zoom = Vector2(float(z.get("x", cam2d.zoom.x)), float(z.get("y", cam2d.zoom.y)))
		respond({"success": true, "camera": "2d", "position": variant_to_json(cam2d.global_position), "zoom": variant_to_json(cam2d.zoom)})
		return

	if cam3d != null:
		if params.has("position"):
			var pos: Dictionary = params["position"]
			cam3d.global_position = Vector3(float(pos.get("x", cam3d.global_position.x)), float(pos.get("y", cam3d.global_position.y)), float(pos.get("z", cam3d.global_position.z)))
		if params.has("rotation"):
			var rot: Dictionary = params["rotation"]
			cam3d.global_rotation = Vector3(deg_to_rad(float(rot.get("x", rad_to_deg(cam3d.global_rotation.x)))), deg_to_rad(float(rot.get("y", rad_to_deg(cam3d.global_rotation.y)))), deg_to_rad(float(rot.get("z", rad_to_deg(cam3d.global_rotation.z)))))
		if params.has("fov"):
			cam3d.fov = float(params["fov"])
		respond({"success": true, "camera": "3d", "position": variant_to_json(cam3d.global_position), "rotation": variant_to_json(cam3d.global_rotation)})
		return


# --- Get Audio ---
func _cmd_set_shader_param(params: Dictionary) -> void:
	var reader := CommandParams.new(params)
	var node: Node = require_node(reader)
	var param_name: String = reader.required_string("param_name")
	if params_invalid(reader):
		return
	var node_path: String = str(node.get_path())

	var material: Material = null
	# Try material_override first (MeshInstance3D/2D)
	if node.get("material_override") != null:
		material = node.get("material_override")
	# Try surface override material (MeshInstance3D)
	elif node.has_method("get_surface_override_material"):
		material = node.get_surface_override_material(0)
	# Try material property (CanvasItem, e.g. Sprite2D)
	elif node.get("material") != null:
		material = node.get("material")

	if material == null or not material is ShaderMaterial:
		respond({"error": "No ShaderMaterial found on node: %s" % node_path})
		return

	var shader_mat: ShaderMaterial = material as ShaderMaterial
	var raw_value: Variant = params.get("value", null)
	var type_hint: String = params.get("type_hint", "")
	var value: Variant = json_to_variant(raw_value, type_hint)
	shader_mat.set_shader_parameter(param_name, value)
	respond({"success": true, "node_path": node_path, "param_name": param_name, "value": variant_to_json(shader_mat.get_shader_parameter(param_name))})


# --- Visual Shader ---
# Shaders built through the visual_shader command live here until applied to a
# node; ids let a client build several graphs. Edits target the fragment
# function, which is where the tool's node/connection workflow operates.
var _visual_shaders: Dictionary = {}
var _next_visual_shader_id: int = 1

const VISUAL_SHADER_MODES: Dictionary = {
	"spatial": Shader.MODE_SPATIAL,
	"canvas_item": Shader.MODE_CANVAS_ITEM,
	"particles": Shader.MODE_PARTICLES,
	"sky": Shader.MODE_SKY,
	"fog": Shader.MODE_FOG,
}

func _cmd_visual_shader(params: Dictionary) -> void:
	var action: String = params.get("action", "")
	if action.is_empty():
		respond({"error": "action is required"})
		return

	if action == "create":
		var shader_type: String = params.get("shader_type", "spatial")
		if not VISUAL_SHADER_MODES.has(shader_type):
			respond({"error": "Unknown shader_type: %s" % shader_type})
			return
		var shader: VisualShader = VisualShader.new()
		shader.set_mode(VISUAL_SHADER_MODES[shader_type])
		var shader_id: int = _next_visual_shader_id
		_next_visual_shader_id += 1
		_visual_shaders[shader_id] = shader
		respond({"success": true, "shader_id": shader_id, "shader_type": shader_type})
		return

	# Every other action edits an existing graph: the one named by shader_id,
	# or the most recently created one.
	var target_id: int = int(params.get("shader_id", _next_visual_shader_id - 1))
	var shader: VisualShader = _visual_shaders.get(target_id)
	if shader == null:
		respond({"error": "No visual shader with id %s; use action create first" % target_id})
		return

	match action:
		"add_node":
			var node_class: String = params.get("node_class", "")
			if node_class.is_empty():
				respond({"error": "node_class is required for add_node"})
				return
			if not ClassDB.class_exists(node_class) or not ClassDB.is_parent_class(node_class, "VisualShaderNode"):
				respond({"error": "Class '%s' is not a VisualShaderNode type" % node_class})
				return
			var graph_node: VisualShaderNode = ClassDB.instantiate(node_class) as VisualShaderNode
			if graph_node == null:
				respond({"error": "Failed to instantiate: %s" % node_class})
				return
			var position: Dictionary = params.get("position", {})
			var node_id: int = shader.get_valid_node_id(VisualShader.TYPE_FRAGMENT)
			shader.add_node(VisualShader.TYPE_FRAGMENT, graph_node, Vector2(position.get("x", 0.0), position.get("y", 0.0)), node_id)
			respond({"success": true, "shader_id": target_id, "node_id": node_id, "node_class": node_class})
		"connect":
			var err: int = shader.connect_nodes(VisualShader.TYPE_FRAGMENT, int(params.get("from_node", -1)), int(params.get("from_port", 0)), int(params.get("to_node", -1)), int(params.get("to_port", 0)))
			if err != OK:
				respond({"error": "Failed to connect nodes (error %d)" % err})
				return
			respond({"success": true, "shader_id": target_id})
		"disconnect":
			shader.disconnect_nodes(VisualShader.TYPE_FRAGMENT, int(params.get("from_node", -1)), int(params.get("from_port", 0)), int(params.get("to_node", -1)), int(params.get("to_port", 0)))
			respond({"success": true, "shader_id": target_id})
		"get_nodes":
			var nodes: Array = []
			for node_id in shader.get_node_list(VisualShader.TYPE_FRAGMENT):
				var graph_node: VisualShaderNode = shader.get_node(VisualShader.TYPE_FRAGMENT, node_id)
				var node_position: Vector2 = shader.get_node_position(VisualShader.TYPE_FRAGMENT, node_id)
				nodes.append({"id": node_id, "class": graph_node.get_class(), "position": {"x": node_position.x, "y": node_position.y}})
			respond({"success": true, "shader_id": target_id, "nodes": nodes})
		"apply":
			var node_path: String = params.get("node_path", "")
			if node_path.is_empty():
				respond({"error": "node_path is required for apply"})
				return
			var node: Node = get_tree().root.get_node_or_null(node_path)
			if node == null:
				respond({"error": "Node not found: %s" % node_path})
				return
			var material: ShaderMaterial = ShaderMaterial.new()
			material.shader = shader
			if "material_override" in node:
				node.set("material_override", material)
			elif "material" in node:
				node.set("material", material)
			else:
				respond({"error": "Node has no material property: %s" % node_path})
				return
			respond({"success": true, "shader_id": target_id, "node_path": node_path})
		_:
			respond({"error": "Unknown action: %s" % action})


# --- Audio Play ---
func _cmd_environment(params: Dictionary) -> void:
	var reader := CommandParams.new(params)
	var action: String = reader.optional_enum("action", "set", ["get", "set"])
	if params_invalid(reader):
		return

	# Find existing WorldEnvironment or Camera3D environment
	var env: Environment = null
	var world_env: Node = null

	# Search for WorldEnvironment node
	var found: Array[Node] = get_tree().root.find_children("*", "WorldEnvironment", true, false)
	if found.size() > 0:
		world_env = found[0]
		if world_env != null:
			env = world_env.get("environment") as Environment

	# Fallback: check Camera3D
	if env == null:
		var cam3d: Camera3D = get_viewport().get_camera_3d()
		if cam3d != null and cam3d.get("environment") != null:
			env = cam3d.get("environment") as Environment

	if action == "get":
		if env == null:
			respond({"error": "No Environment resource found"})
			return
		respond(_get_environment_state(env))
		return

	# action == "set": create if needed
	if env == null:
		env = Environment.new()
		var we: WorldEnvironment = WorldEnvironment.new()
		we.environment = env
		get_tree().root.add_child(we)
		world_env = we

	# Apply settings
	if params.has("background_mode"):
		env.background_mode = int(params["background_mode"]) as Environment.BGMode
	if params.has("background_color"):
		var c: Dictionary = params["background_color"]
		env.background_color = Color(float(c.get("r", 0)), float(c.get("g", 0)), float(c.get("b", 0)), float(c.get("a", 1)))
	if params.has("ambient_light_color"):
		var c: Dictionary = params["ambient_light_color"]
		env.ambient_light_color = Color(float(c.get("r", 0)), float(c.get("g", 0)), float(c.get("b", 0)), float(c.get("a", 1)))
	if params.has("ambient_light_energy"):
		env.ambient_light_energy = float(params["ambient_light_energy"])
	if params.has("fog_enabled"):
		env.fog_enabled = bool(params["fog_enabled"])
	if params.has("fog_density"):
		env.fog_density = float(params["fog_density"])
	if params.has("fog_light_color"):
		var c: Dictionary = params["fog_light_color"]
		env.fog_light_color = Color(float(c.get("r", 0)), float(c.get("g", 0)), float(c.get("b", 0)), float(c.get("a", 1)))
	if params.has("glow_enabled"):
		env.glow_enabled = bool(params["glow_enabled"])
	if params.has("glow_intensity"):
		env.glow_intensity = float(params["glow_intensity"])
	if params.has("glow_bloom"):
		env.glow_bloom = float(params["glow_bloom"])
	if params.has("tonemap_mode"):
		env.tonemap_mode = int(params["tonemap_mode"]) as Environment.ToneMapper
	if params.has("ssao_enabled"):
		env.ssao_enabled = bool(params["ssao_enabled"])
	if params.has("ssao_radius"):
		env.ssao_radius = float(params["ssao_radius"])
	if params.has("ssao_intensity"):
		env.ssao_intensity = float(params["ssao_intensity"])
	if params.has("ssr_enabled"):
		env.ssr_enabled = bool(params["ssr_enabled"])
	if params.has("brightness"):
		env.adjustment_enabled = true
		env.adjustment_brightness = float(params["brightness"])
	if params.has("contrast"):
		env.adjustment_enabled = true
		env.adjustment_contrast = float(params["contrast"])
	if params.has("saturation"):
		env.adjustment_enabled = true
		env.adjustment_saturation = float(params["saturation"])

	respond(_get_environment_state(env))


func _get_environment_state(env: Environment) -> Dictionary:
	return {
		"success": true,
		"background_mode": env.background_mode,
		"background_color": variant_to_json(env.background_color),
		"ambient_light_color": variant_to_json(env.ambient_light_color),
		"ambient_light_energy": env.ambient_light_energy,
		"fog_enabled": env.fog_enabled,
		"fog_density": env.fog_density,
		"fog_light_color": variant_to_json(env.fog_light_color),
		"glow_enabled": env.glow_enabled,
		"glow_intensity": env.glow_intensity,
		"glow_bloom": env.glow_bloom,
		"tonemap_mode": env.tonemap_mode,
		"ssao_enabled": env.ssao_enabled,
		"ssao_radius": env.ssao_radius,
		"ssao_intensity": env.ssao_intensity,
		"ssr_enabled": env.ssr_enabled,
		"brightness": env.adjustment_brightness,
		"contrast": env.adjustment_contrast,
		"saturation": env.adjustment_saturation
	}


# --- Manage Group ---
func _cmd_set_particles(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	if node_path.is_empty():
		respond({"error": "node_path is required"})
		return

	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null:
		respond({"error": "Node not found: %s" % node_path})
		return

	if not (node is GPUParticles2D or node is GPUParticles3D):
		respond({"error": "Node is not a GPUParticles node: %s (is %s)" % [node_path, node.get_class()]})
		return

	# Set direct particle properties
	if params.has("emitting"):
		node.set("emitting", bool(params["emitting"]))
	if params.has("amount"):
		node.set("amount", int(params["amount"]))
	if params.has("lifetime"):
		node.set("lifetime", float(params["lifetime"]))
	if params.has("one_shot"):
		node.set("one_shot", bool(params["one_shot"]))
	if params.has("speed_scale"):
		node.set("speed_scale", float(params["speed_scale"]))
	if params.has("explosiveness"):
		node.set("explosiveness", float(params["explosiveness"]))
	if params.has("randomness"):
		node.set("randomness", float(params["randomness"]))

	# Configure process material
	if params.has("process_material"):
		var mat_params: Dictionary = params["process_material"]
		var mat: ParticleProcessMaterial = node.get("process_material") as ParticleProcessMaterial
		if mat == null:
			mat = ParticleProcessMaterial.new()
			node.set("process_material", mat)
		if mat_params.has("direction"):
			var d: Dictionary = mat_params["direction"]
			mat.direction = Vector3(float(d.get("x", 0)), float(d.get("y", -1)), float(d.get("z", 0)))
		if mat_params.has("spread"):
			mat.spread = float(mat_params["spread"])
		if mat_params.has("gravity"):
			var g: Dictionary = mat_params["gravity"]
			mat.gravity = Vector3(float(g.get("x", 0)), float(g.get("y", -9.8)), float(g.get("z", 0)))
		if mat_params.has("initial_velocity_min"):
			mat.initial_velocity_min = float(mat_params["initial_velocity_min"])
		if mat_params.has("initial_velocity_max"):
			mat.initial_velocity_max = float(mat_params["initial_velocity_max"])
		if mat_params.has("color"):
			var c: Dictionary = mat_params["color"]
			mat.color = Color(float(c.get("r", 1)), float(c.get("g", 1)), float(c.get("b", 1)), float(c.get("a", 1)))
		if mat_params.has("scale_min"):
			mat.scale_min = float(mat_params["scale_min"])
		if mat_params.has("scale_max"):
			mat.scale_max = float(mat_params["scale_max"])

	respond({
		"success": true, "node_path": node_path,
		"emitting": node.get("emitting"), "amount": node.get("amount"),
		"lifetime": node.get("lifetime"), "one_shot": node.get("one_shot"),
		"speed_scale": node.get("speed_scale")
	})


# --- Create Animation ---
func _cmd_viewport(params: Dictionary) -> void:
	var reader := CommandParams.new(params)
	var action: String = reader.optional_enum("action", "create", ["create", "configure", "get"])
	if params_invalid(reader):
		return

	match action:
		"create":
			var parent_path: String = params.get("parent_path", "/root")
			var parent: Node = get_tree().root.get_node_or_null(parent_path)
			if parent == null:
				respond({"error": "Parent node not found: %s" % parent_path})
				return
			var viewport: SubViewport = SubViewport.new()
			if params.has("width") and params.has("height"):
				viewport.size = Vector2i(int(params["width"]), int(params["height"]))
			if params.has("transparent_bg"):
				viewport.transparent_bg = bool(params["transparent_bg"])
			if params.has("msaa"):
				viewport.msaa_2d = int(params["msaa"]) as Viewport.MSAA
				viewport.msaa_3d = int(params["msaa"]) as Viewport.MSAA
			if params.has("name") and params["name"] is String and not (params["name"] as String).is_empty():
				viewport.name = params["name"]
			var container: SubViewportContainer = SubViewportContainer.new()
			container.add_child(viewport)
			parent.add_child(container)
			respond({"success": true, "action": "create", "viewport_path": str(viewport.get_path()), "container_path": str(container.get_path()), "size": variant_to_json(viewport.size)})
		"configure":
			var node_path: String = params.get("node_path", "")
			if node_path.is_empty():
				respond({"error": "node_path is required for configure"})
				return
			var vp: Node = get_tree().root.get_node_or_null(node_path)
			if vp == null or not vp is SubViewport:
				respond({"error": "SubViewport not found: %s" % node_path})
				return
			var sv: SubViewport = vp as SubViewport
			if params.has("width") and params.has("height"):
				sv.size = Vector2i(int(params["width"]), int(params["height"]))
			if params.has("transparent_bg"):
				sv.transparent_bg = bool(params["transparent_bg"])
			if params.has("msaa"):
				sv.msaa_2d = int(params["msaa"]) as Viewport.MSAA
				sv.msaa_3d = int(params["msaa"]) as Viewport.MSAA
			respond({"success": true, "action": "configure", "size": variant_to_json(sv.size), "transparent_bg": sv.transparent_bg})
		"get":
			var node_path: String = params.get("node_path", "")
			if node_path.is_empty():
				respond({"error": "node_path is required for get"})
				return
			var vp: Node = get_tree().root.get_node_or_null(node_path)
			if vp == null or not vp is SubViewport:
				respond({"error": "SubViewport not found: %s" % node_path})
				return
			var sv: SubViewport = vp as SubViewport
			respond({"success": true, "action": "get", "size": variant_to_json(sv.size), "transparent_bg": sv.transparent_bg, "msaa_2d": sv.msaa_2d, "msaa_3d": sv.msaa_3d})
		_:
			respond({"error": "Unknown viewport action: %s. Use create, configure, or get" % action})


# --- Debug Draw ---
var _debug_draw_node: Node = null
var _debug_meshes: Array = []

func _cmd_debug_draw(params: Dictionary) -> void:
	var reader := CommandParams.new(params)
	var action: String = reader.optional_enum("action", "line", ["line", "sphere", "box", "clear"])
	if params_invalid(reader):
		return
	var color_dict: Dictionary = params.get("color", {"r": 1.0, "g": 0.0, "b": 0.0})
	var color: Color = Color(float(color_dict.get("r", 1)), float(color_dict.get("g", 0)), float(color_dict.get("b", 0)), float(color_dict.get("a", 1)))
	var duration: int = int(params.get("duration", 0))

	if action == "clear":
		_clear_debug_draw()
		respond({"success": true, "action": "clear"})
		return

	# Ensure we have a debug draw parent
	if _debug_draw_node == null or not is_instance_valid(_debug_draw_node):
		_debug_draw_node = Node3D.new()
		_debug_draw_node.name = "_McpDebugDraw"
		get_tree().root.add_child(_debug_draw_node)

	var mat: StandardMaterial3D = StandardMaterial3D.new()
	mat.albedo_color = color
	mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	mat.no_depth_test = true
	mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA if color.a < 1.0 else BaseMaterial3D.TRANSPARENCY_DISABLED

	match action:
		"line":
			var from_dict: Dictionary = params.get("from", {})
			var to_dict: Dictionary = params.get("to", {})
			var from_pos: Vector3 = Vector3(float(from_dict.get("x", 0)), float(from_dict.get("y", 0)), float(from_dict.get("z", 0)))
			var to_pos: Vector3 = Vector3(float(to_dict.get("x", 0)), float(to_dict.get("y", 0)), float(to_dict.get("z", 0)))
			var im: ImmediateMesh = ImmediateMesh.new()
			im.surface_begin(Mesh.PRIMITIVE_LINES, mat)
			im.surface_add_vertex(from_pos)
			im.surface_add_vertex(to_pos)
			im.surface_end()
			var mi: MeshInstance3D = MeshInstance3D.new()
			mi.mesh = im
			_debug_draw_node.add_child(mi)
			_debug_meshes.append({"node": mi, "frames_left": duration})
			respond({"success": true, "action": "line"})
		"sphere":
			var center_dict: Dictionary = params.get("center", {})
			var center: Vector3 = Vector3(float(center_dict.get("x", 0)), float(center_dict.get("y", 0)), float(center_dict.get("z", 0)))
			var radius: float = float(params.get("radius", 0.5))
			var sphere_mesh: SphereMesh = SphereMesh.new()
			sphere_mesh.radius = radius
			sphere_mesh.height = radius * 2.0
			sphere_mesh.material = mat
			var mi: MeshInstance3D = MeshInstance3D.new()
			mi.mesh = sphere_mesh
			mi.global_position = center
			_debug_draw_node.add_child(mi)
			_debug_meshes.append({"node": mi, "frames_left": duration})
			respond({"success": true, "action": "sphere"})
		"box":
			var center_dict: Dictionary = params.get("center", {})
			var center: Vector3 = Vector3(float(center_dict.get("x", 0)), float(center_dict.get("y", 0)), float(center_dict.get("z", 0)))
			var size_dict: Dictionary = params.get("size", {"x": 1, "y": 1, "z": 1})
			var box_size: Vector3 = Vector3(float(size_dict.get("x", 1)), float(size_dict.get("y", 1)), float(size_dict.get("z", 1)))
			var box_mesh: BoxMesh = BoxMesh.new()
			box_mesh.size = box_size
			box_mesh.material = mat
			var mi: MeshInstance3D = MeshInstance3D.new()
			mi.mesh = box_mesh
			mi.global_position = center
			_debug_draw_node.add_child(mi)
			_debug_meshes.append({"node": mi, "frames_left": duration})
			respond({"success": true, "action": "box"})
		_:
			respond({"error": "Unknown debug draw action: %s. Use line, sphere, box, or clear" % action})


func _cmd_gi(params: Dictionary) -> void:
	var reader := CommandParams.new(params)
	var parent: Node = require_node(reader, "parent_path", "/root")
	var gi_type: String = reader.optional_enum("gi_type", "voxel_gi", ["voxel_gi", "lightmap_gi", "reflection_probe"])
	if params_invalid(reader):
		return
	var node: VisualInstance3D
	match gi_type:
		"voxel_gi": node = VoxelGI.new()
		"lightmap_gi": node = LightmapGI.new()
		_:
			respond({"error": "Unknown GI type: %s" % gi_type})
			return
	if params.has("size") and node is VoxelGI:
		var s: Dictionary = params["size"]
		(node as VoxelGI).size = Vector3(float(s.get("x", 10)), float(s.get("y", 10)), float(s.get("z", 10)))
	if params.has("name") and not (params["name"] as String).is_empty():
		node.name = params["name"]
	parent.add_child(node)
	respond({"success": true, "path": str(node.get_path()), "gi_type": gi_type})


func _cmd_sky(params: Dictionary) -> void:
	var action: String = params.get("action", "create")
	var env: Environment = _get_or_create_environment()
	if env == null:
		respond({"error": "Could not get or create environment"})
		return
	var sky_type: String = params.get("sky_type", "procedural")
	if action == "create" or env.sky == null:
		env.sky = Sky.new()
		env.background_mode = Environment.BG_SKY
	var sky_mat: ProceduralSkyMaterial = env.sky.sky_material as ProceduralSkyMaterial
	if sky_mat == null:
		sky_mat = ProceduralSkyMaterial.new()
	if params.has("top_color"):
		var c: Dictionary = params["top_color"]
		sky_mat.sky_top_color = Color(float(c.get("r", 0.4)), float(c.get("g", 0.6)), float(c.get("b", 1.0)))
	if params.has("bottom_color"):
		var c: Dictionary = params["bottom_color"]
		sky_mat.sky_horizon_color = Color(float(c.get("r", 0.7)), float(c.get("g", 0.8)), float(c.get("b", 0.9)))
	if params.has("ground_color"):
		var c: Dictionary = params["ground_color"]
		sky_mat.ground_bottom_color = Color(float(c.get("r", 0.1)), float(c.get("g", 0.1)), float(c.get("b", 0.1)))
	if params.has("sun_energy"):
		sky_mat.sun_curve = float(params["sun_energy"])
	env.sky.sky_material = sky_mat
	respond({"success": true, "action": action, "sky_type": sky_type})


func _get_or_create_environment() -> Environment:
	var cam: Camera3D = get_viewport().get_camera_3d()
	if cam != null and cam.get_environment() != null:
		return cam.get_environment()
	var we: WorldEnvironment = null
	for child in get_tree().root.get_children():
		if child is WorldEnvironment:
			we = child as WorldEnvironment
			break
	if we != null and we.environment != null:
		return we.environment
	# Create one
	we = WorldEnvironment.new()
	we.environment = Environment.new()
	get_tree().root.add_child(we)
	return we.environment


func _cmd_camera_attributes(params: Dictionary) -> void:
	var reader := CommandParams.new(params)
	var action: String = reader.optional_enum("action", "get", ["get", "set"])
	if params_invalid(reader):
		return
	var cam: Camera3D = get_viewport().get_camera_3d()
	if cam == null:
		respond({"error": "No Camera3D found in viewport"})
		return
	if action == "get":
		var info: Dictionary = {"success": true, "action": "get"}
		if cam.attributes != null:
			info["has_attributes"] = true
		else:
			info["has_attributes"] = false
		respond(info)
		return
	# set
	if cam.attributes == null:
		cam.attributes = CameraAttributesPractical.new()
	var attr: CameraAttributesPractical = cam.attributes as CameraAttributesPractical
	if attr == null:
		respond({"error": "Camera attributes is not CameraAttributesPractical"})
		return
	if params.has("dof_blur_far"):
		attr.dof_blur_far_enabled = true
		attr.dof_blur_far_distance = float(params["dof_blur_far"])
	if params.has("dof_blur_near"):
		attr.dof_blur_near_enabled = true
		attr.dof_blur_near_distance = float(params["dof_blur_near"])
	if params.has("dof_blur_amount"):
		attr.dof_blur_amount = float(params["dof_blur_amount"])
	if params.has("auto_exposure"):
		attr.auto_exposure_enabled = bool(params["auto_exposure"])
	respond({"success": true, "action": "set"})


# ==========================================================================
# Batch 3: Animation Advanced + Audio Effects
# ==========================================================================

func _cmd_render_settings(params: Dictionary) -> void:
	var vp: Viewport = get_viewport()
	var reader := CommandParams.new(params)
	var action: String = reader.optional_enum("action", "get", ["get", "set"])
	if params_invalid(reader):
		return
	if action == "get":
		respond({"success": true, "msaa_2d": vp.msaa_2d, "msaa_3d": vp.msaa_3d, "screen_space_aa": vp.screen_space_aa, "use_taa": vp.use_taa, "scaling_3d_mode": vp.scaling_3d_mode, "scaling_3d_scale": vp.scaling_3d_scale})
		return
	if params.has("msaa_2d"):
		vp.msaa_2d = int(params["msaa_2d"]) as Viewport.MSAA
	if params.has("msaa_3d"):
		vp.msaa_3d = int(params["msaa_3d"]) as Viewport.MSAA
	if params.has("fxaa"):
		vp.screen_space_aa = Viewport.SCREEN_SPACE_AA_FXAA if bool(params["fxaa"]) else Viewport.SCREEN_SPACE_AA_DISABLED
	if params.has("taa"):
		vp.use_taa = bool(params["taa"])
	if params.has("scaling_mode"):
		vp.scaling_3d_mode = int(params["scaling_mode"]) as Viewport.Scaling3DMode
	if params.has("scaling_scale"):
		vp.scaling_3d_scale = float(params["scaling_scale"])
	respond({"success": true, "action": "set"})


func _cmd_video(params: Dictionary) -> void:
	var reader := CommandParams.new(params)
	var action: String = reader.optional_enum("action", "play", ["create", "play", "pause", "resume", "stop", "seek", "get_status"])
	if params_invalid(reader):
		return
	if action == "create":
		var parent_path: String = params.get("parent_path", "/root")
		var parent: Node = get_tree().root.get_node_or_null(parent_path)
		if parent == null:
			respond({"error": "Parent not found: %s" % parent_path})
			return
		var vp: VideoStreamPlayer = VideoStreamPlayer.new()
		var video_path: String = params.get("video_path", "")
		if not video_path.is_empty():
			if not ResourceLoader.exists(video_path):
				respond({"error": "Video resource not found: %s" % video_path})
				return
			var stream: Resource = ResourceLoader.load(video_path)
			if not stream is VideoStream:
				respond({"error": "Resource is not a VideoStream: %s" % video_path})
				return
			vp.stream = stream
		if params.has("volume"):
			vp.volume = float(params["volume"])
		if params.has("autoplay"):
			vp.autoplay = bool(params["autoplay"])
		if params.has("loop") and "loop" in vp:
			vp.set("loop", bool(params["loop"]))
		if params.has("name") and not (params["name"] as String).is_empty():
			vp.name = params["name"]
		parent.add_child(vp)
		if vp.autoplay:
			vp.play()
		respond({"success": true, "action": "create", "path": str(vp.get_path())})
		return
	var node_path: String = params.get("node_path", "")
	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null or not node is VideoStreamPlayer:
		respond({"error": "VideoStreamPlayer not found: %s" % node_path})
		return
	var player: VideoStreamPlayer = node as VideoStreamPlayer
	match action:
		"play":
			player.play()
			respond({"success": true, "action": "play"})
		"pause":
			player.paused = true
			respond({"success": true, "action": "pause"})
		"resume":
			player.paused = false
			respond({"success": true, "action": "resume"})
		"stop":
			player.stop()
			respond({"success": true, "action": "stop"})
		"seek":
			player.stream_position = float(params.get("position", 0.0))
			respond({"success": true, "action": "seek", "position": player.stream_position})
		"get_status":
			respond({"success": true, "action": "get_status", "is_playing": player.is_playing(), "paused": player.paused, "position": player.stream_position, "length": player.get_stream_length()})
		_:
			respond({"error": "Unknown video action: %s" % action})
