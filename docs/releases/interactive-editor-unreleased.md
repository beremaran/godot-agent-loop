# Interactive editor attachment (unreleased)

This development release adds protocol 2 per-project editor discovery, secure
late attachment, an idempotent `editor_session` contract, acknowledged external
synchronization, compound editor transactions, trace replay, realtime versus
deterministic timing policies, bounded waits/scenarios, and richer screenshot
and performance evidence.

Protocol 1 persistent editor addons must be replaced and Godot restarted. The
runtime protocol remains version 1. Persistent addon installation is optional;
detached authoring and CI remain supported.

The full real-engine matrix now covers the Linux headed/Xvfb release path. A
headed macOS 4.7.1 replay also opened Godot normally, restarted the MCP while
the editor stayed open, applied editor-native and acknowledged file-backed
changes, and observed them without a focus switch or manual reload. Its bounded
machine-readable evidence is in
[`../coverage/interactive-golden-agent-run.json`](../coverage/interactive-golden-agent-run.json).
Windows remains limited to the portable acceptance suite; Windows editor UI,
rendering, and export behavior are not claimed by this release.
