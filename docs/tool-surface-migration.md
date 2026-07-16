# Tool-surface migration

The canonical progressive-disclosure surface is `core`. Existing configurations
that set `GODOT_MCP_TOOL_SURFACE=compact` continue to select the same surface
during the 1.x release line. `full` continues to advertise the full static
catalog. Unknown values now fail at startup instead of silently selecting core.

## Catalog and hidden execution

New clients and prompts should replace the combined dispatcher sequence:

```json
{ "name": "godot_tools", "arguments": { "action": "search", "query": "3d light" } }
{ "name": "godot_tools", "arguments": { "action": "describe", "toolName": "game_light_3d" } }
{ "name": "godot_tools", "arguments": { "action": "call", "toolName": "game_light_3d", "arguments": {} } }
```

with separate advertised identities:

```json
{ "name": "godot_catalog", "arguments": { "action": "search", "query": "3d light" } }
{ "name": "godot_catalog", "arguments": { "action": "describe", "toolName": "game_light_3d", "detail": "schema" } }
{ "name": "godot_call", "arguments": { "toolName": "game_light_3d", "arguments": {} } }
```

Catalog inspection is read-only. Hidden execution has its own conservative
mutation/destruction annotations, and policy, Pause Agent, roots, privilege, and
trace checks use the effective nested tool. `godot_tools` remains callable for
legacy `search`, `describe`, and `call` throughout 1.x; removal is reserved for a
future major release and will be recorded as a breaking change.

## Result compatibility

Modern clients should consume `structuredContent` validated by each tool's
`outputSchema`. Equivalent JSON text remains in `content` for text-only clients.
Recoverable argument and engine failures use `isError: true` tool results rather
than changing the MCP transport contract.

Roots, progress tokens, cancellation, and annotation/title display are optional
client capabilities. Omitting them preserves the bounded legacy path. When
present, roots narrow workspace access, progress reports bounded milestones, and
cancellation requests safe teardown.

## Automated compatibility coverage

- `tests/tool-surface.test.ts` covers `core`, the `compact` alias, `full`, unknown
  mode rejection, titles, and annotations without asserting a hand-maintained
  count.
- `tests/e2e/progressive-disclosure.test.ts` runs legacy `godot_tools` search,
  describe, and call against a core server where that compatibility tool is no
  longer advertised.
- `tests/tool-results.test.ts` checks equivalent text-only and structured result
  consumption.
- `tests/utils.test.ts` covers configured roots with absent, empty, and populated
  client roots; `tests/index.test.ts` covers calls with and without progress and
  cancellation metadata.
- `tests/agent-plugin.test.ts` checks Pi's top-level title, annotation-title, and
  raw-name display precedence.

These deterministic cases do not replace native-client or external cold-model
evidence. Removal of `compact` or `godot_tools` is intentionally deferred to a
future major release.
