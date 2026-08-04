# Tool-surface migration

The canonical progressive-disclosure surface is `core`. Existing configurations
that set `GODOT_MCP_TOOL_SURFACE=compact` continue to select the same surface
during the 1.x release line. `full` advertises the complete 56-tool static
catalog. Unknown values fail at startup instead of silently selecting core.

## Catalog and hidden execution

New clients and prompts use the split dispatcher identities directly:

```json
{ "name": "godot_catalog", "arguments": { "action": "search", "query": "held input" } }
{ "name": "godot_catalog", "arguments": { "action": "describe", "toolName": "game_key_hold", "detail": "schema" } }
{ "name": "godot_call", "arguments": { "toolName": "game_key_hold", "arguments": {} } }
```

Catalog inspection is read-only. Hidden execution has its own conservative
mutation/destruction annotations, and policy, Pause Agent, roots, privilege, and
trace checks use the effective nested tool.

### `godot_tools` removal

The combined `godot_tools search|describe|call` dispatcher was removed in the
lean surface reduction. Clients that still call it receive an unknown-tool
error. Migrate every `godot_tools` call to `godot_catalog` for search and
describe and to `godot_call` for execution, as shown above; there is no
compatibility window for this dispatcher.

## Result compatibility

Modern clients should consume `structuredContent` validated by each tool's
`outputSchema`. Equivalent JSON text remains in `content` for text-only clients.
Recoverable argument and engine failures use `isError: true` tool results rather
than changing the MCP transport contract.

Roots, progress tokens, cancellation, and annotation/title display are optional
client capabilities. Omitting them preserves the bounded legacy path. When
present, roots narrow workspace access, progress reports bounded milestones, and
cancellation requests safe teardown.

## Retained compatibility coverage

- `tests/index.test.ts` covers initialization and representative tool calls.
- `tests/tool-schema-parity.test.ts` checks the retained schema/manifest parity
  contract.
- `tests/e2e/agent-adapter-smoke.test.ts` covers catalog filtering, hidden calls,
  Pi forwarding, and teardown through a real MCP client.

These deterministic cases do not replace native-client or external cold-model
evidence. Removal of `compact` is intentionally deferred to a future major
release.
