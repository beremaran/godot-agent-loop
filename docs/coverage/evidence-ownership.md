# Authoring evidence ownership

The real-engine authoring coverage is split into two intentional tiers so the
same behavior is not proven at every layer. One layer owns each seam; a change
to an implementation detail should require updating exactly one suite per
observable contract.

## Tiers

| Layer | Suites | Owns |
| --- | --- | --- |
| Raw engine (`integration`) | `tests/godot/run-headless-operations.sh`, `tests/godot/run-validate-script.sh` | Direct operation parsing and the exit-status contract `HeadlessOperationService` relies on; engine diagnostics (clean logs, no probe files); engine-specific invariants (resource-typed property conversion, addressable duplicate naming, move-with-descendants, byte-identical rejected edits, valid reloads); the windowless persistent authoring session and its rendering-context precondition; one representative positive per operation family so a direct-invocation regression is caught at the engine seam. |
| MCP transport (`e2e`) | `tests/e2e/headless-tools.test.ts`, `tests/e2e/project-config-tools.test.ts` | Transport, tool dispatch, argument validation, structured responses, persistence through the public boundary, parameter-family breadth, repeatability, exotic project paths, teardown, and cleanup. The authoritative owner of positive behavior breadth. |
| Acceptance (`e2e`) | `tests/e2e/golden-agent-game.test.ts` | The deterministic cold-agent game-build replay. Runs on the Monday schedule, release tag pushes, explicit `workflow_dispatch`, and the Sunday full compatibility pass — not on ordinary pull requests. See `docs/golden-agent-acceptance.md`. |

## Authoring family matrix

| Family | Raw layer retains | E2E layer owns (duplicates removed from raw) |
| --- | --- | --- |
| Scene creation/editing (`create_scene`, `add_node`, `modify_scene_node`, `load_sprite`, `attach_script`, `save_scene`) | One positive per operation on the shared fixture scene, plus the `29bf0b2` invariants | Default/explicit root types, structured property conversion, persistence verified by project files and engine reload, in-place saves, copy reloads, missing-target failures |
| Scene structure (`manage_scene_structure`, `remove_scene_node`) | One representative rename and remove with persistence; duplicate and move live under the `29bf0b2` invariants | Rename/duplicate/move chains with reload verification, unknown/root/cyclic-action failures, root-removal refusal |
| Scene signals (`manage_scene_signals`) | The list → add → list → remove → list cycle | Same cycle with persistence text checks and structured payloads |
| Resources (`create_resource`, `manage_resource`, `manage_theme_resource`) | One create/read/modify cycle per operation | Same cycles plus failure classification (`Unknown resource type`, unknown actions, missing files) |
| MeshLibrary export (`export_mesh_library`) | One 3D-scene → mesh → export pass | Multi-item export with `meshItemNames` selection and exclusion |
| UIDs (`get_uid`, `update_project_uids`) | Sidecar-deleted resave proves UID *generation* | Missing-then-generated UID reports and out-of-contract failures |
| Script validation (`validate_script`) | Authoritative: multiple-autoload resolution and fresh real compile after a source rewrite (`run-validate-script.sh`) | Structured error payloads (file/line) through the public boundary, single-autoload fresh compile, non-GDScript and absent-file rejections, `validate_scripts` scopes |

## Rules for future changes

- Add positive parameter-family breadth to `tests/e2e/headless-tools.test.ts`,
  not to `run-headless-operations.sh`; each raw positive exists to prove direct
  invocation, not breadth.
- Add engine invariants and diagnostics to `run-headless-operations.sh`; they
  cannot be observed through the MCP boundary.
- Before removing an assertion, map it to a retained assertion in the tier that
  owns its contract. The inventory in `tool-coverage.json` verifies every
  retained reference mechanically.
