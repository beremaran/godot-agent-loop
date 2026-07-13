extends "res://mcp_runtime/runtime_domain.gd"

# 3D scene and geometry domain: CSG, instanced and procedural meshes, lights,
# GridMap editing, scene effects, paths, and the built-in terrain mesh service.

func register_commands() -> void:
	register_command("csg", _cmd_csg)
	register_command("multimesh", _cmd_multimesh)
	register_command("procedural_mesh", _cmd_procedural_mesh)
	register_command("light_3d", _cmd_light_3d)
	register_command("mesh_instance", _cmd_mesh_instance)
	register_command("gridmap", _cmd_gridmap)
	register_command("3d_effects", _cmd_3d_effects)
	register_command("path_3d", _cmd_path_3d)
	register_command("terrain", _cmd_terrain)


func _cmd_csg(params: Dictionary) -> void:
	var reader := CommandParams.new(params)
	var action: String = reader.optional_enum("action", "create", ["create", "configure"])
	if params_invalid(reader):
		return
	if action == "create":
		var parent: Node = require_node(reader, "parent_path", "/root")
		var csg_type: String = reader.optional_enum("csg_type", "box", ["box", "sphere", "cylinder", "mesh", "combiner"])
		var operation: String = reader.optional_enum("operation", "union", ["union", "intersection", "subtraction"])
		if params_invalid(reader):
			return
		var node: CSGShape3D
		match csg_type:
			"box": node = CSGBox3D.new()
			"sphere": node = CSGSphere3D.new()
			"cylinder": node = CSGCylinder3D.new()
			"mesh": node = CSGMesh3D.new()
			"combiner": node = CSGCombiner3D.new()
		if params.has("operation"):
			match operation:
				"union": node.operation = CSGShape3D.OPERATION_UNION
				"intersection": node.operation = CSGShape3D.OPERATION_INTERSECTION
				"subtraction": node.operation = CSGShape3D.OPERATION_SUBTRACTION
		var custom_name: String = CommandParams.json_string(params, "name")
		if not custom_name.is_empty():
			node.name = custom_name
		if node is CSGBox3D and params.has("size"):
			var box_size: Variant = json_to_variant(params["size"], "Vector3")
			if box_size is Vector3:
				(node as CSGBox3D).size = box_size
		if node is CSGSphere3D and params.has("radius"):
			(node as CSGSphere3D).radius = CommandParams.to_float(params["radius"])
		if node is CSGCylinder3D:
			if params.has("radius"):
				(node as CSGCylinder3D).radius = CommandParams.to_float(params["radius"])
			if params.has("height"):
				(node as CSGCylinder3D).height = CommandParams.to_float(params["height"])
		parent.add_child(node)
		node.owner = get_tree().edited_scene_root if get_tree().edited_scene_root else get_tree().root
		respond({"success": true, "action": "create", "path": str(node.get_path()), "type": csg_type})
	elif action == "configure":
		var node: Node = require_node(reader)
		var operation: String = reader.optional_enum("operation", "union", ["union", "intersection", "subtraction"])
		if node != null and not node is CSGShape3D:
			reader.fail("node_path must reference a CSGShape3D", {"param": "node_path", "reason": "invalid_value", "expected_class": "CSGShape3D"})
		if params_invalid(reader):
			return
		if params.has("operation"):
			match operation:
				"union": (node as CSGShape3D).operation = CSGShape3D.OPERATION_UNION
				"intersection": (node as CSGShape3D).operation = CSGShape3D.OPERATION_INTERSECTION
				"subtraction": (node as CSGShape3D).operation = CSGShape3D.OPERATION_SUBTRACTION
		respond({"success": true, "action": "configure", "path": str(node.get_path())})


