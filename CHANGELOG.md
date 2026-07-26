# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/beremaran/godot-agent-loop/compare/v1.1.3...HEAD
[1.1.3]: https://github.com/beremaran/godot-agent-loop/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/beremaran/godot-agent-loop/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/beremaran/godot-agent-loop/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/beremaran/godot-agent-loop/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/beremaran/godot-agent-loop/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/beremaran/godot-agent-loop/releases/tag/v1.0.0
