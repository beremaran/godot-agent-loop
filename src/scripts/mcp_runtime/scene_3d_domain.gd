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
		if params.has("name") and not (params["name"] as String).is_empty():
			node.name = params["name"]
		if node is CSGBox3D and params.has("size"):
			var box_size: Variant = json_to_variant(params["size"], "Vector3")
			if box_size is Vector3:
				(node as CSGBox3D).size = box_size
		if node is CSGSphere3D and params.has("radius"):
			(node as CSGSphere3D).radius = float(params["radius"])
		if node is CSGCylinder3D:
			if params.has("radius"):
				(node as CSGCylinder3D).radius = float(params["radius"])
			if params.has("height"):
				(node as CSGCylinder3D).height = float(params["height"])
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
			mm.instance_count = int(params.get("count", 1))
			var mesh_type: String = params.get("mesh_type", "box")
			match mesh_type:
				"box": mm.mesh = BoxMesh.new()
				"sphere": mm.mesh = SphereMesh.new()
				"cylinder": mm.mesh = CylinderMesh.new()
				_: mm.mesh = BoxMesh.new()
			mmi.multimesh = mm
			if params.has("name") and not (params["name"] as String).is_empty():
				mmi.name = params["name"]
			parent.add_child(mmi)
			respond({"success": true, "action": "create", "path": str(mmi.get_path()), "count": mm.instance_count})
		"set_instance":
			var node_path: String = params.get("node_path", "")
			var node: Node = get_tree().root.get_node_or_null(node_path)
			if node == null or not node is MultiMeshInstance3D:
				respond({"error": "MultiMeshInstance3D not found: %s" % node_path})
				return
			var idx: int = int(params.get("index", 0))
			var tf: Dictionary = params.get("transform", {})
			var origin: Dictionary = tf.get("origin", {})
			var xform: Transform3D = Transform3D.IDENTITY
			xform.origin = Vector3(float(origin.get("x", 0)), float(origin.get("y", 0)), float(origin.get("z", 0)))
			(node as MultiMeshInstance3D).multimesh.set_instance_transform(idx, xform)
			respond({"success": true, "action": "set_instance", "index": idx})
		"get_info":
			var node_path: String = params.get("node_path", "")
			var node: Node = get_tree().root.get_node_or_null(node_path)
			if node == null or not node is MultiMeshInstance3D:
				respond({"error": "MultiMeshInstance3D not found: %s" % node_path})
				return
			var mm = (node as MultiMeshInstance3D).multimesh
			respond({"success": true, "count": mm.instance_count if mm else 0, "visible_count": mm.visible_instance_count if mm else 0})
		_:
			respond({"error": "Unknown multimesh action: %s" % action})


func _cmd_procedural_mesh(params: Dictionary) -> void:
	var parent_path: String = params.get("parent_path", "/root")
	var parent: Node = get_tree().root.get_node_or_null(parent_path)
	if parent == null:
		respond({"error": "Parent not found: %s" % parent_path})
		return
	var verts_arr: Array = params.get("vertices", [])
	var verts: PackedVector3Array = PackedVector3Array()
	for v in verts_arr:
		verts.append(Vector3(float(v[0]), float(v[1]), float(v[2])))
	var arrays: Array = []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = verts
	if params.has("normals"):
		var norms: PackedVector3Array = PackedVector3Array()
		for n in params["normals"]:
			norms.append(Vector3(float(n[0]), float(n[1]), float(n[2])))
		arrays[Mesh.ARRAY_NORMAL] = norms
	if params.has("uvs"):
		var uvs: PackedVector2Array = PackedVector2Array()
		for uv in params["uvs"]:
			uvs.append(Vector2(float(uv[0]), float(uv[1])))
		arrays[Mesh.ARRAY_TEX_UV] = uvs
	if params.has("indices"):
		var indices: PackedInt32Array = PackedInt32Array()
		for idx in params["indices"]:
			indices.append(int(idx))
		arrays[Mesh.ARRAY_INDEX] = indices
	var mesh: ArrayMesh = ArrayMesh.new()
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	var mi: MeshInstance3D = MeshInstance3D.new()
	mi.mesh = mesh
	if params.has("name") and not (params["name"] as String).is_empty():
		mi.name = params["name"]
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
			light.light_color = Color(float(c.get("r", 1)), float(c.get("g", 1)), float(c.get("b", 1)))
		if params.has("energy"):
			light.light_energy = float(params["energy"])
		if params.has("shadows"):
			light.shadow_enabled = bool(params["shadows"])
		if light is OmniLight3D and params.has("range"):
			(light as OmniLight3D).omni_range = float(params["range"])
		if light is SpotLight3D:
			if params.has("range"):
				(light as SpotLight3D).spot_range = float(params["range"])
			if params.has("spot_angle"):
				(light as SpotLight3D).spot_angle = float(params["spot_angle"])
		if params.has("name") and not (params["name"] as String).is_empty():
			light.name = params["name"]
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
			light.light_color = Color(float(c.get("r", 1)), float(c.get("g", 1)), float(c.get("b", 1)))
		if params.has("energy"):
			light.light_energy = float(params["energy"])
		if params.has("shadows"):
			light.shadow_enabled = bool(params["shadows"])
		respond({"success": true, "action": "configure", "path": str(node.get_path())})
	else:
		respond({"error": "Unknown light_3d action: %s" % action})


