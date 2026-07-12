extends RefCounted

# Typed boundary between Godot Variants and values accepted by JSON.stringify().
# A codec instance is shared by the server and its domains. Runtime commands are
# serialized, so the small last-error slot is never observed concurrently.

const CommandParams = preload("res://mcp_runtime/command_params.gd")

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
	# Each math type is narrowed to a typed local before its members are read, so
	# an integer vector still encodes its members as integers.
	if value is Vector2:
		var vector2: Vector2 = value
		return {"x": vector2.x, "y": vector2.y}
	if value is Vector2i:
		var vector2i: Vector2i = value
		return {"x": vector2i.x, "y": vector2i.y}
	if value is Vector3:
		var vector3: Vector3 = value
		return {"x": vector3.x, "y": vector3.y, "z": vector3.z}
	if value is Vector3i:
		var vector3i: Vector3i = value
		return {"x": vector3i.x, "y": vector3i.y, "z": vector3i.z}
	if value is Color:
		var color: Color = value
		return {"r": color.r, "g": color.g, "b": color.b, "a": color.a}
	if value is Quaternion:
		var quaternion: Quaternion = value
		return {"x": quaternion.x, "y": quaternion.y, "z": quaternion.z, "w": quaternion.w}
	if value is Basis:
		var basis_value: Basis = value
		var basis_x: Variant = _encode_child(basis_value.x, depth + 1, ancestors)
		if not _last_error.is_empty(): return null
		var basis_y: Variant = _encode_child(basis_value.y, depth + 1, ancestors)
		if not _last_error.is_empty(): return null
		var basis_z: Variant = _encode_child(basis_value.z, depth + 1, ancestors)
		if not _last_error.is_empty(): return null
		return {"x": basis_x, "y": basis_y, "z": basis_z}
	if value is Transform3D:
		var transform3d: Transform3D = value
		var basis: Variant = _encode_child(transform3d.basis, depth + 1, ancestors)
		if not _last_error.is_empty(): return null
		var origin: Variant = _encode_child(transform3d.origin, depth + 1, ancestors)
		if not _last_error.is_empty(): return null
		return {"basis": basis, "origin": origin}
	if value is Transform2D:
		var transform2d: Transform2D = value
		var x_axis: Variant = _encode_child(transform2d.x, depth + 1, ancestors)
		if not _last_error.is_empty(): return null
		var y_axis: Variant = _encode_child(transform2d.y, depth + 1, ancestors)
		if not _last_error.is_empty(): return null
		var transform_origin: Variant = _encode_child(transform2d.origin, depth + 1, ancestors)
		if not _last_error.is_empty(): return null
		return {"x": x_axis, "y": y_axis, "origin": transform_origin}
	if value is Rect2:
		var rect: Rect2 = value
		var rect_position: Variant = _encode_child(rect.position, depth + 1, ancestors)
		if not _last_error.is_empty(): return null
		var rect_size: Variant = _encode_child(rect.size, depth + 1, ancestors)
		if not _last_error.is_empty(): return null
		return {"position": rect_position, "size": rect_size}
	if value is AABB:
		var aabb: AABB = value
		var aabb_position: Variant = _encode_child(aabb.position, depth + 1, ancestors)
		if not _last_error.is_empty(): return null
		var aabb_size: Variant = _encode_child(aabb.size, depth + 1, ancestors)
		if not _last_error.is_empty(): return null
		return {"position": aabb_position, "size": aabb_size}
	if value is NodePath or value is StringName:
		return str(value)
	if _is_packed_array(value):
		# Bounded before the copy, so an oversized packed array is rejected
		# without materializing it.
		var packed_size: int = _packed_size(value)
		if packed_size > max_collection_items:
			return _fail("codec_collection_exceeded", "Packed array exceeds the configured limit", {"max_collection_items": max_collection_items})
		var items: Array = _packed_to_array(value)
		if value is PackedVector2Array or value is PackedVector3Array or value is PackedColorArray:
			var packed_result: Array = []
			for item: Variant in items:
				packed_result.append(_encode_child(item, depth + 1, ancestors))
				if not _last_error.is_empty(): return null
			return packed_result
		return items
	if value is Array or value is Dictionary:
		for ancestor: Variant in ancestors:
			if is_same(ancestor, value):
				return _fail("codec_cycle", "Cyclic arrays and dictionaries cannot be encoded")
		var next_ancestors: Array = ancestors.duplicate()
		next_ancestors.append(value)
		if value is Array:
			var source_array: Array = value
			if source_array.size() > max_collection_items:
				return _fail("codec_collection_exceeded", "Variant collection exceeds the configured limit", {"max_collection_items": max_collection_items})
			var array_result: Array = []
			for item: Variant in source_array:
				array_result.append(_encode_child(item, depth + 1, next_ancestors))
				if not _last_error.is_empty(): return null
			return array_result
		var source_dictionary: Dictionary = value
		if source_dictionary.size() > max_collection_items:
			return _fail("codec_collection_exceeded", "Variant collection exceeds the configured limit", {"max_collection_items": max_collection_items})
		var dictionary_result: Dictionary = {}
		for key: Variant in source_dictionary:
			dictionary_result[str(key)] = _encode_child(source_dictionary[key], depth + 1, next_ancestors)
			if not _last_error.is_empty(): return null
		return dictionary_result
	if value is Node:
		var node: Node = value
		return {"_type": "Node", "class": node.get_class(), "name": node.name, "path": str(node.get_path())}
	if value is Resource:
		var resource: Resource = value
		return {"_type": "Resource", "class": resource.get_class(), "path": resource.resource_path}
	if value is Object:
		var object: Object = value
		return {"_type": "Object", "class": object.get_class(), "id": object.get_instance_id()}
	return _fail("unsupported_variant", "Variant type is not supported by the runtime codec", {"variant_type": type_string(typeof(value))})


