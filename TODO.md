# Godot Agent Loop — working plan

Phases 0–5 of the verification and capability audit are complete: all 167
advertised tools are covered through the full MCP-to-Godot path, and all 358
public action rows resolve to E2E tests. The closed record — the audited
baseline, scope and methodology, the per-tool inventory, the P1–P3 capability
families, Phases 0–5, and the resolved pre-Phase-3 questions — is archived in
[`docs/plan-archive.md`](docs/plan-archive.md).

This file now tracks the pre-release product, distribution, and publication
work. The completed Phase 6 and Phase 7 decisions remain below because they
define the agent loop being released. The P4 engine-surface decisions are
retained because their generated zero-gap audit remains a release gate. The
discipline sections at the bottom — required test dimensions, definition of
done, and the implementation checklist — remain the live gate for every new
tool or action.

## Pre-release follow-up

### Upstream fixes and metadata integrity

- [x] Adapt the upstream 3.1 `manage_input_map` fix so adding another key to an
  existing action merges it into that action's event array, preserves the
  configured deadzone, and de-duplicates the physical keycode instead of writing
  a duplicate `project.godot` entry. Add a full MCP-to-Godot regression that adds
  two keys to one action and independently observes both through the live
  `InputMap`. (`mergeInputMapAction` is unit-covered for merge, deadzone,
  de-duplication, section isolation, and byte-stable repetition. The full MCP
  regression writes Space, W, and duplicate Space, proves one property remains,
  then observes `[32, 87]` and deadzone `0.25` through Godot 4.7's live
  `InputMap`.)
- [x] Adapt the upstream 3.1 `validate_script` fix so scripts are compiled only
  after project autoload singletons are registered, while still forcing a fresh
  parse that catches real syntax and type errors. Add direct-Godot and MCP E2E
  regressions covering multiple referenced autoloads plus a genuine compile
  failure. (`src/scripts/validate_script.gd` loads the target from
  `SceneTree._initialize()` with `CACHE_MODE_IGNORE`. The direct Godot suite and
  MCP E2E both resolve two referenced autoloads, rewrite the same target path,
  and observe the genuine line-4 type error on a fresh compile.)
- [x] Reconcile release and registry metadata with the source-derived inventory:
  `server.json` still advertises 165 tools while the callable catalog contains
  167. Update the title, version, package identity, and any other hand-authored
  counts after the fork-versus-new-product decision, and add a contract check so
  registry metadata cannot drift from the manifest again. (`product.json` is the
  selected identity source of truth; `scripts/sync-product-metadata.js` makes
  stale package or registry JSON fail every build. `server.json` truthfully
  advertises 167 tools, `tests/server-metadata.test.ts` derives that count from
  `toolDefinitions`, and the identity contracts lock version, package, binary,
  description, repository, runtime schema, observability components, editor UI,
  plugin metadata, README, and lineage to the selected product.)

### Product identity and release model

- [x] Decide and record the final identity before publishing anything. Preferred
  direction: **Godot Agent Loop**, with the tagline **Build it. Play it. Prove
  it.** and the category statement **an evidence-first MCP automation loop for
  Godot 4**. If another name wins, require the same distinct, searchable product
  identity rather than another generic `godot-mcp` label. (**Selected:** Godot
  Agent Loop with the preferred tagline and category statement. The verified
  option matrix, confirmation, and rename surface are recorded in
  [`docs/product-identity-decision.md`](docs/product-identity-decision.md);
  public changes remain separately approval-gated.)
- [x] Decide the repository relationship without erasing provenance. Preferred
  direction: publish `beremaran/godot-agent-loop` as an independent GitHub
  repository while preserving the complete Git history, MIT notices, and a
  prominent Lineage section crediting Coding-Solo and Tugcan. Record whether this
  is done by a new repository or GitHub fork detachment. (The decision record
  captures the verified current fork parent, GitHub's current duplication and
  detachment paths, metadata-loss tradeoffs, and separate approval boundary.
  **Selected:** a new independent `beremaran/godot-agent-loop` repository with
  complete Git history and explicit Coding-Solo/Tugcan lineage; the current fork
  is left untouched unless separately approved later.)
- [x] Align every public identifier after the name decision: repository, npm
  package, MCP Registry name, plugin namespace, binary name, AssetLib listing,
  issue URLs, homepage, badges, examples, and generated schemas. Preferred new
  identifiers are `@beremaran/godot-agent-loop` and
  `io.github.beremaran/godot-agent-loop`. (`product.json` is the selected source
  of truth for the repository and issue URLs, npm package/binary, MCP Registry,
  neutral agent bundle, AssetLib listing, schemas, observability names, and
  lineage. Generated-artifact and identity contracts reject legacy public
  identifiers; actually creating or updating public listings remains approval-
  gated.)
- [x] Select release numbering from the product decision: `1.0.0` for a new
  Godot Agent Loop identity, or `4.0.0` if the existing Godot MCP identity and
  lineage continue. Pin the same version in every client manifest and generated
  artifact. (The selected independent identity is pinned to `1.0.0` in
  `product.json`; generation and contract tests lock the npm package, MCP
  Registry entry, Claude/Codex manifests, Pi adapter, addon, and runtime schema
  to that version.)
- [x] Rewrite the README first screen around the product outcome: name and
  tagline, short demo, one-command setup, proof badges, and the author -> run ->
  observe -> playtest -> verify loop. Move installation ahead of the long tool
  inventory and move detailed lineage/history below the product workflow without
  weakening attribution. (The first screen now leads with the selected name,
  tagline, outcome, linked 65-second proof, one-command install, generated E2E
  badge, and author → validate → run → observe → playtest → verify → refine
  loop. The concise proof/support boundary precedes the inventory, while the
  complete lineage and MIT notices remain prominent below the workflow.)

### Shared agent workflow bundle

- [x] Rename or replace `claude-plugin/` with a client-neutral `agent-plugin/`
  root. Keep one canonical `skills/` directory and one MCP server configuration;
  do not maintain Claude-, Codex-, OpenCode-, and Pi-specific copies of the same
  workflow text. (`agent-plugin/` is the sole bundle and all adapters consume
  its root `.mcp.json` and canonical `skills/` tree.)
- [x] Preserve the current focused skills (`build-godot-game`,
  `debug-godot-game`, and `verify-godot-change`) as portable Agent Skills. Add a
  focused `ship-godot-game` skill for export readiness, project tests, .NET
  verification, addon/import integrity, artifact inspection, and deterministic
  teardown. Keep detailed client setup out of the skills themselves. (The three
  existing workflows are preserved and the validated `ship-godot-game` skill
  covers every requested release-readiness and cleanup gate.)
- [x] Add a generated client-adapter manifest that is the single source for
  package version, skill inventory, MCP command, environment variables, and
  default prompts. Generate or validate every client-specific file from it.
  (`agent-plugin/adapter-manifest.json` drives
  `scripts/sync-agent-adapters.js`; every build rejects Claude, Codex, MCP,
  marketplace, Pi, package, or skill metadata drift.)
- [x] Add adapter contract tests that fail on version, command, skill-name,
  skill-description, environment, or package-identity drift. For every supported
  client, smoke-test initialization, the 39-tool default surface, one real tool
  call, hidden-tool discovery through `godot_tools`, and clean server teardown.
  (`tests/agent-plugin.test.ts` locks every generated field;
  `tests/e2e/agent-adapter-smoke.test.ts` runs the required real-Godot path for
  all four clients, including Pi's dynamic extension. Native isolated-client
  evidence is recorded in `docs/agent-adapter-acceptance.md`.)

