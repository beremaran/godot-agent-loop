---
name: ship-godot-game
description: Prepare and verify a Godot 4 game for a reproducible release. Use for export readiness, project test gates, .NET/C# verification, addon and import integrity, export artifact inspection, smoke runs, release evidence, or deterministic teardown before shipping.
---

# Ship a Godot game

Treat shipping as an evidence gate. Preserve the project until every requested
target has a reproducible artifact and a recorded independent check.

## Workflow

1. Establish the release boundary.
   - Inspect project settings, the main scene, export presets, enabled addons,
     imported assets, and repository status.
   - Record target platforms, Godot version/build flavor, renderer, .NET needs,
     expected artifact paths, and any signing or export-template prerequisites.
2. Validate source and dependencies.
   - Run `validate_scripts` and `analyze_project_integrity`.
   - Run `manage_import_pipeline` in inspection mode and resolve missing or stale
     imports without deleting source assets.
   - Inspect enabled addons with `manage_addon`; do not update or remove
     user-managed addons unless the user explicitly requests it.
3. Prove project behavior.
   - Discover and run project tests with `run_project_tests`.
   - Use `verify_project` for bounded startup, scene, log, and screenshot
     assertions. Exercise required win, lose, menu, save, or input paths.
   - Inspect `game_get_errors` and debug output, then stop the project.
4. Verify build-specific requirements.
   - Run `verify_dotnet_project` for C# projects and require a successful restore
     and build with the selected Godot .NET version.
   - Use `verify_export_readiness` to check templates, presets, dependencies,
     export output, and supported smoke execution before the final export.
5. Inspect the artifact independently.
   - Confirm the output exists at the expected path, has the expected file type
     and non-zero size, and contains the required sidecar data or pack files.
   - Smoke-run supported local artifacts and compare logs, exit status, and
     visible behavior with the acceptance criteria.
6. Tear down and report.
   - Stop all MCP-owned projects/editors and remove only generated probes,
     temporary exports, screenshots, and logs that are not deliverables.
   - Recheck the project tree and processes. Report exact commands, versions,
     targets, hashes or sizes, assertions, limitations, and any unverified target.

Never claim an unavailable platform, signing identity, export template, or .NET
toolchain passed. Separate locally proven artifacts from CI-only or manual gates.
