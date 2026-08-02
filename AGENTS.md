# Repository Guidelines

## Project Structure & Module Organization

Core MCP server code lives in `src/`; tool handlers are grouped under
`src/tool-handlers/`, while the Godot runtime bridge is in `src/scripts/`.
The retained unit and contract smoke tests are `tests/*.test.ts`; real-engine
smoke tests live in `tests/e2e/`.
The distributable editor add-on is in `addons/godot_agent_loop/`, reusable agent
skills in `agent-plugin/`, and the playable reference project in `examples/`.
Documentation lives in `docs/`. Treat `build/`,
`coverage/`, and `dist/` as generated output.

## Build, Test, and Development Commands

- `npm install` installs Node 18+ dependencies and Husky hooks.
- `npm run build` compiles TypeScript and synchronizes product and adapter
  metadata.
- `npm run watch` recompiles TypeScript while developing.
- `npm test` runs the Vitest unit and contract suite.
- `npm run check` runs lint, one build, and the retained unit suite exactly
  once. Release validation reuses its own build via `npm run check:built`.
- `npm run check:fast` runs ESLint, Markdown linting, and a no-emit
  TypeScript check; this is the Husky pre-commit gate.
- `npm run test:e2e` builds and runs the retained MCP-to-Godot smoke tests
  serially. It requires `GODOT_BIN`, `GODOT_PATH`, or `godot4`/`godot` on
  `PATH`.
- `npm run inspector` opens the MCP Inspector against the built server.

## Coding Style & Naming Conventions

Use strict TypeScript, two-space indentation, single quotes, semicolons, and
descriptive camelCase identifiers; use PascalCase for types and classes. Keep
imports ESM-compatible, including `.js` suffixes for local TypeScript imports.
GDScript uses tabs, static type annotations, and snake_case names. Prefer Node
path utilities over hard-coded separators. Run `npm run lint`; documentation
must also pass `npm run lint:md`.

## Testing Guidelines

Name tests `*.test.ts` and place E2E coverage in `tests/e2e/`. Keep additions
focused on representative validation and failure paths. The Husky pre-commit
gate runs `npm run check:fast` (lint plus no-emit typecheck); run the retained
E2E suite when engine behavior changes. Godot 4.7 is both the compatibility
floor and primary target.

## Commit & Pull Request Guidelines

History follows Conventional Commit subjects such as `fix(ci): ...`,
`docs(release): ...`, and `chore: ...`; keep subjects imperative and scoped.
Pull requests should explain the problem and solution, link relevant issues,
list verification commands, and note OS/Godot versions for engine-facing work.
Include screenshots or captured evidence for editor, rendering, or gameplay
changes, and update README/tool documentation when public behavior changes.
