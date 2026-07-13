extends "res://mcp_runtime/runtime_domain.gd"

# 2D domain: TileMapLayer cells, canvas layers/modulate, immediate-mode canvas
# drawing, 2D lights and occluders, parallax backgrounds, Line2D/Polygon2D
# points, and Path2D curves. Owns the canvas-draw node and its command list.

# The draw node is created lazily on first draw and re-created if it was freed
# with the scene; the accumulated draw commands survive scene changes.
var _canvas_draw_node: Node2D = null
var _draw_commands: Array = []


# The draw node is parented into the scene, not under this domain, so it would
# outlive the server. Free it with the domain that owns it.
func _exit_tree() -> void:
	_draw_commands.clear()
	if _canvas_draw_node != null and is_instance_valid(_canvas_draw_node):
		_canvas_draw_node.queue_free()
	_canvas_draw_node = null


func register_commands() -> void:
	register_command("tilemap", _cmd_tilemap)
	register_command("canvas", _cmd_canvas)
	register_command("canvas_draw", _cmd_canvas_draw)
	register_command("light_2d", _cmd_light_2d)
	register_command("parallax", _cmd_parallax)
	register_command("shape_2d", _cmd_shape_2d)
	register_command("path_2d", _cmd_path_2d)


# Records a structured failure when the resolved node is not the class the
# command drives; the caller still routes through params_invalid().
func _require_class(reader: CommandParams, node: Node, type_name: String) -> void:
	if reader.failed() or node == null:
		return
	reader.fail("Node is not a %s: %s" % [type_name, node.get_class()],
		{"param": "node_path", "reason": "invalid_value", "expected": type_name, "value": node.get_class()})


func _color_from(value: Dictionary) -> Color:
	return Color(
		CommandParams.json_float(value, "r", 1.0),
		CommandParams.json_float(value, "g", 1.0),
		CommandParams.json_float(value, "b", 1.0),
		CommandParams.json_float(value, "a", 1.0),
	)


func _vector2_from(value: Dictionary, default_x: float = 0.0, default_y: float = 0.0) -> Vector2:
	return Vector2(CommandParams.json_float(value, "x", default_x), CommandParams.json_float(value, "y", default_y))


func _apply_optional_name(reader: CommandParams, node: Node) -> void:
	var node_name: String = reader.optional_string("name")
	if not node_name.is_empty():
		node.name = node_name


# Validates that every element of an array parameter is an object; the caller
# still routes through params_invalid().
func _require_dictionary_items(reader: CommandParams, param_name: String, items: Array) -> void:
	if reader.failed():
		return
	for item: Variant in items:
		if not item is Dictionary:
			reader.fail("%s must contain objects" % param_name, {"param": param_name, "reason": "invalid_type"})
			return


func _points_from(reader: CommandParams, param_name: String) -> PackedVector2Array:
	var points: Array = reader.optional_array(param_name)
	_require_dictionary_items(reader, param_name, points)
	var packed: PackedVector2Array = PackedVector2Array()
	if reader.failed():
		return packed
	for point: Dictionary in points:
		@warning_ignore("return_value_discarded")
		packed.append(_vector2_from(point))
	return packed


