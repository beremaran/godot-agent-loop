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
  allowed directories before mutation. Author project files with normal host
  file tools: `.tscn`, `.gd`, and `project.godot` are plain text. If
  `project.godot` is absent, create the scaffold with the host's file tools. If
  Godot is unavailable, stop without writing anything.
- Record an acceptance contract before choosing nodes: playable loop, controls,
  visible feedback, ordinary state, success/failure transitions, and whether the
  user requested watched or unattended work.
- For watched work, call `editor_session` with ensure and launch enabled and
  route scene edits through `editor_transaction`. Stop with a blocker if a
  matching usable editor cannot be attached or launched; never silently continue
  detached. Unattended work may author directly with host file tools.
- Treat scene, resource, script, and settings edits as persistent authoring.
  Treat `game_*` observations and injected input as runtime-ephemeral and never
  report them as saved project changes.
- Use canonical core tools directly (compact is only the compatibility alias).
  Resolve hidden tools through `godot_catalog` detail, then invoke them with
  `godot_call`; never call a hidden tool directly.
- If the human selects **Pause Agent**, do not retry, route around, or disguise a
  blocked mutation. Preserve state, continue only safe observation or teardown,
  and report the blocked effective tool.
- Action schemas are strict: `editor_session` timeoutSeconds/launchIfNeeded only
  apply to ensure; status/disconnect use only projectPath/action.
  `run_project_tests` discover uses framework/testPaths; `stop_project` takes no
  arguments.

## Workflow

1. Inspect an existing project by reading `project.godot`, the main scene, and
   relevant `.gd` files with the host's file tools, and summarize the structure
   with `analyze_project_integrity` (action=analyze). Identify the main scene,
   input map, persisted hierarchy,
   renderer, and relevant resources.
2. Author one human-readable change per `editor_transaction` (watched) or host
   file edit (unattended). Prefer persisted scene hierarchy and resources; use
   procedural `_ready()` construction only when requested or explicitly
   accepted. Do not hand-write `.tscn` text as a shortcut when an
   `editor_transaction` can make the change. Re-read each edited file after
   authoring and compare it with the planned structure.
3. Use canonical Godot Variant shapes. For example, pass a Vector2 as
   `{ "x": 120, "y": 80 }` and a Color as
   `{ "r": 0.2, "g": 0.7, "b": 1.0, "a": 1.0 }`, not numeric arrays.
4. Put behavior in `.gd` scripts and bind named input actions in `project.godot`
   with the host's file tools. Keep edits minimal and typed; do not duplicate
   logic across files.
5. Run `run_project_tests` discovery or headless GDScript validation,
   then independently re-read changed files before starting the game. Treat this
   as a gate: script validation alone does not prove saved scenes or project
   settings.
6. Start watched gameplay with `run_project`; success means the runtime bridge
   is usable. Observe the baseline with `game_get_scene_tree` capped to the
   nodes needed, `game_get_ui` rooted at the HUD or menu, logs, and
   `game_screenshot`. A connected bridge is not startup proof: inspect startup
   diagnostics and `game_get_errors` at once; stop on SCRIPT ERROR, Parse Error,
   or failed script load. For one node, use `game_get_node_info` with compact
   detail and exact property names; never request its full method and property
   dump for a value you already know by name. If startup output matters, drain
   it with `game_get_logs`; its cursor does not set a later log wait's start
   point.
7. Prefer bounded `game_wait_until` and `game_scenario` steps. Drive held
   movement with a `game_key_hold` step inside one `game_scenario`: hold,
   bounded wait or observation, and release in the same scenario; its teardown
   is the backstop, not the main release. Do not hand-assemble repeated
   `game_key_press` taps to simulate a hold. Never leave a key or action held
   across separate MCP calls. When a named input action exists, pass its action
   name instead of a raw key. Named action injection updates Godot's Input
   action state, so game code should consume `Input.is_action_pressed()` or
   `Input.is_action_just_pressed()`; it must not rely only on `_input()` or
   `_unhandled_input()` events. A scenario step is input plus arguments, a
   wait/assert condition, an observe, or a screenshot/performance step. For
   example:

   ```json
   {"name":"baseline","steps":[{"type":"wait","condition":{"condition":"node","nodePath":"/root/Main/Player","timeoutSeconds":2}},{"type":"observe","tool":"game_get_ui"},{"type":"screenshot"}]}
   ```

   Put input fields inside step arguments, for example
   `{"type":"input","tool":"game_key_hold","arguments":{"action":"move_right"}}`;
   `game_key_hold` has no duration field. In a scenario, wait/assert steps put
   condition directly on the step, not tool `game_wait_until` plus arguments.
   Set fresh=true on a log condition when it must prove an event emitted after
   that wait starts; without it, retained process output may satisfy the
   condition. Keep baseline runtime reads serial to avoid a busy bridge. Before
   input, confirm the game has not advanced past the baseline; restart it if it
   has. Never use an old log line or reasoning time as a clock; use bounded
   engine-side waits, test hooks, or fixed-frame proof instead.
8. Prove ordinary play and requested success/failure transitions with independent
   state plus rendered or log evidence. Use `verify_project` and
   `run_project_tests` where they express the criteria directly. For discovery,
   pass only projectPath/action=discover plus optional framework/test paths; use
   run-only fields only with action=run. Mark each unobserved path as unproved,
   even if the code seems to implement it.
9. Inspect `game_get_logs` and `game_get_errors`, release held input, call
   `stop_project`, and remove only identified MCP-owned probes or transient
   files. For watched work, leave the editor available to the human and use
   `editor_session` with projectPath/action=disconnect to hand off the agent
   connection; do not add timeoutSeconds to that action.

Establish an explicit frame/object/voice budget before high-volume effects. For
external assets, verify source, license, attribution, import, and rendered or
audible use. Distinguish mandatory acceptance gates from conditional polish.
Report passed, failed, blocked, unobserved, warning, fallback, unsupported,
subjective/manual-review, and cleanup results. Never remove a user's addon.