func _encode_child(value: Variant, depth: int, ancestors: Array) -> Variant:
	var encoded: Variant = _encode(value, depth, ancestors)
	return null if not _last_error.is_empty() else encoded


# --- Packed arrays ---
# The packed array types share no common static type, so each is narrowed to a
# typed local before it is measured or copied.

const PACKED_ARRAY_TYPES: Array[int] = [
	TYPE_PACKED_BYTE_ARRAY, TYPE_PACKED_INT32_ARRAY, TYPE_PACKED_INT64_ARRAY,
	TYPE_PACKED_FLOAT32_ARRAY, TYPE_PACKED_FLOAT64_ARRAY, TYPE_PACKED_STRING_ARRAY,
	TYPE_PACKED_VECTOR2_ARRAY, TYPE_PACKED_VECTOR3_ARRAY, TYPE_PACKED_COLOR_ARRAY,
]


func _is_packed_array(value: Variant) -> bool:
	return PACKED_ARRAY_TYPES.has(typeof(value))


func _packed_size(value: Variant) -> int:
	if value is PackedByteArray:
		var packed: PackedByteArray = value
		return packed.size()
	if value is PackedInt32Array:
		var packed: PackedInt32Array = value
		return packed.size()
	if value is PackedInt64Array:
		var packed: PackedInt64Array = value
		return packed.size()
	if value is PackedFloat32Array:
		var packed: PackedFloat32Array = value
		return packed.size()
	if value is PackedFloat64Array:
		var packed: PackedFloat64Array = value
		return packed.size()
	if value is PackedStringArray:
		var packed: PackedStringArray = value
		return packed.size()
	if value is PackedVector2Array:
		var packed: PackedVector2Array = value
		return packed.size()
	if value is PackedVector3Array:
		var packed: PackedVector3Array = value
		return packed.size()
	if value is PackedColorArray:
		var packed: PackedColorArray = value
		return packed.size()
	return -1


func _packed_to_array(value: Variant) -> Array:
	if value is PackedByteArray:
		var packed: PackedByteArray = value
		return Array(packed)
	if value is PackedInt32Array:
		var packed: PackedInt32Array = value
		return Array(packed)
	if value is PackedInt64Array:
		var packed: PackedInt64Array = value
		return Array(packed)
	if value is PackedFloat32Array:
		var packed: PackedFloat32Array = value
		return Array(packed)
	if value is PackedFloat64Array:
		var packed: PackedFloat64Array = value
		return Array(packed)
	if value is PackedStringArray:
		var packed: PackedStringArray = value
		return Array(packed)
	if value is PackedVector2Array:
		var packed: PackedVector2Array = value
		return Array(packed)
	if value is PackedVector3Array:
		var packed: PackedVector3Array = value
		return Array(packed)
	if value is PackedColorArray:
		var packed: PackedColorArray = value
		return Array(packed)
	return []


