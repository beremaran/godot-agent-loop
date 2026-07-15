# Tool disclosure compatibility decision

Checked against current primary documentation on 2026-07-14.

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

The default is a static 39-tool core that includes `godot_tools`, which can
search, describe, and call every entry in the complete catalog. This requires
only the universally usable tools primitive and keeps discovery functional even
when a client ignores resources and dynamic-list notifications. The full static
catalog remains available with `GODOT_MCP_TOOL_SURFACE=full` for clients with
native tool search or workflows that require exact legacy discovery.

Dynamic list changes are not needed because the visible set never changes during
a connection. Resources may later carry long reference material, but no required
workflow will depend on a client surfacing them.
