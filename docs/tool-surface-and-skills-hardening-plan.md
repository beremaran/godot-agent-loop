# Tool Surface, Human Control, and Shipped Skills Hardening Plan

> **Status:** completed 2026-07-17
> **Baseline:** 2026-07-17, 171 total tools, 40 default tools, Godot 4.7.1  
> **Goal-ready objective:** Harden Godot Agent Loop's MCP tool surface and four
> shipped skills so agents can reliably discover the right capability, form
> valid calls, distinguish persistent authoring from ephemeral runtime changes,
> wait for usable lifecycle states, produce typed evidence, and remain visibly
> under human control without exposing the complete catalog by default.

This is an interface and workflow hardening program. It is not a capability
expansion roadmap. The existing Godot/editor implementation, authenticated
bridges, undo integration, bounded observations, deterministic verification,
and full-catalog execution coverage should be preserved.

## Completion evidence

The historical 171/40 baseline above remains unchanged as audit evidence. The
completed candidate has 173 catalog tools and 42 tools on the canonical `core`
surface. The exact compact definition surface is 59,447 bytes (14,862 estimated
tokens), within the reviewed 60,000-byte/15,000-token budget justified in
`docs/coverage/core-budget-revision.json`; the full surface is 1,185,743 bytes.

- Deterministic discovery passes all 25 ranked intent cases, compared with 2/19
  in the preserved pre-change baseline. The cold-model runs recorded 1.0 recall
  at 1/3/5 for every applicable catalog target.
- Catalog metadata, input schemas, output schemas, titles, and all four MCP
  annotation hints cover 173/173 tools. All 2,255 input property nodes are
  described, and positive/negative schema parity covers every public action.
- Direct, hidden-dispatch, compatibility-dispatch, and scenario mutation paths
  share effective identity, pause policy, tracing, roots, progress,
  cancellation, structured results, and bounded observations. Runtime startup
  waits for an authenticated usable bridge and performs owned cleanup on
  failure.
- Watched editor attach/launch, disconnect, conflict, Activity, and pause paths
  have automated real-engine coverage. Current UI captures show both
  **Agent paused — human editing / Resume Agent** and **Agent is driving / Pause
  Agent** in `docs/launch/activity-paused.png` and
  `docs/launch/activity-resumed.png`.
- The build, debug, verify, and ship trigger boundaries pass their deterministic
  corpus. All nine external GPT-5.6 Luna/high scenarios pass: 28/28 acceptance
  criteria and 58/58 total checks, with no interventions or pause violations
  and clean teardown for every scenario. The durable record is
  `evals/current-model-status.json`.
- Final automated evidence includes 852/852 unit and contract tests; 401/401
  Godot runtime assertions across 19 parsed scripts; 209 passed and one
  intentionally skipped real-engine E2E test across 35 files; adapter smoke on
  `core` and `compact`; and candidate-tarball byte-identity/install checks.
- Compatibility is explicit: `compact` aliases `core`, while `godot_tools`
  remains callable but deprecated through the 1.x release line. Removal is
  reserved for a major release. MCP Tasks remain intentionally deferred until
  the protocol and a concrete workflow require them.
- Remaining release gates are honestly classified rather than treated as
  failures of this plan: Apple signing/notarization, unavailable target SDKs or
  export templates, target-hardware smoke tests, subjective game/audio feel,
  and hardware-specific GPU metrics require the corresponding external
  environment or manual review.

## Definition of done

The goal is complete only when all of the following are true:

- [x] Natural-language discovery finds every required core and hidden workflow
  capability in the committed discovery corpus at the required rank.
- [x] Read-only catalog inspection and arbitrary hidden-tool execution have
  separate advertised identities and conservative MCP annotations.
- [x] Activity, mutation policy, privilege policy, and project correlation use
  the effective nested tool rather than only its dispatcher wrapper.
- [x] **Pause Agent** blocks persistent and runtime mutations for the connected
  project, including indirect calls, while observation and safe teardown remain
  available.
- [x] Watched workflows attach to an existing editor or deliberately launch one;
  they never silently continue detached after the human asked to watch.
- [x] `run_project` reports success only after the runtime bridge is usable, or
  returns a bounded actionable failure and cleans up owned state.
- [x] Advertised input schemas match server validation, including unknown-field
  policy, action-specific requirements, structured Godot Variant shapes, and
  positive and negative examples.
- [x] Every tool has a human title, accurate effect/precondition metadata, a
  validated output contract, and structured success and error content while
  retaining compatible text content.
- [x] Scene and observation tools support concise, bounded reads without losing
  an explicit full-detail mode.
- [x] MCP roots, cancellation, and progress are honored where supported without
  breaking clients that omit them.
- [x] The build, debug, verify, and ship skills work against the default compact
  surface, use hidden tools deliberately, respect watched operation and human
  pause, and pass their own current-model scenario evaluations.
