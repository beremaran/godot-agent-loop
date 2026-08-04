# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.0] - 2026-08-04

### BREAKING

- **Lean tool-surface reduction.** The catalog shrinks from 173 tools to 64:
  109 tools are removed (70 subsystem runtime wrappers, 38 project
  file/authoring/settings/CI tools, and the deprecated `godot_tools` alias).
  The advertised `core` surface is now 20 tools — `godot_catalog`,
  `godot_call`, `get_project_info`, `get_godot_version`, `run_project`,
  `stop_project`, `get_debug_output`, `editor_session`, `editor_transaction`,
  `game_screenshot`, `game_get_scene_tree`, `game_get_ui`, `game_get_node_info`,
  `game_get_errors`, `game_get_logs`, `game_scenario`, `game_wait_until`,
  `validate_scripts`, `run_project_tests`, and `verify_project` — at 32,787
  bytes / ~8,197 estimated tokens, a 92.39% reduction against the full 64-tool
  surface (430,774 bytes / ~107,694 estimated tokens). A tool earns its place
  only if it does something file editing plus shell cannot, and the product is
  the feedback loop: author files → validate → run → observe → interact →
  assert.
- Remove the `GODOT_MCP_AUTHORING_MODE` environment variable (host file tools
  and watched-mode `editor_transaction` replace the persistent authoring
  session) and the `benchmark:loop` npm script.
- Migration: author `.gd`/`.tscn`/`.tres`/`project.godot` with the coding
  agent's own file tools; use `editor_transaction` in watched mode; reach the
  44 hidden tools via `godot_catalog` + `godot_call`; opted-in agents use the
  privileged `reflection`/`code-execution` generics in place of the deleted
  subsystem runtime wrappers. Clients still calling `godot_tools` receive an
  unknown-tool error and must switch to `godot_catalog`/`godot_call`.

## [1.2.0] - 2026-08-03

### Editor

- Route project.godot mutations through the attached editor bridge while an
  editor session is connected: `modify_project_settings`, `set_main_scene`, and
  `manage_input_map` add/remove now apply through `ProjectSettings` inside the
  editor and persist with the editor's own save, so the editor never reports
  `project.godot` as modified on disk and no "reload from disk?" prompt appears
  while the agent works.
- Add the additive `project_settings` editor bridge command. The addon decodes
  each JSON entry, preserves the existing setting's Variant type, merges
  `InputEventKey` events into the in-memory input action with physical keycode
  deduplication, and erases settings with a null value. Editor protocol `2` is
  unchanged; addons that predate the command fall back to the declared
  file-backed implementation.

## [1.1.6] - 2026-08-02

### Authoring

- Spawn the persistent authoring session with Godot's `--headless` flag so MCP
  authoring no longer leaves a visible `<project> (DEBUG)` helper window open
  for the server's lifetime (#29). Authoring operations are pure
  scene/resource manipulation and never required a rendering context, so the
  session is now windowless by design.

### Input

- Map `game_mouse_move` relative deltas from the schema-declared
  `relative_x`/`relative_y` arguments instead of dropped camelCase names, so
  synthetic mouse motion delivers the caller's movement to the game.
- Flush synthetic mouse motion immediately while input accumulation is
  disabled, so a buffered OS event cannot merge with and transform the
  caller-supplied deltas.

### Developer Experience

- Make the pre-commit hook a fast gate (`npm run check:fast`: lint plus a
  no-emit TypeScript check) instead of the multi-minute `npm run check`, and
  keep the full gate for CI and release validation.
- Let `npm run coverage:engine -- --check` skip with a warning instead of
  failing when `GODOT_BIN` is unset, so environment absence no longer rejects
  commits or local checks.
- Reduce the automated suite from 1,041 runnable Vitest cases to 83 focused
  smoke cases: 60 unit/contract cases and 23 real-engine E2E cases. The retained
  paths cover server startup, registry/schema parity, authoring and editor
  connections, process ownership, adapters, and cross-platform execution.
- Remove the obsolete per-tool coverage inventory, direct Godot runners, and
  deterministic golden replay. `npm run check` now runs lint, one build, and the
  retained unit suite; release validation reuses its own build.

### E2E stability

- Stabilize Godot input and resource fixtures, share MCP servers across E2E
  cases, and measure per-server startup overhead.

## [1.1.5] - 2026-08-01

### Evaluations

- Add a layered MCP qualification framework covering protocol, tool, engine, and
  agent workflow evidence, with pinned Inspect AI tooling, deterministic
  scorers, and comparison reports.
- Add release and CI checks for evaluation corpus integrity, tool coverage,
  transport equivalence, and Godot compatibility.
- Keep paid behavioural evaluation as an explicit opt-in workflow rather than a
  requirement for npm publication.

### Reliability

- Retry editor pause-state checks so transient editor bridge disconnects do not
  spuriously refuse agent mutations.