func _cmd_multimesh(params: Dictionary) -> void:
	var action: String = params.get("action", "create")
	match action:
		"create":
			var parent_path: String = params.get("parent_path", "/root")
			var parent: Node = get_tree().root.get_node_or_null(parent_path)
			if parent == null:
				respond({"error": "Parent not found: %s" % parent_path})
				return
			var mmi: MultiMeshInstance3D = MultiMeshInstance3D.new()
			var mm: MultiMesh = MultiMesh.new()
			mm.transform_format = MultiMesh.TRANSFORM_3D
			mm.instance_count = CommandParams.json_int(params, "count", 1)
			var mesh_type: String = params.get("mesh_type", "box")
			match mesh_type:
				"box": mm.mesh = BoxMesh.new()
				"sphere": mm.mesh = SphereMesh.new()
				"cylinder": mm.mesh = CylinderMesh.new()
				_: mm.mesh = BoxMesh.new()
			mmi.multimesh = mm
			var custom_name: String = CommandParams.json_string(params, "name")
			if not custom_name.is_empty():
				mmi.name = custom_name
			parent.add_child(mmi)
			respond({"success": true, "action": "create", "path": str(mmi.get_path()), "count": mm.instance_count})
		"set_instance":
			var node_path: String = params.get("node_path", "")
			var node: Node = get_tree().root.get_node_or_null(node_path)
			if node == null or not node is MultiMeshInstance3D:
				respond({"error": "MultiMeshInstance3D not found: %s" % node_path})
				return
			var idx: int = CommandParams.json_int(params, "index", 0)
			var mm: MultiMesh = (node as MultiMeshInstance3D).multimesh
			if idx < 0 or idx >= mm.instance_count:
				respond({"error": "index %d is outside the instance range 0..%d" % [idx, mm.instance_count - 1], "error_data": {"param": "index", "reason": "out_of_range", "value": idx, "instance_count": mm.instance_count}})
				return
			# Instance transforms live in the rendering server's buffer. Godot's
			# headless dummy renderer allocates no buffer, so the write would be
			# dropped without a word; say so instead of reporting success.
			if not _multimesh_instance_data_available(mm):
				respond_limit(
					"MultiMesh instance data is unavailable: the active rendering server does not allocate instance buffers (Godot's headless dummy renderer). Run the game with a display to position MultiMesh instances.",
					{"reason": "instance_buffer_unavailable", "video_adapter": RenderingServer.get_video_adapter_name()},
				)
				return
			var tf: Dictionary = params.get("transform", {})
			var origin: Dictionary = tf.get("origin", {})
			var xform: Transform3D = Transform3D.IDENTITY
			xform.origin = Vector3(CommandParams.json_float(origin, "x", 0), CommandParams.json_float(origin, "y", 0), CommandParams.json_float(origin, "z", 0))
			mm.set_instance_transform(idx, xform)
			respond({"success": true, "action": "set_instance", "index": idx})
		"get_info":
			var node_path: String = params.get("node_path", "")
			var node: Node = get_tree().root.get_node_or_null(node_path)
			if node == null or not node is MultiMeshInstance3D:
				respond({"error": "MultiMeshInstance3D not found: %s" % node_path})
				return
			var mm: MultiMesh = (node as MultiMeshInstance3D).multimesh
			respond({
				"success": true,
				"count": mm.instance_count if mm else 0,
				"visible_count": mm.visible_instance_count if mm else 0,
				"instance_data_available": _multimesh_instance_data_available(mm) if mm else false,
			})
		_:
			respond({"error": "Unknown multimesh action: %s" % action})


# An instance_count > 0 with an empty buffer means the rendering server kept no
# per-instance storage, which is what the headless dummy renderer does.
func _multimesh_instance_data_available(mm: MultiMesh) -> bool:
	return mm.instance_count <= 0 or not mm.buffer.is_empty()


# Mesh buffers arrive as [x, y, z] triples; curve points arrive as {x, y, z}.
func _vec3_from_triple(value: Variant) -> Vector3:
	var triple: Array = CommandParams.as_array(value)
	return Vector3(
		CommandParams.to_float(triple[0] if triple.size() > 0 else 0.0),
		CommandParams.to_float(triple[1] if triple.size() > 1 else 0.0),
		CommandParams.to_float(triple[2] if triple.size() > 2 else 0.0),
	)


func _vec3_from_object(value: Variant) -> Vector3:
	var point: Dictionary = CommandParams.as_dictionary(value)
	return Vector3(CommandParams.json_float(point, "x"), CommandParams.json_float(point, "y"), CommandParams.json_float(point, "z"))


