extends RefCounted

# Typed boundary between Godot Variants and values accepted by JSON.stringify().
# A codec instance is shared by the server and its domains. Runtime commands are
# serialized, so the small last-error slot is never observed concurrently.

const SUPPORTED_TYPE_HINTS: Array[String] = [
	"", "String", "Vector2", "Vector2i", "Vector3", "Vector3i", "Color",
	"Quaternion", "Rect2", "AABB", "Basis", "Transform3D", "Transform2D",
]

var max_depth: int
var max_collection_items: int
var _last_error: Dictionary = {}


func _init(depth_limit: int = 32, collection_limit: int = 1024) -> void:
	max_depth = depth_limit
	max_collection_items = collection_limit


func configure(depth_limit: int, collection_limit: int) -> void:
	max_depth = depth_limit
	max_collection_items = collection_limit


func take_error() -> Dictionary:
	var error: Dictionary = _last_error
	_last_error = {}
	return error


func encode(value: Variant) -> Variant:
	_last_error = {}
	return _encode(value, 0, [])


func _fail(reason: String, message: String, details: Dictionary = {}) -> Variant:
	if _last_error.is_empty():
		_last_error = {"reason": reason, "message": message}
		_last_error.merge(details)
	return null


func _encode(value: Variant, depth: int, ancestors: Array) -> Variant:
	if depth > max_depth:
		return _fail("codec_depth_exceeded", "Variant nesting exceeds the configured limit", {"max_depth": max_depth})
	if value == null or value is bool or value is int or value is float or value is String:
		return value
	if value is Vector2 or value is Vector2i:
		return {"x": value.x, "y": value.y}
	if value is Vector3 or value is Vector3i:
		return {"x": value.x, "y": value.y, "z": value.z}
	if value is Color:
		return {"r": value.r, "g": value.g, "b": value.b, "a": value.a}
	if value is Quaternion:
		return {"x": value.x, "y": value.y, "z": value.z, "w": value.w}
	if value is Basis:
		var basis_x: Variant = _encode_child(value.x, depth + 1, ancestors)
		if not _last_error.is_empty(): return null
		var basis_y: Variant = _encode_child(value.y, depth + 1, ancestors)
		if not _last_error.is_empty(): return null
		var basis_z: Variant = _encode_child(value.z, depth + 1, ancestors)
		if not _last_error.is_empty(): return null
		return {"x": basis_x, "y": basis_y, "z": basis_z}
	if value is Transform3D:
		var basis: Variant = _encode_child(value.basis, depth + 1, ancestors)
		if not _last_error.is_empty(): return null
		var origin: Variant = _encode_child(value.origin, depth + 1, ancestors)
		if not _last_error.is_empty(): return null
		return {"basis": basis, "origin": origin}
	if value is Transform2D:
		var x_axis: Variant = _encode_child(value.x, depth + 1, ancestors)
		if not _last_error.is_empty(): return null
		var y_axis: Variant = _encode_child(value.y, depth + 1, ancestors)
		if not _last_error.is_empty(): return null
		var transform_origin: Variant = _encode_child(value.origin, depth + 1, ancestors)
		if not _last_error.is_empty(): return null
		return {"x": x_axis, "y": y_axis, "origin": transform_origin}
	if value is Rect2 or value is AABB:
		var position: Variant = _encode_child(value.position, depth + 1, ancestors)
		if not _last_error.is_empty(): return null
		var size: Variant = _encode_child(value.size, depth + 1, ancestors)
		if not _last_error.is_empty(): return null
		return {"position": position, "size": size}
	if value is NodePath or value is StringName:
		return str(value)
	if value is PackedByteArray or value is PackedInt32Array or value is PackedInt64Array or value is PackedFloat32Array or value is PackedFloat64Array or value is PackedStringArray:
		if value.size() > max_collection_items:
			return _fail("codec_collection_exceeded", "Packed array exceeds the configured limit", {"max_collection_items": max_collection_items})
		return Array(value)
	if value is PackedVector2Array or value is PackedVector3Array or value is PackedColorArray:
		if value.size() > max_collection_items:
			return _fail("codec_collection_exceeded", "Packed array exceeds the configured limit", {"max_collection_items": max_collection_items})
		var packed_result: Array = []
		for item: Variant in value:
			packed_result.append(_encode_child(item, depth + 1, ancestors))
			if not _last_error.is_empty(): return null
		return packed_result
	if value is Array or value is Dictionary:
		for ancestor: Variant in ancestors:
			if is_same(ancestor, value):
				return _fail("codec_cycle", "Cyclic arrays and dictionaries cannot be encoded")
		if value.size() > max_collection_items:
			return _fail("codec_collection_exceeded", "Variant collection exceeds the configured limit", {"max_collection_items": max_collection_items})
		var next_ancestors: Array = ancestors.duplicate()
		next_ancestors.append(value)
		if value is Array:
			var array_result: Array = []
			for item: Variant in value:
				array_result.append(_encode_child(item, depth + 1, next_ancestors))
				if not _last_error.is_empty(): return null
			return array_result
		var dictionary_result: Dictionary = {}
		for key: Variant in value:
			dictionary_result[str(key)] = _encode_child(value[key], depth + 1, next_ancestors)
			if not _last_error.is_empty(): return null
		return dictionary_result
	if value is Node:
		return {"_type": "Node", "class": value.get_class(), "name": value.name, "path": str(value.get_path())}
	if value is Resource:
		return {"_type": "Resource", "class": value.get_class(), "path": value.resource_path}
	if value is Object:
		return {"_type": "Object", "class": value.get_class(), "id": value.get_instance_id()}
	return _fail("unsupported_variant", "Variant type is not supported by the runtime codec", {"variant_type": type_string(typeof(value))})


