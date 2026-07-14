# Agent adapter acceptance record

Verified locally on 2026-07-14 with Godot 4.7, Node.js 24.13.0, Claude Code
2.1.208, Codex CLI 0.144.1, OpenCode 1.17.13, and Pi 0.80.2.

## Automated MCP path

`tests/e2e/agent-adapter-smoke.test.ts` exercises the generated Claude Code,
Codex, OpenCode, and Pi paths against the built server. Each adapter:

1. completes the MCP initialization handshake;
2. receives exactly 39 default tools;
3. calls `get_godot_version` against the real Godot binary;
4. finds hidden `game_light_3d` through `godot_tools`; and
5. closes its MCP client and child process.

The Pi case loads the shipped TypeScript extension through a fake Pi lifecycle,
then uses its dynamically registered tools. This proves Pi does not statically
register the 167-tool catalog and that `session_shutdown` closes the stdio
client.

## Native client packaging

All native checks used temporary client homes; no real user configuration was
changed.

- Claude Code validated the repository marketplace and neutral plugin, then
  installed and enabled `godot-agent-loop@godot-agent-loop` from the isolated
  local marketplace.
- Codex added the isolated repository marketplace, installed version 1.0.0 into
  its cache, and reported the plugin enabled with the local source path.
- OpenCode ran the built `setup opencode --write`, resolved the generated MCP
  entry, and returned all four canonical skills from `opencode debug skill`.
- Pi installed and listed the local package, then started its native interactive
  surface with telemetry and network access disabled. Startup exposed all four
  canonical skills and reported `Godot Agent Loop connected (39 tools)`.
  `/reload` shut down and recreated the extension runtime, then reported the
  same 39-tool connection and skill inventory. `pi update <local-source>`
  reconciled the package. `pi config` disabled and re-enabled the MCP extension
  through Pi's native package filter while leaving the four skills available.
  Removal left an empty package list and no Godot Agent Loop server process.
  The automated MCP case separately exercises a real tool call, hidden-tool
  discovery, and structured result forwarding through the extension.

The exact candidate npm tarball was also installed into an empty npm project.
Its binary ran without checkout dependencies, previewed/applied/uninstalled the
OpenCode adapter, exposed all four skills through native OpenCode discovery, and
installed/listed/loaded/removed in Pi from the dependency-complete npm-installed
package tree. Pi does not load a raw `.tgz` path directly; the public `npm:` path
performs that installation step. This check caught and fixed a missing runtime
declaration for `pngjs` before the candidate was accepted.

## Publication-dependent cases

The exact `npx -y @beremaran/godot-agent-loop@1.0.0` command cannot resolve from
the public npm registry until publication is approved and complete. Likewise,
Git/npm installs from the selected new repository, a candidate tag, ChatGPT
desktop cache pickup, and update behavior against those public sources remain
release-gated. They must be rerun from the exact candidate tag and again from
the public artifacts.