func _cmd_procedural_mesh(params: Dictionary) -> void:
	var parent_path: String = params.get("parent_path", "/root")
	var parent: Node = get_tree().root.get_node_or_null(parent_path)
	if parent == null:
		respond({"error": "Parent not found: %s" % parent_path})
		return
	var verts: PackedVector3Array = PackedVector3Array()
	for v: Variant in CommandParams.json_array(params, "vertices"):
		@warning_ignore("return_value_discarded")
		verts.append(_vec3_from_triple(v))
	var arrays: Array = []
	@warning_ignore("return_value_discarded")
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = verts
	if params.has("normals"):
		var norms: PackedVector3Array = PackedVector3Array()
		for n: Variant in CommandParams.json_array(params, "normals"):
			@warning_ignore("return_value_discarded")
			norms.append(_vec3_from_triple(n))
		arrays[Mesh.ARRAY_NORMAL] = norms
	if params.has("uvs"):
		var uvs: PackedVector2Array = PackedVector2Array()
		for uv: Variant in CommandParams.json_array(params, "uvs"):
			var pair: Array = CommandParams.as_array(uv)
			@warning_ignore("return_value_discarded")
			uvs.append(Vector2(CommandParams.to_float(pair[0] if pair.size() > 0 else 0.0), CommandParams.to_float(pair[1] if pair.size() > 1 else 0.0)))
		arrays[Mesh.ARRAY_TEX_UV] = uvs
	if params.has("indices"):
		var indices: PackedInt32Array = PackedInt32Array()
		for idx: Variant in CommandParams.json_array(params, "indices"):
			@warning_ignore("return_value_discarded")
			indices.append(CommandParams.to_int(idx))
		arrays[Mesh.ARRAY_INDEX] = indices
	var mesh: ArrayMesh = ArrayMesh.new()
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	var mi: MeshInstance3D = MeshInstance3D.new()
	mi.mesh = mesh
	var custom_name: String = CommandParams.json_string(params, "name")
	if not custom_name.is_empty():
		mi.name = custom_name
	parent.add_child(mi)
	respond({"success": true, "path": str(mi.get_path()), "vertex_count": verts.size()})


func _cmd_light_3d(params: Dictionary) -> void:
	var action: String = params.get("action", "create")
	if action == "create":
		var parent_path: String = params.get("parent_path", "/root")
		var parent: Node = get_tree().root.get_node_or_null(parent_path)
		if parent == null:
			respond({"error": "Parent not found: %s" % parent_path})
			return
		var light_type: String = params.get("light_type", "omni")
		var light: Light3D
		match light_type:
			"directional": light = DirectionalLight3D.new()
			"omni": light = OmniLight3D.new()
			"spot": light = SpotLight3D.new()
			_:
				respond({"error": "Unknown light type: %s" % light_type})
				return
		if params.has("color"):
			var c: Dictionary = params["color"]
			light.light_color = Color(CommandParams.json_float(c, "r", 1), CommandParams.json_float(c, "g", 1), CommandParams.json_float(c, "b", 1))
		if params.has("energy"):
			light.light_energy = CommandParams.to_float(params["energy"])
		if params.has("shadows"):
			light.shadow_enabled = CommandParams.to_bool(params["shadows"])
		if light is OmniLight3D and params.has("range"):
			(light as OmniLight3D).omni_range = CommandParams.to_float(params["range"])
		if light is SpotLight3D:
			if params.has("range"):
				(light as SpotLight3D).spot_range = CommandParams.to_float(params["range"])
			if params.has("spot_angle"):
				(light as SpotLight3D).spot_angle = CommandParams.to_float(params["spot_angle"])
		var custom_name: String = CommandParams.json_string(params, "name")
		if not custom_name.is_empty():
			light.name = custom_name
		parent.add_child(light)
		respond({"success": true, "action": "create", "path": str(light.get_path()), "type": light_type})
	elif action == "configure":
		var node_path: String = params.get("node_path", "")
		var node: Node = get_tree().root.get_node_or_null(node_path)
		if node == null or not node is Light3D:
			respond({"error": "Light3D not found: %s" % node_path})
			return
		var light: Light3D = node as Light3D
		if params.has("color"):
			var c: Dictionary = params["color"]
			light.light_color = Color(CommandParams.json_float(c, "r", 1), CommandParams.json_float(c, "g", 1), CommandParams.json_float(c, "b", 1))
		if params.has("energy"):
			light.light_energy = CommandParams.to_float(params["energy"])
		if params.has("shadows"):
			light.shadow_enabled = CommandParams.to_bool(params["shadows"])
		respond({"success": true, "action": "configure", "path": str(node.get_path())})
	else:
		respond({"error": "Unknown light_3d action: %s" % action})