func decode(value: Variant, type_hint: String = "") -> Variant:
	_last_error = {}
	if not type_hint in SUPPORTED_TYPE_HINTS:
		return _fail("invalid_type_hint", "Unknown Variant type hint", {"type_hint": type_hint, "allowed": SUPPORTED_TYPE_HINTS})
	return _decode(value, type_hint, 0)


func _decode(value: Variant, type_hint: String, depth: int) -> Variant:
	if depth > max_depth:
		return _fail("codec_depth_exceeded", "Variant nesting exceeds the configured limit", {"max_depth": max_depth})
	if value is String and type_hint != "" and type_hint != "String":
		var text: String = value
		var trimmed: String = text.strip_edges()
		if trimmed.begins_with("{") or trimmed.begins_with("["):
			var parsed: Variant = JSON.parse_string(trimmed)
			if parsed != null:
				value = parsed
	if not value is Dictionary:
		return value
	var dict: Dictionary = value
	match type_hint:
		"Vector2": return _vector2(dict)
		"Vector2i": return Vector2i(CommandParams.json_int(dict, "x"), CommandParams.json_int(dict, "y"))
		"Vector3": return _vector3(dict)
		"Vector3i": return Vector3i(CommandParams.json_int(dict, "x"), CommandParams.json_int(dict, "y"), CommandParams.json_int(dict, "z"))
		"Color": return Color(CommandParams.json_float(dict, "r"), CommandParams.json_float(dict, "g"), CommandParams.json_float(dict, "b"), CommandParams.json_float(dict, "a", 1.0))
		"Quaternion": return Quaternion(CommandParams.json_float(dict, "x"), CommandParams.json_float(dict, "y"), CommandParams.json_float(dict, "z"), CommandParams.json_float(dict, "w", 1.0))
		"Rect2":
			var rect_position: Vector2 = _vector2(CommandParams.json_dictionary(dict, "position"))
			var rect_size: Vector2 = _vector2(CommandParams.json_dictionary(dict, "size"))
			return Rect2(rect_position, rect_size)
		"AABB":
			var aabb_position: Vector3 = _vector3(CommandParams.json_dictionary(dict, "position"))
			var aabb_size: Vector3 = _vector3(CommandParams.json_dictionary(dict, "size"))
			return AABB(aabb_position, aabb_size)
		"Basis":
			return Basis(
				_vector3(_member_or(dict, "x", {"x": 1})),
				_vector3(_member_or(dict, "y", {"y": 1})),
				_vector3(_member_or(dict, "z", {"z": 1})),
			)
		"Transform3D":
			var basis: Basis = _decode(CommandParams.json_dictionary(dict, "basis"), "Basis", depth + 1)
			return Transform3D(basis, _vector3(CommandParams.json_dictionary(dict, "origin")))
		"Transform2D":
			return Transform2D(
				_vector2(_member_or(dict, "x", {"x": 1})),
				_vector2(_member_or(dict, "y", {"y": 1})),
				_vector2(CommandParams.json_dictionary(dict, "origin")),
			)
	if dict.has("basis") and dict.has("origin"): return _decode(dict, "Transform3D", depth + 1)
	if dict.has("r") and dict.has("g") and dict.has("b"): return _decode(dict, "Color", depth + 1)
	if dict.has("x") and dict.has("y") and dict.has("z") and dict.has("w"): return _decode(dict, "Quaternion", depth + 1)
	if dict.has("position") and dict.has("size"):
		var position: Dictionary = CommandParams.json_dictionary(dict, "position")
		var size: Dictionary = CommandParams.json_dictionary(dict, "size")
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
		if hints.has(type_id):
			var hint: String = hints[type_id]
			return decode(value, hint)
		if type_id == TYPE_BOOL: return CommandParams.to_bool(value)
		if type_id == TYPE_INT: return CommandParams.to_int(value)
		if type_id == TYPE_FLOAT: return CommandParams.to_float(value)
		break
	return decode(value)


# A member that is only defaulted when the key is absent; a present object still
# defaults its own missing members to zero.
func _member_or(source: Dictionary, key: String, default_value: Dictionary) -> Dictionary:
	if not source.has(key):
		return default_value
	return CommandParams.json_dictionary(source, key)


func _vector2(value: Dictionary) -> Vector2:
	return Vector2(CommandParams.json_float(value, "x"), CommandParams.json_float(value, "y"))


func _vector3(value: Dictionary) -> Vector3:
	return Vector3(CommandParams.json_float(value, "x"), CommandParams.json_float(value, "y"), CommandParams.json_float(value, "z"))
