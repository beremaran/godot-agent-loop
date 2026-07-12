extends "res://mcp_runtime/runtime_domain.gd"

# Physics and navigation domain: raycasts and direct-space queries in 2D and
# 3D, collision shapes, physics body properties, joints, NavigationRegion3D
# management, and NavigationServer path queries. Commands that accept both
# dimensions pick 2D or 3D from the parameters (a `z` component) or from the
# target node's class, exactly as before the move.

const SHAPE_TYPES_3D: Array = ["box", "sphere", "capsule", "cylinder", "ray"]
const SHAPE_TYPES_2D: Array = ["box", "circle", "capsule", "segment"]
const JOINT_TYPES: Array = ["pin_2d", "spring_2d", "groove_2d", "pin_3d", "hinge_3d", "cone_3d", "slider_3d"]


func register_commands() -> void:
	register_command("raycast", _cmd_raycast)
	register_command("navigate_path", _cmd_navigate_path)
	register_command("add_collision", _cmd_add_collision)
	register_command("physics_body", _cmd_physics_body)
	register_command("create_joint", _cmd_create_joint)
	register_command("navigation_3d", _cmd_navigation_3d)
	register_command("physics_3d", _cmd_physics_3d)
	register_command("physics_2d", _cmd_physics_2d)


# Records a structured failure when the resolved node is not the class the
# command drives; the caller still routes through params_invalid().
func _require_class(reader: CommandParams, node: Node, type_name: String) -> void:
	if reader.failed() or node == null:
		return
	reader.fail("Node is not a %s: %s" % [type_name, node.get_class()],
		{"param": "node_path", "reason": "invalid_value", "expected": type_name, "value": node.get_class()})


func _vector2_from(value: Variant) -> Vector2:
	var source: Dictionary = CommandParams.as_dictionary(value)
	return Vector2(CommandParams.json_float(source, "x"), CommandParams.json_float(source, "y"))


func _vector3_from(value: Variant) -> Vector3:
	var source: Dictionary = CommandParams.as_dictionary(value)
	return Vector3(CommandParams.json_float(source, "x"), CommandParams.json_float(source, "y"), CommandParams.json_float(source, "z"))


func _apply_optional_name(reader: CommandParams, node: Node) -> void:
	var node_name: String = reader.optional_string("name")
	if not node_name.is_empty():
		node.name = node_name


