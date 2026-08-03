extends RefCounted

# Trust policy for runtime commands that can execute arbitrary code, invoke
# arbitrary engine APIs, mutate scripts, call peers, or reach external hosts.
# Authentication proves possession of the per-launch session secret; this
# separate least-privilege gate still keeps dangerous commands disabled unless
# the project owner explicitly opts in.

const CAPABILITY: String = "privileged-commands"
const ENVIRONMENT_VARIABLE: String = "GODOT_MCP_ALLOW_PRIVILEGED_COMMANDS"
const GROUP_ENVIRONMENT_VARIABLE: String = "GODOT_MCP_PRIVILEGED_GROUPS"
const ERROR_CODE: int = -32007
const GROUPS: Array[String] = ["reflection", "code-execution", "network"]
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
const COMMAND_GROUPS: Dictionary = {
	"call_method": "reflection",
	"eval": "code-execution",
	"get_property": "reflection",
	"http_request": "network",
	"rpc": "network",
	"script": "code-execution",
	"set_property": "reflection",
	"websocket": "network",
}


func is_privileged(command: String) -> bool:
	return COMMANDS.has(command)


func is_enabled(command: String, explicit_opt_in: bool) -> bool:
	return enabled_groups(explicit_opt_in).has(group_for(command))


func enabled_groups(explicit_opt_in: bool) -> Array[String]:
	if explicit_opt_in:
		return GROUPS.duplicate()
	var environment_value: String = OS.get_environment(ENVIRONMENT_VARIABLE).strip_edges().to_lower()
	if ["1", "true", "yes", "on"].has(environment_value):
		return GROUPS.duplicate()
	var result: Array[String] = []
	for requested: String in OS.get_environment(GROUP_ENVIRONMENT_VARIABLE).split(","):
		var group: String = requested.strip_edges().to_lower()
		if GROUPS.has(group) and not result.has(group):
			result.append(group)
	return result


func group_for(command: String) -> String:
	return str(COMMAND_GROUPS.get(command, ""))


func capabilities(base_capabilities: Array[String], explicit_opt_in: bool) -> Array[String]:
	var result: Array[String] = base_capabilities.duplicate()
	var groups: Array[String] = enabled_groups(explicit_opt_in)
	for group: String in groups:
		result.append("privileged-%s" % group)
	if groups.size() == GROUPS.size():
		result.append(CAPABILITY)
	return result


func denial_details(command: String) -> Dictionary:
	var group: String = group_for(command)
	return {
		"reason": "privileged_command_disabled",
		"command": command,
		"group": group,
		"capability": "privileged-%s" % group,
		"enable_group_with": "%s=%s" % [GROUP_ENVIRONMENT_VARIABLE, group],
		"enable_all_with": ENVIRONMENT_VARIABLE,
	}
