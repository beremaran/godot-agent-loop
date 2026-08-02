# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Godot Agent Loop (`@beremaran/godot-agent-loop`): a TypeScript MCP server (stdio transport) that lets agents author, run, observe, and verify Godot 4 games. Entry point `src/index.ts`, compiled to `build/index.js`. Godot 4.7 is both the compatibility floor and primary target.

## Commands

```bash
npm run build          # tsc + metadata/adapter sync + scripts/build.js (copies GDScript into build/)
npm test               # unit tests (vitest)
npx vitest run tests/utils.test.ts            # single unit test file
npx vitest run tests/utils.test.ts -t "name"  # single test by name
npm run test:e2e       # full-path MCP E2E (builds first, needs a Godot binary, ~25s)
npm run build && npx vitest run --config vitest.e2e.config.ts tests/e2e/observers.test.ts  # single E2E file
npm run test:godot     # Godot-side suites (typecheck, validate-script, headless ops, runtime, launch demo)
npm run lint           # eslint + markdownlint; npm run lint:md:fix auto-fixes markdown
npm run check          # lint + coverage:check — full gate: builds once and runs the unit suite once (via coverage:unit); used by CI and release validation
npm run check:built    # lint + coverage:verify — same gate assuming a fresh build; what release validation runs after its own build
npm run check:fast     # lint + tsc --noEmit — what the Husky pre-commit hook runs (~seconds)
npm run coverage:report  # regenerate docs/coverage/coverage-report.md after coverage changes
npm run inspector      # MCP Inspector against build/index.js
```

Godot binary resolution for tests: `GODOT_BIN` (executable path) → `godot4`/`godot` on PATH → first `godot*` executable inside `GODOT_PATH` (a directory). Note: the MCP server itself treats `GODOT_PATH` as an executable path, not a directory — the E2E harness passes the binary explicitly.

## Architecture

### Tool pipeline (TypeScript side)

Every MCP tool flows through a chain where each layer is cross-validated by tests:

- `src/tool-definitions.ts` — name + JSON schema for all tools.
- `src/tool-manifest.ts` — one entry per tool: domain, handler method, backend, action list, privilege flag. Typed as `Record<ToolName, ...>` so completeness is a compile-time fact; `tests/tool-manifest.test.ts` cross-checks entries against schema enums, GDScript action declarations, and handler dispatch, so a new action cannot ship without appearing here.
- `src/domain-tool-registries.ts` — dispatches to the three handler classes in `src/tool-handlers/`: lifecycle (processes/editor), project (files, scenes, headless ops), game (runtime interaction).
- `src/tool-surface.ts` — the advertised surface. Default is a compact 42-tool "core" set; `GODOT_MCP_TOOL_SURFACE=full` advertises everything. The `godot_catalog` tool searches/describes the full catalog and `godot_call` dispatches it by name either way. Size budgets (bytes/token/count) are constants here and enforced by tests.

### Backends (how a tool reaches Godot)

Declared per-tool in the manifest (`ToolBackend` in `src/tool-manifest.ts`):

- `subprocess` — one headless operation dispatched to `src/scripts/godot_operations.gd` via the Godot CLI.
- `authoring-session` — persistent authoring loop command, with a declared subprocess fallback.
- `runtime` / `runtime-buffer` — JSON-RPC over loopback TCP to `src/scripts/mcp_interaction_server.gd` running inside the game; domain command implementations live in `src/scripts/mcp_runtime/*.gd`. The runtime executes ONE command at a time (a concurrent command gets error -32001).
- `process`, `godot-cli`, `local` — process management, direct CLI invocations, and pure-TypeScript tools.

The editor bridge (`addons/godot_agent_loop` + `src/editor-plugin-installer.ts`, `editor-connection.ts`) is the persistent, editor-native attachment used as the primary setup; MCP-owned sessions install it transiently and clean it up afterward. `src/editor-mutation-guard.ts` implements the human "Pause Agent" lock.

### Security defaults

Privileged runtime groups (reflection, code execution, networking) are denied by default; opt in via `GODOT_MCP_PRIVILEGED_GROUPS` / `GODOT_MCP_ALLOW_PRIVILEGED_COMMANDS`. Runtime connections are authenticated with `GODOT_MCP_RUNTIME_SECRET` (random if unset); a runtime without a secret refuses handshakes unless `GODOT_MCP_ALLOW_INSECURE_RUNTIME=true`. Filesystem access requires `GODOT_MCP_ALLOWED_DIRS` or MCP client roots; `GODOT_MCP_ALLOW_UNRESTRICTED=true` restores the legacy open mode. Other knobs: `GODOT_MCP_RUNTIME_PORT` (default 9090; both ends inherit it), `GODOT_MCP_AUTHORING_MODE`, `GODOT_MCP_TOOL_SURFACE`, `DEBUG=true`.

## Testing conventions

- **Coverage traceability is enforced.** `docs/coverage/tool-coverage.json` records each tool's verification level and per-action test references (`file::needle`); `tests/tool-coverage.test.ts` validates it and `npm run coverage:check` (part of `check` and CI) fails if `docs/coverage/coverage-report.md` is stale. When you change tool coverage, update the JSON and run `npm run coverage:report` before committing.
- **Godot suites gate on clean engine output.** Every `tests/godot/` suite appends raw Godot output to a log and fails on unexpected `ERROR/WARNING/leak` diagnostics (`assert_clean_godot_log` in `tests/godot/godot-bin.sh`). A diagnostic may only be tolerated via `tests/godot/allowed-godot-output.tsv`, and only with a reason, issue/test reference, owner, and expiry.
- **E2E harness** (`tests/e2e/helpers/harness.ts`): spawns `build/index.js` over stdio, drives it with the official MCP SDK client, and gives each test an isolated temp project, free runtime port, XDG-isolated user dir, and a leaked-process assertion at teardown. E2E tests require `npm run build` first (the npm scripts do this).
- `tests/source-guardrails.test.ts` enforces GDScript source rules (e.g. scoped `@warning_ignore` only, no raw socket/transport internals outside designated files) — if it fails, fix the source, don't loosen the test.