func _cmd_mesh_instance(params: Dictionary) -> void:
	var parent_path: String = params.get("parent_path", "/root")
	var parent: Node = get_tree().root.get_node_or_null(parent_path)
	if parent == null:
		respond({"error": "Parent not found: %s" % parent_path})
		return
	var mesh_type: String = params.get("mesh_type", "box")
	var mesh: Mesh
	match mesh_type:
		"box": mesh = BoxMesh.new()
		"sphere": mesh = SphereMesh.new()
		"cylinder": mesh = CylinderMesh.new()
		"capsule": mesh = CapsuleMesh.new()
		"plane": mesh = PlaneMesh.new()
		"quad": mesh = QuadMesh.new()
		_:
			respond({"error": "Unknown mesh type: %s" % mesh_type})
			return
	if params.has("size") and mesh is BoxMesh:
		var s: Dictionary = params["size"]
		(mesh as BoxMesh).size = Vector3(float(s.get("x", 1)), float(s.get("y", 1)), float(s.get("z", 1)))
	if params.has("radius"):
		if mesh is SphereMesh: (mesh as SphereMesh).radius = float(params["radius"])
		elif mesh is CylinderMesh: (mesh as CylinderMesh).top_radius = float(params["radius"])
		elif mesh is CapsuleMesh: (mesh as CapsuleMesh).radius = float(params["radius"])
	if params.has("height"):
		if mesh is CylinderMesh: (mesh as CylinderMesh).height = float(params["height"])
		elif mesh is CapsuleMesh: (mesh as CapsuleMesh).height = float(params["height"])
		elif mesh is SphereMesh: (mesh as SphereMesh).height = float(params["height"])
	var mi: MeshInstance3D = MeshInstance3D.new()
	mi.mesh = mesh
	if params.has("material") and params["material"] is String:
		var mat: StandardMaterial3D = StandardMaterial3D.new()
		var hex: String = params["material"]
		if hex.begins_with("#") or hex.length() == 6 or hex.length() == 8:
			mat.albedo_color = Color.from_string(hex, Color.WHITE)
		mi.material_override = mat
	if params.has("name") and not (params["name"] as String).is_empty():
		mi.name = params["name"]
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
			gm.set_cell_item(Vector3i(int(params.get("x", 0)), int(params.get("y", 0)), int(params.get("z", 0))), int(params.get("item", 0)), int(params.get("orientation", 0)))
			respond({"success": true, "action": "set_cell"})
		"get_cell":
			var item: int = gm.get_cell_item(Vector3i(int(params.get("x", 0)), int(params.get("y", 0)), int(params.get("z", 0))))
			respond({"success": true, "action": "get_cell", "item": item})
		"clear":
			gm.clear()
			respond({"success": true, "action": "clear"})
		"get_used":
			var cells: Array = gm.get_used_cells()
			var result: Array = []
			for c in cells.slice(0, 100):
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
		var size_v: Vector3 = Vector3(float(s.get("x", 1)), float(s.get("y", 1)), float(s.get("z", 1)))
		if node is ReflectionProbe: (node as ReflectionProbe).size = size_v
		elif node is Decal: (node as Decal).size = size_v
		elif node is FogVolume: (node as FogVolume).size = size_v
	if params.has("name") and not (params["name"] as String).is_empty():
		node.name = params["name"]
	parent.add_child(node)
	respond({"success": true, "path": str(node.get_path()), "effect_type": effect_type})


