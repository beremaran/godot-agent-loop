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
		_fail_param(name, "out_of_range", "%s must be between %s and %s" % [name, min_value, max_value], {"min": min_value, "max": max_value, "value": number})
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
	elif value is float and value == floorf(value):
		# JSON parsing yields floats for every number; accept integral ones.
		number = int(value)
	else:
		_fail_param(name, "invalid_type", "%s must be an integer" % name)
		return default_value
	if number < min_value or number > max_value:
		_fail_param(name, "out_of_range", "%s must be between %s and %s" % [name, min_value, max_value], {"min": min_value, "max": max_value, "value": number})
		return default_value
	return number

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