- [x] Current documentation and generated adapter metadata agree on surface
  mode, tool counts, discovery names, skills, and compatibility behavior.
- [x] Unit, contract, Godot, full MCP-to-Godot E2E, adapter, packaging, and
  cold-agent acceptance gates pass with no unexpected process, bridge, input,
  ObjectDB, or temporary-file leak.

## Recommended product decisions

These decisions should be treated as the default implementation direction. A
different choice needs recorded evidence and an update to this plan.

1. Keep progressive disclosure and a static compact default. Do not expose all
   171 schemas to every model.
2. Replace the exact default tool-count target with a compact-surface byte/token
   budget. A small increase above 40 tools is acceptable when evaluations prove
   it improves selection.
3. Split read-only discovery from hidden execution:
   - advertise `godot_catalog` for `search` and `describe`;
   - advertise `godot_call` for hidden execution;
   - continue accepting `godot_tools` as a deprecated compatibility alias for
     at least one minor release;
   - do not rely on dynamic `tools/list` refresh for required workflows.
4. Use deterministic local search first: weighted lexical ranking, curated
   aliases, fuzzy token matching, and intent metadata. Do not add a network or
   embedding-service dependency to basic discovery.
5. Treat **Pause Agent** as a project-wide human lock covering both persistent
   authoring and ephemeral runtime mutation.
6. Keep explicit `projectPath` on persistent tools. Resolve the authenticated
   connected project for pathless runtime commands instead of adding repetitive
   project arguments to every runtime tool.
7. Use a standards-compliant JSON Schema 2020-12 validator as the advertised and
   runtime source of truth rather than growing a partial parallel validator.
8. Add MCP `structuredContent` and `outputSchema` while retaining equivalent
   serialized JSON text for older clients.
9. Implement progress and cancellation now. Defer MCP Tasks until the protocol
   feature is stable and a concrete client workflow requires it.
10. Keep four focused shipped skills. Improve their triggers, workflows,
    metadata, and evaluations instead of adding a broad catch-all skill.

## Audited baseline to preserve

- The full catalog contains 171 tools; the default core contains 40.
- The serialized full definition surface is approximately 98 KB versus 20 KB
  for the compact surface, an approximately 80% reduction.
- The catalog includes 79 multi-action tools and 108 runtime tools.
- Input-property coverage is generally strong: only 27 of 833 inspected
  property nodes lack descriptions, all inside `editor_transaction`,
  `game_wait_until`, and `game_scenario`.
- The historical cold-agent run exposed four high-value problems: structured
  property-shape mistakes, tapping instead of holding input, missed hidden-tool
  discovery, and broad `read_scene` responses.
- At this baseline `npm run check` passes 753 tests and all static audit gates.
  `GODOT_BIN=/Applications/Godot.app/Contents/MacOS/Godot npm run
  coverage:engine -- --check` passes against Godot 4.7.1.
- The complete real-engine E2E suite was not rerun during the audit and remains
  a required final gate for this plan.

## Phase 0 — Freeze the interface baseline and evaluation corpus

### 0.1 Record machine-readable surface facts

- [x] Add a generated/current surface report containing:
  - advertised and full tool counts;
  - serialized bytes and estimated tokens;
  - domain, backend, action, privilege, and effect-scope counts;
  - core-versus-hidden membership;
  - input/output schema coverage;
  - titles and annotation coverage;
  - skill-to-tool references.
- [x] Replace tests that assert an unexplained exact count with tests for:
  - uniqueness and registry/handler/manifest completeness;
  - the explicitly reviewed core membership;
  - a compact byte budget of at most 26 KB and estimated budget of at most
    6,500 tokens, unless a checked-in evaluation justifies a revision;
  - generated count consistency across docs and adapter manifests.
- [x] Preserve historical counts in historical evidence files; label them as
  historical instead of mechanically rewriting them.

### 0.2 Commit a discovery-intent corpus

- [x] Add deterministic search cases for at least these intents:
  - hold input while moving;
  - tap a key once;
  - release held input;
  - add or change 2D and 3D lighting;
  - play audio and inspect audio state;
  - export a game and inspect readiness;
  - rename an asset safely;
  - inspect resource dependencies;
  - wait until a label or property changes;
  - compare a screenshot;
  - create terrain;
  - inspect imports, addons, .NET status, and project integrity;
  - distinguish persistent scene creation from runtime-only node spawning.
- [x] Store expected top result, acceptable alternatives, forbidden unsafe or
  wrong-scope results, and maximum acceptable rank for each case.
- [x] Include spelling variants, snake-case fragments, action verbs, Godot class
  names, user-language phrases, and terse agent-style queries.
- [x] Add a baseline report showing the current failures before changing search.

### 0.3 Define agent-level scenario evaluations

- [x] Define a compact-surface, no-skill discovery scenario.
- [x] Define one primary scenario and at least one failure/edge scenario for each
  shipped skill.
