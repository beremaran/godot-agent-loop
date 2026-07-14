# Claude Code plugin packaging

Format verified against current primary documentation and Claude Code 2.1.208
on 2026-07-14.

- [Create plugins](https://code.claude.com/docs/en/plugins) requires
  `.claude-plugin/plugin.json`, root-level skills, and optional root `.mcp.json`.
- [Plugin MCP documentation](https://code.claude.com/docs/en/mcp#plugin-provided-mcp-servers)
  confirms that enabling a plugin starts its MCP server automatically.
- [Marketplace documentation](https://code.claude.com/docs/en/plugin-marketplaces)
  defines repository-root `.claude-plugin/marketplace.json` and relative plugin
  sources.

This repository is a marketplace containing `./claude-plugin`. The plugin pins
its MCP process to the matching npm release and bundles three model-invoked
skills at the documented `skills/<name>/SKILL.md` locations. The npm package also
includes the plugin directory.

Validation commands:

```bash
claude plugin validate .
claude plugin validate ./claude-plugin
npm pack --dry-run
```

Install from GitHub in Claude Code:

```text
/plugin marketplace add beremaran/godot-agent-loop
/plugin install godot-agent-loop@godot-agent-loop
```

For a source checkout during development, use
`claude --plugin-dir ./claude-plugin` and run `/reload-plugins` after edits.