func _cmd_mesh_instance(params: Dictionary) -> void:
	var reader := CommandParams.new(params)
	var parent: Node = require_node(reader, "parent_path", "/root")
	var mesh_type: String = reader.optional_enum("mesh_type", "box", ["box", "sphere", "cylinder", "capsule", "plane", "quad"])
	var radius: float = reader.optional_number("radius", 0.0, 0.0)
	var height: float = reader.optional_number("height", 0.0, 0.0)
	if params_invalid(reader):
		return
	var mesh: Mesh
	match mesh_type:
		"box": mesh = BoxMesh.new()
		"sphere": mesh = SphereMesh.new()
		"cylinder": mesh = CylinderMesh.new()
		"capsule": mesh = CapsuleMesh.new()
		"plane": mesh = PlaneMesh.new()
		"quad": mesh = QuadMesh.new()
	if params.has("size"):
		var s: Dictionary = reader.required_dictionary("size")
		if mesh is BoxMesh:
			(mesh as BoxMesh).size = Vector3(CommandParams.json_float(s, "x", 1), CommandParams.json_float(s, "y", 1), CommandParams.json_float(s, "z", 1))
		elif mesh is QuadMesh:
			(mesh as QuadMesh).size = Vector2(CommandParams.json_float(s, "x", 1), CommandParams.json_float(s, "y", 1))
		elif mesh is PlaneMesh:
			(mesh as PlaneMesh).size = Vector2(CommandParams.json_float(s, "x", 1), CommandParams.json_float(s, "z", 1))
	if params_invalid(reader):
		return
	if params.has("radius"):
		if mesh is SphereMesh: (mesh as SphereMesh).radius = radius
		elif mesh is CylinderMesh:
			(mesh as CylinderMesh).top_radius = radius
			(mesh as CylinderMesh).bottom_radius = radius
		elif mesh is CapsuleMesh: (mesh as CapsuleMesh).radius = radius
	if params.has("height"):
		if mesh is CylinderMesh: (mesh as CylinderMesh).height = height
		elif mesh is CapsuleMesh: (mesh as CapsuleMesh).height = height
		elif mesh is SphereMesh: (mesh as SphereMesh).height = height
	var mi: MeshInstance3D = MeshInstance3D.new()
	mi.mesh = mesh
	if params.has("material") and params["material"] is String:
		var mat: StandardMaterial3D = StandardMaterial3D.new()
		var hex: String = params["material"]
		if hex.begins_with("#") or hex.length() == 6 or hex.length() == 8:
			mat.albedo_color = Color.from_string(hex, Color.WHITE)
		mi.material_override = mat
	var custom_name: String = CommandParams.json_string(params, "name")
	if not custom_name.is_empty():
		mi.name = custom_name
	parent.add_child(mi)
	respond({"success": true, "path": str(mi.get_path()), "mesh_type": mesh_type})


func _cmd_gridmap(params: Dictionary) -> void:
	var node_path: String = params.get("node_path", "")
	var node: Node = get_tree().root.get_node_or_null(node_path)
	if node == null or not node is GridMap:
		respond({"error": "GridMap not found: %s" % node_path})
		return
	var gm: GridMap = node as GridMap
	var action: String = params.get("action", "get_used")
	match action:
		"set_cell":
			gm.set_cell_item(Vector3i(CommandParams.json_int(params, "x", 0), CommandParams.json_int(params, "y", 0), CommandParams.json_int(params, "z", 0)), CommandParams.json_int(params, "item", 0), CommandParams.json_int(params, "orientation", 0))
			respond({"success": true, "action": "set_cell"})
		"get_cell":
			var item: int = gm.get_cell_item(Vector3i(CommandParams.json_int(params, "x", 0), CommandParams.json_int(params, "y", 0), CommandParams.json_int(params, "z", 0)))
			respond({"success": true, "action": "get_cell", "item": item})
		"clear":
			gm.clear()
			respond({"success": true, "action": "clear"})
		"get_used":
			var cells: Array = gm.get_used_cells()
			var result: Array = []
			for c: Vector3i in cells.slice(0, 100):
				result.append({"x": c.x, "y": c.y, "z": c.z})
			respond({"success": true, "action": "get_used", "cells": result, "total": cells.size()})
		_:
			respond({"error": "Unknown gridmap action: %s" % action})


func _cmd_3d_effects(params: Dictionary) -> void:
	var parent_path: String = params.get("parent_path", "/root")
	var parent: Node = get_tree().root.get_node_or_null(parent_path)
	if parent == null:
		respond({"error": "Parent not found: %s" % parent_path})
		return
	var effect_type: String = params.get("effect_type", "")
	var node: Node3D
	match effect_type:
		"reflection_probe": node = ReflectionProbe.new()
		"decal": node = Decal.new()
		"fog_volume": node = FogVolume.new()
		_:
			respond({"error": "Unknown effect type: %s" % effect_type})
			return
	if params.has("size"):
		var s: Dictionary = params["size"]
		var size_v: Vector3 = Vector3(CommandParams.json_float(s, "x", 1), CommandParams.json_float(s, "y", 1), CommandParams.json_float(s, "z", 1))
		if node is ReflectionProbe: (node as ReflectionProbe).size = size_v
		elif node is Decal: (node as Decal).size = size_v
		elif node is FogVolume: (node as FogVolume).size = size_v
	var custom_name: String = CommandParams.json_string(params, "name")
	if not custom_name.is_empty():
		node.name = custom_name
	parent.add_child(node)
	respond({"success": true, "path": str(node.get_path()), "effect_type": effect_type})