- [x] Capture metrics consistently:
  - task and acceptance-criterion success;
  - tool-selection precision and search recall at 1/3/5;
  - invalid calls and self-correction count;
  - calls, elapsed time, and response bytes;
  - detached/editor/runtime state mistakes;
  - human interventions and pause violations;
  - trace accuracy and cleanup state.
- [x] Version the model/client/prompt/tool-surface inputs with each result.

### Phase 0 acceptance gate

- [x] Baseline generation is deterministic and checked by CI.
- [x] The known failed queries fail in the recorded pre-change baseline.
- [x] Every later phase can demonstrate improvement against the same corpus.

## Phase 1 — Effective-call identity and human control

### 1.1 Centralize effective call resolution

- [x] Introduce one execution-context representation containing:
  - advertised wrapper name, if any;
  - effective tool name and arguments;
  - parent scenario/transaction identifier, if any;
  - resolved project path and connection identity;
  - domain, backend, effect scope, privilege group, mutation classification;
  - request, trace, and optional progress identifiers;
  - cancellation signal.
- [x] Resolve and validate this context before mutation guard, privilege checks,
  Activity tracing, synchronization, and handler dispatch.
- [x] Preserve parent and child trace relationships for `godot_call` and
  `game_scenario` rather than flattening everything into the outer tool.
- [x] Remove lifecycle outcome inference from response-text regexes. Have
  handlers or a common response builder return structured outcome metadata.
- [x] Redact secrets and bounded payload fields before Activity or debug logging.

### 1.2 Split catalog inspection from execution

- [x] Add read-only `godot_catalog` with `search` and `describe` actions.
- [x] Add conservatively mutating/destructive `godot_call` with a single hidden
  tool execution action.
- [x] Reject recursive dispatcher calls and unsupported scenario nesting.
- [x] Return the effective tool name, scope, privilege group, and trace ID in
  dispatcher results.
- [x] Keep the existing `godot_tools` handler as a deprecated compatibility
  alias and test old clients against it.
- [x] Update the Pi adapter and human-facing display precedence to use MCP
  `tool.title`, then legacy annotation title, then name.

### 1.3 Make Pause Agent authoritative

- [x] Resolve pathless runtime calls to the authenticated connected project.
- [x] Apply pause to direct, dispatched, and scenario-contained mutations.
- [x] Keep these classes callable while paused:
  - status, logs, errors, screenshots, scene/UI/property reads;
  - `stop_project`, held-input release, bridge cleanup, and safe disconnect;
  - explicit Resume Agent initiated by the human UI.
- [x] Decide and document how queued work responds to pause: do not start a new
  mutation after pause is observed; cancel only when the operation is safely
  cancellable; otherwise finish the atomic unit and report it.
- [x] Show the blocked effective tool and reason in Activity.

### 1.4 Human-control tests

- [x] Test direct persistent mutation while paused.
- [x] Test hidden persistent mutation through the compatibility and new
  dispatchers while paused.
- [x] Test pathless runtime property, input, scene, and audio mutations while
  paused.
- [x] Test a scenario paused before start and paused between steps.
- [x] Test read-only observation, input release, stop, and cleanup while paused.
- [x] Test no-editor/unattended operation and editor disconnect during a check.
- [x] Test trace and Activity fields for success, failure, conflict, fallback,
  paused, cancellation, and nested calls.

### Phase 1 acceptance gate

- [x] No mutating call path bypasses pause because its project path is nested or
  implicit.
- [x] Human-visible records identify the actual capability and scope used.
- [x] Discovery can be approved as read-only without implicitly approving hidden
  mutation.

## Phase 2 — Discovery, summaries, and on-demand tool guidance

### 2.1 Build a deterministic ranked catalog

- [x] Index tool name, split snake-case tokens, short summary, actions, aliases,
  tags, Godot concepts/classes, effect scope, preconditions, examples, and
  related tools.
- [x] Implement weighted ranking rather than all-term substring filtering.
- [x] Support normalized tense/plural forms, fuzzy matching for small typos, and
  curated product synonyms without a network dependency.
- [x] Give exact names/actions a strong boost without allowing definition order
  to determine tied results silently.
- [x] Return a score or match explanation suitable for debugging evaluations.
- [x] Add filters for domain, backend, effect scope, required state, privilege,
  and read-only/mutating behavior.
- [x] Prefer persistent authoring tools for create/save/project requests and
  runtime tools for inspect/playtest/temporary requests.

### 2.2 Add rich catalog metadata

- [x] Extend the catalog's source of truth with:
  - concise advertised summary;
  - human title;
  - detailed purpose;
  - when to use and when not to use;
  - aliases and intent tags;
  - required editor/runtime/project state;
  - effect scope: read-only, project-persistent, runtime-ephemeral, process, or
    external/open-world;
  - mutation, destruction, idempotency, and privilege data;
  - action-specific requirements;
  - realistic positive examples and common invalid examples;
  - output summary, warnings, fallbacks, and remediation;
  - preferred alternatives and related tools.
