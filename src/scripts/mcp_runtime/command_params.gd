extends RefCounted

# Validated accessor for one command's params dictionary. Records the first
# failure as a message plus structured {param, reason, ...} details; every
# handler must stop via _params_invalid() once any accessor fails, so no
# command continues past invalid input.
var _params: Dictionary
var error_message: String = ""
var error_details: Dictionary = {}

func _init(params: Dictionary) -> void:
	_params = params

func failed() -> bool:
	return not error_message.is_empty()

func fail(message: String, details: Dictionary = {}) -> void:
	if failed():
		return
	error_message = message
	error_details = details

func _fail_param(name: String, reason: String, message: String, extra: Dictionary = {}) -> void:
	var details: Dictionary = {"param": name, "reason": reason}
	details.merge(extra)
	fail(message, details)

func has_param(name: String) -> bool:
	return _params.has(name)

# Raw passthrough for values that are converted later (e.g. typed Variant
# payloads handled by the JSON/Variant codec).
func raw(name: String, default_value: Variant = null) -> Variant:
	return _params.get(name, default_value)

func required_string(name: String) -> String:
	if not _params.has(name):
		_fail_param(name, "missing", "%s is required" % name)
		return ""
	return _string_value(name, "")

func optional_string(name: String, default_value: String = "") -> String:
	if not _params.has(name):
		return default_value
	return _string_value(name, default_value)

func _string_value(name: String, default_value: String) -> String:
	var value: Variant = _params[name]
	if not value is String:
		_fail_param(name, "invalid_type", "%s must be a string" % name)
		return default_value
	return value

func required_number(name: String, min_value: float = -INF, max_value: float = INF) -> float:
	if not _params.has(name):
		_fail_param(name, "missing", "%s is required" % name)
		return 0.0
	return _number_value(name, 0.0, min_value, max_value)

func optional_number(name: String, default_value: float, min_value: float = -INF, max_value: float = INF) -> float:
	if not _params.has(name):
		return default_value
	return _number_value(name, default_value, min_value, max_value)

func _number_value(name: String, default_value: float, min_value: float, max_value: float) -> float:
	var value: Variant = _params[name]
	if not (value is float or value is int):
		_fail_param(name, "invalid_type", "%s must be a number" % name)
		return default_value
	var number: float = value
	if number < min_value or number > max_value:
		_fail_range(name, number, min_value, max_value)
		return default_value
	return number

func required_int(name: String, min_value: float = -INF, max_value: float = INF) -> int:
	if not _params.has(name):
		_fail_param(name, "missing", "%s is required" % name)
		return 0
	return _int_value(name, 0, min_value, max_value)

func optional_int(name: String, default_value: int, min_value: float = -INF, max_value: float = INF) -> int:
	if not _params.has(name):
		return default_value
	return _int_value(name, default_value, min_value, max_value)

func _int_value(name: String, default_value: int, min_value: float, max_value: float) -> int:
	var value: Variant = _params[name]
	var number: int
	if value is int:
		number = value
	elif value is float and _is_integral(value):
		# JSON parsing yields floats for every number; accept integral ones.
		number = to_int(value)
	else:
		_fail_param(name, "invalid_type", "%s must be an integer" % name)
		return default_value
	if number < min_value or number > max_value:
		_fail_range(name, number, min_value, max_value)
		return default_value
	return number

func _fail_range(name: String, value: Variant, min_value: float, max_value: float) -> void:
	var details: Dictionary = {"value": value}
	var constraint: String
	if min_value != -INF and max_value != INF:
		details.merge({"min": min_value, "max": max_value})
		constraint = "between %s and %s" % [min_value, max_value]
	elif min_value != -INF:
		details["min"] = min_value
		constraint = "at least %s" % min_value
	else:
		details["max"] = max_value
		constraint = "at most %s" % max_value
	_fail_param(name, "out_of_range", "%s must be %s" % [name, constraint], details)

func optional_bool(name: String, default_value: bool) -> bool:
	if not _params.has(name):
		return default_value
	var value: Variant = _params[name]
	if not value is bool:
		_fail_param(name, "invalid_type", "%s must be a boolean" % name)
		return default_value
	return value

func required_enum(name: String, allowed: Array) -> String:
	var value: String = required_string(name)
	return _enum_value(name, value, "", allowed)

func optional_enum(name: String, default_value: String, allowed: Array) -> String:
	var value: String = optional_string(name, default_value)
	return _enum_value(name, value, default_value, allowed)

func _enum_value(name: String, value: String, default_value: String, allowed: Array) -> String:
	if failed():
		return default_value
	if not allowed.has(value):
		_fail_param(name, "invalid_value", "%s must be one of: %s" % [name, ", ".join(allowed)], {"allowed": allowed, "value": value})
		return default_value
	return value

func required_array(name: String) -> Array:
	if not _params.has(name):
		_fail_param(name, "missing", "%s is required" % name)
		return []
	return _array_value(name, [])

func optional_array(name: String, default_value: Array = []) -> Array:
	if not _params.has(name):
		return default_value
	return _array_value(name, default_value)

func _array_value(name: String, default_value: Array) -> Array:
	var value: Variant = _params[name]
	if not value is Array:
		_fail_param(name, "invalid_type", "%s must be an array" % name)
		return default_value
	return value

