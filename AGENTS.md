# Repository Guidelines

## Project Structure & Module Organization

Core MCP server code lives in `src/`; tool handlers are grouped under
`src/tool-handlers/`, while the Godot runtime bridge is in `src/scripts/`.
Unit and contract tests are `tests/*.test.ts`; real-engine suites live in
`tests/e2e/`, with Godot fixtures and shell harnesses under `tests/godot/`.
The distributable editor add-on is in `addons/godot_agent_loop/`, reusable agent
skills in `agent-plugin/`, and the playable reference project in `examples/`.
Documentation and generated coverage reports live in `docs/`. Treat `build/`,
`coverage/`, and `dist/` as generated output.

## Build, Test, and Development Commands

- `npm install` installs Node 18+ dependencies and Husky hooks.
- `npm run build` compiles TypeScript and synchronizes product and adapter
  metadata.
- `npm run watch` recompiles TypeScript while developing.
- `npm test` runs the Vitest unit and contract suite.
- `npm run check` runs tests, ESLint, Markdown linting, and coverage audits.
- `npm run test:e2e` builds and runs full MCP-to-Godot tests serially.
- `npm run test:godot` runs GDScript type checks and headless integration suites.
  Real-engine commands require `GODOT_BIN`, `GODOT_PATH`, or `godot4`/`godot`
  on `PATH`.
- `npm run inspector` opens the MCP Inspector against the built server.

## Coding Style & Naming Conventions

Use strict TypeScript, two-space indentation, single quotes, semicolons, and
descriptive camelCase identifiers; use PascalCase for types and classes. Keep
imports ESM-compatible, including `.js` suffixes for local TypeScript imports.
GDScript uses tabs, static type annotations, and snake_case names. Prefer Node
path utilities over hard-coded separators. Run `npm run lint`; documentation
must also pass `npm run lint:md`.

## Testing Guidelines

Name tests `*.test.ts` and place E2E coverage in `tests/e2e/`. Add focused tests
for every behavior change, including validation and failure paths. Changes to
tools should preserve manifest, handler, protocol, and coverage-report
consistency. Run `npm run check` before committing; run the relevant Godot and
E2E suites when engine behavior changes. Godot compatibility spans 4.4 through
the primary 4.7 target.

## Commit & Pull Request Guidelines

History follows Conventional Commit subjects such as `fix(ci): ...`,
`docs(release): ...`, and `chore: ...`; keep subjects imperative and scoped.
Pull requests should explain the problem and solution, link relevant issues,
list verification commands, and note OS/Godot versions for engine-facing work.
Include screenshots or captured evidence for editor, rendering, or gameplay
changes, and update README/tool documentation when public behavior changes.
