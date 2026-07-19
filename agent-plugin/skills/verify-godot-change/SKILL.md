---
name: verify-godot-change
description: Verify an existing Godot 4 change with static checks and independent runtime evidence. Use to prove saved scenes, scripts, resources, input, UI, rendering, timing, or gameplay without assuming permission to repair failures; do not use for implementation, diagnosis-and-fix, or release preparation.
---

# Verify a Godot change

Translate the requested change into observable criteria, then report what the
evidence proves. Verification alone authorizes observation and bounded test
interaction, not corrective persistent mutation. Fail a criterion unless the
user separately requested a fix. Support begins at Godot 4.7.

## Control contract

- Validate `projectPath` against effective MCP roots and allowed directories
  before any runtime or project access. Snapshot persistent files so verification
  can prove it did not edit them.
- Record watched or unattended mode. For watched work, call `editor_session` with
  `ensure` and launch enabled; stop if no usable editor can be established.
  For unattended verification, do not launch an editor: direct saved-state,
  compound verification, and runtime tools are sufficient and must not rewrite
  project metadata merely to establish a bridge.
- Treat reads as observation, injected input as bounded runtime-ephemeral test
  state, and any scene/resource/script/settings change as unauthorized unless the
  user also requested repair.
- Use canonical core tools directly (`compact` is only the compatibility alias).
  Resolve hidden `analyze_project_integrity`, `game_get_property`, and
  `game_eval` through `godot_catalog` detail, then invoke them with `godot_call`;
  never call a hidden tool directly.
- Respect **Pause Agent** without retry or bypass. While paused, use only safe
  observation, input release, stop, and cleanup; report the blocked effective tool.
- Use privileged reflection or evaluation only when already enabled, necessary
  for a criterion, and independently corroborated. Never enable it for convenience.

## Workflow

1. Define applicable saved-state, runtime, rendered, timing, log/error,
   regression, and subjective/manual-review criteria. Mark non-applicable and
   unobservable criteria explicitly.
2. Check saved state first with `validate_script`, `validate_scripts`,
   `read_scene`, `read_project_settings`, or `read_file`. Use concise reads and
   hidden integrity analysis only through the declared discovery flow.
3. Prefer `verify_project` and `run_project_tests`; use realtime `run_project`
   only for behavior the compound tools cannot prove.
4. Observe a baseline with capped `game_get_scene_tree`, subtree-filtered
   `game_get_ui`, logs, and `game_screenshot` where rendering is material. Use
   `game_get_node_info` with compact detail and exact property names.
5. Prefer bounded `game_wait_until` and `game_scenario`. Use `game_key_press` for
   a one-frame tap, `game_key_hold` for continuous input, and always pair holds
   with `game_key_release`, including failure cleanup. Keep hold, bounded wait or
   observation, and release in one scenario. Never leave input held while making
   a separate observation call or while reasoning. Use `game_click` only when
   coordinate interaction is part of the criterion.
6. Repeat the same observation and compare the intended state. A successful tool
   response or screenshot alone does not prove behavior, audio quality, feel, or
   aesthetics.
7. Check negative evidence: `game_get_errors`, `get_debug_output`, warnings,
   fallbacks, ObjectDB/orphan/resource diagnostics, leaks, cleanup, and adjacent
   regressions. Re-hash persistent files to prove verification made no edit.
8. Release held input, call `stop_project`, and independently confirm teardown.

Report each criterion as passed, failed, incomplete/unobserved, subjective/manual,
blocked, or unsupported, with exact evidence. Disclose warnings and fallbacks;
never infer success from an unavailable observation or silently repair a failure.
