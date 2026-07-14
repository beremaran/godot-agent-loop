---
name: verify-godot-change
description: Verify a Godot 4 project change with static checks and independent evidence from the running game. Use after editing scenes, scripts, resources, input, UI, rendering, or gameplay, and when deciding whether a Godot task is genuinely complete.
---

# Verify a Godot change

Turn the requested behavior into observable acceptance criteria before running
the game. A successful mutation response is not evidence that the change works.

## Workflow

1. Check saved state.
   - Use `validate_script` or `validate_scripts` for code.
   - Use `read_scene`, `read_project_settings`, or `read_file` to confirm the
     intended artifact persisted.
2. Prefer compound verification.
   - Use `verify_project` for bounded startup, node/group/log assertions,
     optional screenshot evidence, and deterministic teardown.
   - Use `run_project_tests` with `discover` before `run` when tests exist.
3. Exercise interactive behavior when a compound assertion is insufficient.
   - Call `run_project`, then observe the baseline with `game_get_scene_tree`,
     `game_get_ui`, `game_get_node_info`, and/or `game_screenshot`.
   - Inject input with `game_key_press`, `game_click`, or a specialized input tool
     discovered through `godot_tools`.
   - Wait only as long as the behavior requires with `game_wait`, then make the
     same observation again and compare the changed state.
4. Check negative evidence.
   - Inspect `game_get_errors`, `get_debug_output`, and relevant logs.
   - Verify unrelated state still works when the change has regression risk.
5. Stop the project and report the exact assertions and evidence. If any
   acceptance criterion remains unobserved, say verification is incomplete.

Use privileged reflection only when the required group is already enabled; do
not replace observable gameplay evidence with `game_eval`.