func required_dictionary(name: String) -> Dictionary:
	if not _params.has(name):
		_fail_param(name, "missing", "%s is required" % name)
		return {}
	return _dictionary_value(name, {})

func optional_dictionary(name: String, default_value: Dictionary = {}) -> Dictionary:
	if not _params.has(name):
		return default_value
	return _dictionary_value(name, default_value)

func _dictionary_value(name: String, default_value: Dictionary) -> Dictionary:
	var value: Variant = _params[name]
	if not value is Dictionary:
		_fail_param(name, "invalid_type", "%s must be an object" % name)
		return default_value
	return value

func required_node_path(name: String = "node_path") -> String:
	var value: String = required_string(name)
	if failed():
		return ""
	if value.is_empty():
		_fail_param(name, "invalid_value", "%s must be a non-empty node path" % name)
		return ""
	return value

func required_resource_path(name: String) -> String:
	var value: String = required_string(name)
	if failed():
		return ""
	if not (value.begins_with("res://") or value.begins_with("user://")):
		_fail_param(name, "invalid_value", "%s must be a res:// or user:// path" % name, {"value": value})
		return ""
	return value


# --- Variant narrowing at the JSON boundary ---
# The accessors above cover a command's own params. Handlers also read nested
# JSON objects (a position's `x`, a color's `r`), whose members are Variant
# because JSON is untyped. These narrowers are the only place that boundary is
# crossed, so the type-strictness suppressions stay confined to three functions
# instead of spreading through every handler.
#
# The engine's float()/int()/bool() constructors raise a script error on a type
# they cannot convert -- and bool() rejects even a String. Inside a handler that
# error abandoned the request without a response, so the narrowers fall back to
# the caller's default instead.

static func _is_integral(value: Variant) -> bool:
	if not value is float:
		return false
	var number: float = value
	return number == floorf(number)


static func to_float(value: Variant, default_value: float = 0.0) -> float:
	if value is float or value is int or value is bool:
		@warning_ignore("unsafe_call_argument")
		return float(value)
	if value is String:
		var text: String = value
		return text.to_float()
	return default_value


static func to_int(value: Variant, default_value: int = 0) -> int:
	if value is float or value is int or value is bool:
		@warning_ignore("unsafe_call_argument", "narrowing_conversion")
		return int(value)
	if value is String:
		var text: String = value
		return text.to_int()
	return default_value


static func to_bool(value: Variant, default_value: bool = false) -> bool:
	if value is bool:
		return value
	if value is float or value is int:
		return not is_zero_approx(to_float(value))
	if value is String:
		var text: String = value
		return text.to_lower() == "true"
	return default_value


# Members of a nested JSON object.
static func json_float(source: Dictionary, key: String, default_value: float = 0.0) -> float:
	return to_float(source.get(key), default_value)


static func json_int(source: Dictionary, key: String, default_value: int = 0) -> int:
	return to_int(source.get(key), default_value)


static func json_bool(source: Dictionary, key: String, default_value: bool = false) -> bool:
	return to_bool(source.get(key), default_value)


static func json_string(source: Dictionary, key: String, default_value: String = "") -> String:
	var value: Variant = source.get(key)
	if value is String:
		return value
	return default_value


static func as_dictionary(value: Variant) -> Dictionary:
	if value is Dictionary:
		return value
	return {}


static func as_array(value: Variant) -> Array:
	if value is Array:
		return value
	return []


static func json_dictionary(source: Dictionary, key: String) -> Dictionary:
	var value: Variant = source.get(key)
	if value is Dictionary:
		return value
	return {}


static func json_array(source: Dictionary, key: String) -> Array:
	var value: Variant = source.get(key)
	if value is Array:
		return value
	return []


# Nested JSON vectors and colors, which every geometry-facing domain reads.
static func json_vector2(source: Dictionary, key: String, default_value: Vector2 = Vector2.ZERO) -> Vector2:
	var value: Dictionary = json_dictionary(source, key)
	if value.is_empty():
		return default_value
	return Vector2(json_float(value, "x", default_value.x), json_float(value, "y", default_value.y))


static func json_vector3(source: Dictionary, key: String, default_value: Vector3 = Vector3.ZERO) -> Vector3:
	var value: Dictionary = json_dictionary(source, key)
	if value.is_empty():
		return default_value
	return Vector3(
		json_float(value, "x", default_value.x),
		json_float(value, "y", default_value.y),
		json_float(value, "z", default_value.z),
	)


static func to_vector2(value: Variant, default_value: Vector2 = Vector2.ZERO) -> Vector2:
	if not value is Dictionary:
		return default_value
	var source: Dictionary = value
	return Vector2(json_float(source, "x", default_value.x), json_float(source, "y", default_value.y))


static func to_vector3(value: Variant, default_value: Vector3 = Vector3.ZERO) -> Vector3:
	if not value is Dictionary:
		return default_value
	var source: Dictionary = value
	return Vector3(
		json_float(source, "x", default_value.x),
		json_float(source, "y", default_value.y),
		json_float(source, "z", default_value.z),
	)


static func to_color(value: Variant, default_value: Color = Color.WHITE) -> Color:
	if not value is Dictionary:
		return default_value
	var source: Dictionary = value
	return Color(
		json_float(source, "r", default_value.r),
		json_float(source, "g", default_value.g),
		json_float(source, "b", default_value.b),
		json_float(source, "a", default_value.a),
	)
