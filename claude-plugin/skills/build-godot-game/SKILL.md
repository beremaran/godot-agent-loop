---
name: build-godot-game
description: Build a new playable Godot 4 game or substantial gameplay slice through Godot Agent Loop. Use for requests to create a game from an empty project or project path, add a complete mechanic, or deliver a playable scene with input, visible state, and win/lose behavior.
---

# Build a Godot game

Use the MCP tools for project changes and engine evidence. Do not add MCP
autoloads, addons, or bridge files; `run_project` installs and removes its runtime
bridge automatically.

## Workflow

1. Inspect before writing.
   - Call `list_project_files`, `read_project_settings`, and `read_scene` when a
     project exists.
   - Call `create_project` only when `project.godot` is absent.
   - Define the playable loop, controls, visible feedback, and objective before
     choosing nodes.
2. Author the smallest complete game.
   - Use `create_scene` and `add_node` for the scene tree.
   - Use `create_script` or `write_file`, then `attach_script`.
   - Use `manage_input_map` for named actions and `set_main_scene` for startup.
   - Use `godot_tools` `search` then `describe` when a specialized node/resource
     tool is needed; invoke it with `godot_tools` `call`.
3. Validate static artifacts.
   - Call `validate_scripts` and fix every error.
   - Re-read the scene and project settings rather than trusting write responses.
4. Run and exercise the game.
   - Call `run_project`, wait for connection, then inspect with
     `game_get_scene_tree`, `game_get_ui`, and `game_screenshot`.
   - Inject the documented controls with `game_key_press`, `game_click`, or the
     relevant input tool. Observe state before and after input.
5. Assert and finish.
   - Prefer `verify_project` for bounded node/log/screenshot assertions and
     `run_project_tests` for project tests.
   - Prove both ordinary play and the win/lose transition independently.
   - Inspect `get_debug_output` and `game_get_errors`; stop the project when done.

Keep the project tree game-only. Remove temporary probes, screenshots, and test
artifacts unless the user requested them as deliverables.
