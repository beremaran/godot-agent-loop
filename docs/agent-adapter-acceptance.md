# Agent adapter acceptance record

Current automated contracts are described first. Native-client and public-source
records below are historical evidence from 2026-07-14 through 2026-07-15 and
retain the tool counts and versions observed at that time.

## Automated MCP path

`tests/agent-plugin.test.ts` validates the generated Claude Code, Codex,
OpenCode, and Pi metadata. `tests/e2e/agent-adapter-smoke.test.ts` then exercises
the shared MCP configuration contract and the real Pi forwarding path against
the built server. The current contract:

1. completes the MCP initialization handshake;
2. receives the generated `core` surface rather than a hand-maintained count;
3. calls `get_godot_version` against the real Godot binary;
4. finds hidden `game_light_3d` through read-only `godot_catalog` detail and
   invokes hidden tools only through `godot_call`;
5. closes its MCP client and child process.

The Pi case loads the shipped TypeScript extension through a fake Pi lifecycle,
then uses its dynamically registered tools. This proves Pi does not statically
register the full catalog and that `session_shutdown` closes the stdio client.
Adapter compatibility smoke covers canonical `core` plus the `compact` alias;
`tests/e2e/progressive-disclosure.test.ts` separately proves that an old client
can still call unadvertised `godot_tools search`, `describe`, and `call` on the
core server during the 1.x migration window.

`tests/agent-package-layout.test.ts` creates and extracts an npm archive with
lifecycle scripts disabled, proves that all four canonical skills, OpenAI
interfaces, and Claude/Codex/MCP/Pi adapter files are byte-identical, then runs
the packed OpenCode installer and checks its installed inventory and `core`
environment. Evaluation automation is registered separately from external
cold-model status, which remains explicitly `not_run` until a deliberate model
execution is recorded.

## Historical native client packaging

All native checks used temporary client homes; no real user configuration was
changed.

- Claude Code validated the repository marketplace and neutral plugin, then
  installed and enabled `godot-agent-loop@godot-agent-loop` from the isolated
  local marketplace. Its native `--plugin-dir` details command resolves inline
  version 1.0.0 with the four canonical skills and one bundled MCP server.
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

## Historical public-source acceptance

Public signed tag `v1.0.0` was cloned and signature-verified at `75f8241`. From
isolated homes, Claude Code installed version 1.0.0 with all four skills and the
pinned MCP entry, Codex installed and removed the same public tag marketplace
snapshot, and Pi installed, reconciled, and removed
`git:github.com/beremaran/godot-agent-loop@v1.0.0` using its production-only
dependency path.

After npm publication, a fresh registry cache installed
`@beremaran/godot-agent-loop@1.0.0` with zero vulnerabilities. Its downloaded
tarball matched the signed release artifact byte-for-byte. The exact public
`npx -y @beremaran/godot-agent-loop@1.0.0` command completed an MCP handshake,
exposed 39 tools, called the real Godot 4.7 binary, discovered hidden
`game_light_3d`, and shut down without a server-process leak. The public CLI
also previewed, installed, and uninstalled the OpenCode adapter.

Pi 0.80.2 installed the public npm source into an isolated native home, listed
version 1.0.0, reconciled it through `pi update`, and started the extension.
Native startup reported `Godot Agent Loop connected (39 tools)`, all four
canonical skills, and the npm extension path. Removal left an empty package
list and no server process.

On 2026-07-15, Wave 3 repeated the public repository marketplace lifecycle in
isolated homes. Claude Code installed, inventoried, and removed
`godot-agent-loop@godot-agent-loop`. Codex CLI 0.144.1 and the OpenAI VS Code
extension's bundled Codex 0.144.0-alpha.4 host each discovered the signed
`v1.0.0` marketplace snapshot, installed it enabled, found all four skills and
the pinned compact-surface MCP command, then removed both plugin and marketplace
state. OpenCode repeated its public npm user-scope install, native skill
discovery, and clean uninstall.

The official MCP Registry record is active and latest at version 1.0.0, with an
exact stdio binding to `@beremaran/godot-agent-loop@1.0.0`. This Linux
verification host has no ChatGPT desktop executable or process, so its CLI and
IDE-host results were not substituted for the UI check. On 2026-07-15, the user
independently verified the public plugin worked in Codex Desktop on a separate
MacBook, closing the final Wave 3 client-surface gate.
