---
name: debug-godot-game
description: Diagnose and fix a Godot 4 game that crashes, logs errors, renders incorrectly, ignores input, has wrong scene state, or fails a gameplay expectation. Use for runtime bugs, script failures, broken scenes/resources, flaky behavior, and regressions that need reproduction before repair.
---

# Debug a Godot game

Preserve the failing evidence, isolate one cause, make the smallest repair, and
rerun the original reproduction. Do not begin with speculative edits.

## Workflow

1. Reproduce.
   - Call `run_project` and repeat the user's input with `game_key_press`,
     `game_click`, or the relevant input tool.
   - Capture `get_debug_output`, `game_get_errors`, `game_get_logs`, scene/UI
     state, and a screenshot when rendering is involved.
2. Classify the boundary.
   - Parse/startup: run `validate_scripts` and inspect project/main-scene settings.
   - Saved scene/resource: use `read_scene`, `read_file`, and `manage_resource`
     (discover it through `godot_tools` when hidden).
   - Runtime state: use `game_get_scene_tree`, `game_get_ui`, and
     `game_get_node_info`.
   - Timing/input: use deterministic `game_wait`, then query input or time tools
     through `godot_tools` if needed.
3. Form one falsifiable hypothesis. Gather a second observation that distinguishes
   it from the nearest alternative. Use privileged property/method inspection only
   when the user enabled the `reflection` group; avoid `game_eval` by default.
4. Stop the project before editing persistent files. Apply the minimal fix with
   the matching scene, script, resource, or settings tool.
5. Validate and rerun.
   - Run static validation first.
   - Repeat the exact failing input and observation.
   - Use `verify_project` or `run_project_tests` for stable regression evidence.
   - Confirm errors are gone and adjacent behavior still works.
6. Stop the project and remove temporary probes. Report the root cause, changed
   artifact, reproduction, and independent passing evidence.