- [x] Populate all core tools and every tool referenced by a shipped skill
  manually before relying on generated fallbacks.
- [x] Fill the 27 missing property descriptions in the compound core tools.
- [x] Replace the 80-character per-description test with quality and total
  compact-budget checks.
- [x] Make `describe` return detail levels such as `summary`, `schema`, and
  `full`, with `summary` as the default.

### 2.3 Correct core input discoverability

- [x] Add `game_key_hold` to the default surface.
- [x] Describe `game_key_press` explicitly as a one-frame tap and state when to
  use hold/release instead.
- [x] Keep `game_key_release` in the default surface for deterministic cleanup.
- [x] Review the rest of the compact membership against build/debug/verify/ship
  evaluations. Do not preserve an exact count at the expense of successful use.
- [x] Record why each core tool is present and which common workflow it serves.

### Phase 2 acceptance gate

- [x] Every required discovery-corpus intent has the expected result in the top
  three and no unsafe/wrong-scope result above an explicitly preferred tool.
- [x] All 171 tools have non-empty scope, state, mutation, and discovery metadata.
- [x] An agent can distinguish tap/hold/release and persistent/runtime creation
  using only advertised summaries plus one catalog detail call.

## Phase 3 — Input schema and validation contract

### 3.1 Make JSON Schema the source of truth

- [x] Adopt JSON Schema 2020-12 validation for the complete tool catalog.
- [x] Advertise `$schema`, object type, and `additionalProperties: false` at the
  top level and in closed nested objects.
- [x] Mark intentionally free-form Godot Dictionary/Variant objects as open and
  explain that exception in their descriptions.
- [x] Validate normalized arguments once, then pass the validated value through
  policy and handlers without a second divergent structural parser.
- [x] Preserve path, privilege, authentication, and engine/business validation
  after structural validation.
- [x] Return model-recoverable argument errors as `isError: true` structured tool
  results with field paths and remediation. Reserve protocol errors for unknown
  methods/tools and malformed MCP requests.

### 3.2 Encode compound tools accurately

- [x] Model `editor_transaction.operations` as a discriminated union with
  operation-specific required and forbidden fields.
- [x] Model every `game_wait_until` condition as a discriminated union with
  required node/group/property/text/value parameters and bounded timeouts.
- [x] Model every `game_scenario` step as a discriminated union and define an
  explicit safe tool/action allowlist.
- [x] Encode exactly one of key, input action, or text for key input tools.
- [x] Encode action-specific requirements for `editor_control`.
- [x] Audit and encode the remaining multi-action tools in batches by domain;
  every one of the 79 multi-action tools must finish with positive and negative
  action samples.

### 3.3 Standardize Godot Variant inputs

- [x] Define canonical schemas and examples for Vector2/3/4, integer vectors,
  Color, Rect2, Transform2D/3D, Basis, Quaternion, NodePath, StringName, RID,
  arrays, dictionaries, resources, and typed wrappers.
- [x] Accept only intentionally supported shorthand forms and document how they
  are disambiguated.
- [x] Reject unconvertible shapes before executing or reporting success.
- [x] Include the target property type and accepted shape in conversion errors.
- [x] Test the historical array-versus-component-object Vector/Color failures.
- [x] Independently re-read saved values after authoring in E2E tests.

### 3.4 Full-catalog schema quality gates

- [x] Require descriptions on all properties, union branches, array items, and
  action discriminators.
- [x] Require examples for complex objects and every action family.
- [x] Validate committed positive examples against their schemas.
- [x] Assert committed negative examples fail for the intended reason and field.
- [x] Assert the advertised schema and runtime validator accept and reject the
  same generated corpus.

### Phase 3 acceptance gate

- [x] No known handler-only structural requirement is absent from the advertised
  schema.
- [x] Unknown fields, missing conditional fields, and invalid Variant shapes
  produce actionable tool errors without reaching Godot.
- [x] All 171 tools and all public actions pass schema parity tests.

## Phase 4 — Structured outputs, errors, annotations, and observability

### 4.1 Define common response contracts

- [x] Extend tool definitions with MCP `title`, `outputSchema`, `annotations`,
  and supported execution metadata.
- [x] Define a common metadata object containing effective tool, project, effect
  scope, trace ID, duration, warnings, fallback/synchronization status, and
  cleanup state where applicable.
- [x] Define a common error object containing stable code/category, message,
  field or engine location, retryability, remediation, and bounded details.
- [x] Return schema-valid `structuredContent` and equivalent JSON text during the
  compatibility period.
- [x] Keep image/audio/binary content blocks and place their typed metadata in
  `structuredContent`.

### 4.2 Migrate tools in risk/traffic order

- [x] Batch 1: `godot_catalog`, `godot_call`, editor session/control/transaction,
  run/stop, wait/scenario, and verification.
- [x] Batch 2: scene/settings/file reads and mutations, validation, logs/errors,
  screenshots, project tests, import, integrity, .NET, and export.
