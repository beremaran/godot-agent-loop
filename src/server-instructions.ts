/**
 * Initialization guidance is paid for in every MCP session. Keep this to the
 * durable operating method; detailed procedures belong in plugin skills.
 */
export const SERVER_INSTRUCTIONS = `Build and verify Godot changes with an author → run → observe → assert loop.

1. Author scenes, scripts, resources, and project settings with project tools.
2. Run with run_project, then observe through game_get_scene_tree, game_get_ui, game_screenshot, and get_debug_output.
3. Assert outcomes with verify_project or run_project_tests instead of assembling fragile manual checks. Stop the project when finished.

Prefer compound tools when they cover the task. Runtime bridge injection and cleanup are automatic; do not add MCP autoloads or addon files to the project. Reflection, code execution, and network tools are denied by default. For trusted local work, enable only required groups with GODOT_MCP_PRIVILEGED_GROUPS (reflection, code-execution, network), or explicitly enable all with GODOT_MCP_ALLOW_PRIVILEGED_COMMANDS=true.`;