# --- TileMapLayer cells ---
func _cmd_tilemap(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var node: Node = require_node(reader)
	var action: String = reader.optional_enum("action", "get_cell", ["set_cells", "get_cell", "erase_cells", "get_used_cells"])
	if node != null and not node is TileMapLayer:
		_require_class(reader, node, "TileMapLayer")
	if params_invalid(reader):
		return

	var tilemap: TileMapLayer = node as TileMapLayer
	match action:
		"set_cells":
			var cells: Array = reader.required_array("cells")
			_require_dictionary_items(reader, "cells", cells)
			if params_invalid(reader):
				return
			for cell: Dictionary in cells:
				var pos: Vector2i = Vector2i(CommandParams.json_int(cell, "x"), CommandParams.json_int(cell, "y"))
				var source_id: int = CommandParams.json_int(cell, "source_id")
				var atlas_coords: Vector2i = Vector2i(CommandParams.json_int(cell, "atlas_x"), CommandParams.json_int(cell, "atlas_y"))
				var alt_tile: int = CommandParams.json_int(cell, "alt_tile")
				tilemap.set_cell(pos, source_id, atlas_coords, alt_tile)
			respond({"success": true, "action": "set_cells", "count": cells.size()})
		"get_cell":
			var x: int = reader.optional_int("x", 0)
			var y: int = reader.optional_int("y", 0)
			if params_invalid(reader):
				return
			var pos: Vector2i = Vector2i(x, y)
			respond({
				"success": true, "action": "get_cell",
				"x": x, "y": y,
				"source_id": tilemap.get_cell_source_id(pos),
				"atlas_coords": variant_to_json(tilemap.get_cell_atlas_coords(pos)),
				"alt_tile": tilemap.get_cell_alternative_tile(pos)
			})
		"erase_cells":
			var cells: Array = reader.required_array("cells")
			_require_dictionary_items(reader, "cells", cells)
			if params_invalid(reader):
				return
			for cell: Dictionary in cells:
				tilemap.erase_cell(Vector2i(CommandParams.json_int(cell, "x"), CommandParams.json_int(cell, "y")))
			respond({"success": true, "action": "erase_cells", "count": cells.size()})
		"get_used_cells":
			var source_filter: int = reader.optional_int("source_id", -1)
			if params_invalid(reader):
				return
			var used: Array
			if source_filter >= 0:
				used = tilemap.get_used_cells_by_id(source_filter)
			else:
				used = tilemap.get_used_cells()
			respond({"success": true, "action": "get_used_cells", "cells": variant_to_json(used), "count": used.size()})


# --- CanvasLayer / CanvasModulate ---
func _cmd_canvas(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var action: String = reader.optional_enum("action", "create_layer", ["create_layer", "create_modulate", "configure"])
	if params_invalid(reader):
		return

	match action:
		"create_layer":
			var parent: Node = require_node(reader, "parent_path", "/root")
			var layer: int = reader.optional_int("layer", 1)
			if params_invalid(reader):
				return
			var cl: CanvasLayer = CanvasLayer.new()
			if reader.has_param("layer"):
				cl.layer = layer
			_apply_optional_name(reader, cl)
			parent.add_child(cl)
			respond({"success": true, "action": "create_layer", "path": str(cl.get_path())})
		"create_modulate":
			var parent: Node = require_node(reader, "parent_path", "/root")
			var color: Dictionary = reader.optional_dictionary("color")
			if params_invalid(reader):
				return
			var cm: CanvasModulate = CanvasModulate.new()
			if reader.has_param("color"):
				cm.color = _color_from(color)
			_apply_optional_name(reader, cm)
			parent.add_child(cm)
			respond({"success": true, "action": "create_modulate", "path": str(cm.get_path())})
		"configure":
			var node: Node = require_node(reader)
			if node != null and not (node is CanvasLayer or node is CanvasModulate):
				_require_class(reader, node, "CanvasLayer or CanvasModulate")
			if params_invalid(reader):
				return
			var applied: Array = []
			if node is CanvasLayer:
				var cl2: CanvasLayer = node as CanvasLayer
				var layer: int = reader.optional_int("layer", cl2.layer)
				var offset: Dictionary = reader.optional_dictionary("offset")
				var layer_visible: bool = reader.optional_bool("visible", cl2.visible)
				if params_invalid(reader):
					return
				if reader.has_param("layer"):
					cl2.layer = layer
					applied.append("layer")
				if reader.has_param("offset"):
					cl2.offset = _vector2_from(offset)
					applied.append("offset")
				if reader.has_param("visible"):
					cl2.visible = layer_visible
					applied.append("visible")
			elif node is CanvasModulate:
				var color: Dictionary = reader.optional_dictionary("color")
				if params_invalid(reader):
					return
				if reader.has_param("color"):
					(node as CanvasModulate).color = _color_from(color)
					applied.append("color")
			respond({"success": true, "action": "configure", "applied": applied})


# --- Immediate-mode canvas drawing ---
func _cmd_canvas_draw(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var action: String = reader.optional_enum("action", "line", ["line", "rect", "circle", "polygon", "text", "clear"])
	if params_invalid(reader):
		return

	if action == "clear":
		_draw_commands.clear()
		if _canvas_draw_node != null and is_instance_valid(_canvas_draw_node):
			_canvas_draw_node.queue_redraw()
		respond({"success": true, "action": "clear"})
		return

	var color: Dictionary = reader.optional_dictionary("color", {"r": 1.0, "g": 1.0, "b": 1.0, "a": 1.0})
	match action:
		"line":
			var _from: Dictionary = reader.required_dictionary("from")
			var _to: Dictionary = reader.required_dictionary("to")
		"rect":
			var _rect: Dictionary = reader.required_dictionary("rect")
		"circle":
			var _center: Dictionary = reader.required_dictionary("center")
			var radius: float = reader.required_number("radius", 0.0)
			if not reader.failed() and radius <= 0.0:
				reader.fail("radius must be greater than zero", {"param": "radius", "reason": "out_of_range", "min_exclusive": 0})
		"polygon":
			var points: Array = reader.required_array("points")
			_require_dictionary_items(reader, "points", points)
			if not reader.failed() and points.size() < 3:
				reader.fail("points must contain at least 3 points", {"param": "points", "reason": "out_of_range", "min_items": 3})
		"text":
			var _position: Dictionary = reader.required_dictionary("position")
			var _text: String = reader.required_string("text")
	if params_invalid(reader):
		return
	if _canvas_draw_node == null or not is_instance_valid(_canvas_draw_node):
		var parent: Node = require_node(reader, "parent_path", "/root")
		if params_invalid(reader):
			return
		_canvas_draw_node = Node2D.new()
		_canvas_draw_node.name = "_McpCanvasDraw"
		_canvas_draw_node.set_script(_create_draw_script())
		parent.add_child(_canvas_draw_node)
		_canvas_draw_node.set("draw_commands", _draw_commands)
	_draw_commands.append({"action": action, "params": params, "color": _color_from(color)})
	_canvas_draw_node.set("draw_commands", _draw_commands)
	_canvas_draw_node.queue_redraw()
	respond({"success": true, "action": action})


func _create_draw_script() -> GDScript:
	var s: GDScript = GDScript.new()
	s.source_code = """extends Node2D
var draw_commands: Array = []
func _draw():
	for cmd in draw_commands:
		var p = cmd.params
		var c = cmd.color
		match cmd.action:
			"line":
				var f = p.get("from", {})
				var t = p.get("to", {})
				draw_line(Vector2(float(f.get("x",0)),float(f.get("y",0))),Vector2(float(t.get("x",0)),float(t.get("y",0))),c,float(p.get("width",2)))
			"rect":
				var r = p.get("rect", {})
				draw_rect(Rect2(float(r.get("x",0)),float(r.get("y",0)),float(r.get("w",10)),float(r.get("h",10))),c,bool(p.get("filled",true)))
			"circle":
				var ct = p.get("center", {})
				draw_circle(Vector2(float(ct.get("x",0)),float(ct.get("y",0))),float(p.get("radius",10)),c)
			"polygon":
				var pts = p.get("points", [])
				var pv = PackedVector2Array()
				for pt in pts:
					pv.append(Vector2(float(pt.get("x",0)),float(pt.get("y",0))))
				if pv.size() >= 3:
					draw_colored_polygon(pv, c)
			"text":
				var pos = p.get("position", p.get("pos", {}))
				draw_string(ThemeDB.fallback_font, Vector2(float(pos.get("x",0)),float(pos.get("y",0))), str(p.get("text","")), HORIZONTAL_ALIGNMENT_LEFT, -1, int(p.get("font_size",16)), c)
"""
	@warning_ignore("return_value_discarded")
	s.reload()
	return s


# --- 2D lights and occluders ---
func _cmd_light_2d(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var action: String = reader.optional_enum("action", "create_point", ["create_point", "create_directional", "create_occluder"])
	var parent: Node = require_node(reader, "parent_path", "/root")
	if params_invalid(reader):
		return

	match action:
		"create_point":
			var color: Dictionary = reader.optional_dictionary("color")
			var energy: float = reader.optional_number("energy", 1.0)
			var light_range: float = reader.optional_number("range", 1.0)
			if params_invalid(reader):
				return
			var light: PointLight2D = PointLight2D.new()
			if reader.has_param("color"):
				light.color = _color_from(color)
			if reader.has_param("energy"):
				light.energy = energy
			# Create a simple gradient texture for the light
			var tex: GradientTexture2D = GradientTexture2D.new()
			tex.width = 128
			tex.height = 128
			tex.fill = GradientTexture2D.FILL_RADIAL
			tex.gradient = Gradient.new()
			light.texture = tex
			if reader.has_param("range"):
				light.texture_scale = light_range
			_apply_optional_name(reader, light)
			parent.add_child(light)
			respond({"success": true, "action": "create_point", "path": str(light.get_path())})
		"create_directional":
			var color: Dictionary = reader.optional_dictionary("color")
			var energy: float = reader.optional_number("energy", 1.0)
			if params_invalid(reader):
				return
			var light: DirectionalLight2D = DirectionalLight2D.new()
			if reader.has_param("color"):
				light.color = _color_from(color)
			if reader.has_param("energy"):
				light.energy = energy
			_apply_optional_name(reader, light)
			parent.add_child(light)
			respond({"success": true, "action": "create_directional", "path": str(light.get_path())})
		"create_occluder":
			var points: Array = reader.required_array("points")
			_require_dictionary_items(reader, "points", points)
			if not reader.failed() and points.size() < 3:
				reader.fail("points must contain at least 3 points", {"param": "points", "reason": "out_of_range", "min_items": 3})
			var packed: PackedVector2Array = PackedVector2Array()
			if not reader.failed():
				for point: Dictionary in points:
					@warning_ignore("return_value_discarded")
					packed.append(_vector2_from(point))
			if params_invalid(reader):
				return
			var occ: LightOccluder2D = LightOccluder2D.new()
			var poly: OccluderPolygon2D = OccluderPolygon2D.new()
			poly.polygon = packed
			occ.occluder = poly
			_apply_optional_name(reader, occ)
			parent.add_child(occ)
			respond({"success": true, "action": "create_occluder", "path": str(occ.get_path()), "point_count": packed.size()})


# --- Parallax backgrounds and layers ---
func _cmd_parallax(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var action: String = reader.optional_enum("action", "create_background", ["create_background", "add_layer", "configure"])
	if params_invalid(reader):
		return

	match action:
		"create_background":
			var parent: Node = require_node(reader, "parent_path", "/root")
			if params_invalid(reader):
				return
			var bg: ParallaxBackground = ParallaxBackground.new()
			_apply_optional_name(reader, bg)
			parent.add_child(bg)
			respond({"success": true, "action": "create_background", "path": str(bg.get_path())})
		"add_layer":
			var parent: Node = require_node(reader, "parent_path")
			if parent != null and not parent is ParallaxBackground:
				reader.fail("Node is not a ParallaxBackground: %s" % parent.get_class(),
					{"param": "parent_path", "reason": "invalid_value", "expected": "ParallaxBackground", "value": parent.get_class()})
			var motion_scale: Dictionary = reader.optional_dictionary("motion_scale")
			var motion_offset: Dictionary = reader.optional_dictionary("motion_offset")
			var mirroring: Dictionary = reader.optional_dictionary("mirroring")
			if params_invalid(reader):
				return
			var layer: ParallaxLayer = ParallaxLayer.new()
			if reader.has_param("motion_scale"):
				layer.motion_scale = _vector2_from(motion_scale, 1, 1)
			if reader.has_param("motion_offset"):
				layer.motion_offset = _vector2_from(motion_offset)
			if reader.has_param("mirroring"):
				layer.motion_mirroring = _vector2_from(mirroring)
			_apply_optional_name(reader, layer)
			parent.add_child(layer)
			respond({"success": true, "action": "add_layer", "path": str(layer.get_path())})
		"configure":
			var node: Node = require_node(reader)
			if node != null and not (node is ParallaxBackground or node is ParallaxLayer):
				_require_class(reader, node, "ParallaxBackground or ParallaxLayer")
			if params_invalid(reader):
				return
			var applied: Array = []
			if node is ParallaxBackground:
				var pbg: ParallaxBackground = node as ParallaxBackground
				var scroll_offset: Dictionary = reader.optional_dictionary("scroll_offset")
				var scroll_base_offset: Dictionary = reader.optional_dictionary("scroll_base_offset")
				if params_invalid(reader):
					return
				if reader.has_param("scroll_offset"):
					pbg.scroll_offset = _vector2_from(scroll_offset)
					applied.append("scroll_offset")
				if reader.has_param("scroll_base_offset"):
					pbg.scroll_base_offset = _vector2_from(scroll_base_offset)
					applied.append("scroll_base_offset")
			elif node is ParallaxLayer:
				var pl: ParallaxLayer = node as ParallaxLayer
				var motion_scale: Dictionary = reader.optional_dictionary("motion_scale")
				var motion_offset: Dictionary = reader.optional_dictionary("motion_offset")
				var mirroring: Dictionary = reader.optional_dictionary("mirroring")
				if params_invalid(reader):
					return
				if reader.has_param("motion_scale"):
					pl.motion_scale = _vector2_from(motion_scale, 1, 1)
					applied.append("motion_scale")
				if reader.has_param("motion_offset"):
					pl.motion_offset = _vector2_from(motion_offset)
					applied.append("motion_offset")
				if reader.has_param("mirroring"):
					pl.motion_mirroring = _vector2_from(mirroring)
					applied.append("mirroring")
			respond({"success": true, "action": "configure", "applied": applied})


# --- Line2D / Polygon2D points ---
func _cmd_shape_2d(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var node: Node = require_node(reader)
	var action: String = reader.optional_enum("action", "get_points", ["add_point", "set_points", "clear", "get_points"])
	if node != null and not (node is Line2D or node is Polygon2D):
		_require_class(reader, node, "Line2D or Polygon2D")
	if params_invalid(reader):
		return

	match action:
		"add_point":
			var point: Dictionary = reader.required_dictionary("point")
			if params_invalid(reader):
				return
			var pt: Vector2 = _vector2_from(point)
			if node is Line2D:
				(node as Line2D).add_point(pt)
			else:
				var polygon: PackedVector2Array = (node as Polygon2D).polygon
				@warning_ignore("return_value_discarded")
				polygon.append(pt)
				(node as Polygon2D).polygon = polygon
			respond({"success": true, "action": "add_point"})
		"set_points":
			var points: Array = reader.required_array("points")
			_require_dictionary_items(reader, "points", points)
			var packed: PackedVector2Array = PackedVector2Array()
			if not reader.failed():
				for point: Dictionary in points:
					@warning_ignore("return_value_discarded")
					packed.append(_vector2_from(point))
			if params_invalid(reader):
				return
			if node is Line2D:
				(node as Line2D).points = packed
			else:
				(node as Polygon2D).polygon = packed
			respond({"success": true, "action": "set_points", "count": packed.size()})
		"clear":
			if node is Line2D:
				(node as Line2D).clear_points()
			else:
				(node as Polygon2D).polygon = PackedVector2Array()
			respond({"success": true, "action": "clear"})
		"get_points":
			var pts: PackedVector2Array
			if node is Line2D:
				pts = (node as Line2D).points
			else:
				pts = (node as Polygon2D).polygon
			var result: Array = []
			for p: Vector2 in pts:
				result.append({"x": p.x, "y": p.y})
			respond({"success": true, "action": "get_points", "points": result})


# --- Path2D curves ---
func _cmd_path_2d(params: Dictionary) -> void:
	var reader: CommandParams = CommandParams.new(params)
	var action: String = reader.optional_enum("action", "create", ["create", "add_point", "get_points"])
	if params_invalid(reader):
		return

	match action:
		"create":
			var parent: Node = require_node(reader, "parent_path", "/root")
			var packed: PackedVector2Array = _points_from(reader, "points")
			if params_invalid(reader):
				return
			var path_node: Path2D = Path2D.new()
			path_node.curve = Curve2D.new()
			_apply_optional_name(reader, path_node)
			for pt: Vector2 in packed:
				path_node.curve.add_point(pt)
			parent.add_child(path_node)
			respond({"success": true, "action": "create", "path": str(path_node.get_path()), "point_count": path_node.curve.point_count})
		"add_point":
			var node: Node = require_node(reader)
			if node != null and not node is Path2D:
				_require_class(reader, node, "Path2D")
			var point: Dictionary = reader.required_dictionary("point")
			if params_invalid(reader):
				return
			var path_node: Path2D = node as Path2D
			path_node.curve.add_point(_vector2_from(point))
			respond({"success": true, "action": "add_point", "point_count": path_node.curve.point_count})
		"get_points":
			var node: Node = require_node(reader)
			if node != null and not node is Path2D:
				_require_class(reader, node, "Path2D")
			if params_invalid(reader):
				return
			var path_node: Path2D = node as Path2D
			var pts: Array = []
			for i: int in path_node.curve.point_count:
				var pt: Vector2 = path_node.curve.get_point_position(i)
				pts.append({"x": pt.x, "y": pt.y})
			respond({"success": true, "action": "get_points", "points": pts})