- [x] Batch 3: remaining runtime inspection and mutation tools.
- [x] Batch 4: remaining project, CI/container, networking, and open-world tools.
- [x] Require schema validation of every structured success and error result in
  unit and E2E tests.

### 4.3 Add conservative human-facing annotations

- [x] Add accurate `readOnlyHint`, `destructiveHint`, `idempotentHint`, and
  `openWorldHint` to every advertised tool.
- [x] Mark `godot_catalog` read-only and closed-world.
- [x] Mark `godot_call` conservatively mutating, potentially destructive, and
  open-world because its effective target varies.
- [x] Split additional mixed-action tools only when one conservative annotation
  would make normal approval materially misleading.
- [x] Treat annotations as hints; continue enforcing server policy independently.

### 4.4 Replace text scraping in internal control flow

- [x] Drive trace outcome, synchronization, fallback, conflict, pause, and retry
  behavior from typed internal results.
- [x] Remove regex classification over the first text content block.
- [x] Include child outcomes in scenario and dispatcher parent summaries.
- [x] Ensure Activity remains concise and cannot expose secrets or unbounded
  response bodies.

### Phase 4 acceptance gate

- [x] Every tool result validates against its advertised output schema.
- [x] Older text-only clients continue receiving equivalent content.
- [x] Activity outcomes remain correct when content order or prose changes.
- [x] Client UIs can display meaningful titles and conservative operation hints.

## Phase 5 — Lifecycle, workspace boundaries, cancellation, and response size

### 5.1 Make watched editor behavior explicit

- [x] Document `editor_session` as the canonical attach/status/disconnect flow.
- [x] Keep `launch_editor` as a compatibility convenience unless usage evidence
  supports later deprecation.
- [x] Preserve the existing API default where needed, but require skills to call
  `editor_session ensure` with `launchIfNeeded: true` when the human asks to
  watch and no reusable editor is present.
- [x] Return explicit attached/launched/detached/restart-required states with
  remediation and addon compatibility details.
- [x] Never interpret “no editor found” as permission to continue detached after
  a watched request. Stop with a clear blocker if launch cannot succeed.
- [x] Test existing editor, absent editor, stale addon, restart required, editor
  exit, unsaved conflict, and multiple-project selection.

### 5.2 Make runtime startup atomic from the caller's perspective

- [x] Have `run_project` wait for process start, authenticated bridge connection,
  and an initial usable command response within a bounded timeout.
- [x] Return `process_started`, `runtime_connected`, project/scene identity,
  engine version, startup duration, and bounded startup diagnostics.
- [x] On connection failure, stop owned processes, remove transient bridge files,
  release input, and return actionable structured failure.
- [x] Make repeated run/stop requests deterministic and ownership-aware.
- [x] Keep an explicit connection wait condition for reconnect and advanced
  workflows, but do not require it after an ordinary successful `run_project`.

### 5.3 Honor MCP cancellation and progress

- [x] Pass the MCP request `AbortSignal` through registry, execution context,
  subprocesses, editor commands, runtime requests, tests, imports, builds,
  exports, waits, and scenarios.
- [x] Map cancellation to safe subprocess termination and existing runtime cancel
  commands without deleting user-owned state.
- [x] Send progress only when the client provides a progress token.
- [x] Report meaningful completed/total stages for imports, project tests, .NET
  restore/build, export readiness/export, and scenarios.
- [x] Test cancellation before start, during work, after completion races, and
  while paused; verify cleanup and one terminal result.
- [x] Do not advertise MCP task support in this program.

### 5.4 Support MCP Roots safely

- [x] When the client advertises Roots, request and canonicalize file roots and
  refresh them after roots-list changes.
- [x] Intersect client roots with `GODOT_MCP_ALLOWED_DIRS`; neither source may
  broaden the other.
- [x] Reject project and relative paths outside the effective session boundary,
  including symlink and case-normalization escapes.
- [x] Retain the legacy fallback for clients with neither roots nor configured
  directories during the compatibility period, but emit a bounded startup or
  catalog warning explaining the unrestricted boundary.
- [x] Document a future secure-default change separately if it requires a major
  release.

### 5.5 Make observations concise by default without breaking callers

- [x] Add `read_scene` selectors for node path, property names, maximum depth,
  authored-only values, defaults, resources, and response limit.
- [x] Add `compact`, `authored`, and `full` detail modes.
- [x] During the compatibility period, preserve legacy behavior when no detail
  option is supplied; update skills to request the concise mode explicitly.
- [x] Measure response bytes and truncation metadata for scene, tree, UI, node,
  logs, errors, and debug reads.
- [x] Use cursors or continuation tokens where repeated observation can avoid
  retransmitting unchanged history.
- [x] Never silently truncate without reporting limit, returned count, and a
  continuation/refinement path.

### Phase 5 acceptance gate