func _cmd_path_3d(params: Dictionary) -> void:
	var reader := CommandParams.new(params)
	var action: String = reader.optional_enum("action", "create", ["create", "add_point", "get_points", "set_points"])
	if params_invalid(reader):
		return
	match action:
		"create":
			var parent: Node = require_node(reader, "parent_path", "/root")
			if params_invalid(reader):
				return
			var path_node: Path3D = Path3D.new()
			path_node.curve = Curve3D.new()
			var custom_name: String = CommandParams.json_string(params, "name")
			if not custom_name.is_empty():
				path_node.name = custom_name
			if params.has("points"):
				for p: Variant in CommandParams.json_array(params, "points"):
					path_node.curve.add_point(_vec3_from_object(p))
			parent.add_child(path_node)
			respond({"success": true, "action": "create", "path": str(path_node.get_path()), "point_count": path_node.curve.point_count})
		"add_point":
			var node_path: String = reader.required_node_path()
			var point: Dictionary = reader.required_dictionary("point")
			var node: Node = get_tree().root.get_node_or_null(node_path) if not reader.failed() else null
			if params_invalid(reader):
				return
			if node == null or not node is Path3D:
				respond({"error": "Path3D not found: %s" % node_path})
				return
			(node as Path3D).curve.add_point(_vec3_from_object(point))
			respond({"success": true, "action": "add_point", "point_count": (node as Path3D).curve.point_count})
		"get_points":
			var node_path: String = params.get("node_path", "")
			var node: Node = get_tree().root.get_node_or_null(node_path)
			if node == null or not node is Path3D:
				respond({"error": "Path3D not found: %s" % node_path})
				return
			var pts: Array = []
			for i in (node as Path3D).curve.point_count:
				var pt: Vector3 = (node as Path3D).curve.get_point_position(i)
				pts.append({"x": pt.x, "y": pt.y, "z": pt.z})
			respond({"success": true, "action": "get_points", "points": pts})
		"set_points":
			var node_path: String = reader.required_node_path()
			var points: Array = reader.required_array("points")
			var node: Node = get_tree().root.get_node_or_null(node_path) if not reader.failed() else null
			if params_invalid(reader):
				return
			if node == null or not node is Path3D:
				respond({"error": "Path3D not found: %s" % node_path})
				return
			var curve: Curve3D = (node as Path3D).curve
			if curve == null:
				curve = Curve3D.new()
				(node as Path3D).curve = curve
			curve.clear_points()
			for p: Variant in points:
				curve.add_point(_vec3_from_object(p))
			respond({"success": true, "action": "set_points", "point_count": curve.point_count})
		_:
			respond({"error": "Unknown path_3d action: %s" % action})


