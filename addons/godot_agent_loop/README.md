# Godot Agent Loop Bridge

An optional Godot 4 editor addon for
[Godot Agent Loop](https://github.com/beremaran/godot-agent-loop). It adds a
dock with authenticated connection status, live Agent Activity, human
Pause/Resume Agent control, protocol and Godot compatibility diagnostics, and
setup help for Claude Code, Codex, OpenCode, and Pi.

## Install

Copy `addons/godot_agent_loop/` into a Godot project, then enable **Godot Agent
Loop Bridge** under **Project > Project Settings > Plugins**. Installing the
addon is optional: the external MCP package creates and removes a transient
bridge when this persistent addon is absent.

The addon listens only on loopback. It accepts commands only after a secret
authenticated protocol handshake from an editor launched through Godot Agent
Loop. A normally launched editor shows setup diagnostics but does not accept
agent commands.

## Human control

Use **Pause Agent** before editing shared project state. Inspection remains
available, while subsequent agent mutations are refused before dispatch. Use
**Resume Agent** to return control.

This addon does not install Node.js, an MCP client, or an AI agent. Follow the
client setup in the main project documentation, then use `launch_editor` so the
bridge receives its per-session authentication secret.

Licensed under the MIT License; see [LICENSE](LICENSE).