func _encode_child(value: Variant, depth: int, ancestors: Array) -> Variant:
	var encoded: Variant = _encode(value, depth, ancestors)
	return null if not _last_error.is_empty() else encoded


func decode(value: Variant, type_hint: String = "") -> Variant:
	_last_error = {}
	if not type_hint in SUPPORTED_TYPE_HINTS:
		return _fail("invalid_type_hint", "Unknown Variant type hint", {"type_hint": type_hint, "allowed": SUPPORTED_TYPE_HINTS})
	return _decode(value, type_hint, 0)


func _decode(value: Variant, type_hint: String, depth: int) -> Variant:
	if depth > max_depth:
		return _fail("codec_depth_exceeded", "Variant nesting exceeds the configured limit", {"max_depth": max_depth})
	if value is String and type_hint != "" and type_hint != "String":
		var trimmed: String = value.strip_edges()
		if trimmed.begins_with("{") or trimmed.begins_with("["):
			var parsed: Variant = JSON.parse_string(trimmed)
			if parsed != null:
				value = parsed
	if not value is Dictionary:
		return value
	var dict: Dictionary = value
	match type_hint:
		"Vector2": return Vector2(float(dict.get("x", 0)), float(dict.get("y", 0)))
		"Vector2i": return Vector2i(int(dict.get("x", 0)), int(dict.get("y", 0)))
		"Vector3": return Vector3(float(dict.get("x", 0)), float(dict.get("y", 0)), float(dict.get("z", 0)))
		"Vector3i": return Vector3i(int(dict.get("x", 0)), int(dict.get("y", 0)), int(dict.get("z", 0)))
		"Color": return Color(float(dict.get("r", 0)), float(dict.get("g", 0)), float(dict.get("b", 0)), float(dict.get("a", 1)))
		"Quaternion": return Quaternion(float(dict.get("x", 0)), float(dict.get("y", 0)), float(dict.get("z", 0)), float(dict.get("w", 1)))
		"Rect2":
			var p: Dictionary = dict.get("position", {})
			var s: Dictionary = dict.get("size", {})
			return Rect2(float(p.get("x", 0)), float(p.get("y", 0)), float(s.get("x", 0)), float(s.get("y", 0)))
		"AABB":
			var p: Dictionary = dict.get("position", {})
			var s: Dictionary = dict.get("size", {})
			return AABB(Vector3(float(p.get("x", 0)), float(p.get("y", 0)), float(p.get("z", 0))), Vector3(float(s.get("x", 0)), float(s.get("y", 0)), float(s.get("z", 0))))
		"Basis":
			return Basis(_vector3(dict.get("x", {"x": 1})), _vector3(dict.get("y", {"y": 1})), _vector3(dict.get("z", {"z": 1})))
		"Transform3D":
			var basis: Basis = _decode(dict.get("basis", {}), "Basis", depth + 1)
			return Transform3D(basis, _vector3(dict.get("origin", {})))
		"Transform2D":
			return Transform2D(_vector2(dict.get("x", {"x": 1})), _vector2(dict.get("y", {"y": 1})), _vector2(dict.get("origin", {})))
	if dict.has("basis") and dict.has("origin"): return _decode(dict, "Transform3D", depth + 1)
	if dict.has("r") and dict.has("g") and dict.has("b"): return _decode(dict, "Color", depth + 1)
	if dict.has("x") and dict.has("y") and dict.has("z") and dict.has("w"): return _decode(dict, "Quaternion", depth + 1)
	if dict.has("position") and dict.has("size"):
		var position: Dictionary = dict["position"]
		var size: Dictionary = dict["size"]
		return _decode(dict, "AABB" if position.has("z") or size.has("z") else "Rect2", depth + 1)
	if dict.has("x") and dict.has("y") and dict.has("z"): return _decode(dict, "Vector3", depth + 1)
	if dict.has("x") and dict.has("y") and dict.size() == 2: return _decode(dict, "Vector2", depth + 1)
	return value


func decode_for_property(object: Object, property: String, value: Variant) -> Variant:
	for property_info: Dictionary in object.get_property_list():
		if property_info.get("name", "") != property:
			continue
		var hints: Dictionary = {TYPE_VECTOR2: "Vector2", TYPE_VECTOR2I: "Vector2i", TYPE_VECTOR3: "Vector3", TYPE_VECTOR3I: "Vector3i", TYPE_COLOR: "Color", TYPE_QUATERNION: "Quaternion", TYPE_RECT2: "Rect2", TYPE_AABB: "AABB", TYPE_BASIS: "Basis", TYPE_TRANSFORM3D: "Transform3D", TYPE_TRANSFORM2D: "Transform2D"}
		var type_id: int = property_info.get("type", TYPE_NIL)
		if hints.has(type_id): return decode(value, hints[type_id])
		if type_id == TYPE_BOOL: return value.to_lower() == "true" if value is String else bool(value)
		if type_id == TYPE_INT: return int(value)
		if type_id == TYPE_FLOAT: return float(value)
		break
	return decode(value)


func _vector2(value: Dictionary) -> Vector2:
	return Vector2(float(value.get("x", 0)), float(value.get("y", 0)))


func _vector3(value: Dictionary) -> Vector3:
	return Vector3(float(value.get("x", 0)), float(value.get("y", 0)), float(value.get("z", 0)))
