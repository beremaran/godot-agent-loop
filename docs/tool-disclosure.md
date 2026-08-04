# Tool disclosure compatibility decision

Updated for the lean surface reduction. Current counts and byte/token sizes are
generated in [`coverage/tool-surface.json`](coverage/tool-surface.json).

## What clients can be trusted to do

MCP standardizes static `tools/list` and `tools/call`. It also standardizes
`notifications/tools/list_changed`, but the server advertises that feature; the
current client capability object does not let a server require or detect a
client-side refresh implementation. The protocol's resource surface is likewise
application-controlled: clients choose how, or whether, resources enter model
context.

- The [MCP architecture documentation](https://modelcontextprotocol.io/docs/learn/architecture)
  defines tool-list change notifications and says clients typically re-list.
- The [MCP resource specification](https://modelcontextprotocol.io/specification/draft/server/resources)
  explicitly leaves the resource interaction model to each implementation.
- [Claude Code](https://code.claude.com/docs/en/mcp) documents automatic dynamic
  list refresh, resource browsing, and default Tool Search that defers schemas.
- [VS Code](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)
  documents MCP resources and a manual **Reset Cached Tools** command, but does
  not make automatic refresh a portable server assumption.

## Decision

The default is a reviewed static `core` surface of 20 tools (~32,787 bytes /
~8,197 estimated tokens). It advertises two separate identities:

- `godot_catalog` is read-only and performs ranked `search` and `describe`;
- `godot_call` conservatively represents mutation/destruction risk and executes
  one inspected hidden tool.

This uses only the universally available tools primitive and keeps required
discovery functional when a client ignores resources and dynamic-list
notifications. `GODOT_MCP_TOOL_SURFACE=full` advertises the complete 64-tool
static catalog (430,774 bytes / ~107,694 estimated tokens) for clients with
native tool search or exact legacy requirements. The advertised core is 92.39%
smaller than the full surface.

`core` is the canonical surface name. `compact` remains an accepted alias during
the 1.x line, and unknown surface values are rejected. The combined
`godot_tools search|describe|call` dispatcher was removed in the lean surface
reduction, so every hidden tool is reached through the split `godot_catalog` +
`godot_call` identities. See [the migration guide](tool-surface-migration.md).

Dynamic list changes are not needed because the visible set never changes during
a connection. Resources may later carry long reference material, but no required
workflow depends on a client surfacing them. The server still supports clients
that omit roots, progress tokens, cancellation, structured content, and modern
title/annotation display; these capabilities improve safety or presentation but
do not change which workflow capabilities are discoverable.
