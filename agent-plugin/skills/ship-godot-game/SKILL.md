---
name: ship-godot-game
description: Prepare and gate a reproducible Godot 4 release. Use for export readiness, test gates, .NET/C# checks, addon/import integrity, artifact inspection, smoke runs, signing or platform blockers, and release evidence; do not use for greenfield feature work or an isolated bug fix.
---

# Ship a Godot game

Treat shipping as an evidence gate. Preserve the project and release artifacts;
never turn an unavailable platform, signing identity, export template, SDK,
toolchain, or target device into a passing claim. Support begins at Godot 4.7.

## Control contract

- Validate `projectPath`, artifact destinations, and local sources against the
  effective MCP roots and allowed directories before access or mutation.
- Record whether release verification is watched or unattended. For watched work,
  call `editor_session` with `ensure` and launch enabled; stop if a usable editor
  cannot be established rather than silently continuing detached.
  For unattended release work, do not launch an editor; use direct and hidden
  inspection/runtime tools so readiness checks do not alter project metadata.
- Keep inspection read-only until the user authorizes a repair, export, signing,
  addon/import change, or other release mutation. Distinguish persistent project
  changes, runtime-ephemeral playtest state, process lifecycle, and deliverables.
- Use canonical core tools directly (`compact` is only the compatibility alias).
  Resolve hidden `list_project_files`, `analyze_project_integrity`,
  `manage_import_pipeline`, `manage_addon`, `manage_export_presets`,
  `verify_dotnet_project`, `verify_export_readiness`, and `export_project`
  through `godot_catalog` detail, then invoke them with `godot_call`; never call
  a hidden tool directly.
- The wrapper field is exactly toolName, not name or tool. Use
  `godot_catalog` like this:

      { "action": "describe", "toolName": "verify_export_readiness", "detail": "full" }

  Then dispatch through `godot_call` like this:

      { "toolName": "verify_export_readiness", "arguments": { "projectPath": "...", "action": "inspect", "presetName": "Local Eval" } }
- Respect **Pause Agent** without retry or bypass. While paused, retain inspection,
  input release, stop, and cleanup; report any blocked effective mutation.
- Use privileged reflection or evaluation only when already enabled and necessary
  for a release criterion. Never enable it to manufacture missing evidence.

## Workflow

1. Build a release matrix: targets, Godot version/build flavor, renderer, .NET,
   presets, templates, signing, expected outputs, and whether each gate is local,
   CI, target-hardware, or manual.
2. Inspect settings, main scene, files, export presets, addons, imports, and
   repository state through read-only direct or hidden actions. Pass a real
   sourcePath to manage_import_pipeline inspect, a real pluginName to
   manage_addon inspect, and call .NET checks only when a C# project exists.
3. Run `validate_scripts`, hidden integrity/import/addon/.NET readiness checks,
   and project tests. Do not repair a failed gate without explicit authorization.
4. Require representative gameplay proof with `verify_project` before export.
   Use bounded `game_scenario` and `game_wait_until` where needed. Use
   `game_key_press` for a one-frame tap, `game_key_hold` for continuous input,
   and always pair holds with `game_key_release`, including failure cleanup.
   Keep each hold, bounded wait or observation, and release in one scenario;
   never leave input held across separate MCP calls or while reasoning.
5. Inspect `game_get_errors`, `get_debug_output`, warnings, metric availability,
   leaks, and teardown; call `stop_project` before artifact production.
6. For each authorized target, run readiness before export. Keep unavailable or
   signing-dependent targets blocked instead of weakening the matrix. Describe
   export_project first, then pass its required outputPath; do not invent a
   release flag.
7. Inspect every produced artifact independently: expected path, file type,
   non-zero size, sidecar or pack files, hash, logs, exit status, and supported
   local smoke-run behavior. Do not treat the export response as artifact proof.
8. Remove only identified generated probes, temporary exports, screenshots,
   logs, and MCP-owned transient files that are not deliverables. Preserve user
   addons, source assets, release artifacts, and foreign files.

Return a concise release verdict with passed, failed, blocked, manual, and
unsupported gates; exact versions, targets, hashes/sizes, fallbacks, warnings,
subjective gaps, and cleanup state. Separate locally proven artifacts from CI,
signing, store, device, and human-review requirements.
