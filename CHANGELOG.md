# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-07-14

First release under the independent `@beremaran/godot-agent-loop` product
identity. Full release notes: [`docs/releases/1.0.0.md`](docs/releases/1.0.0.md).

### Added

- Evidence-first MCP automation loop for Godot 4 with 167 tools exercised
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

[Unreleased]: https://github.com/beremaran/godot-agent-loop/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/beremaran/godot-agent-loop/releases/tag/v1.0.0