# --- Raycast (2D or 3D depending on whether z is present) ---
func _cmd_raycast(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var from_dict: Dictionary = reader.optional_dictionary("from")
	var to_dict: Dictionary = reader.optional_dictionary("to")
	var collision_mask: int = reader.optional_int("collision_mask", 0xFFFFFFFF)
	if params_invalid(reader):
		return

	var is_3d: bool = from_dict.has("z") or to_dict.has("z")
	# Wait a frame so the physics state reflects the latest scene changes.
	await get_tree().process_frame

	if is_3d:
		var query: PhysicsRayQueryParameters3D = PhysicsRayQueryParameters3D.create(
			_vector3_from(from_dict), _vector3_from(to_dict), collision_mask)
		_respond_ray_hit("3d", get_viewport().world_3d.direct_space_state.intersect_ray(query))
	else:
		var query: PhysicsRayQueryParameters2D = PhysicsRayQueryParameters2D.create(
			_vector2_from(from_dict), _vector2_from(to_dict), collision_mask)
		_respond_ray_hit("2d", get_viewport().world_2d.direct_space_state.intersect_ray(query))


func _respond_ray_hit(mode: String, result: Dictionary) -> void:
	if result.is_empty():
		respond({"success": true, "hit": false, "mode": mode})
		return
	respond({
		"success": true, "hit": true, "mode": mode,
		"position": variant_to_json(result["position"]),
		"normal": variant_to_json(result["normal"]),
		"collider_path": _collider_path(result),
		"collider_class": _collider_class(result),
	})


func _collider(result: Dictionary) -> Node:
	var collider: Variant = result.get("collider")
	if collider is Node:
		return collider
	return null


func _collider_path(result: Dictionary) -> String:
	var collider: Node = _collider(result)
	return str(collider.get_path()) if collider != null else ""


func _collider_class(result: Dictionary) -> String:
	var collider: Node = _collider(result)
	return collider.get_class() if collider != null else ""


# --- Navigation path query via NavigationServer ---
func _cmd_navigate_path(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var start: Dictionary = reader.required_dictionary("start")
	var end: Dictionary = reader.required_dictionary("end")
	var optimize: bool = reader.optional_bool("optimize", true)
	if not reader.failed() and (start.is_empty() or end.is_empty()):
		var empty_name: String = "start" if start.is_empty() else "end"
		reader.fail("%s must be a position object" % empty_name, {"param": empty_name, "reason": "invalid_value"})
	if params_invalid(reader):
		return

	# Wait a frame so the navigation map is ready.
	await get_tree().process_frame

	if start.has("z") or end.has("z"):
		var map_rid: RID = get_tree().root.get_world_3d().get_navigation_map()
		var path: PackedVector3Array = NavigationServer3D.map_get_path(map_rid, _vector3_from(start), _vector3_from(end), optimize)
		var total_length: float = 0.0
		for i: int in range(1, path.size()):
			total_length += path[i - 1].distance_to(path[i])
		respond({"success": true, "mode": "3d", "path": variant_to_json(path), "point_count": path.size(), "total_length": total_length})
	else:
		var map_rid: RID = get_tree().root.get_world_2d().get_navigation_map()
		var path: PackedVector2Array = NavigationServer2D.map_get_path(map_rid, _vector2_from(start), _vector2_from(end), optimize)
		var total_length: float = 0.0
		for i: int in range(1, path.size()):
			total_length += path[i - 1].distance_to(path[i])
		respond({"success": true, "mode": "2d", "path": variant_to_json(path), "point_count": path.size(), "total_length": total_length})


# --- Collision shapes ---
func _cmd_add_collision(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var parent: Node = require_node(reader, "parent_path")
	var shape_type: String = reader.required_string("shape_type")
	var shape_params: Dictionary = reader.optional_dictionary("shape_params")
	var disabled: bool = reader.optional_bool("disabled", false)
	var collision_layer: int = reader.optional_int("collision_layer", 0)
	var collision_mask: int = reader.optional_int("collision_mask", 0)
	var is_3d: bool = parent != null and (parent.get_class().ends_with("3D") or parent is PhysicsBody3D or parent is Area3D)
	if not reader.failed():
		var allowed: Array = SHAPE_TYPES_3D if is_3d else SHAPE_TYPES_2D
		if not allowed.has(shape_type):
			reader.fail("Unknown %s shape type: %s. Use %s" % ["3D" if is_3d else "2D", shape_type, ", ".join(allowed)],
				{"param": "shape_type", "reason": "invalid_value", "allowed": allowed, "value": shape_type})
	if params_invalid(reader):
		return

	var col_shape: Node
	if is_3d:
		var shape_3d: CollisionShape3D = CollisionShape3D.new()
		shape_3d.shape = _shape_3d(shape_type, shape_params)
		if reader.has_param("disabled"):
			shape_3d.disabled = disabled
		col_shape = shape_3d
	else:
		var shape_2d: CollisionShape2D = CollisionShape2D.new()
		shape_2d.shape = _shape_2d(shape_type, shape_params)
		if reader.has_param("disabled"):
			shape_2d.disabled = disabled
		col_shape = shape_2d
	parent.add_child(col_shape)
	col_shape.owner = get_tree().edited_scene_root if get_tree().edited_scene_root else get_tree().root
	if reader.has_param("collision_layer"):
		parent.set("collision_layer", collision_layer)
	if reader.has_param("collision_mask"):
		parent.set("collision_mask", collision_mask)
	respond({"success": true, "name": col_shape.name, "path": str(col_shape.get_path()), "shape_type": shape_type, "mode": "3d" if is_3d else "2d"})


func _shape_3d(shape_type: String, shape_params: Dictionary) -> Shape3D:
	match shape_type:
		"box":
			var s: BoxShape3D = BoxShape3D.new()
			s.size = Vector3(CommandParams.json_float(shape_params, "size_x", 1), CommandParams.json_float(shape_params, "size_y", 1), CommandParams.json_float(shape_params, "size_z", 1))
			return s
		"sphere":
			var s: SphereShape3D = SphereShape3D.new()
			s.radius = CommandParams.json_float(shape_params, "radius", 0.5)
			return s
		"capsule":
			var s: CapsuleShape3D = CapsuleShape3D.new()
			s.radius = CommandParams.json_float(shape_params, "radius", 0.5)
			s.height = CommandParams.json_float(shape_params, "height", 2.0)
			return s
		"cylinder":
			var s: CylinderShape3D = CylinderShape3D.new()
			s.radius = CommandParams.json_float(shape_params, "radius", 0.5)
			s.height = CommandParams.json_float(shape_params, "height", 2.0)
			return s
		"ray":
			var s: SeparationRayShape3D = SeparationRayShape3D.new()
			s.length = CommandParams.json_float(shape_params, "length", 1.0)
			return s
	return null


func _shape_2d(shape_type: String, shape_params: Dictionary) -> Shape2D:
	match shape_type:
		"box":
			var s: RectangleShape2D = RectangleShape2D.new()
			s.size = Vector2(CommandParams.json_float(shape_params, "size_x", 1), CommandParams.json_float(shape_params, "size_y", 1))
			return s
		"circle":
			var s: CircleShape2D = CircleShape2D.new()
			s.radius = CommandParams.json_float(shape_params, "radius", 0.5)
			return s
		"capsule":
			var s: CapsuleShape2D = CapsuleShape2D.new()
			s.radius = CommandParams.json_float(shape_params, "radius", 0.5)
			s.height = CommandParams.json_float(shape_params, "height", 2.0)
			return s
		"segment":
			var s: SegmentShape2D = SegmentShape2D.new()
			s.a = Vector2(CommandParams.json_float(shape_params, "a_x", 0), CommandParams.json_float(shape_params, "a_y", 0))
			s.b = Vector2(CommandParams.json_float(shape_params, "b_x", 1), CommandParams.json_float(shape_params, "b_y", 0))
			return s
	return null


# --- Physics body properties ---
func _cmd_physics_body(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var node: Node = require_node(reader)
	if node != null and not (node is PhysicsBody2D or node is PhysicsBody3D):
		_require_class(reader, node, "PhysicsBody2D or PhysicsBody3D")
	var gravity_scale: float = reader.optional_number("gravity_scale", 0.0)
	var mass: float = reader.optional_number("mass", 0.0)
	var freeze: bool = reader.optional_bool("freeze", false)
	var sleeping: bool = reader.optional_bool("sleeping", false)
	var linear_damp: float = reader.optional_number("linear_damp", 0.0)
	var angular_damp: float = reader.optional_number("angular_damp", 0.0)
	var linear_velocity: Dictionary = reader.optional_dictionary("linear_velocity")
	var angular_velocity: Variant = reader.raw("angular_velocity")
	if reader.has_param("angular_velocity") and not (angular_velocity is Dictionary or angular_velocity is float or angular_velocity is int):
		reader.fail("angular_velocity must be a number or an object", {"param": "angular_velocity", "reason": "invalid_type"})
	var friction: float = reader.optional_number("friction", 0.0)
	var bounce: float = reader.optional_number("bounce", 0.0)
	if params_invalid(reader):
		return

	# Common properties are set only where the concrete body class exposes them.
	if reader.has_param("gravity_scale") and node.get("gravity_scale") != null:
		node.set("gravity_scale", gravity_scale)
	if reader.has_param("mass") and node.get("mass") != null:
		node.set("mass", mass)
	if reader.has_param("freeze") and node.get("freeze") != null:
		node.set("freeze", freeze)
	if reader.has_param("sleeping") and node.get("sleeping") != null:
		node.set("sleeping", sleeping)
	if reader.has_param("linear_damp") and node.get("linear_damp") != null:
		node.set("linear_damp", linear_damp)
	if reader.has_param("angular_damp") and node.get("angular_damp") != null:
		node.set("angular_damp", angular_damp)

	# Velocity (2D vs 3D)
	if reader.has_param("linear_velocity"):
		if node is PhysicsBody3D:
			node.set("linear_velocity", _vector3_from(linear_velocity))
		else:
			node.set("linear_velocity", _vector2_from(linear_velocity))
	if reader.has_param("angular_velocity"):
		if node is PhysicsBody3D and angular_velocity is Dictionary:
			node.set("angular_velocity", _vector3_from(angular_velocity))
		else:
			node.set("angular_velocity", CommandParams.to_float(angular_velocity))

	# Physics material (friction, bounce)
	if reader.has_param("friction") or reader.has_param("bounce"):
		var material_value: Variant = node.get("physics_material_override")
		var phys_mat: PhysicsMaterial = null
		if material_value is PhysicsMaterial:
			phys_mat = material_value
		if phys_mat == null:
			phys_mat = PhysicsMaterial.new()
			node.set("physics_material_override", phys_mat)
		if reader.has_param("friction"):
			phys_mat.friction = friction
		if reader.has_param("bounce"):
			phys_mat.bounce = bounce

	var result: Dictionary = {"success": true, "node_path": params.get("node_path"), "class": node.get_class()}
	if node.get("mass") != null:
		result["mass"] = node.get("mass")
	if node.get("gravity_scale") != null:
		result["gravity_scale"] = node.get("gravity_scale")
	if node.get("linear_velocity") != null:
		result["linear_velocity"] = variant_to_json(node.get("linear_velocity"))
	if node.get("angular_velocity") != null:
		result["angular_velocity"] = variant_to_json(node.get("angular_velocity"))
	respond(result)


# --- Joints ---
func _cmd_create_joint(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var parent: Node = require_node(reader, "parent_path")
	var joint_type: String = reader.required_enum("joint_type", JOINT_TYPES)
	var node_a: String = reader.optional_string("node_a_path")
	var node_b: String = reader.optional_string("node_b_path")
	var softness: float = reader.optional_number("softness", 0.0)
	var length: float = reader.optional_number("length", 0.0)
	var rest_length: float = reader.optional_number("rest_length", 0.0)
	var stiffness: float = reader.optional_number("stiffness", 0.0)
	var damping: float = reader.optional_number("damping", 0.0)
	var initial_offset: float = reader.optional_number("initial_offset", 0.0)
	if params_invalid(reader):
		return

	var joint: Node = null
	match joint_type:
		"pin_2d":
			var j: PinJoint2D = PinJoint2D.new()
			if reader.has_param("softness"):
				j.softness = softness
			joint = j
		"spring_2d":
			var j: DampedSpringJoint2D = DampedSpringJoint2D.new()
			if reader.has_param("length"):
				j.length = length
			if reader.has_param("rest_length"):
				j.rest_length = rest_length
			if reader.has_param("stiffness"):
				j.stiffness = stiffness
			if reader.has_param("damping"):
				j.damping = damping
			joint = j
		"groove_2d":
			var j: GrooveJoint2D = GrooveJoint2D.new()
			if reader.has_param("length"):
				j.length = length
			if reader.has_param("initial_offset"):
				j.initial_offset = initial_offset
			joint = j
		"pin_3d":
			joint = PinJoint3D.new()
		"hinge_3d":
			joint = HingeJoint3D.new()
		"cone_3d":
			joint = ConeTwistJoint3D.new()
		"slider_3d":
			joint = SliderJoint3D.new()
	# Joint2D and Joint3D both expose node_a/node_b as NodePath properties.
	if not node_a.is_empty():
		joint.set("node_a", NodePath(node_a))
	if not node_b.is_empty():
		joint.set("node_b", NodePath(node_b))
	parent.add_child(joint)
	respond({"success": true, "joint_type": joint_type, "name": joint.name, "path": str(joint.get_path())})


# --- NavigationRegion3D management ---
func _cmd_navigation_3d(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var action: String = reader.optional_enum("action", "create", ["create", "bake"])
	if params_invalid(reader):
		return

	match action:
		"create":
			var parent: Node = require_node(reader, "parent_path", "/root")
			var cell_size: float = reader.optional_number("cell_size", 0.0)
			var agent_radius: float = reader.optional_number("agent_radius", 0.0)
			var agent_height: float = reader.optional_number("agent_height", 0.0)
			if params_invalid(reader):
				return
			var region: NavigationRegion3D = NavigationRegion3D.new()
			region.navigation_mesh = NavigationMesh.new()
			if reader.has_param("cell_size"):
				region.navigation_mesh.cell_size = cell_size
			if reader.has_param("agent_radius"):
				region.navigation_mesh.agent_radius = agent_radius
			if reader.has_param("agent_height"):
				region.navigation_mesh.agent_height = agent_height
			_apply_optional_name(reader, region)
			parent.add_child(region)
			respond({"success": true, "action": "create", "path": str(region.get_path())})
		"bake":
			var node: Node = require_node(reader)
			if node != null and not node is NavigationRegion3D:
				_require_class(reader, node, "NavigationRegion3D")
			if params_invalid(reader):
				return
			(node as NavigationRegion3D).bake_navigation_mesh()
			await get_tree().process_frame
			await get_tree().process_frame
			respond({"success": true, "action": "bake"})


# --- 3D direct-space queries ---
func _cmd_physics_3d(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var action: String = reader.optional_enum("action", "ray", ["ray", "overlap"])
	if params_invalid(reader):
		return

	match action:
		"ray":
			var from_dict: Dictionary = reader.optional_dictionary("from")
			var to_dict: Dictionary = reader.optional_dictionary("to")
			var collision_mask: int = reader.optional_int("collision_mask", 0)
			if params_invalid(reader):
				return
			await get_tree().physics_frame
			var query: PhysicsRayQueryParameters3D = PhysicsRayQueryParameters3D.create(_vector3_from(from_dict), _vector3_from(to_dict))
			if reader.has_param("collision_mask"):
				query.collision_mask = collision_mask
			var result: Dictionary = get_viewport().world_3d.direct_space_state.intersect_ray(query)
			if result.is_empty():
				respond({"success": true, "action": "ray", "hit": false})
			else:
				respond({"success": true, "action": "ray", "hit": true, "position": variant_to_json(result["position"]), "normal": variant_to_json(result["normal"]), "collider": str(result.get("collider", ""))})
		"overlap":
			var node: Node = require_node(reader)
			if node != null and not node is Area3D:
				_require_class(reader, node, "Area3D")
			if params_invalid(reader):
				return
			await get_tree().physics_frame
			var bodies: Array = (node as Area3D).get_overlapping_bodies()
			var out: Array = []
			for body: Node in bodies:
				out.append({"name": body.name, "path": str(body.get_path())})
			respond({"success": true, "action": "overlap", "bodies": out})


# --- 2D direct-space queries ---
func _cmd_physics_2d(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var action: String = reader.optional_enum("action", "ray", ["ray", "overlap", "point_query", "shape_query"])
	if params_invalid(reader):
		return

	match action:
		"ray":
			var from_dict: Dictionary = reader.optional_dictionary("from")
			var to_dict: Dictionary = reader.optional_dictionary("to")
			var collision_mask: int = reader.optional_int("collision_mask", 0)
			if params_invalid(reader):
				return
			await get_tree().physics_frame
			var query: PhysicsRayQueryParameters2D = PhysicsRayQueryParameters2D.create(_vector2_from(from_dict), _vector2_from(to_dict))
			if reader.has_param("collision_mask"):
				query.collision_mask = collision_mask
			var result: Dictionary = get_viewport().world_2d.direct_space_state.intersect_ray(query)
			if result.is_empty():
				respond({"success": true, "action": "ray", "hit": false})
			else:
				respond({"success": true, "action": "ray", "hit": true, "position": variant_to_json(result["position"]), "normal": variant_to_json(result["normal"]), "collider": str(result.get("collider", ""))})
		"overlap":
			var node: Node = require_node(reader)
			if node != null and not node is Area2D:
				_require_class(reader, node, "Area2D")
			if params_invalid(reader):
				return
			await get_tree().physics_frame
			var bodies: Array = (node as Area2D).get_overlapping_bodies()
			var out: Array = []
			for body: Node in bodies:
				out.append({"name": body.name, "path": str(body.get_path())})
			respond({"success": true, "action": "overlap", "bodies": out})
		"point_query":
			var position: Dictionary = reader.optional_dictionary("position", reader.optional_dictionary("point"))
			var collide_with_areas: bool = reader.optional_bool("collide_with_areas", true)
			var collide_with_bodies: bool = reader.optional_bool("collide_with_bodies", true)
			var collision_mask: int = reader.optional_int("collision_mask", 0)
			var max_results: int = reader.optional_int("max_results", 32, 1)
			if params_invalid(reader):
				return
			await get_tree().physics_frame
			var query: PhysicsPointQueryParameters2D = PhysicsPointQueryParameters2D.new()
			query.position = _vector2_from(position)
			query.collide_with_areas = collide_with_areas
			query.collide_with_bodies = collide_with_bodies
			if reader.has_param("collision_mask"):
				query.collision_mask = collision_mask
			var hits: Array = get_viewport().world_2d.direct_space_state.intersect_point(query, max_results)
			var out: Array = []
			for hit: Dictionary in hits:
				out.append({"collider": str(hit.get("collider", "")), "rid": str(hit.get("rid", ""))})
			respond({"success": true, "action": "point_query", "count": out.size(), "results": out})
		"shape_query":
			var shape_type: String = reader.optional_enum("shape_type", "circle", ["circle", "rectangle"])
			var size: Dictionary = reader.optional_dictionary("size", {"x": 10, "y": 10})
			var radius: float = reader.optional_number("radius", 10.0)
			var position: Dictionary = reader.optional_dictionary("position")
			var collide_with_areas: bool = reader.optional_bool("collide_with_areas", true)
			var collide_with_bodies: bool = reader.optional_bool("collide_with_bodies", true)
			var collision_mask: int = reader.optional_int("collision_mask", 0)
			var max_results: int = reader.optional_int("max_results", 32, 1)
			if params_invalid(reader):
				return
			await get_tree().physics_frame
			var shape: Shape2D
			if shape_type == "rectangle":
				var rect: RectangleShape2D = RectangleShape2D.new()
				rect.size = Vector2(CommandParams.json_float(size, "x", 10), CommandParams.json_float(size, "y", 10))
				shape = rect
			else:
				var circle: CircleShape2D = CircleShape2D.new()
				circle.radius = radius
				shape = circle
			var query: PhysicsShapeQueryParameters2D = PhysicsShapeQueryParameters2D.new()
			query.shape = shape
			var transform: Transform2D = Transform2D.IDENTITY
			transform.origin = _vector2_from(position)
			query.transform = transform
			query.collide_with_areas = collide_with_areas
			query.collide_with_bodies = collide_with_bodies
			if reader.has_param("collision_mask"):
				query.collision_mask = collision_mask
			var hits: Array = get_viewport().world_2d.direct_space_state.intersect_shape(query, max_results)
			var out: Array = []
			for hit: Dictionary in hits:
				out.append({"collider": str(hit.get("collider", "")), "rid": str(hit.get("rid", ""))})
			respond({"success": true, "action": "shape_query", "count": out.size(), "results": out})