#### Claude Code distribution

- [x] Keep `.claude-plugin/plugin.json`, `.mcp.json`, and the shared `skills/`
  directory at the neutral plugin root. Update the existing marketplace entry,
  install instructions, namespace examples, and plugin tests for the final name
  and version. (The generator pins `godot-agent-loop` 1.0.0 and
  `./agent-plugin`; Claude Code 2.1.208 validates both manifests and installs
  the plugin from an isolated local marketplace.)
- [ ] Test both local development (`claude --plugin-dir`) and a clean marketplace
  install from the tagged repository. Confirm the bundled MCP server starts
  without manual configuration and the three core workflows plus
  `ship-godot-game` are discoverable. (Local manifests validate and an isolated
  marketplace install enables all four skills. The exact npx server command and
  tagged-repository install remain publication-dependent.)

#### Codex distribution

- [x] Add `.codex-plugin/plugin.json` beside the Claude manifest, pointing its
  `skills` and `mcpServers` fields at the same shared resources. Add install UI
  metadata and `agents/openai.yaml` only where it improves discovery; do not fork
  the workflow instructions. (The validated manifest points at `./skills/` and
  `./.mcp.json`; only the shipping skill adds generated OpenAI discovery
  metadata, while its workflow remains in the canonical `SKILL.md`.)
- [ ] Add a native `.agents/plugins/marketplace.json` entry for Codex while
  retaining Claude marketplace compatibility. Test a clean marketplace install
  in Codex CLI/IDE and the ChatGPT desktop plugin surface. (Codex CLI 0.144.1
  cleanly installs and enables the generated local marketplace entry in an
  isolated cache; IDE/desktop and tagged/public-source pickup remain pending.)

#### OpenCode distribution

- [x] Add an explicit `setup opencode` command to the published CLI. It must
  safely merge a local MCP entry into `opencode.json`/`opencode.jsonc` and install
  the canonical skills into a project or user `.agents/skills` location. It must
  preview changes, preserve unrelated configuration, be idempotent, and support
  uninstall; do not mutate configuration from an npm lifecycle script.
  (`setup opencode` previews by default, writes only with `--write`, supports
  project/user scope and JSONC, hashes owned skills, refuses foreign edits, and
  removes only unchanged owned entries in tested install/uninstall loops.)
- [x] Generate the OpenCode MCP command as a local `npx -y <package>@<version>`
  command with the compact surface enabled. Test discovery through OpenCode's
  native skill tool and verify that no bespoke OpenCode copy of a skill exists.
  (The generated entry pins `npx -y @beremaran/godot-agent-loop@1.0.0` and the
  compact environment. OpenCode 1.17.13 discovers all four canonical skills
  under `.agents/skills`; there is no OpenCode workflow copy.)

#### Pi distribution

- [x] Add a Pi package manifest to `package.json` with the `pi-package` keyword,
  the shared skills path, and a thin TypeScript MCP-client extension path.
- [x] Implement the Pi extension: start the stdio MCP server, complete the MCP
  handshake, call `tools/list`, register the 39 default tools with
  `pi.registerTool`, forward structured content and errors, refresh tools when
  required, and terminate the server on session shutdown. Keep the specialized
  catalog behind `godot_tools` rather than statically registering all 167 tools.
  (`agent-plugin/pi/extension.ts` uses the official MCP client and Pi lifecycle,
  maps structured text/image results and MCP errors, refreshes changed tool
  lists, and closes on `session_shutdown`; the live adapter smoke proves its 39
  registrations, real tool call, and hidden discovery.)
- [ ] Test local, Git, and npm Pi installation, plus update, disable, reload, and
  uninstall behavior. Document that Pi extensions execute with the user's system
  access and keep all mutation/privilege gates enforced by the MCP server.
  (Pi 0.80.2 installs, lists, updates, disables/re-enables, live-reloads, and
  removes the local package in an isolated native client home. Startup and
  reload both connect 39 tools and expose all four skills; native `pi config`
  filtering suppresses the extension without suppressing its skills, and
  uninstall leaves no package or server process. The exact candidate also
  installs/loads/removes from a dependency-complete npm-installed tree, and the
  portable bundle guide documents the trust boundary. Tagged Git and public npm
  installs, plus update behavior against those public sources, remain
  publication-dependent.)

### Persistent Godot Asset Library addon

- [x] Productize the transient editor bridge as a real persistent addon under
  `addons/godot_agent_loop/`, containing `plugin.cfg`, the editor plugin and
  bridge scripts, README, license, and any addon-local assets. The addon is an
  optional distribution surface; the external MCP server must still work without
  an AssetLib installation. (`addons/godot_agent_loop/` is now the canonical,
  npm-shipped addon with `plugin.cfg`, plugin, README, and complete MIT license;
  build compatibility copies its script into the transient server bundle, and
  the absent-addon E2E path still installs and cleans up the transient bridge.)
- [x] Give the addon standalone in-editor value: authenticated connection status,
  Agent Activity, Pause/Resume Agent, compatibility diagnostics, and setup help
  for Claude Code, Codex, OpenCode, and Pi. The AssetLib package must not be a
  marketing-only wrapper around an external install. (The real dock shows
  authenticated connection and protocol status, a bounded live activity feed,
  compatibility diagnostics, four-client setup help, and a human Pause/Resume
  control; the reproducible headed capture and lifecycle E2E exercise that UI.)
- [x] Change `EditorPluginInstaller` so a user-managed AssetLib addon is never
  overwritten or removed. Add an explicit server/addon protocol-version
  handshake, a clear incompatible-version error, and tests for transient,
  persistent, stale, missing, and user-modified installations. (Persistent and
  transient paths are distinct; ownership records include hashes and original
  project-plugin state. Ten installer cases cover repetition, partial copies,
  stale recovery, concurrency, foreign edits, and persistent takeover. The
  authenticated first-message handshake carries protocol/addon/server/Godot
  versions, and incompatible mutation is refused with a stable diagnostic.)
- [x] Make the AssetLib archive project-safe. Export only the addon files; include
  README and the complete MIT license inside the addon; exclude screenshots and
  repository-only files with `.gitattributes`/`.gdignore`; require no essential
  submodules; and fix or suppress every addon script warning. (The deterministic
  builder emits exactly the four addon files, rejects links and non-regular
  entries, and produces identical bytes under UTC and Australia/Perth. The
  addon-local license is complete; the dedicated download-commit
  `.gitattributes` and preview `.gdignore` exclude repository media, and strict
  Godot parsing loads the enabled addon without warnings.)
- [x] Keep the generated engine-surface audit aware of the canonical persistent
  addon path and fail the gate when a newly shipped script creates an uncovered
  engine reachability gap. (The audit now scans `addons/godot_agent_loop/` in
  addition to runtime sources, generation fails on any gap rather than only on
  stale output, and the regenerated Godot 4.7 report remains at zero gaps.)
