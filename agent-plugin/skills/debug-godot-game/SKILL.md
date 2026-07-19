---
name: debug-godot-game
description: Diagnose and repair a reproducible Godot 4 failure. Use for crashes, errors, broken scenes/resources, wrong runtime state, input/timing, rendering, audio, export, toolchain, flaky behavior, or regressions; do not use for greenfield builds, proof-only review, or release gating.
---

# Debug a Godot game

Preserve the failure, isolate one cause, apply the smallest repair, and rerun the
same reproduction. Godot Agent Loop supports Godot 4.7 or later; report older
engine behavior as outside the supported boundary.

## Control contract

- Validate `projectPath` against effective MCP roots and allowed directories
  before mutation. Preserve a reproducible baseline and changed-file snapshot.
- Record whether the user requested watched or unattended work. For watched work,
  call `editor_session` with `ensure` and launch enabled; stop if a usable editor
  cannot be established instead of silently continuing detached.
- Distinguish persistent scene/resource/script/settings repair from
  runtime-ephemeral observation or mutation. Stop the runtime before persistent repair
  unless an editor-native operation is explicitly safe during play and record why.
- Use canonical core tools directly (`compact` is only the compatibility alias).
  Resolve hidden `manage_resource`, `game_get_property`, `game_call_method`, and
  `game_eval` through `godot_catalog` detail, then invoke them with `godot_call`;
  never call a hidden tool directly.
- If **Pause Agent** blocks a mutation, do not retry or bypass it. Continue only
  observation or safe teardown and report the effective blocked tool.
- Use privileged reflection or evaluation only when its group is already enabled,
  the hypothesis requires it, and safer observations cannot distinguish the cause.

## Workflow

1. Reproduce before editing. Use realtime `run_project` for visual or timing
   complaints and repeat the user's exact input or a bounded `game_scenario`.
2. Capture the minimum distinguishing evidence: cursor-bounded
   `get_debug_output`, `game_get_errors`, `game_get_logs`, concise scene/UI/node
   state, and `game_screenshot` only when rendering matters.
3. Classify the failing boundary: parse/startup, persistent scene/resource,
   import, runtime state, input/timing, rendering, audio, export, or
   platform/toolchain.
4. State one falsifiable hypothesis and one observation that distinguishes it
   from the nearest alternative. Change one independent variable per trial; do
   not disable multiple systems and infer a single cause.
5. For input, use `game_key_press` only for a one-frame tap. Use
   `game_key_hold` for continuous movement and always call `game_key_release` in
   normal and failure cleanup. Keep hold, bounded wait or observation, and
   release in one `game_scenario`. Never leave input held across a separate MCP
   call or while reasoning. Use bounded `game_wait_until`, never manual sleeps.
6. Stop the project before persistent repair. Apply the smallest matching scene,
   script, resource, or setting change as one coherent undoable change.
7. Run static validation before runtime proof. Repeat the exact baseline,
   stress/recovery input, and observation; then run adjacent regression checks
   with `verify_project` or `run_project_tests`.
8. Separate measured FPS/frame time/process/render data from unavailable GPU
   metrics and subjective reports of feel. Do not substitute simulation counters
   for displayed frame pacing.
9. Release held input, call `stop_project`, remove only identified probes and
   MCP-owned transient artifacts, and independently check cleanup.

Report root cause, hypothesis, isolated variable, changed artifact, exact
reproduction, passing and negative evidence, warnings/errors/leaks, fallbacks,
blocked or unsupported metrics, subjective gaps, and teardown. Never remove a
user's addon or broaden a repair beyond the causal artifact.
