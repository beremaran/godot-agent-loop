---
name: build-godot-game
description: Build a new playable Godot 4 game or substantial gameplay slice through Godot Agent Loop. Use to create a game, add a complete mechanic, or deliver playable controls, visible state, and success/failure behavior; do not use for diagnosis-only, verification-only, or release-only requests.
---

# Build a Godot game

Build the smallest coherent playable loop and prove it independently. Godot Agent
Loop supports Godot 4.7 or later. Report an older project or engine as outside
the supported boundary. Never add MCP autoloads, addons, or bridge files.

## Control contract

- Validate the requested `projectPath` against the effective MCP roots and
  allowed directories before mutation. Inspect first; call `create_project` only
  when `project.godot` is absent.
- For an empty watched directory, preflight the executable with
  `get_godot_version` before `create_project`. If Godot is unavailable, stop
  without writing anything. After the minimal project scaffold exists, attach
  or launch the editor before any scene, script, setting, or input authoring.
- Record an acceptance contract before choosing nodes: playable loop, controls,
  visible feedback, ordinary state, success/failure transitions, and whether the
  user requested watched or unattended work.
- For watched work, call `editor_session` with `ensure` and launch enabled.
  Stop with a blocker if a matching usable editor cannot be attached or launched;
  never silently continue detached. Unattended work may proceed without an editor.
- Treat scene, resource, script, settings, and input-map tools as persistent
  authoring. Treat `game_*` scene/property/input changes as runtime-ephemeral and
  never report them as saved project changes.
- Use canonical core tools directly (`compact` is only the compatibility alias).
  Resolve hidden `list_project_files` and `analyze_project_integrity` through
  `godot_catalog` detail, then invoke them with `godot_call`; never call a hidden
  tool directly.
- If the human selects **Pause Agent**, do not retry, route around, or disguise a
  blocked mutation. Preserve state, continue only safe observation or teardown,
  and report the blocked effective tool.
- Use privileged reflection or evaluation only when already enabled, necessary,
  and recorded. Never enable a privilege merely to make the workflow easier.

## Workflow

1. Inspect an existing project in concise mode with `read_project_settings`,
   `read_scene`, and the hidden file inventory when needed. Identify the main
   scene, input map, persisted hierarchy, renderer, and relevant resources.
2. Author one human-readable change per `editor_transaction` or editor undo step.
   Prefer persisted scene hierarchy and resources; use procedural `_ready()`
   construction only when requested or explicitly accepted. A scripted root
   that creates all controls at runtime is not a persisted hierarchy: save the
   root plus meaningful gameplay and UI child nodes in the saved scene.
3. Use canonical Godot Variant shapes. For example, pass a Vector2 as
   `{ "x": 120, "y": 80 }` and a Color as
   `{ "r": 0.2, "g": 0.7, "b": 1.0, "a": 1.0 }`, not numeric arrays.
4. Put behavior in `create_script` or `write_file`, attach it with
   `attach_script`, create named actions with `manage_input_map`, and set the
   startup scene with `set_main_scene`.
5. Run `validate_scripts`, then independently re-read changed scenes, scripts,
   settings, and integrity state before starting the game.
6. Start watched gameplay with `run_project`; success means the runtime bridge is
   usable. Observe the baseline with concise `game_get_scene_tree`, `game_get_ui`,
   logs, and `game_screenshot`.
7. Prefer bounded `game_wait_until` and `game_scenario` steps. Use
   `game_key_press` for a one-frame tap, `game_key_hold` for continuous movement,
   and always pair a hold with `game_key_release`, including failure cleanup.
   When the game exposes continuous control, prove at least one real
   hold/release path even if debug keys can force success or failure.
8. Prove ordinary play and requested success/failure transitions with independent
   state plus rendered or log evidence. Use `verify_project` and
   `run_project_tests` where they express the criteria directly.
9. Inspect `get_debug_output` and `game_get_errors`, release held input, call
   `stop_project`, and remove only identified MCP-owned probes or transient files.
   For watched work, leave the editor available to the human and use
   `editor_session` with the disconnect action to hand off the agent connection.

Establish an explicit frame/object/voice budget before high-volume effects. For
external assets, verify source, license, attribution, import, and rendered or
audible use. Distinguish mandatory acceptance gates from conditional polish.
Report passed, failed, blocked, unobserved, warning, fallback, unsupported,
subjective/manual-review, and cleanup results. Never remove a user's addon.
