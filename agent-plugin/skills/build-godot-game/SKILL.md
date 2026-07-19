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
   In unattended work, if `editor_transaction` cannot run because no editor
   add-on is ready, use `create_scene`, `add_node`, `attach_script`, and other
   persisted authoring tools. For each nested node, pass the parentNodePath field
   to `add_node`; omitting it adds the node at the scene root. Instantiate a saved
   child with `parentNodePath` set to a saved-scene path such as `HUD`; omit the
   field or use `.` for a direct child of the scene root. Never pass runtime paths
   such as `/root` to persistent scene tools. Instantiate a saved child scene or
   attach its script and resources to the node in the main scene:
   making a separate player scene does not wire a plain CharacterBody2D in the
   main scene to it. Re-read each scene after authoring and compare its node paths
   with the planned hierarchy. Do not hand-write tscn text as a shortcut.
3. Use canonical Godot Variant shapes. For example, pass a Vector2 as
   `{ "x": 120, "y": 80 }` and a Color as
   `{ "r": 0.2, "g": 0.7, "b": 1.0, "a": 1.0 }`, not numeric arrays.
4. Put behavior in `create_script` or `write_file`, attach it with
   `attach_script`, create named actions with `manage_input_map`, and set the
   startup scene with `set_main_scene`. Pass plain JSON strings to
   `modify_project_settings`; the tool writes their required Godot quotes.
5. Run `validate_scripts`, then independently re-read changed scenes, scripts,
   settings, and integrity state before starting the game. Treat this as a gate:
   script validation alone does not prove saved scenes or project settings.
6. Start watched gameplay with `run_project`; success means the runtime bridge is
   usable. Observe the baseline with concise `game_get_scene_tree`, `game_get_ui`,
   logs, and `game_screenshot`. Check `game_get_errors` at once. Prefer these
   small views over broad node method or property dumps. Read the runtime tree or
   UI paths before asserting them; persisted paths and runtime paths are distinct.
7. Prefer bounded `game_wait_until` and `game_scenario` steps. Use
   `game_key_press` for a one-frame tap, `game_key_hold` for continuous movement,
   and always pair a hold with `game_key_release`, including failure cleanup.
   When a named input action exists, pass its action name instead of a raw key.
   Named action injection updates Godot's Input action state. Game code tested
   this way should consume `Input.is_action_pressed()` or
   `Input.is_action_just_pressed()`; it must not rely only on `_input()` or
   `_unhandled_input()` events.
   When the game exposes continuous control, prove at least one real
   hold/release path even if debug keys can force success or failure.
   A valid scenario step is an input with tool plus arguments, a wait or
   assert with condition, an observe with tool, or a bare screenshot or
   performance step. For example:

   ```json
   {"name":"baseline","steps":[{"type":"wait","condition":{"condition":"node","nodePath":"/root/Main/Player","timeoutSeconds":2}},{"type":"observe","tool":"game_get_ui"},{"type":"screenshot"}]}
   ```

   Wait on current scene, node, UI, signal, or new log evidence. Never use an old
   log line as a clock. Do not slow or change the game to fit agent response time;
   use bounded engine-side waits, test hooks, or fixed-frame proof instead.
8. Prove ordinary play and requested success/failure transitions with independent
   state plus rendered or log evidence. Use `verify_project` and
   `run_project_tests` where they express the criteria directly.
   Mark each unobserved path as unproved, even if the code seems to implement it.
9. Inspect `get_debug_output` and `game_get_errors`, release held input, call
   `stop_project`, and remove only identified MCP-owned probes or transient files.
   For watched work, leave the editor available to the human and use
   `editor_session` with the disconnect action to hand off the agent connection.

Establish an explicit frame/object/voice budget before high-volume effects. For
external assets, verify source, license, attribution, import, and rendered or
audible use. Distinguish mandatory acceptance gates from conditional polish.
Report passed, failed, blocked, unobserved, warning, fallback, unsupported,
subjective/manual-review, and cleanup results. Never remove a user's addon.
