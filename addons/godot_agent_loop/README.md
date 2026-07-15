# Godot Agent Loop Bridge

An optional Godot 4 editor addon for
[Godot Agent Loop](https://github.com/beremaran/godot-agent-loop). It adds a
dock with authenticated connection status, live and replayed Agent Activity,
human Pause/Resume Agent control, and compatibility diagnostics.

## Install

Install this directory as `addons/godot_agent_loop` in the Godot project, then
enable **Godot Agent Loop** under **Project > Project Settings > Plugins** and
restart the editor once. The **Agent Activity** dock remains present and says it
is waiting while no MCP is connected. Opening Godot normally is the recommended
interactive workflow; `editor_session ensure` discovers it by project.

The addon publishes a private, untracked session record at
`.godot/godot_agent_loop/editor-session.json`. It contains a fresh per-start
token and ephemeral loopback port. Do not copy or commit `.godot/`. The record
is removed on clean editor exit and stale records are rejected by the server.

To uninstall, disable the plugin, close Godot, and remove
`addons/godot_agent_loop`. You may also remove a stale
`.godot/godot_agent_loop` directory while Godot is closed. MCP cleanup never
removes this persistent addon.

If an editor was started before the addon was installed and enabled, restart it
after installation. Godot does not expose a safe public API for loading a new
`EditorPlugin` into an already running editor.

## Human control

Use **Pause Agent** before editing shared project state. Inspection remains
available, while subsequent agent mutations are refused before dispatch. Use
**Resume Agent** to return control. An unsaved scene conflict is preserved and
reported; the addon never reloads over it.

This addon does not install Node.js, an MCP client, or an AI agent. Follow the
client setup in the main project documentation. It is licensed under the MIT
License; see [LICENSE](LICENSE).