- [x] A successful watched run is immediately usable by the next runtime call.
- [x] Cancellation leaves no owned process, bridge, held input, or temporary
  artifact behind.
- [x] Root-aware clients cannot escape their effective workspace boundary.
- [x] Common scene-inspection scenarios consume materially fewer response bytes
  than the baseline while full detail remains available.

## Phase 6 — Rehaul the four shipped skills

The skills are part of the public agent interface. They must be concise enough
to load reliably, but explicit enough to select valid tools and preserve human
expectations. Critical rules must remain in each `SKILL.md`; optional detail may
live in linked references, but no required safety or lifecycle behavior may
depend on a client automatically loading an extra file.

### 6.1 Establish a shared skill contract

- [x] Update all four skill trigger descriptions so their boundaries are clear:
  - **build:** create a new game or implement a substantial playable feature;
  - **debug:** reproduce, diagnose, and repair a failure;
  - **verify:** inspect and prove an existing change without assuming permission
    to modify it;
  - **ship:** prepare and gate reproducible release artifacts.
- [x] Add positive and negative trigger-prompt tests to prevent build/debug/
  verify/ship overlap.
- [x] Extend adapter metadata with a machine-readable tool contract per skill:
  - tools callable directly on the compact surface;
  - hidden tools that require catalog inspection and `godot_call`;
  - privileged groups that may be used only when already enabled;
  - expected persistent/runtime effect scopes.
- [x] Test every backticked tool reference against the actual catalog and skill
  tool contract.
- [x] Fail when a skill directly instructs use of a hidden tool without the
  catalog/detail/dispatch sequence.
- [x] Give all four skills consistent `agents/openai.yaml` interface metadata,
  generated or checked against the adapter manifest.
- [x] Keep each primary skill concise, preferably at or below 120 lines. Replace
  the current arbitrary 100-line test with a reviewed context budget and content
  assertions.

Every skill must explicitly cover:

- [x] supported Godot 4.7 boundary;
- [x] project/root validation before mutation;
- [x] watched attach-or-launch versus unattended operation;
- [x] persistent authoring versus runtime-ephemeral tools;
- [x] compact direct tools versus hidden catalog tools;
- [x] bounded wait/scenario use instead of manual polling or sleeps;
- [x] tap versus hold/release input and cleanup of held state;
- [x] human Pause Agent semantics and no attempt to bypass it;
- [x] static validation before runtime proof when persistent files changed;
- [x] independent evidence rather than trusting mutation responses;
- [x] errors, warnings, fallbacks, unsupported metrics, subjective gaps, and
  cleanup in the final report;
- [x] privileged reflection/evaluation only when already enabled and necessary.

### 6.2 Rework `build-godot-game`

- [x] Begin by extracting a small acceptance contract: playable loop, controls,
  visible feedback, ordinary state, success/failure transitions, and requested
  watch mode.
- [x] Inspect an existing project in concise mode before writing; create a
  project only when `project.godot` is absent.
- [x] Attach or launch the editor when watched, and stop if watched operation
  cannot be established.
- [x] Prefer one coherent editor transaction/undo step per human-readable change.
- [x] Include canonical Variant/property examples where the skill demonstrates
  scene authoring.
- [x] Require meaningful persisted scene hierarchy unless the user requests or
  accepts a procedural design.
- [x] Resolve hidden integrity/import/resource capabilities through catalog
  detail and dispatch rather than naming them as directly available.
- [x] Use named input actions and use hold/release for continuous movement.
- [x] Prove baseline play plus requested win/lose or equivalent completion/failure
  transitions with independent observations.
- [x] Keep asset-license, attribution, performance-budget, and game-only project
  cleanup guidance, but distinguish mandatory gates from conditional polish.

Build evaluation:

- [x] From an empty compact-surface project, create a watched minimal game using
  continuous movement, visible state, and independently proven success/failure.
- [x] Verify the agent does not simulate held movement with repeated tap calls,
  silently continue detached, or leave transient bridge/test artifacts.

### 6.3 Rework `debug-godot-game`

- [x] Require preservation of a reproducible baseline before editing.
- [x] Classify the failing boundary explicitly: parse/startup, persistent scene
  or resource, import, runtime state, input/timing, rendering, audio, export, or
  platform/toolchain.
- [x] Use bounded/cursor-based logs and errors and capture the minimum relevant
  scene/UI/screenshot evidence.
- [x] Require one falsifiable hypothesis and a distinguishing observation before
  mutation; keep one independent variable per trial.
- [x] Stop runtime before persistent repair unless the chosen editor-native
  operation is explicitly safe during play and the skill records why.
- [x] Discover hidden resource/debug tools deliberately and preserve reflection
  privilege rules.
- [x] Repeat the exact reproduction and adjacent regression checks after the
  smallest repair.
- [x] Separate objective performance measurements from unavailable GPU metrics
  and subjective reports of feel.

Debug evaluation:

- [x] Diagnose a seeded input/timing or scene-state regression, change only the
  causal artifact, rerun the same reproduction, and report independent evidence.
