# Evaluation dependency audit

- Audit date: 2026-07-26
- Commands: `npm audit --audit-level=high` and
  `npm audit --omit=dev --audit-level=high`
- Result: no high or critical advisories

## Accepted moderate advisory

The full tree reports four moderate vulnerability records and the production
tree reports two. They all trace to one advisory:
[`@hono/node-server` encoded-backslash path traversal on Windows
(GHSA-frvp-7c67-39w9)](https://github.com/advisories/GHSA-frvp-7c67-39w9).

The affected function is Hono's static-file handler. It is not reachable in
this repository:

- the product MCP server uses stdio and does not serve static files;
- the test-only conformance transport uses Node's `http.createServer` and the
  MCP Streamable HTTP transport directly;
- the Inspector CLI is invoked over production stdio;
- the conformance server is bound to loopback and does not expose a static-file
  route; and
- the advisory's encoded-backslash traversal applies to Windows static-file
  serving, while no such handler exists in the Windows product path.

`npm audit fix --force` proposes downgrading `@modelcontextprotocol/sdk` from
the repository's current supported line to 1.24.3. That would discard required
current SDK behavior without removing a reachable product path, so it is not an
acceptable remediation.

The exception expires on 2026-08-26. Recheck it earlier when the MCP SDK updates
its Hono dependency, the product adds an HTTP transport, or any static-file
route is introduced.

## Development dependency reduction

The evaluation lane pins `@modelcontextprotocol/inspector-cli` 1.0.0 directly
instead of installing the full Inspector browser/server bundle. This keeps the
required official stdio client while excluding unused UI and proxy
dependencies. `js-yaml` is overridden to patched version 5.2.2 for the
Markdown linter.