func _cmd_terrain(params: Dictionary) -> void:
	var reader := CommandParams.new(params)
	var action: String = reader.optional_enum("action", "create", ["create", "get_height", "modify", "paint"])
	if params_invalid(reader):
		return
	if action == "create":
		var parent: Node = require_node(reader, "parent_path", "/root")
		var width: int = reader.optional_int("width", 16, 2)
		var depth: int = reader.optional_int("depth", 16, 2)
		var max_height: float = reader.optional_number("max_height", 1.0)
		var height_data: Array = reader.optional_array("height_data")
		if params_invalid(reader):
			return
		var heights: Array = []
		for i in range(width * depth):
			var h: float = CommandParams.to_float(height_data[i]) * max_height if i < height_data.size() else 0.0
			heights.append(h)
		var colors: Array = []
		for i in range(width * depth):
			colors.append(Color.WHITE)
		var mi: MeshInstance3D = MeshInstance3D.new()
		var custom_name: String = CommandParams.json_string(params, "name")
		if not custom_name.is_empty():
			mi.name = custom_name
		mi.set_meta("terrain_width", width)
		mi.set_meta("terrain_depth", depth)
		mi.set_meta("terrain_heights", heights)
		mi.set_meta("terrain_colors", colors)
		parent.add_child(mi)
		_terrain_rebuild(mi)
		respond({"success": true, "action": "create", "path": str(mi.get_path()), "width": width, "depth": depth})
		return
	var node_path: String = reader.required_node_path()
	var node: Node = get_tree().root.get_node_or_null(node_path) if not reader.failed() else null
	if params_invalid(reader):
		return
	if node == null or not node is MeshInstance3D or not node.has_meta("terrain_width"):
		respond({"error": "Terrain node not found: %s" % node_path})
		return
	var mesh_node: MeshInstance3D = node as MeshInstance3D
	var t_width: int = mesh_node.get_meta("terrain_width")
	var t_depth: int = mesh_node.get_meta("terrain_depth")
	var t_heights: Array = mesh_node.get_meta("terrain_heights")
	var t_colors: Array = mesh_node.get_meta("terrain_colors")
	match action:
		"get_height":
			var gx: int = reader.required_int("x")
			var gz: int = reader.required_int("z")
			if params_invalid(reader):
				return
			if gx < 0 or gx >= t_width or gz < 0 or gz >= t_depth:
				respond({"error": "Coordinate out of bounds"})
				return
			respond({"success": true, "action": "get_height", "x": gx, "z": gz, "height": t_heights[gz * t_width + gx]})
		"modify":
			var cx: float = reader.required_number("x")
			var cz: float = reader.required_number("z")
			var radius: float = reader.required_number("radius", 0.0)
			var delta: float = reader.required_number("height_delta")
			if params_invalid(reader):
				return
			for z in range(t_depth):
				for x in range(t_width):
					var d: float = Vector2(x - cx, z - cz).length()
					if d <= radius:
						var falloff: float = 1.0 - (d / radius) if radius > 0.0 else 1.0
						t_heights[z * t_width + x] += delta * falloff
			mesh_node.set_meta("terrain_heights", t_heights)
			_terrain_rebuild(mesh_node)
			respond({"success": true, "action": "modify"})
		"paint":
			var cx: float = reader.required_number("x")
			var cz: float = reader.required_number("z")
			var radius: float = reader.required_number("radius", 0.0)
			var col_d: Dictionary = reader.required_dictionary("color")
			if params_invalid(reader):
				return
			var col: Color = Color(CommandParams.json_float(col_d, "r", 1), CommandParams.json_float(col_d, "g", 1), CommandParams.json_float(col_d, "b", 1), CommandParams.json_float(col_d, "a", 1))
			for z in range(t_depth):
				for x in range(t_width):
					if Vector2(x - cx, z - cz).length() <= radius:
						t_colors[z * t_width + x] = col
			mesh_node.set_meta("terrain_colors", t_colors)
			_terrain_rebuild(mesh_node)
			respond({"success": true, "action": "paint"})
		_:
			respond({"error": "Unknown terrain action: %s" % action})


func _terrain_rebuild(mi: MeshInstance3D) -> void:
	var width: int = mi.get_meta("terrain_width")
	var depth: int = mi.get_meta("terrain_depth")
	var heights: Array = mi.get_meta("terrain_heights")
	var colors: Array = mi.get_meta("terrain_colors")
	var st: SurfaceTool = SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)
	for z in range(depth - 1):
		for x in range(width - 1):
			var i00: int = z * width + x
			var i10: int = z * width + (x + 1)
			var i01: int = (z + 1) * width + x
			var i11: int = (z + 1) * width + (x + 1)
			var v00: Vector3 = Vector3(x, CommandParams.to_float(heights[i00]), z)
			var v10: Vector3 = Vector3(x + 1, CommandParams.to_float(heights[i10]), z)
			var v01: Vector3 = Vector3(x, CommandParams.to_float(heights[i01]), z + 1)
			var v11: Vector3 = Vector3(x + 1, CommandParams.to_float(heights[i11]), z + 1)
			var triangles: Array[Array] = [[i00, v00], [i10, v10], [i01, v01], [i10, v10], [i11, v11], [i01, v01]]
			for tri: Array in triangles:
				var color_index: int = tri[0]
				var vertex: Vector3 = tri[1]
				var vertex_color: Color = colors[color_index]
				st.set_color(vertex_color)
				st.add_vertex(vertex)
	st.generate_normals()
	var mat: StandardMaterial3D = StandardMaterial3D.new()
	mat.vertex_color_use_as_albedo = true
	st.set_material(mat)
	mi.mesh = st.commit()