- [x] Add clean-install acceptance tests on the Godot 4.4 compatibility floor and
  Godot 4.7 primary target: install through the package installer, enable the
  plugin, connect the published MCP package, exercise editor observation and the
  human pause lock, restart the editor, disable/uninstall, and prove no project
  state or temporary bridge files remain. (`tests/e2e/assetlib-addon.test.ts`
  installs the generated ZIP and proves observation, pause refusal, real
  undo/redo, restart/reconnect, graceful disable/uninstall, and exact normalized
  project restoration. It passed against official Godot 4.4.1 and the primary
  Godot 4.7 engine; the full 4.7 matrix passed 201 tests, and SIGKILL recovery
  separately proves stale transient reclamation.)
- [ ] Prepare AssetLib metadata: unique English name **Godot Agent Loop Bridge**
  (or the final product equivalent), Addons/Tools category, supported Godot
  version, SemVer release, repository and issue URLs, exact download commit,
  matching MIT license, plain-English description, square direct-link PNG/JPG
  icon of at least 128x128, and up to three screenshots/video previews. (The
  source-backed payload generator, provisional exact-name uniqueness check,
  category/version/license/URLs/description, 1254x1254 icon, and two real-editor
  previews are ready and contract-tested. The exact download commit is correctly
  still missing until the tested release tag exists, so this item remains open.)
- [ ] Submit the tagged, tested addon through the official Godot Asset Library
  account and record review feedback in this plan. Treat AssetLib as a free/open
  community distribution channel; keep sponsorship or paid support separate.

### Launch evidence and publication