- Retarget project symlinks before updating them to avoid escape races during
  macOS path canonicalization.

## [1.1.4] - 2026-07-26

### Validation and startup clarity

- Reject fatal Godot startup errors earlier during validation and clarify
  project validation and status messaging to reduce ambiguous failures.
- Bound game observations and enforce safe input handling, including held-input
  and unprivileged property waits.
- Prevent scene-root name collisions and tighten scenario argument validation.
- Keep output stable when runtime reflection is unavailable.
- Omit transient bridge files from project scans only when ownership is clear,
  so user files remain visible.
- Improve structured output compatibility and project setting handling.

## [1.1.3] - 2026-07-19

### Headless authoring and compatibility

- Add `GODOT_MCP_AUTHORING_MODE=headless` for scene and resource authoring
  without a persistent helper window; `persistent` remains the default.
- Add a scheduled compatibility check for new stable Godot 4 releases, with
  known-good comparison and issue reporting for confirmed regressions.

### Audit and policy fixes

- Exclude only byte-proven, MCP-owned transient bridge files from project
  integrity scans and whole-project script validation.
- Fail property waits and scenario property assertions at once when the runtime
  lacks reflection access, with clear opt-in and log or UI fallbacks.

## [1.1.2] - 2026-07-17

### Testing

- Increase the agent package layout test timeout so the release gate remains
  stable on slower verification environments.

## [1.1.1] - 2026-07-16

### Packaging

- Keep the generated Godot extension API audit cache outside the shipped
  `build/` tree so npm publication produces the same bounded package contents
  as the deterministic release candidate.

## [1.1.0] - 2026-07-16

### Editor-native workflow

- Add secure, persistent editor-native attachment with per-project discovery,
  acknowledged external synchronization, compound transactions, and trace
  replay.
- Add an idempotent `editor_session` lifecycle contract plus bounded waits,
  scenarios, and richer screenshot and performance evidence.

### Compatibility

- Raise the supported Godot compatibility floor to 4.7 across the editor addon,
  generated projects, .NET defaults, export generators, CI, and agent workflows.
- Require protocol 1 persistent editor addons to be replaced and Godot to be
  restarted; detached authoring and CI remain supported.

## [1.0.1] - 2026-07-15

### Fixed

- Canonicalize macOS project paths before listing files or validating scripts,
  including `/var` to `/private/var` aliases, while preventing symlink retarget
  races from escaping configured project roots.
- Make headed-editor process evidence and WebSocket fixture teardown portable
  across Linux, macOS, and Windows verification environments.
- Keep patch-level Godot engine audits reproducible when the complete generated
  API surface is identical to the checked-in baseline.

### Changed

- Run export inspection, classification, and path-security coverage on every
  supported host while retaining real Linux artifact execution in its dedicated
  export-template job.
- Refine product documentation, tool discovery guidance, and repository
  community-health files.

## [1.0.0] - 2026-07-14

First release under the independent `@beremaran/godot-agent-loop` product
identity. Full release notes: [`docs/releases/1.0.0.md`](docs/releases/1.0.0.md).

### Added

- MCP automation loop for Godot 4 with 167 tools exercised
  through the complete MCP-to-Godot path and 358 traced public actions.
- Compact 39-tool default surface (81.56% smaller by schema bytes) with the full
  catalog reachable through the `godot_tools` meta-tool.
- Persistent and transient editor bridges with an authenticated protocol and a
  human **Pause Agent** control; user-managed addons are never overwritten.
- Client-neutral `agent-plugin/` bundle carrying MCP configuration and canonical
  build/debug/verify/ship workflows for Claude Code, Codex, OpenCode, and Pi.
- C# / .NET project support, GDScript diagnostics, project testing,
  import/addon integrity checks, export readiness, and deterministic
  verification workflows.
- Deterministic golden-agent acceptance: a cold agent built and independently
  verified a playable win/lose game from an empty directory with zero human
  corrections.

### Security

- Reflection, code-execution, and networking privilege groups are denied by
  default and must be opted into explicitly.
- Runtime connections are authenticated with a per-session secret; transports
  bind to loopback and retained logs are bounded and redacted.

[Unreleased]: https://github.com/beremaran/godot-agent-loop/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/beremaran/godot-agent-loop/compare/v1.1.6...v2.0.0
[1.1.6]: https://github.com/beremaran/godot-agent-loop/compare/v1.1.5...v1.1.6
[1.1.5]: https://github.com/beremaran/godot-agent-loop/compare/v1.1.4...v1.1.5
[1.1.4]: https://github.com/beremaran/godot-agent-loop/compare/v1.1.3...v1.1.4
[1.1.3]: https://github.com/beremaran/godot-agent-loop/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/beremaran/godot-agent-loop/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/beremaran/godot-agent-loop/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/beremaran/godot-agent-loop/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/beremaran/godot-agent-loop/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/beremaran/godot-agent-loop/releases/tag/v1.0.0