- [x] Include a misleading nearby symptom to ensure the agent tests its
  hypothesis instead of applying a broad speculative edit.

### 6.4 Rework `verify-godot-change`

- [x] State that verification alone authorizes observation, not corrective
  mutation; report a failed criterion unless the user also requested a fix.
- [x] Translate the requested change into saved-state, runtime, rendered,
  timing, log/error, and subjective/manual-review criteria as applicable.
- [x] Prefer `verify_project` and project tests, then use realtime interaction
  only for behavior the compound tools cannot prove.
- [x] Use concise reads, bounded waits, scenarios, and correct tap/hold/release
  semantics.
- [x] Require a negative-evidence pass for errors, warnings, leaks, fallbacks,
  cleanup, and adjacent regressions.
- [x] Explicitly reject screenshots as sole proof of behavior, audio quality, or
  game feel.
- [x] Report unobserved criteria as incomplete rather than inferring success.

Verify evaluation:

- [x] Verify a supplied change with one objective passing criterion, one
  regression criterion, and one deliberately subjective criterion.
- [x] Confirm the agent neither edits the project nor claims the subjective
  criterion was automatically proven.

### 6.5 Rework `ship-godot-game`

- [x] Start with an explicit release matrix: targets, engine/build flavor,
  renderer, .NET, presets, templates, signing, expected outputs, and which gates
  are local versus CI/manual.
- [x] Discover all hidden integrity, import, addon, .NET, and export-readiness
  tools through the compact catalog contract.
- [x] Keep inspection actions read-only until the user authorizes repairs or
  release mutations.
- [x] Require project tests and representative gameplay verification before
  final export.
- [x] Require independent artifact existence, type, size, sidecar/pack, hash,
  and supported smoke-run evidence.
- [x] Never imply unavailable export templates, platform SDKs, signing identities,
  or target hardware passed.
- [x] Preserve user addons and release artifacts; delete only identified
  generated probes and MCP-owned transient files.
- [x] Produce a concise release verdict with passed, failed, blocked, manual, and
  unsupported gates.

Ship evaluation:

- [x] Run against a project with one available local export target and one
  intentionally unavailable/signing-dependent target.
- [x] Confirm the available artifact is independently inspected and the
  unavailable target remains explicitly blocked rather than claimed.

### 6.6 Cross-client skill packaging and behavior

- [x] Regenerate and validate Claude Code, Codex/ChatGPT, OpenCode, and Pi
  adapter metadata after skill changes.
- [x] Test the four skill inventories, descriptions, default prompts, OpenAI
  interface files, and MCP surface environment from installed package layouts.
- [x] Run adapter smoke tests against both `core` and the supported `compact`
  compatibility alias during migration.
- [x] Test public-package paths from a packed artifact, not only the checkout.

### Phase 6 acceptance gate

- [x] Every skill references only valid tools using the correct direct or hidden
  invocation flow.
- [x] All trigger tests and four agent-level scenario evaluations pass.
- [x] Watched, pause, persistence, input cleanup, evidence, and teardown rules
  are observable in skill behavior, not merely present as prose.
- [x] All supported adapters install the same four canonical skill versions.

## Phase 7 — Documentation, compatibility, and release evidence

### 7.1 Synchronize current documentation

- [x] Update README, `docs/tools.md`, `docs/tool-disclosure.md`,
  `docs/agent-plugin.md`, adapter acceptance, and relevant architecture docs.
- [x] Replace current stale 39-tool references with generated current facts.
- [x] Use one canonical surface term, `core`, while accepting `compact` as a
  documented compatibility alias.
- [x] Document `godot_catalog`, `godot_call`, and the `godot_tools` deprecation
  window with examples.
- [x] Document titles, annotations, structured output, errors, roots, progress,
  cancellation, effect scopes, watched mode, runtime readiness, and Pause Agent.
- [x] Document concise versus full scene observation.
- [x] Update public tool and runtime schema artifacts from source.

### 7.2 Add migration and compatibility coverage

- [x] Test an old client using `godot_tools search`, `describe`, and `call`.
- [x] Test `GODOT_MCP_TOOL_SURFACE=compact`, `core`, and `full` explicitly;
  reject unknown mode values instead of silently treating them as core.
- [x] Test text-only response consumption alongside structured clients.
- [x] Test clients with and without roots, progress tokens, cancellation, and
  annotation display.
- [x] Record any intentionally breaking behavior for the next major release
  rather than smuggling it into a minor release.

### 7.3 Refresh end-to-end and cold-agent evidence

- [x] Run `npm run check`.
- [x] Run `npm run test:godot` with the supported Godot 4.7 binary.
- [x] Run `npm run test:e2e` through the built MCP server and real engine.
- [x] Run engine-surface coverage checks and regenerate current reports.
- [x] Run adapter/package smoke tests from the candidate tarball.
- [x] Run the compact no-skill and four skill evaluations from Phase 0.
- [x] Compare against the historical golden run and report selection, invalid
  call, latency, response-size, trace, intervention, and cleanup changes.
