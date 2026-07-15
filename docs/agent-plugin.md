# Portable agent bundle

Godot Agent Loop ships one neutral `agent-plugin/` bundle. Its four workflows
live once under `skills/`; Claude Code, Codex, OpenCode, and Pi consume that same
tree. `agent-plugin/adapter-manifest.json` owns the shared package version, MCP
command, environment, skill inventory, and starter prompts.

The formats were rechecked on 2026-07-14 against Claude Code 2.1.208, Codex CLI
0.144.1, OpenCode 1.17.13, and Pi 0.80.2:

- [Claude Code plugins](https://code.claude.com/docs/en/plugins) discover root
  `.mcp.json` and `skills/<name>/SKILL.md` beside
  `.claude-plugin/plugin.json`.
- [Codex plugins](https://developers.openai.com/codex/plugins/build) use
  `.codex-plugin/plugin.json` and can point `skills` and `mcpServers` at those
  same resources; repo marketplaces live at `.agents/plugins/marketplace.json`.
- [OpenCode MCP servers](https://opencode.ai/docs/mcp-servers/) use a local
  command array in `opencode.json` or `opencode.jsonc`; OpenCode also discovers
  `.agents/skills`.
- [Pi packages](https://pi.dev/docs/latest/packages) declare extension and skill
  paths in `package.json`. The bundled extension uses Pi's documented dynamic
  `registerTool` and session shutdown lifecycle.

Run `npm run adapters:sync` after deliberately changing the adapter manifest.
Every build rejects a generated manifest, skill trigger, command, environment,
or package field that has drifted.

## Claude Code

Validate a source checkout:

```bash
claude plugin validate .
claude plugin validate ./agent-plugin
claude --plugin-dir ./agent-plugin
```

Install from the repository marketplace after the repository is public:

```text
/plugin marketplace add beremaran/godot-agent-loop
/plugin install godot-agent-loop@godot-agent-loop
```

## Codex and ChatGPT desktop

Validate a local marketplace without changing the repository:

```bash
codex plugin marketplace add .
codex plugin add godot-agent-loop@godot-agent-loop
codex plugin list
```

Install the signed public snapshot with:

```bash
codex plugin marketplace add beremaran/godot-agent-loop --ref v1.0.0
codex plugin add godot-agent-loop@godot-agent-loop
```

In the ChatGPT desktop app, open **Plugins** from Work or Codex, add the same
repository marketplace, and install `godot-agent-loop@godot-agent-loop`. Start a
new chat after installation. Remove a prior local-cache copy before checking the
public version, and restart the app after changing a locally installed plugin.

## OpenCode

The setup command previews by default and writes only with `--write`:

```bash
npx -y @beremaran/godot-agent-loop@1.0.0 setup opencode
npx -y @beremaran/godot-agent-loop@1.0.0 setup opencode --write
npx -y @beremaran/godot-agent-loop@1.0.0 setup opencode uninstall --write
```

Use `--scope user` for `~/.config/opencode/opencode.json` and
`~/.agents/skills`; project scope is the default. The command preserves JSONC
comments and unrelated settings, records hashes for files it owns, refuses to
overwrite foreign or modified entries, is idempotent, and leaves modified
skills in place during uninstall.

## Pi

Install locally, from Git, or from npm:

```bash
pi install ./
pi install git:github.com/beremaran/godot-agent-loop
pi install npm:@beremaran/godot-agent-loop
```

The extension launches this package's built stdio server, completes the MCP
handshake, registers the 39 returned default tools, keeps specialized discovery
behind `godot_tools`, and closes the child server on session shutdown. Pi
extensions execute with the user's system access; Godot Agent Loop's path,
mutation, authentication, and privileged-command gates remain in force, but a
Pi package should still be reviewed before installation.
