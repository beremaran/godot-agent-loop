# Godot MCP — working plan

Phases 0–5 of the verification and capability audit are complete: all 166
advertised tools are covered through the full MCP-to-Godot path, and all 334
public action rows resolve to E2E tests. The closed record — the audited
baseline, scope and methodology, the per-tool inventory, the P1–P3 capability
families, Phases 0–5, and the resolved pre-Phase-3 questions — is archived in
[`docs/plan-archive.md`](docs/plan-archive.md).

This file is the working plan for what remains: Phase 6b–6d (making the agent
loop the product), Phase 7 (making the surface usable by an agent), and the P4
engine-surface decisions. The discipline sections at the bottom — required
test dimensions, definition of done, and the implementation checklist — remain
the live gate for every new tool or action.

## P4: engine-surface gaps (handle classes)

Unlike the authored P1–P3 capability families (closed; see
[`docs/plan-archive.md`](docs/plan-archive.md)), these are derived
mechanically rather than authored:
`scripts/engine-surface-audit.js` classifies every class in Godot's own
`--dump-extension-api` output, and `docs/coverage/engine-surface.md` is the
generated result. Of 1,036 classes in Godot 4.7, 218 are named by our sources,
720 are generically reachable (`ClassDB`-instantiable, so `add_node` and
`game_eval` construct them; sampled and proven in `tests/e2e/engine-reach.test.ts`),
and 53 are scoped out in `docs/coverage/engine-scope.json` under eight grouped
reasons, each of which the audit fails if it stops matching any class.

That leaves 45, in two kinds. Each needs one of three outcomes: a tool, a proof
that `game_eval` already reaches it, or a line in `engine-scope.json` recording
why we do not care. The list regenerates from the engine, so it changes when
Godot does.

- [ ] Assign this section's exit criteria to a phase; it is currently the only
  open work owned by no phase. The editor-context decision below depends on the
  editor bridge that 6d extends, and `RenderingDevice`/`SceneState` interact
  with the seams 6c freezes (the persistent session and `read_scene`), so the
  decision — though not necessarily the implementation — must land before 6c
  completes.

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

- [ ] Decide whether outside-the-editor configuration is the right seam for an
  MCP server, or a limitation to close by reaching these through the editor
  bridge that `editor_control` already establishes.

### Handle classes (17)

Not `ClassDB`-instantiable, not a singleton, and with no instantiable subclass,
so the only way to hold one is to be handed it by an engine accessor that no
tool exposes. Not missing wrappers — missing *doorways*.

- [ ] **Rendering device:** `RenderingDevice` (135 methods). Reached via
  `RenderingServer.get_rendering_device()` / `create_local_rendering_device()`.
  The largest single gap by API surface; gates any compute-shader workflow.
- [ ] **Scene introspection:** `SceneState` (23 methods), via
  `PackedScene.get_state()`. Would give read-only structural inspection of a
  packed scene without instantiating it — plausibly useful to `read_scene`.
- [ ] **Audio stream playbacks:** `AudioStreamGeneratorPlayback`,
  `AudioStreamPlaybackPolyphonic`, `AudioStreamPlaybackInteractive`,
  `AudioStreamPlaybackPlaylist`, `AudioStreamPlaybackSynchronized`, and
  `AudioEffectSpectrumAnalyzerInstance`. All obtained from a player or bus effect
  after playback starts (`get_stream_playback()`, `get_effect_instance()`).
  Procedural audio generation and spectrum analysis are unreachable without them.
- [ ] **Networking handles:** `ENetPacketPeer` (from `ENetMultiplayerPeer`) and
  `TLSOptions` (from its static constructors). `TLSOptions` in particular gates
  authenticated/secure transport options on the existing networking tools.
- [ ] **XR:** `WebXRInterface` and `OpenXRFutureResult`. Both are obtained from
  `XRServer`. XR is not currently a claimed workflow — these are the strongest
  candidates for a scope-out line rather than a tool.
- [ ] **Remaining handles:** `GodotInstance`, `InstancePlaceholder` (from
  scenes loaded with `load_placeholder`), `SkinReference` (from
  `MeshInstance3D.get_skin_reference()`), `PackedDataContainerRef`, and
  `JavaScriptObject` (web-export only, so also a scope-out candidate).

Exit criteria: `docs/coverage/engine-surface.md` reports zero gaps, with every
class in this list resolved to a tool, a reachability proof, or a recorded
scope decision.

## End goal and architecture direction

Phases 0-5 established that the advertised surface is real: every tool reaches
Godot and every action is observed. That is a statement about *correctness*. It
says nothing about whether the surface composes into the thing it exists for.

**End goal: an agent builds a game end to end.** Not "an agent can call 166
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
`src/tool-manifest.ts`, `backend: { kind: 'headless' }` means *one-shot CLI
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
- [ ] Re-run the full MCP E2E matrix and Godot suites on 4.4 and 4.7 over the
  override.cfg injection (deferred at the user's request on 2026-07-14; the
  affected suites — crash-recovery, installer unit tests — pass on 4.7, and
  the three suites asserting the old `project.godot` mechanism were updated).

#### 6c: the persistent session

- [ ] Extend the runtime JSON-RPC contract with the authoring commands currently
  served by `godot_operations.gd`, and make the operations script a long-lived
  `SceneTree` that serves them.
- [ ] Port headless tools to the session one at a time through
  `ToolBackend`, which already models backend-per-tool; keep the subprocess path
  as a fallback until parity is proven.
- [ ] Add `--fixed-fps` and time-scale control so "wait N frames, then capture"
  means the same thing on every run. Determinism is miserable to retrofit.