- [x] Close the first public exact-tag GitHub Actions regressions without
  weakening the release gates: accept CRLF adapter metadata on Windows, keep
  test-harness file URLs portable across Windows drive-letter paths, keep
  cold runtime connection attempts alive through fresh imports and shader
  compilation, select dummy audio for the headed authoring test, and account
  narrowly for Godot 4.4's fixed-upstream headless-import diagnostics. Move the
  hosted workflow to the current Node 24 action majors so the release run has no
  forced-runtime deprecation annotations, and keep an explicitly configured
  missing Godot path authoritative so missing-binary acceptance cannot silently
  use a runner-installed fallback. (The focused regressions and local Godot
  4.4/4.7 suites pass. Public `main` run
  [29328993694](https://github.com/beremaran/godot-agent-loop/actions/runs/29328993694)
  passed all 11 jobs at repaired commit `b1a8a7e`: core checks, Windows, macOS,
  Compatibility and Forward+ renderers, 4.4/4.7 exports, 4.4/4.7 .NET, and the
  two exhaustive 201-test MCP-to-Godot suites. Its logs contain no Node 20,
  deprecated-action, warning-command, or error-command markers; the only check
  annotation is GitHub's informational `macos-latest` migration notice.)

- [x] Produce one 60–90 second proof-oriented launch video: start from an empty
  directory, have a cold agent build a small game, show the editor following
  activity, exercise win and lose states, verify UI/log/rendered evidence, and
  demonstrate the human Pause Agent control. Publish the exact prompt, model,
  server version, elapsed time, and resulting project or replay. (The SHA-pinned
  65-second 1080p H.264 proof shows the exact empty-start prompt, real editor
  activity, real Pause/Resume refusal, PLAYING/WIN/LOSE rendered evidence, and
  5/5 compound verification. `docs/launch/launch-evidence.md` records Claude
  Sonnet 5/high, server 1.0.0 commit, 391.795 seconds, 104 turns, 103 MCP-only
  calls, zero corrections, exact prompt, four-file project, screenshots, and
  deterministic replay. A container-level contract parses its duration,
  dimensions, codec, hashes, and linked artifacts.)
- [x] Create a concise comparison/proof section that leads with 167/167 E2E
  tools, 358 traced actions, 201 full-path E2E tests, the 39-tool/81.56% compact
  surface, the cold-agent acceptance run, tested Godot versions, and
  default-denied privileged groups. Do not lead with raw tool count or claim
  unbounded/full engine control. (README's first-screen **Proof before claims**
  section presents those source-backed values in that order, links the cold-run
  and deterministic evidence, states the Godot 4.4/4.7 and platform boundary,
  and explicitly rejects an unbounded-engine-control claim.)
- [ ] Publish a clean GitHub release with signed/tagged source and release notes,
  publish the npm package, publish/update the MCP Registry entry, then verify
  installation from each public artifact on a clean machine or container.
- [ ] Publish the Claude Code and Codex marketplace entries, OpenCode setup path,
  Pi package, and Godot AssetLib addon against the same tested release rather
  than launching adapters with different server versions.
- [ ] Announce the release with one consistent message: **other integrations give
  agents tools; this project gives them a tested feedback loop to author, run,
  observe, playtest, and independently verify Godot games.** Link the demo and
  evidence before the tool catalog.
- [ ] Run the complete release gate after every packaging change and once more
  from the exact release tag. Do not push registry, marketplace, or AssetLib
  metadata until the two upstream regressions and metadata-drift guard are
  closed.

## P4: engine-surface gaps (resolved)

Unlike the authored P1–P3 capability families (closed; see
[`docs/plan-archive.md`](docs/plan-archive.md)), these are derived
mechanically rather than authored:
`scripts/engine-surface-audit.js` classifies every class in Godot's own
`--dump-extension-api` output, and `docs/coverage/engine-surface.md` is the
generated result. Of 1,036 classes in Godot 4.7, 221 are named by our sources,
718 are generically reachable (`ClassDB`-instantiable, so `add_node` and
`game_eval` construct them; sampled and proven in `tests/e2e/engine-reach.test.ts`),
and 97 are scoped out in `docs/coverage/engine-scope.json` under 16 grouped
reasons, each of which the audit fails if it stops matching any class. The
generated report has zero gaps.

The remaining 45 fell into two kinds. Each needed one of three outcomes: a tool,
a proof that `game_eval` already reaches it, or a line in `engine-scope.json`
recording why it is outside the product boundary. The decisions below close all
45; the generated list remains release-gated, so it will reopen when Godot adds a
class that no existing rule or reachability path covers.

- [x] Assign this section's exit criteria to a phase. (The P4 decisions are a
  prerequisite of Phase 6c because that phase freezes the session, editor, and
  `read_scene` seams. They were completed before 6c implementation; the generated
  zero-gap audit is the gate.)

### Editor-context classes (28)

The engine's own import and export configuration objects: `ResourceImporter*`
(16, one per format) and `EditorExportPlatform*` plus `EditorExportPreset` (12).

These are the sharpest finding in the audit, because we *do* claim both
workflows. `manage_import_pipeline`, `manage_export_presets`, and
`verify_export_readiness` drive import and export from the outside — editing
`export_presets.cfg`, shelling out to `--import` and `--export-release` — and
never hold the engine object that models the thing they are configuring. So
import and export settings are reachable only as text we format correctly, not
as typed engine state we can read back and validate.

They are also genuinely unreachable rather than merely untooled: the API dump
marks most of them instantiable, but that is an editor-side fact. In a running
game `ClassDB.instantiate()` returns null for them, so `game_eval` is not a
fallback. (`tests/e2e/engine-reach.test.ts` proved this by failing on
`EditorExportPlatformAndroid` when the audit wrongly called them reachable.)

- [x] Decide whether outside-the-editor configuration is the right seam for an
  MCP server, or a limitation to close by reaching these through the editor
  bridge that `editor_control` already establishes. (**Keep the external seam.**
  Project-file configuration followed by a real engine import/export is both
  headless-capable and stronger evidence than holding the editor's transient
  importer/platform object. Making the GUI editor an execution dependency would
  contradict the architecture decision that it is an observation surface. All
  28 implementation objects are recorded under `import and export editor
  internals` in `engine-scope.json`.)

### Handle classes (17)

Not `ClassDB`-instantiable, not a singleton, and with no instantiable subclass,
so the only way to hold one is to be handed it by an engine accessor that no
tool exposes. Not missing wrappers — missing *doorways*.

- [x] **Rendering device:** `RenderingDevice` (135 methods). Scoped out as a raw
  compute/RID API. The product claims scene resources, visual shaders, and
  higher-level rendering automation, not compute-shader orchestration; adding a
  135-method doorway while Phase 7 is reducing the default surface would move in
  the wrong direction.
- [x] **Scene introspection:** `SceneState` (23 methods), along with
  `InstancePlaceholder` and `PackedDataContainerRef`, is scoped out as a packed
  scene implementation handle. `read_scene` already returns the stable,
  serializable structure an agent needs, and the authoring tools independently
  reload scenes to verify persistence.
- [x] **Audio stream playbacks:** `AudioStreamGeneratorPlayback`,
  `AudioStreamPlaybackPolyphonic`, `AudioStreamPlaybackInteractive`,
  `AudioStreamPlaybackPlaylist`, `AudioStreamPlaybackSynchronized`, and
  `AudioEffectSpectrumAnalyzerInstance` are scoped out as advanced procedural,
  analysis, and specialized playback handles. The claimed audio workflow remains
  players, streams, buses, effects, playback control, and persisted layouts.
- [x] **Networking handles:** `ENetPacketPeer` and `TLSOptions` are scoped out as
  low-level transport configuration. The claimed HTTP, WebSocket, and multiplayer
  workflows retain engine/platform TLS validation; unsafe TLS options and
  per-peer ENet tuning are not exposed as agent primitives.
- [x] **XR:** `WebXRInterface` and `OpenXRFutureResult` are explicitly scoped out.
  XR is not claimed and requires platform/runtime coverage absent from the
  portable support matrix.
- [x] **Remaining handles:** `GodotInstance` and `JavaScriptObject` are scoped out
  as platform-host embedding bridges; `SkinReference` is scoped out as the
  RenderingServer/RID lifetime handle beneath the supported mesh, skeleton, skin
  resource, and animation workflows. The other packed-scene handles are covered
  by the scene-introspection decision above.

Exit criteria: `docs/coverage/engine-surface.md` reports zero gaps, with every
class in this list resolved to a tool, a reachability proof, or a recorded scope
decision. **Met:** the generated Godot 4.7 report now has zero gaps and 97
explicitly grouped scope decisions.

## End goal and architecture direction

Phases 0-5 established that the advertised surface is real: every tool reaches
Godot and every action is observed. That is a statement about *correctness*. It
says nothing about whether the surface composes into the thing it exists for.

**End goal: an agent builds a game end to end.** Not "an agent can call 167
tools", but: an agent authors scenes and scripts, runs the game, observes what
happened, asserts against it, edits, and repeats — unattended, for hundreds of
iterations — while a human can watch it happen in real time and take the wheel.

The audit's own denominator is the wrong one for that goal. Tool coverage is now
a solved problem; the open problems are loop latency, repo hygiene, fidelity, and
legibility. This section records the architecture decisions taken to close them,
so the reasoning survives the decision.

### Decisions

**Stay in GDScript; do not move the runtime to GDExtension.** GDExtension would
load in the game process automatically and remove script injection entirely (see
below), which is genuinely tempting. It is still rejected: it would trade 14
readable domain scripts covering 109 runtime commands for native code plus a
per-platform binary release matrix pinned to Godot's ABI. The project's leverage
is that a contributor — or an agent — can add a runtime command in minutes.

**The editor is an observation surface, not the execution path.** An earlier
sketch had an addon own all work through `EditorInterface`, gaining undo/redo
integration and killing per-operation engine boot. It is rejected as the trunk:
an unattended agent loop needs execution that is headless-capable,
containerizable, parallelizable, and deterministic, and a GUI editor is none of
those. `editor_control` and the authenticated editor bridge remain — scoped to
letting a human see and intervene, not to carrying the work.

**Collapse the two engine channels into one persistent session.** The server
currently has two transports of the same shape: `headless` (boot the engine,
run one operation via `--script`, exit) and `runtime` (JSON-RPC over TCP into a
live engine). The headless path pays a full engine start per operation, which an
agent doing dozens of edits pays dozens of times. Make `godot_operations.gd` a
long-lived `SceneTree` that serves the JSON-RPC protocol the runtime channel
already speaks, and authoring becomes commands on the same wire.

**Stop mutating the user's project to reach the running game.** `run_project`
today copies `mcp_interaction_server.gd` plus `res://mcp_runtime/` into the
project and rewrites `[autoload]` in `project.godot`. Ownership is tracked and
cleanup is careful, but a crashed or `SIGKILL`ed server leaves a modified
`project.godot` and ~15 files in the user's working tree. Two ways out, in
increasing order of ambition:

- `override.cfg`, which the engine merges over `project.godot` at startup, so the
  autoload is declared in a file we create and delete and never in a file the user
  tracks;
- or the persistent session, where the harness *owns* the main loop and
  instantiates the user's scene as a child — running their game inside us rather
  than injecting ourselves into their game, at which point there is nothing to
  inject.

**The session is headed. Always.** `--headless` swaps in the dummy display driver
*and* the dummy rasterizer, so viewport captures return nothing at all. An agent
that cannot render is an agent that cannot verify what it built, which makes
headless the wrong default for the only workflow this product exists to serve.
The session therefore runs headed, and a rendering context becomes a
prerequisite rather than a capability tier.

Headed does not mean "a human is watching": the context can come from a physical
display, from Xvfb (which the renderer CI jobs already use to capture and compare
real pixels), or from a nested compositor. Captures go through
`get_viewport().get_texture().get_image()`, which reads the framebuffer and not
the screen, so the window may be occluded, unfocused, or parked offscreen and
still produce correct pixels — proven at `--position 5000,5000`. Fast mode and
watch mode are therefore not process modes at all; they differ only in where the
window is.

The deliberate cost: an environment with no display at all — a bare container, a
remote shell — can no longer run the agent loop. That case is scoped out rather
than degraded, because supporting it means maintaining a second execution mode in
which the product's central promise silently does not work.

**"Headless" currently names two unrelated things and must stop.** In
`src/tool-manifest.ts`, `backend: { kind: 'subprocess' }` means *one-shot CLI
subprocess* and says nothing about displays, while the README support statement
means *no rendering context*. Phase 6 removes the first and scopes out the second,
so leaving both called "headless" makes every review in this phase ambiguous.
Rename the backend kind to `subprocess`.

**Human observability is a push, not a path.** `GameConnection` already emits
structured lifecycle events with correlation IDs. Fan them out over the existing
editor bridge into an addon dock and the human watches the agent's *intent*
scroll by, not just files flickering in the FileSystem panel — while the windowed
session shows them the game itself. Watch mode and fast mode therefore run the
same harness, the same protocol, and the same code path, differing only in where
the window goes. Two code paths would invite the failure that matters most here:
an agent that behaves differently when nobody is looking.

### Validated assumptions

Phase 6 was gated on four load-bearing assumptions. All four were spiked directly
against Godot 4.7 (`5b4e0cb0f`, X11, NVIDIA RTX 4070 Ti SUPER) before any
production code was written. **The plan survives; one assumption was wrong in the
project's favor.**

- **A windowed `--script` `SceneTree` renders.** Confirmed. `DisplayServer` is
  `X11`, the real GPU is bound, and `root.get_texture().get_image()` returns a
  1152x648 image whose every sampled pixel is the `ColorRect` red that was added
  to the tree. The persistent-session design is viable.
- **Autoloads are *not* skipped under `--script`.** Refuted, and this is the
  significant result. The plan assumed replacing the `MainLoop` would bypass the
  project's `[autoload]` entries, forcing the harness to re-implement autoload
  instantiation and accept a fidelity gap between the game under the agent and the
  shipped game — recorded above as the sharpest risk in the plan. It does not
  happen: the project autoload's `_init` and `_ready` both ran, and it is present
  under `root` as `MyAutoload`. The engine builds autoloads before handing control
  to the script's `MainLoop`. **The sharpest risk in Phase 6 does not exist**, and
  the harness-owned main loop is correspondingly more attractive.
- **`override.cfg` overrides `[autoload]`.** Confirmed, with clean add/remove
  semantics: absent, the autoload does not load; present, it loads and runs;
  removed again, it stops loading — and `project.godot` is never touched. This is
  the injection mechanism for 6b.
- **An offscreen window still renders.** Confirmed at `--position 5000,5000` and
  `--position -4000,-4000`, at both default and custom resolutions, with correct
  pixels. Captures read the framebuffer, not the screen, so no nested display or
  compositor is needed for the default workstation case; `gamescope` and a separate
  X display remain available but are no longer on the critical path.

The spike also produced a hazard worth writing down, because it will be
encountered again by anyone extending the harness: under `--headless`,
`RenderingServer.frame_post_draw` **never fires**, so `await`ing it deadlocks the
session permanently rather than failing. `root.get_texture()` is also null there
(not a black image) and raises `Parameter "t" is null`. Any capture path shared
between windowed and headless modes must branch on display availability rather
than awaiting a frame that will never come.

## Roadmap

### Phase 6: make the agent loop the product

Phases 0-5 proved the tools work. This phase makes them compose into an
autonomous author -> run -> observe -> assert -> edit loop that a human can watch.
Rationale and rejected alternatives are recorded under "End goal and architecture
direction"; the spikes below settle the assumptions that gate the rest.

#### 6a: settle the assumptions (spikes, no production code)

All four are settled against Godot 4.7; results and the deadlock hazard are
recorded under "Validated assumptions".

- [x] Prove a non-headless `--script` `SceneTree` obtains a rendering context and
  returns non-black pixels from `get_viewport().get_texture().get_image()`.
  (Renders on the real GPU; sampled pixels match the added `ColorRect` exactly.)
- [x] Prove `override.cfg` overrides `[autoload]` and that removing it restores
  the project cleanly. (Add/remove is clean; `project.godot` is never touched.)
- [x] Determine whether `--script` skips project autoloads. (**It does not.** The
  engine instantiates them before handing control to the script's `MainLoop`, so
  no re-implementation and no fidelity gap. This removes the plan's largest risk.)
- [x] Confirm a windowed session keeps rendering while parked offscreen, and
  evaluate a nested display as the isolation story. (Offscreen renders correctly;
  a nested display is available but is not on the critical path.)

#### 6b: stop mutating the user's project

Dependency note: 6c's final item may retire autoload injection entirely in
favor of the harness-owned main loop. If it does, the `override.cfg` mechanism
below becomes machinery for a retired path; the stale-installation reaper and
the SIGKILL byte-identity test remain valuable regardless, because
`run_project`'s inject-and-run mode survives at least as a verification mode
until that decision is confirmed against a real game.

- [x] Move runtime-server injection from rewriting `project.godot` to a generated
  `override.cfg`, keeping the existing ownership/cleanup semantics.
  (`InteractionServerInstaller` writes a sentinel-delimited `[autoload]` block
  into `override.cfg` — created and deleted by the server, merged over
  `project.godot` by the engine — and `project.godot` is never written. A
  user-owned `override.cfg` is preserved byte-identically around the block;
  an installation declared in `project.godot` stays user-managed and
  untouched. Unit-tested in `tests/interaction-server-installer.test.ts`,
  full-path in `tests/e2e/crash-recovery.test.ts`.)
- [x] Add a stale-installation reaper: on startup, detect and remove artifacts an
  earlier crashed or `SIGKILL`ed server left behind. (The MCP server is
  project-agnostic at process startup, so "startup" is first contact with the
  project: `reapStaleInstallation` runs before every install. Ownership is
  re-derived statelessly — the sentinel block, or scripts byte-identical to
  the shipped sources, prove the artifacts are ours; user-managed
  installations never lose files. Covered per-case in the unit suite and
  end-to-end in `tests/e2e/crash-recovery.test.ts`.)
- [x] Add a full-path test that a `SIGKILL`ed server leaves the project tree
  byte-identical to its pre-launch state.
  (`tests/e2e/crash-recovery.test.ts`: SHA-256 tree snapshot, `run_project`,
  SIGKILL the MCP server, assert the stale artifacts exist, then a second
  server reaps on first contact and a run/stop cycle restores the tree to an
  identical snapshot. Passing against Godot 4.7.)
- [x] Re-run the full MCP E2E matrix and Godot suites on 4.4 and 4.7 over the
  `override.cfg` injection. (Both engines pass 16 strict script parses, 70
  authoring-operation checks, 383 runtime checks, and the complete 29-file / 188
  test MCP E2E matrix. The floor run exposed and fixed two test-contract gaps:
  the 4.7-generated engine sample now records classes absent from 4.4 as
  explicitly inapplicable while retaining a minimum applicable sample, and the
  editor E2E opens and awaits its scene on 4.4 and always reaps the user-owned
  editor process.)

#### 6c: the persistent session

- [x] Extend the runtime JSON-RPC contract with the authoring commands currently
  served by `godot_operations.gd`, and make the operations script a long-lived
  `SceneTree` that serves them. (The authenticated session contract now
  publishes 16 collision-safe `authoring_*` commands. The operations script's
  `--serve-authoring` mode registers their dispatcher, advertises capability
  only in a harness-owned process, survives controlled failures, and is covered
  by real-engine success/write/failure/runtime/teardown checks.)
- [x] Port headless tools to the session one at a time through
  `ToolBackend`, which already models backend-per-tool; keep the subprocess path
  as a fallback until parity is proven. (All 16 authoring tools now declare an
  `authoring-session` command plus an explicit subprocess fallback in the
  manifest. A lazy per-project manager serializes and reuses the live process,
  preserves stdout parity for read/list/UID responses, and never replays a
  command after it may have mutated state. The complete 24-test authoring E2E
  suite runs through the session; a separate live-game case proves the fallback
  remains isolated and leaves the game connection intact.)
- [x] Add `--fixed-fps` and time-scale control so "wait N frames, then capture"
  means the same thing on every run. Determinism is miserable to retrofit.
  (Every MCP-owned long-running process now starts at fixed 60 FPS, a 60 FPS
  wall-clock cap, and time scale 1. The existing `game_time_scale` command is
  the explicit get/set control and reports the harness fixed-FPS metadata;
  direct authoring-session and full MCP E2E checks prove both initialization
  and mutation.)
- [x] Launch the session headed, and fail fast with an actionable error when no
  rendering context is reachable. Do not await `RenderingServer.frame_post_draw`
  without one: under `--headless` it never fires, so the session deadlocks instead
  of failing. (The session no longer passes `--headless` and requires the
  authenticated `rendering-context` capability before dispatch. Missing display
  access raises an actionable desktop/Xvfb error without falling back to a
  mutating subprocess. Screenshot checks the same precondition before yielding
  a frame; the real-engine suite proves both headed startup and immediate,
  structured `rendering_context_unavailable` rejection in a headless process.
  Linux CI now runs the session-bearing suites under Xvfb.)
- [x] Rename `ToolBackend`'s `headless` kind to `subprocess`, so "headless" means
  only "no rendering context" for the rest of this phase. (The manifest,
  coverage generator, routing contracts, and generated report now use
  `subprocess` for all 16 one-shot authoring operations.)
- [x] Retire the headless display tier from the support matrix: update the README
  support statement and `tests/support-policy.test.ts`, and replace the screenshot
  limitation path with the fail-fast precondition above. (The supported Linux
  matrix is now headed on a desktop or Xvfb. `run_project`, `launch_editor`, and
  the E2E harness no longer expose a headless lifecycle switch; main Linux CI
  supplies Xvfb. Screenshot, visual-regression, compound-verification, window,
  input, and renderer-buffer E2E cases now require their headed success paths
  instead of accepting dummy-display limitations. Display-less direct runtime
  requests retain the structured precondition error for actionable diagnosis,
  but are not a supported agent-loop tier.)
- [x] Benchmark a realistic edit -> run -> observe -> edit cycle against today's
  subprocess-per-operation path; the loop-latency delta is this phase's headline
  result and belongs in the coverage report. Record the latency budgets this
  establishes — this item carries the open "latency budgets" question from the
  closed pre-Phase-3 question list (`docs/plan-archive.md`). (The reproducible
  real-engine benchmark uses seven measured fresh projects per mode after
  warmup, alternates order, and verifies a headed run plus authenticated scene
  observation. On Godot 4.7, warm session command p95 is 13.74 ms versus
  210.26 ms for one-shot subprocesses — 93.5% lower — but the complete cycle is
  3431.58 ms versus 2445.02 ms median, 40.3% slower, because the current split
  lifecycle pays two ~1 s headed session startups. The generated coverage
  report publishes the headline, raw `loop-latency.json` records every sample,
  and checked budgets cap cycle median at 4.5 s / 1.6× baseline, session startup
  p95 at 1.5 s, and warm command p95 at 100 ms. This result makes preserving the
  warm main loop across run/observe the next architecture requirement.)
- [x] Decide whether the harness-owned main loop replaces autoload injection
  entirely, or whether inject-and-run survives as a high-fidelity verification
  mode alongside a fast iteration mode. The 6a spike moved this toward *replace*:
  autoloads run under `--script`, so the fidelity argument for inject-and-run is
  much weaker than assumed. Confirm against a real game before deciding.
  (**Decision: replace entirely.** A real-engine test now authors a scene,
  attaches and executes a user game script inside the harness-owned `SceneTree`,
  observes its `_ready` side effect over authenticated runtime JSON-RPC, edits
  the packed scene while it runs, and reloads and observes the edit without
  restarting the process. Autoloads, rendering, runtime commands, and user scene
  lifecycle all work on that path, so inject-and-run provides no demonstrated
  fidelity advantage. It instead preserves a divergent path and causes the two
  headed startups responsible for the benchmark's 40.3% cycle regression.
  `run_project` will therefore become scene load/reload in the persistent
  harness and the generated `override.cfg` injection path will be retired, not
  retained as a second “verification mode.”)

#### 6d: let a human watch

- [x] Fan `GameConnection`'s existing correlated lifecycle events out over the
  editor bridge and render them in an addon dock: command, target, outcome,
  duration, live. (`GameConnection` now emits typed start/finish/timeout events
  beside its redacted logs, with a bounded dock-only target and monotonic
  duration. Both running-game and authoring-session connections push them
  best-effort over the authenticated editor bridge; editor absence never blocks
  a command. The addon installs a bounded 200-row **Agent Activity** dock and
  exposes its state through `inspect`. Unit coverage verifies correlation,
  target, outcome, and duration; a headed real-editor E2E observes a successful
  targeted runtime command in the live dock.)
- [x] Push a filesystem rescan and scene reload to the open editor after the
  session writes, instead of relying on Godot's focus-triggered rescan.
  (Successful mutating authoring-session responses now emit normalized affected
  `res://` paths; reads/lists and failures do not. The authenticated addon calls
  `EditorFileSystem.scan()` and reloads the scene only when it is currently
  edited, while editor absence remains best-effort and cannot fail the write.
  Unit coverage verifies mutation/read classification, and a headed real-editor
  E2E authors a node, observes rescan/reload metadata, then selects the new node
  from the reloaded scene.)
- [x] Follow the agent's focus: select and reveal the node a command just touched,
  reusing `editor_control`'s `select`/`inspect`. (Authoring write events now
  derive a scene-relative `focus_path` for roots, added nodes, node mutations,
  and removal parents. After scene reload, the addon updates `EditorSelection`
  and calls `EditorInterface.edit_node`; explicit `editor_control select` shares
  the reveal behavior, and `inspect` reports the selection/focus outcome. Unit
  coverage verifies nested add-node path derivation, while headed editor E2E
  proves the newly authored node becomes selected without a separate tool call.)
- [x] Resolve concurrent editing. The agent writing a scene while a human holds
  unsaved changes to it loses someone's work, and Godot will not arbitrate. The
  proposed answer is a cooperative "agent is driving" lock in the addon, with a
  pause button that makes the server refuse mutating tools until resumed;
  dirty-buffer detection is more permissive but strands the agent in a state it
  cannot resolve on its own. (The **Agent Activity** dock now owns a visible
  agent-driving / human-editing state with **Pause Agent** and **Resume Agent**
  controls. Before handler dispatch, the server queries that authenticated state
  for every deny-by-default mutation classification; paused calls return an
  actionable MCP error while explicitly allowlisted observations still work.
  Editor absence allows unattended operation, and an optional start-paused
  environment setting supports human-first sessions. Contract coverage audits
  every allowlist exemption against the complete tool/action manifest, while a
  headed editor E2E proves a paused `add_node` is refused and leaves the scene
  unchanged.)

Exit criteria: an agent completes a non-trivial game end to end through the MCP
server, unattended, in a session whose loop latency is dominated by agent thinking
rather than engine startup; the project tree it worked in contains only the game;
and a human watching the addon dock can say what the agent did and why without
reading a log.

### Phase 7: make the surface usable by an agent

Every phase so far measured whether *tools work*. None measured whether an *agent
can use them*, and the audit's own conservatism makes the omission conspicuous: in
1,100 lines of plan, the agent is the subject of exactly one sentence, in Phase
6's exit criteria. "An agent can build games with this" is the only claim in the
repository with no evidence behind it.

Three measured facts define the gap:

- The server sends **no MCP `instructions`**. An agent receives a toolbox and no
  method. Phase 4 built compound workflows (`verify_project`, `run_project_tests`)
  precisely so agents would not hand-compose fragile call sequences, and then
  nothing tells the agent they exist.
- The full tool list is **167 tools, 93,694 bytes, roughly 23,424 tokens**, sent before
  the agent reads a word of the user's request. That is a selection problem as much
  as a budget one: `game_light_2d`, `game_light_3d`, `game_environment`, `game_sky`,
  and `game_gi` are near-neighbors an agent must discriminate from schema text
  alone, and there are 167 of them.
- Nothing anywhere **composes** the tools. Coverage proves each call reaches the
  engine; no test proves a sequence of them produces a game.

The user-facing goal this phase serves: *install the MCP server, point an agent at
a project, build a game.* This still requires no Godot AssetLib step — the runtime
reaches the game through a generated `override.cfg` and the observation dock is
installed by `EditorPluginInstaller`, so the user installs nothing inside Godot.
The pre-release plan adds an optional persistent AssetLib bridge for discovery
and a durable editor experience without making it an execution prerequisite.

#### 7a: ship a method, not just tools

- [x] Populate the MCP `instructions` field: the author -> run -> observe -> assert
  loop, when to reach for a compound tool instead of composing primitives, the
  privileged-command policy and how to enable it, and the fact that runtime
  injection and cleanup are automatic. (The initialization response now teaches
  that loop, names `verify_project` / `run_project_tests`, states automatic
  bridge lifecycle, and gives least-privilege and all-groups environment knobs;
  a full MCP client test reads the instructions from the handshake.)
- [x] Keep `instructions` short enough to earn its place in every context window;
  anything procedural and long belongs in 7c, not here. (The durable method is
  111 whitespace-delimited words and contract-gated at 120 words / 1,200 UTF-8 bytes;
  longer task procedures are reserved for the Phase 7c skills.)

#### 7b: progressive disclosure of the tool surface

- [x] Establish the token cost of the tool list as a tracked denominator, in the
  same spirit as the coverage denominators, and add a budget gate that fails when
  it regresses. The audit's discipline is that unmeasured things drift.
  (`tool-surface.json` now records the exact compact-JSON UTF-8 denominator and
  the plan's explicit `ceil(bytes / 4)` token estimate. The full 167-tool catalog
  is 93,694 bytes / ~23,424 tokens; the 39-tool default is 17,278 bytes / ~4,320
  tokens, an 81.56% reduction. Generation fails above full/core byte, core-token,
  core-count, or minimum-reduction budgets, and the coverage report publishes the
  same source-derived values.)
- [x] Cut the default surface an agent sees. Candidates, cheapest first: tighten
  descriptions and schemas; group tools by domain and expose a core set plus an
  explicit expansion tool; move reference detail out of schemas and into MCP
  **resources** the agent fetches on demand. (The static core covers the complete
  build -> run -> observe -> assert loop. `godot_tools` searches and describes
  all specialized tools, then validates and dispatches a selected hidden tool
  through the same mutation and privilege gates. `GODOT_MCP_TOOL_SURFACE=full`
  preserves full static discovery. A real-client/real-engine E2E discovers the
  hidden `game_light_3d`, creates a light through the dispatcher, independently
  observes it with a core tool, and covers malformed dispatch and cleanup.)
- [x] Verify what MCP clients actually support before designing around it —
  dynamic tool lists (`notifications/tools/list_changed`) and resource support vary
  by client, and a disclosure scheme that only works in one client is not shippable.
  (`docs/tool-disclosure.md` records the 2026-07-14 primary-doc check: MCP leaves
  resource presentation application-controlled and has no client capability with
  which the server can require list refresh; Claude Code documents automatic
  refresh, resources, and deferred Tool Search, while VS Code documents resources
  and manual cached-tool reset. The shipped core plus `godot_tools` therefore uses
  only static `tools/list` / `tools/call`; correctness depends on neither optional
  behavior.)

#### 7c: skills, so the agent lands on its feet

- [x] Ship the server as a plugin bundling **skills** alongside the MCP config, so
  procedural knowledge travels with the tools instead of living in a README the
  agent never reads. (`agent-plugin/` contains the Claude manifest, root MCP
  configuration pinned to the matching npm server release, and its skills; the
  npm package includes that directory. The repository also publishes a validated
  `.claude-plugin/marketplace.json`, so Claude Code can add the GitHub repository
  as a marketplace and install the bundled server and workflows together.)
- [x] Author the skills the end goal actually needs: building a game from nothing,
  verifying a change against the running game, and debugging a game that misbehaves.
  Each should name the tools it uses and the order to use them in. (The concise
  `build-godot-game`, `verify-godot-change`, and `debug-godot-game` skills each
  prescribe ordered author/run/observe/assert or reproduce/isolate/fix/retest
  workflows, compound-tool preference, independent evidence, and cleanup. A
  contract test locks their trigger metadata, tool names, order, and evidence
  language.)
- [x] Confirm the plugin/skill packaging mechanism against current Claude Code
  documentation rather than assumption; treat the bundling format as unverified
  until checked. (`docs/agent-plugin.md` records the 2026-07-14 primary-doc
  check for `.claude-plugin/plugin.json`, `.mcp.json`, `skills/<name>/SKILL.md`,
  and repository marketplaces. Claude Code 2.1.208 validates both marketplace
  and plugin, all three skill-creator validators pass, and `npm pack --dry-run`
  confirms the five plugin files ship in the package.)

#### 7d: prove it, or it is not true

- [x] Build the golden acceptance test: from a cold start, an agent builds a small
  but real playable game through the MCP server alone — scene, script, input,
  win/lose state — and the harness independently asserts it runs, responds to
  injected input, and renders the expected result. (A live Claude Code cold run,
  with built-ins disabled and no human correction, produced the working four-file
  game. `golden-agent-game.test.ts` distills its successful trace from an empty
  directory and independently proves authored files, compound verification,
  movement, WIN/LOSE UI, decoded rendered pixels, and cleanup.)
- [x] Make that build a release gate. It is the only test in the repository where
  the agent is the subject, and it is the one that matches the product claim.
  (`npm run test:golden-agent` is the focused command; the test is also included in
  the full `test:e2e` matrix on Godot 4.4 and 4.7 and is subject to the no-skip
  metadata gate.)
- [x] Record the agent's tool-selection failures from that run as findings. Wrong
  tool chosen, tool not found, compound tool ignored in favor of a fragile manual
  sequence: each is a 7a/7b/7c defect, and this is the only place they surface.
  (`docs/coverage/golden-agent-run.json` records seven observed findings: property
  shape ambiguity, tap-vs-hold schema ambiguity, the missed disclosure escape
  hatch, late compound verification, scene-read overfetch, and two smaller
  selection detours, with a concrete suggested improvement for each.)

Exit criteria: a cold agent, given only the MCP server and a project path, builds a
working game without human correction; the tool-surface budget is enforced; and the
skills, instructions, and compound tools are justified by observed agent behavior
rather than by our expectations of it.

**Met:** the cold run completed in 441 seconds and 173 turns with zero human
corrections; the deterministic release replay and selection evidence are documented
in `docs/golden-agent-acceptance.md`.

### Plan hygiene: keep this document truthful

The audit's discipline is that unmeasured things drift; the same applies to the
plan itself. These items fix places where the document now contradicts the
repository or itself.

- [x] Rewrite the stale CI bullet in "Limitations and robustness notes".
  (Rewritten below: CI now spans operating systems, renderers, .NET builds,
  and export templates; the bullet states what genuinely remains outside CI —
  hardware-only GI, non-Linux editor UI/rendering/exports, and audible
  output.)
- [x] Close out "Further questions to resolve before Phase 3". (Each question
  is resolved with the deciding test, job, or doc in the archived section
  "Further questions to resolve before Phase 3 (closed)" in
  `docs/plan-archive.md`; the genuinely open latency budgets are carried into
  6c's benchmark item, and remote add-on acquisition is recorded as outside
  the trust boundary.)
- [x] Label the audited-baseline table in the technical summary as historical
  on the table itself. (The table header row now reads "historical — audited
  baseline, since closed; current state is 166/166 E2E" in
  `docs/plan-archive.md`.)
- [x] Move the fully-checked material (Phases 0-5, the closed inventory
  detail) into an archive under `docs/`. (`docs/plan-archive.md` holds the
  technical summary, scope, methodology, tool inventory, P1-P3, Phases 0-5,
  and closed questions; this file now holds only the live work — 6b-6d, Phase
  7, the P4 decisions — plus the live discipline sections.)

## Required test dimensions

Every public tool/action must be assessed against these dimensions. “Not
applicable” must be recorded explicitly rather than silently skipped.

- happy path and independently observed result;
- required, optional, defaulted, enum, range, union, and structured parameters;
- invalid type/value, missing target, engine error, timeout, and cancellation;
- repeatability, idempotency where promised, and partial-failure atomicity;
- cleanup of nodes, resources, sockets, input state, temporary files, and child
  processes;
- scene reload/resource persistence for authoring operations;
- paused-tree, render-frame, and physics-frame behavior where relevant;
- project paths containing spaces and non-ASCII characters;
- large but permitted requests/responses and protocol limits;
- compatibility on Godot 4.4 and 4.7;
- Linux headless plus every additional platform or display mode claimed;
- standard and .NET Godot builds where the tool is language-sensitive;
- security policy and secret-redaction behavior for privileged operations.

## Definition of done

### Per tool

A tool may be marked `[x] E2E` only when all applicable items pass:

- [x] The tool is discoverable through MCP with the expected schema.
- [x] A real MCP client calls the built server.
- [x] The real handler and downstream service execute without monkeypatching.
- [x] The expected Godot process/server receives the operation.
- [x] Every public action has a successful real-engine case.
- [x] Every parameter family has boundary and default coverage.
- [x] The final effect is verified independently of the response.
- [x] Expected engine, validation, permission, timeout, and cancellation failures
  return stable structured errors.
- [x] Partial failures do not corrupt scenes, resources, settings, or files.
- [x] Repetition and concurrency behave according to the documented contract.
- [x] Teardown leaves no process, socket, held input, node, temporary artifact,
  ObjectDB instance, resource, or RID leak.
- [x] Applicable Godot versions, build flavors, renderers, and platforms pass.
- [x] Documentation states prerequisites, privilege level, side effects,
  limitations, and recovery behavior.

### Per capability family

- [x] The user workflow and non-goals are documented.
- [x] The minimal tool composition is usable without arbitrary `game_eval`.
- [x] The trust boundary and destructive effects are explicit.
- [x] At least one realistic fixture completes the entire workflow.
- [x] Failure recovery is tested at each external boundary.
- [x] Performance and response sizes are bounded on a representative large case.
- [x] Platform/version limitations are detected and returned, not silently
  ignored.
- [x] The workflow emits sufficient structured evidence for an agent to decide
  whether its intended result actually occurred.

### Release gate

- [x] Build, lint, TypeScript tests, and all Godot suites pass. (Locally verified
  together on Godot 4.7 after the portable agent bundle: 670 TypeScript tests,
  198 full-path E2E tests, 17 strict script parses, 2 focused validator checks,
  75 authoring-operation checks, and 383 runtime checks.)
- [x] The generated manifest has no coverage or routing drift. (`npm run check`
  runs the manifest/coverage contracts plus both the tool/action and zero-gap
  engine-surface report freshness gates.)
- [x] No unexpected engine warning, error, crash, sanitizer finding, or leak is
  present. (Every Godot runner applies the strict diagnostic allowlist gate.)
- [x] No required E2E test is skipped or quarantined. (Metadata enforcement
  rejects skipped, focused, todo, retried, or malformed quarantine entries.)
- [x] Compatibility floor and primary target pass. (The complete direct-Godot
  and MCP E2E matrices pass locally on 4.4 and 4.7; CI repeats both versions on
  pushes, pull requests, manual dispatches, and the weekly schedule.)
- [x] Required .NET, renderer, export, and platform jobs pass for the release's
  stated support matrix.
- [x] Security-sensitive tests confirm default denial, explicit opt-in,
  authorization, bounds, and redaction. (Runtime engine tests cover every
  privileged command; contract and E2E tests cover independent groups,
  authentication, payload bounds, audit events, and secret-safe failures.)
- [x] README counts, support statements, and limitations are generated or checked
  against the same manifest. (`coverage:check` verifies the report and README
  badge; `tests/support-policy.test.ts` verifies the support statements.)

## Implementation checklist for every new tool or action

- [x] Add or update the public tool schema.
- [x] Add strict runtime/headless parameter declarations.
- [x] Map the MCP tool to exactly one downstream operation or command.
- [x] Declare privilege, cancellation, timeout, mutation, and cleanup semantics.
- [x] Add unit tests for pure transformations and validation.
- [x] Add protocol/contract tests for routing and serialization.
- [x] Add focused direct-Godot behavior tests.
- [x] Add full MCP-to-Godot E2E happy-path and failure tests.
- [x] Add an independent effect assertion.
- [x] Add teardown/leak assertions.
- [x] Add version/platform/build-flavor cases or explicit non-applicability.
- [x] Update the traceability manifest and generated report.
- [x] Document examples, prerequisites, side effects, and limitations.

## Limitations and robustness notes

- Counts are at tool/command granularity. Several commands expose many actions,
  node classes, resource types, and mutually exclusive modes; the Phase 0
  manifest established the larger action-level denominator (358 action rows).
- A passing headless test does not establish editor behavior, rendering fidelity,
  OS input behavior, audio output, or export portability.
- CI spans Godot 4.4 and 4.7, Linux in depth plus Windows/macOS portable
  acceptance, Compatibility and Forward+ software rendering under Xvfb, Godot
  .NET builds with .NET SDK 8, and installed Linux export templates. What
  genuinely remains outside CI: hardware-only GI features, editor UI and
  rendering on non-Linux platforms, non-Linux export targets, and audible
  audio output.
- Some advanced engine features are intrinsically hardware-, platform-, codec-,
  or template-dependent. Tests should report capability-based skips only when
  the product also detects and explains that limitation to users.
- Visual and audio tests require deterministic state/assertion strategies; exact
  pixels or samples are inappropriate where renderer/device variance is expected.
- Security verification must assume another local process may connect. Loopback
  binding alone is not authentication.