func _cmd_path_3d(params: Dictionary) -> void:
	var action: String = params.get("action", "create")
	match action:
		"create":
			var parent_path: String = params.get("parent_path", "/root")
			var parent: Node = get_tree().root.get_node_or_null(parent_path)
			if parent == null:
				respond({"error": "Parent not found: %s" % parent_path})
				return
			var path_node: Path3D = Path3D.new()
			path_node.curve = Curve3D.new()
			if params.has("name") and not (params["name"] as String).is_empty():
				path_node.name = params["name"]
			if params.has("points"):
				for p in params["points"]:
					path_node.curve.add_point(Vector3(float(p.get("x", 0)), float(p.get("y", 0)), float(p.get("z", 0))))
			parent.add_child(path_node)
			respond({"success": true, "action": "create", "path": str(path_node.get_path()), "point_count": path_node.curve.point_count})
		"add_point":
			var node_path: String = params.get("node_path", "")
			var node: Node = get_tree().root.get_node_or_null(node_path)
			if node == null or not node is Path3D:
				respond({"error": "Path3D not found: %s" % node_path})
				return
			var p: Dictionary = params.get("point", {})
			(node as Path3D).curve.add_point(Vector3(float(p.get("x", 0)), float(p.get("y", 0)), float(p.get("z", 0))))
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
			var node_path: String = params.get("node_path", "")
			var node: Node = get_tree().root.get_node_or_null(node_path)
			if node == null or not node is Path3D:
				respond({"error": "Path3D not found: %s" % node_path})
				return
			var curve: Curve3D = (node as Path3D).curve
			if curve == null:
				curve = Curve3D.new()
				(node as Path3D).curve = curve
			curve.clear_points()
			for p in params.get("points", []):
				curve.add_point(Vector3(float(p.get("x", 0)), float(p.get("y", 0)), float(p.get("z", 0))))
			respond({"success": true, "action": "set_points", "point_count": curve.point_count})
		_:
			respond({"error": "Unknown path_3d action: %s" % action})


func _cmd_terrain(params: Dictionary) -> void:
	var action: String = params.get("action", "create")
	if action == "create":
		var parent_path: String = params.get("parent_path", "/root")
		var parent: Node = get_tree().root.get_node_or_null(parent_path)
		if parent == null:
			respond({"error": "Parent not found: %s" % parent_path})
			return
		var width: int = max(2, int(params.get("width", 16)))
		var depth: int = max(2, int(params.get("depth", 16)))
		var max_height: float = float(params.get("max_height", 1.0))
		var height_data: Array = params.get("height_data", [])
		var heights: Array = []
		for i in range(width * depth):
			var h: float = float(height_data[i]) * max_height if i < height_data.size() else 0.0
			heights.append(h)
		var colors: Array = []
		for i in range(width * depth):
			colors.append(Color.WHITE)
		var mi: MeshInstance3D = MeshInstance3D.new()
		if params.has("name") and not (params["name"] as String).is_empty():
			mi.name = params["name"]
		mi.set_meta("terrain_width", width)
		mi.set_meta("terrain_depth", depth)
		mi.set_meta("terrain_heights", heights)
		mi.set_meta("terrain_colors", colors)
		parent.add_child(mi)
		_terrain_rebuild(mi)
		respond({"success": true, "action": "create", "path": str(mi.get_path()), "width": width, "depth": depth})
		return
	var node_path: String = params.get("node_path", "")
	var node: Node = get_tree().root.get_node_or_null(node_path)
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
			var gx: int = int(params.get("x", 0))
			var gz: int = int(params.get("z", 0))
			if gx < 0 or gx >= t_width or gz < 0 or gz >= t_depth:
				respond({"error": "Coordinate out of bounds"})
				return
			respond({"success": true, "action": "get_height", "x": gx, "z": gz, "height": t_heights[gz * t_width + gx]})
		"modify":
			var cx: float = float(params.get("x", 0))
			var cz: float = float(params.get("z", 0))
			var radius: float = float(params.get("radius", 1.0))
			var delta: float = float(params.get("height_delta", 0.0))
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
			var cx: float = float(params.get("x", 0))
			var cz: float = float(params.get("z", 0))
			var radius: float = float(params.get("radius", 1.0))
			var col_d: Dictionary = params.get("color", {"r": 1, "g": 1, "b": 1, "a": 1})
			var col: Color = Color(float(col_d.get("r", 1)), float(col_d.get("g", 1)), float(col_d.get("b", 1)), float(col_d.get("a", 1)))
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
			var v00: Vector3 = Vector3(x, heights[i00], z)
			var v10: Vector3 = Vector3(x + 1, heights[i10], z)
			var v01: Vector3 = Vector3(x, heights[i01], z + 1)
			var v11: Vector3 = Vector3(x + 1, heights[i11], z + 1)
			for tri in [[i00, v00], [i10, v10], [i01, v01], [i10, v10], [i11, v11], [i01, v01]]:
				st.set_color(colors[tri[0]])
				st.add_vertex(tri[1])
	st.generate_normals()
	var mat: StandardMaterial3D = StandardMaterial3D.new()
	mat.vertex_color_use_as_albedo = true
	st.set_material(mat)
	mi.mesh = st.commit()