- [ ] Launch the session headed, and fail fast with an actionable error when no
  rendering context is reachable. Do not await `RenderingServer.frame_post_draw`
  without one: under `--headless` it never fires, so the session deadlocks instead
  of failing.
- [ ] Rename `ToolBackend`'s `headless` kind to `subprocess`, so "headless" means
  only "no rendering context" for the rest of this phase.
- [ ] Retire the headless display tier from the support matrix: update the README
  support statement and `tests/support-policy.test.ts`, and replace the screenshot
  limitation path with the fail-fast precondition above.
- [ ] Benchmark a realistic edit -> run -> observe -> edit cycle against today's
  subprocess-per-operation path; the loop-latency delta is this phase's headline
  result and belongs in the coverage report. Record the latency budgets this
  establishes — this item carries the open "latency budgets" question from the
  closed pre-Phase-3 question list (`docs/plan-archive.md`).
- [ ] Decide whether the harness-owned main loop replaces autoload injection
  entirely, or whether inject-and-run survives as a high-fidelity verification
  mode alongside a fast iteration mode. The 6a spike moved this toward *replace*:
  autoloads run under `--script`, so the fidelity argument for inject-and-run is
  much weaker than assumed. Confirm against a real game before deciding.

#### 6d: let a human watch

- [ ] Fan `GameConnection`'s existing correlated lifecycle events out over the
  editor bridge and render them in an addon dock: command, target, outcome,
  duration, live.
- [ ] Push a filesystem rescan and scene reload to the open editor after the
  session writes, instead of relying on Godot's focus-triggered rescan.
- [ ] Follow the agent's focus: select and reveal the node a command just touched,
  reusing `editor_control`'s `select`/`inspect`.
- [ ] Resolve concurrent editing. The agent writing a scene while a human holds
  unsaved changes to it loses someone's work, and Godot will not arbitrate. The
  proposed answer is a cooperative "agent is driving" lock in the addon, with a
  pause button that makes the server refuse mutating tools until resumed;
  dirty-buffer detection is more permissive but strands the agent in a state it
  cannot resolve on its own.

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
- The tool list is **166 tools, 92,928 bytes, roughly 23,000 tokens**, sent before
  the agent reads a word of the user's request. That is a selection problem as much
  as a budget one: `game_light_2d`, `game_light_3d`, `game_environment`, `game_sky`,
  and `game_gi` are near-neighbors an agent must discriminate from schema text
  alone, and there are 166 of them.
- Nothing anywhere **composes** the tools. Coverage proves each call reaches the
  engine; no test proves a sequence of them produces a game.

The user-facing goal this phase serves: *install the MCP server, point an agent at
a project, build a game.* Note that this needs no Godot AssetLib step — the runtime
reaches the game through a generated `override.cfg` and the observation dock is
installed by `EditorPluginInstaller`, so the user installs nothing inside Godot.

#### 7a: ship a method, not just tools

- [ ] Populate the MCP `instructions` field: the author -> run -> observe -> assert
  loop, when to reach for a compound tool instead of composing primitives, the
  privileged-command policy and how to enable it, and the fact that runtime
  injection and cleanup are automatic.
- [ ] Keep `instructions` short enough to earn its place in every context window;
  anything procedural and long belongs in 7c, not here.

#### 7b: progressive disclosure of the tool surface

- [ ] Establish the token cost of the tool list as a tracked denominator, in the
  same spirit as the coverage denominators, and add a budget gate that fails when
  it regresses. The audit's discipline is that unmeasured things drift.
- [ ] Cut the default surface an agent sees. Candidates, cheapest first: tighten
  descriptions and schemas; group tools by domain and expose a core set plus an
  explicit expansion tool; move reference detail out of schemas and into MCP
  **resources** the agent fetches on demand.
- [ ] Verify what MCP clients actually support before designing around it —
  dynamic tool lists (`notifications/tools/list_changed`) and resource support vary
  by client, and a disclosure scheme that only works in one client is not shippable.

#### 7c: skills, so the agent lands on its feet

- [ ] Ship the server as a plugin bundling **skills** alongside the MCP config, so
  procedural knowledge travels with the tools instead of living in a README the
  agent never reads.
- [ ] Author the skills the end goal actually needs: building a game from nothing,
  verifying a change against the running game, and debugging a game that misbehaves.
  Each should name the tools it uses and the order to use them in.
- [ ] Confirm the plugin/skill packaging mechanism against current Claude Code
  documentation rather than assumption; treat the bundling format as unverified
  until checked.

#### 7d: prove it, or it is not true

- [ ] Build the golden acceptance test: from a cold start, an agent builds a small
  but real playable game through the MCP server alone — scene, script, input,
  win/lose state — and the harness independently asserts it runs, responds to
  injected input, and renders the expected result.
- [ ] Make that build a release gate. It is the only test in the repository where
  the agent is the subject, and it is the one that matches the product claim.
- [ ] Record the agent's tool-selection failures from that run as findings. Wrong
  tool chosen, tool not found, compound tool ignored in favor of a fragile manual
  sequence: each is a 7a/7b/7c defect, and this is the only place they surface.

Exit criteria: a cold agent, given only the MCP server and a project path, builds a
working game without human correction; the tool-surface budget is enforced; and the
skills, instructions, and compound tools are justified by observed agent behavior
rather than by our expectations of it.

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
  together on Godot 4.7: 601 TypeScript tests, 184 full-path E2E tests, 16 strict
  script parses, 70 headless checks, and 383 runtime checks.)
- [x] The generated manifest has no coverage or routing drift. (`npm run check`
  runs the manifest/coverage contracts and the generated-report freshness gate.)
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
  manifest established the larger action-level denominator (334 action rows).
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
