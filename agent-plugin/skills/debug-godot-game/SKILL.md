---
name: debug-godot-game
description: Diagnose and fix a Godot 4 game that crashes, logs errors, renders incorrectly, ignores input, has wrong scene state, or fails a gameplay expectation. Use for runtime bugs, script failures, broken scenes/resources, flaky behavior, and regressions that need reproduction before repair.
---

# Debug a Godot game

Preserve the failing evidence, isolate one cause, make the smallest repair, and
rerun the original reproduction. Do not begin with speculative edits.

## Workflow

1. Reproduce.
   - Call realtime `run_project` for visual/timing complaints. Capture a
     baseline, then repeat the user's exact input or bounded `game_scenario`.
   - Capture `get_debug_output`, `game_get_errors`, `game_get_logs`, scene/UI
     state, and a screenshot when rendering is involved.
2. Classify the boundary.
   - Parse/startup: run `validate_scripts` and inspect project/main-scene settings.
   - Saved scene/resource: use `read_scene`, `read_file`, and `manage_resource`
     (discover it through `godot_tools` when hidden).
   - Runtime state: use `game_get_scene_tree`, `game_get_ui`, and
     `game_get_node_info`.
   - Timing/input: use `game_wait_until`; use deterministic waits only for
     repeatable simulation checks, not as evidence of displayed frame pacing.
3. Form one falsifiable hypothesis. Gather a second observation that distinguishes
   it from the nearest alternative. Use privileged property/method inspection only
   when the user enabled the `reflection` group; avoid `game_eval` by default.
   - Change one independent variable per trial and rerun the same stress path.
     Never infer one cause after disabling particles, shockwaves, audio, camera
     shake, and other systems together.
   - Test camera shake and any persistent per-frame effect independently.
   - For a visual freeze or stutter, collect realtime FPS/frame-time and
     process/render/GPU availability. Simulation counters alone are insufficient;
     report GPU time as unavailable when the platform does not expose it.
4. Stop the project before editing persistent files. Apply the minimal fix with
   the matching scene, script, resource, or settings tool.
5. Validate and rerun.
   - Run static validation first.
   - Repeat the exact baseline/stress/recovery input and observation.
   - Use `verify_project` or `run_project_tests` for stable regression evidence.
   - Confirm errors are gone and adjacent behavior still works.
6. Stop the project and remove temporary probes and MCP-owned transient bridge
   artifacts. Report the root cause, isolated variable, changed artifact,
   reproduction, independent passing evidence, every warning/error/ObjectDB or
   orphan diagnostic, cleanup result, fallback, and unsupported metric. Never
   remove a user's persistent addon.
