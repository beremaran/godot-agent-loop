---
name: verify-godot-change
description: Verify a Godot 4 project change with static checks and independent evidence from the running game. Use after editing scenes, scripts, resources, input, UI, rendering, or gameplay, and when deciding whether a Godot task is genuinely complete.
---

# Verify a Godot change

Turn the requested behavior into observable acceptance criteria before running
the game. A successful mutation response is not evidence that the change works.

Godot Agent Loop supports Godot 4.7 or later. Report verification on an older
engine as outside the supported boundary.

## Workflow

1. Check saved state.
   - Use `validate_script` or `validate_scripts` for code.
   - Use `read_scene`, `read_project_settings`, or `read_file` to confirm the
     intended artifact persisted.
   - Run `analyze_project_integrity` when scene structure changed. Flag a trivial
     scripted main scene unless procedural construction is an explicit design.
2. Prefer compound verification.
   - Use `verify_project` for bounded startup, node/group/log assertions,
     optional screenshot evidence, and deterministic teardown.
   - Use `run_project_tests` with `discover` before `run` when tests exist.
   - Prefer `game_wait_until` and `game_scenario` for bounded interaction evidence
     rather than assembling short polling loops.
3. Exercise interactive behavior when a compound assertion is insufficient.
   - Call realtime `run_project` for behavior a person watches, then observe the baseline with `game_get_scene_tree`,
     `game_get_ui`, `game_get_node_info`, and/or `game_screenshot`.
   - Inject input with `game_key_press`, `game_click`, or a specialized input tool
     discovered through `godot_tools`.
   - Wait only as long as the behavior requires with `game_wait_until`, then make the
     same observation again and compare the changed state.
4. Check negative evidence.
   - Inspect `game_get_errors`, `get_debug_output`, and relevant logs.
   - Verify unrelated state still works when the change has regression risk.
   - Treat warnings, ObjectDB leaks, orphan/resource diagnostics, bridge cleanup
     failures, fallbacks, and unavailable metrics as evidence to resolve or
     disclose, even when the positive assertion passes.
5. Stop the project and report the exact assertions and evidence. If any
   acceptance criterion remains unobserved, say verification is incomplete.

Separate objective evidence (persisted values, node state, logs, timing,
rendered pixels) from subjective review (feel, audio quality, composition, and
polish). A structural check or screenshot proves neither aesthetics nor sound;
label those as manual review when no human judgment was obtained.

Use privileged reflection only when the required group is already enabled; do
not replace observable gameplay evidence with `game_eval`.