- [x] Capture watched-editor evidence for attach, launch, Activity, pause/resume,
  unsaved conflict, and teardown.
- [x] Require a clean worktree after generated-file synchronization and tests.

### Phase 7 acceptance gate

- [x] All automated and real-engine gates pass on the supported Godot baseline.
- [x] Current docs, schemas, adapter manifests, package contents, and observed
  MCP discovery agree.
- [x] Cold-agent evaluations show no recurrence of the historical hold,
  property-shape, hidden-discovery, or unbounded-read failures.
- [x] Release evidence clearly lists any remaining manual or platform-specific
  gates.

## Cross-cutting test matrix

Each affected capability should be assessed against the applicable rows below.
“Not applicable” must be explicit in test metadata rather than silently omitted.

- [x] Direct advertised call, hidden dispatched call, and scenario-contained call.
- [x] Read-only, persistent mutation, runtime mutation, process lifecycle,
  destructive, privileged, and open-world behavior.
- [x] Attached editor, launched editor, detached/unattended, paused editor,
  editor disconnect, and unsaved conflict.
- [x] Runtime disconnected, starting, connected, stopped, crashed, reconnecting,
  and cancellation states.
- [x] Valid required/default/optional/union/action arguments and invalid missing,
  unknown, wrong-type, wrong-shape, range, path, and privilege arguments.
- [x] Paths with spaces, non-ASCII characters, symlinks, and multiple roots.
- [x] Success, engine/tool failure, timeout, cancellation, partial failure,
  fallback, conflict, cleanup failure, and retry.
- [x] Structured client, text-only client, client with roots/progress/cancel, and
  client without optional capabilities.
- [x] Independent persistence/effect observation after mutation.
- [x] Repeatability, promised idempotency, bounded output, continuation, and
  resource/process/input cleanup.

## Likely implementation areas

This list is navigational, not permission to limit changes to these files.

- `src/tool-surface.ts`: compact membership, catalog ranking, rich details.
- `src/tool-definitions.ts`: titles, input/output schemas, annotations, examples.
- `src/tool-manifest.ts` and generated manifests: effect, state, privilege, and
  discovery metadata.
- `src/tool-argument-validation.ts`: standards-compliant schema validation.
- `src/tool-registry.ts`: execution context, recoverable errors, cancellation.
- `src/tool-mutation-policy.ts` and `src/editor-mutation-guard.ts`: effective
  nested calls and runtime project pause.
- `src/index.ts`: MCP optional capabilities, tracing, roots, progress, and
  structured result handling.
- `src/tool-handlers/lifecycle-tool-handlers.ts`: catalog/call split, watched
  editor flow, runtime readiness, scenarios, and teardown.
- Scene/runtime services and handlers: concise reads, Variant validation,
  cancellation, and structured outputs.
- `agent-plugin/adapter-manifest.json`, generated client manifests, Pi extension,
  and all four `agent-plugin/skills/*/SKILL.md` files.
- `tests/*.test.ts`, `tests/e2e/`, `tests/godot/`, evaluation scripts, and
  generated coverage reports.
- README and current docs named in Phase 7.

## External standards used by this plan

- [MCP tool specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
  for titles, annotations, structured output, output schemas, errors, and human
  confirmation expectations.
- [MCP client best practices](https://modelcontextprotocol.io/docs/develop/clients/client-best-practices)
  for progressive discovery and catalog/inspect/execute workflows.
- [MCP Roots](https://modelcontextprotocol.io/specification/2025-11-25/client/roots),
  [progress](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress),
  and [cancellation](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation).
- [Anthropic tool definition guidance](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools)
  for high-signal descriptions, examples, namespacing, and result design.
- Godot's
  [EditorUndoRedoManager](https://docs.godotengine.org/en/stable/classes/class_editorundoredomanager.html)
  and [EditorFileSystem](https://docs.godotengine.org/en/stable/classes/class_editorfilesystem.html)
  contracts for editor-native persistence and filesystem synchronization.

## Final completion report

When the goal is closed, publish a concise report containing:

- [x] final advertised/full counts and compact byte/token size;
- [x] discovery recall and ranking results;
- [x] schema, structured-output, title, and annotation coverage;
- [x] direct/hidden/scenario pause and trace evidence;
- [x] watched editor and runtime-readiness evidence;
- [x] cancellation, progress, roots, and concise-response evidence;
- [x] each skill's trigger and scenario-evaluation result;
- [x] unit, Godot, E2E, adapter, package, and cold-agent commands/results;
- [x] compatibility aliases and remaining deprecation dates;
- [x] warnings, unsupported platforms/metrics, manual-review items, and deferred
  work;
- [x] confirmation that no unexpected owned process, bridge, held input,
  temporary artifact, or dirty generated file remains.
