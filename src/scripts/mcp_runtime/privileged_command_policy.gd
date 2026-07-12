extends RefCounted

# Trust policy for runtime commands that can execute arbitrary code, invoke
# arbitrary engine APIs, mutate scripts, call peers, or reach external hosts.
# The interaction server is localhost-only, but it has no authentication, so
# these commands stay disabled unless the project owner explicitly opts in.

const CAPABILITY: String = "privileged-commands"
const ENVIRONMENT_VARIABLE: String = "GODOT_MCP_ALLOW_PRIVILEGED_COMMANDS"
const ERROR_CODE: int = -32007
const COMMANDS: Array[String] = [
	"call_method",
	"eval",
	"get_property",
	"http_request",
	"rpc",
	"script",
	"set_property",
	"websocket",
]


func is_privileged(command: String) -> bool:
	return COMMANDS.has(command)


func is_enabled(explicit_opt_in: bool) -> bool:
	if explicit_opt_in:
		return true
	var environment_value: String = OS.get_environment(ENVIRONMENT_VARIABLE).strip_edges().to_lower()
	return ["1", "true", "yes", "on"].has(environment_value)


func capabilities(base_capabilities: Array[String], explicit_opt_in: bool) -> Array[String]:
	var result: Array[String] = base_capabilities.duplicate()
	if is_enabled(explicit_opt_in):
		result.append(CAPABILITY)
	return result


func denial_details(command: String) -> Dictionary:
	return {
		"reason": "privileged_command_disabled",
		"command": command,
		"capability": CAPABILITY,
		"enable_with": ENVIRONMENT_VARIABLE,
	}
