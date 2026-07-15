---
name: build-godot-game
description: Build a new playable Godot 4 game or substantial gameplay slice through Godot Agent Loop. Use for requests to create a game from an empty project or project path, add a complete mechanic, or deliver a playable scene with input, visible state, and win/lose behavior.
---

# Build a Godot game

Use the MCP tools for project changes and engine evidence. Do not add MCP
autoloads, addons, or bridge files; `run_project` installs and removes its runtime
bridge automatically.

Godot Agent Loop supports Godot 4.7 or later. Report an older project/engine as
outside the supported boundary before authoring.

## Workflow

1. Inspect before writing.
   - Call `list_project_files`, `read_project_settings`, and `read_scene` when a
     project exists.
   - Call `create_project` only when `project.godot` is absent.
   - Define the playable loop, controls, visible feedback, and objective before
     choosing nodes.
   - If the user wants to watch, call `editor_session` with `ensure` before
     authoring. Continue detached only when the returned state requires it, and
     report every fallback or unsaved conflict.
2. Author the smallest complete game.
   - Prefer `editor_transaction` or editor-routed `create_scene`, `add_node`,
     node mutation, and supported resource tools while attached. Group one
     coherent human-readable change into one undo step.
   - Use `create_script` or `write_file`, then `attach_script`.
   - Persist meaningful game hierarchy and resources in scenes. Use scripts for
     behavior; build most persistent nodes in `_ready()` only when procedural
     generation is requested or justified, and report that choice.
   - Use `manage_input_map` for named actions and `set_main_scene` for startup.
   - Use `godot_tools` `search` then `describe` when a specialized node/resource
     tool is needed; invoke it with `godot_tools` `call`.
3. Validate static artifacts.
   - Call `validate_scripts` and fix every error.
   - Re-read the scene and project settings rather than trusting write responses.
   - Run `analyze_project_integrity` and require
     `main_scene_structure.meaningful_persisted_structure`, unless an explicit
     procedural design was passed as `allowProceduralMainScene`.
4. Run and exercise the game.
   - Call realtime `run_project` for watched play, then inspect with
     `game_get_scene_tree`, `game_get_ui`, and `game_screenshot`.
   - Prefer `game_wait_until` and `game_scenario` over repeated polling. Inject
     controls, observe state before and after input, and keep waits bounded.
5. Assert and finish.
   - Prefer `verify_project` for bounded node/log/screenshot assertions and
     `run_project_tests` for project tests.
   - Prove both ordinary play and the win/lose transition independently.
   - Inspect `get_debug_output` and `game_get_errors`; stop the project when done.

Before adding high-volume particles, trails, lights, shockwaves, fireworks, or
audio voices, establish an explicit frame/object/voice budget. For external
assets, verify source and license, record attribution or CC0 status, and confirm
the imported asset independently loads and renders or plays.

Keep the project tree game-only. Remove temporary probes, screenshots, and test
artifacts and MCP-owned transient bridges unless requested as deliverables.
Never remove a user's persistent addon. Report warnings, leaks, fallbacks,
unsupported metrics, and subjective polish that still needs human review.
