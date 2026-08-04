/**
 * Initialization guidance is paid for in every MCP session. Keep this to the
 * durable operating method; detailed procedures belong in plugin skills.
 */
export const SERVER_INSTRUCTIONS = `Use an author → run → observe → assert loop.

Author project files with your normal file tools; in watched mode, call editor_session ensure and prefer editor_transaction for undoable editor scene mutations. Validate GDScript with validate_scripts, then run_project.

Observe with game_get_scene_tree, game_get_ui, game_get_node_info, game_get_logs, game_get_errors, or game_screenshot. Interact through game_scenario — prefer it over hand-assembled key taps; game_key_hold exists in the catalog for held movement. Assert with game_wait_until, verify_project, or run_project_tests. Stop with stop_project and report diagnostics, unsupported metrics, and cleanup.

Advanced and hidden capabilities — input primitives, game_eval, game_call_method, game_set_property, game_performance, game_visual_regression, launch_editor, editor_control, and ship tooling such as export_project, verify_export_readiness, analyze_project_integrity, manage_import_pipeline, verify_dotnet_project, and manage_addon — are discoverable via godot_catalog and callable via godot_call.

Prefer compound tools. Runtime injection and cleanup are automatic; never add MCP files. Reflection and code execution are denied by default. Enable only needed GODOT_MCP_PRIVILEGED_GROUPS, or explicitly allow all with GODOT_MCP_ALLOW_PRIVILEGED_COMMANDS=true.`;
