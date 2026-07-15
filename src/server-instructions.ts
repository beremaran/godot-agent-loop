/**
 * Initialization guidance is paid for in every MCP session. Keep this to the
 * durable operating method; detailed procedures belong in plugin skills.
 */
export const SERVER_INSTRUCTIONS = `Use an author → run → observe → assert loop.

For watched work, call editor_session ensure and prefer editor_transaction or editor-routed tools. Report fallbacks and conflicts. Persist structure in scenes/resources and behavior in scripts; justify procedural construction.

Use realtime run_project when watched. Observe with scene/UI queries, screenshots, and logs. Assert with deterministic verify_project, game_wait_until, game_scenario, or run_project_tests. Stop and report diagnostics, unsupported metrics, and cleanup.

Prefer compound tools. Runtime injection and cleanup are automatic; never add MCP files. Reflection, code execution, and network are denied by default. Enable only needed GODOT_MCP_PRIVILEGED_GROUPS, or explicitly allow all with GODOT_MCP_ALLOW_PRIVILEGED_COMMANDS=true.`;
