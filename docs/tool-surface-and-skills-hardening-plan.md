# Tool Surface, Human Control, and Shipped Skills Hardening Plan

> **Status:** proposed work plan  
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

## Definition of done

The goal is complete only when all of the following are true:

- [ ] Natural-language discovery finds every required core and hidden workflow
  capability in the committed discovery corpus at the required rank.
- [ ] Read-only catalog inspection and arbitrary hidden-tool execution have
  separate advertised identities and conservative MCP annotations.
- [ ] Activity, mutation policy, privilege policy, and project correlation use
  the effective nested tool rather than only its dispatcher wrapper.
- [ ] **Pause Agent** blocks persistent and runtime mutations for the connected
  project, including indirect calls, while observation and safe teardown remain
  available.
- [ ] Watched workflows attach to an existing editor or deliberately launch one;
  they never silently continue detached after the human asked to watch.
- [ ] `run_project` reports success only after the runtime bridge is usable, or
  returns a bounded actionable failure and cleans up owned state.
- [ ] Advertised input schemas match server validation, including unknown-field
  policy, action-specific requirements, structured Godot Variant shapes, and
  positive and negative examples.
- [ ] Every tool has a human title, accurate effect/precondition metadata, a
  validated output contract, and structured success and error content while
  retaining compatible text content.
- [ ] Scene and observation tools support concise, bounded reads without losing
  an explicit full-detail mode.
- [ ] MCP roots, cancellation, and progress are honored where supported without
  breaking clients that omit them.
- [ ] The build, debug, verify, and ship skills work against the default compact
  surface, use hidden tools deliberately, respect watched operation and human
  pause, and pass their own current-model scenario evaluations.
- [ ] Current documentation and generated adapter metadata agree on surface
  mode, tool counts, discovery names, skills, and compatibility behavior.
- [ ] Unit, contract, Godot, full MCP-to-Godot E2E, adapter, packaging, and
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

- [ ] Add a generated/current surface report containing:
  - advertised and full tool counts;
  - serialized bytes and estimated tokens;
  - domain, backend, action, privilege, and effect-scope counts;
  - core-versus-hidden membership;
  - input/output schema coverage;
  - titles and annotation coverage;
  - skill-to-tool references.
- [ ] Replace tests that assert an unexplained exact count with tests for:
  - uniqueness and registry/handler/manifest completeness;
  - the explicitly reviewed core membership;
  - a compact byte budget of at most 26 KB and estimated budget of at most
    6,500 tokens, unless a checked-in evaluation justifies a revision;
  - generated count consistency across docs and adapter manifests.
- [ ] Preserve historical counts in historical evidence files; label them as
  historical instead of mechanically rewriting them.

### 0.2 Commit a discovery-intent corpus

- [ ] Add deterministic search cases for at least these intents:
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
- [ ] Store expected top result, acceptable alternatives, forbidden unsafe or
  wrong-scope results, and maximum acceptable rank for each case.
- [ ] Include spelling variants, snake-case fragments, action verbs, Godot class
  names, user-language phrases, and terse agent-style queries.
- [ ] Add a baseline report showing the current failures before changing search.

### 0.3 Define agent-level scenario evaluations

- [ ] Define a compact-surface, no-skill discovery scenario.
- [ ] Define one primary scenario and at least one failure/edge scenario for each
  shipped skill.
- [ ] Capture metrics consistently:
  - task and acceptance-criterion success;
  - tool-selection precision and search recall at 1/3/5;
  - invalid calls and self-correction count;
  - calls, elapsed time, and response bytes;
  - detached/editor/runtime state mistakes;
  - human interventions and pause violations;
  - trace accuracy and cleanup state.
- [ ] Version the model/client/prompt/tool-surface inputs with each result.

### Phase 0 acceptance gate

- [ ] Baseline generation is deterministic and checked by CI.
- [ ] The known failed queries fail in the recorded pre-change baseline.
- [ ] Every later phase can demonstrate improvement against the same corpus.

## Phase 1 — Effective-call identity and human control

### 1.1 Centralize effective call resolution

- [ ] Introduce one execution-context representation containing:
  - advertised wrapper name, if any;
  - effective tool name and arguments;
  - parent scenario/transaction identifier, if any;
  - resolved project path and connection identity;
  - domain, backend, effect scope, privilege group, mutation classification;
  - request, trace, and optional progress identifiers;
  - cancellation signal.
- [ ] Resolve and validate this context before mutation guard, privilege checks,
  Activity tracing, synchronization, and handler dispatch.
- [ ] Preserve parent and child trace relationships for `godot_call` and
  `game_scenario` rather than flattening everything into the outer tool.
- [ ] Remove lifecycle outcome inference from response-text regexes. Have
  handlers or a common response builder return structured outcome metadata.
- [ ] Redact secrets and bounded payload fields before Activity or debug logging.

### 1.2 Split catalog inspection from execution

- [ ] Add read-only `godot_catalog` with `search` and `describe` actions.
- [ ] Add conservatively mutating/destructive `godot_call` with a single hidden
  tool execution action.
- [ ] Reject recursive dispatcher calls and unsupported scenario nesting.
- [ ] Return the effective tool name, scope, privilege group, and trace ID in
  dispatcher results.
- [ ] Keep the existing `godot_tools` handler as a deprecated compatibility
  alias and test old clients against it.
- [ ] Update the Pi adapter and human-facing display precedence to use MCP
  `tool.title`, then legacy annotation title, then name.

### 1.3 Make Pause Agent authoritative

- [ ] Resolve pathless runtime calls to the authenticated connected project.
- [ ] Apply pause to direct, dispatched, and scenario-contained mutations.
- [ ] Keep these classes callable while paused:
  - status, logs, errors, screenshots, scene/UI/property reads;
  - `stop_project`, held-input release, bridge cleanup, and safe disconnect;
  - explicit Resume Agent initiated by the human UI.
- [ ] Decide and document how queued work responds to pause: do not start a new
  mutation after pause is observed; cancel only when the operation is safely
  cancellable; otherwise finish the atomic unit and report it.
- [ ] Show the blocked effective tool and reason in Activity.

### 1.4 Human-control tests

- [ ] Test direct persistent mutation while paused.
- [ ] Test hidden persistent mutation through the compatibility and new
  dispatchers while paused.
- [ ] Test pathless runtime property, input, scene, and audio mutations while
  paused.
- [ ] Test a scenario paused before start and paused between steps.
- [ ] Test read-only observation, input release, stop, and cleanup while paused.
- [ ] Test no-editor/unattended operation and editor disconnect during a check.
- [ ] Test trace and Activity fields for success, failure, conflict, fallback,
  paused, cancellation, and nested calls.

### Phase 1 acceptance gate

- [ ] No mutating call path bypasses pause because its project path is nested or
  implicit.
- [ ] Human-visible records identify the actual capability and scope used.
- [ ] Discovery can be approved as read-only without implicitly approving hidden
  mutation.

## Phase 2 — Discovery, summaries, and on-demand tool guidance

### 2.1 Build a deterministic ranked catalog

- [ ] Index tool name, split snake-case tokens, short summary, actions, aliases,
  tags, Godot concepts/classes, effect scope, preconditions, examples, and
  related tools.
- [ ] Implement weighted ranking rather than all-term substring filtering.
- [ ] Support normalized tense/plural forms, fuzzy matching for small typos, and
  curated product synonyms without a network dependency.
- [ ] Give exact names/actions a strong boost without allowing definition order
  to determine tied results silently.
- [ ] Return a score or match explanation suitable for debugging evaluations.
- [ ] Add filters for domain, backend, effect scope, required state, privilege,
  and read-only/mutating behavior.
- [ ] Prefer persistent authoring tools for create/save/project requests and
  runtime tools for inspect/playtest/temporary requests.

### 2.2 Add rich catalog metadata

- [ ] Extend the catalog's source of truth with:
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
- [ ] Populate all core tools and every tool referenced by a shipped skill
  manually before relying on generated fallbacks.
- [ ] Fill the 27 missing property descriptions in the compound core tools.
- [ ] Replace the 80-character per-description test with quality and total
  compact-budget checks.
- [ ] Make `describe` return detail levels such as `summary`, `schema`, and
  `full`, with `summary` as the default.

### 2.3 Correct core input discoverability

- [ ] Add `game_key_hold` to the default surface.
- [ ] Describe `game_key_press` explicitly as a one-frame tap and state when to
  use hold/release instead.
- [ ] Keep `game_key_release` in the default surface for deterministic cleanup.
- [ ] Review the rest of the compact membership against build/debug/verify/ship
  evaluations. Do not preserve an exact count at the expense of successful use.
- [ ] Record why each core tool is present and which common workflow it serves.

### Phase 2 acceptance gate

- [ ] Every required discovery-corpus intent has the expected result in the top
  three and no unsafe/wrong-scope result above an explicitly preferred tool.
- [ ] All 171 tools have non-empty scope, state, mutation, and discovery metadata.
- [ ] An agent can distinguish tap/hold/release and persistent/runtime creation
  using only advertised summaries plus one catalog detail call.

## Phase 3 — Input schema and validation contract

### 3.1 Make JSON Schema the source of truth

- [ ] Adopt JSON Schema 2020-12 validation for the complete tool catalog.
- [ ] Advertise `$schema`, object type, and `additionalProperties: false` at the
  top level and in closed nested objects.
- [ ] Mark intentionally free-form Godot Dictionary/Variant objects as open and
  explain that exception in their descriptions.
- [ ] Validate normalized arguments once, then pass the validated value through
  policy and handlers without a second divergent structural parser.
- [ ] Preserve path, privilege, authentication, and engine/business validation
  after structural validation.
- [ ] Return model-recoverable argument errors as `isError: true` structured tool
  results with field paths and remediation. Reserve protocol errors for unknown
  methods/tools and malformed MCP requests.

### 3.2 Encode compound tools accurately

- [ ] Model `editor_transaction.operations` as a discriminated union with
  operation-specific required and forbidden fields.
- [ ] Model every `game_wait_until` condition as a discriminated union with
  required node/group/property/text/value parameters and bounded timeouts.
- [ ] Model every `game_scenario` step as a discriminated union and define an
  explicit safe tool/action allowlist.
- [ ] Encode exactly one of key, input action, or text for key input tools.
- [ ] Encode action-specific requirements for `editor_control`.
- [ ] Audit and encode the remaining multi-action tools in batches by domain;
  every one of the 79 multi-action tools must finish with positive and negative
  action samples.

### 3.3 Standardize Godot Variant inputs

- [ ] Define canonical schemas and examples for Vector2/3/4, integer vectors,
  Color, Rect2, Transform2D/3D, Basis, Quaternion, NodePath, StringName, RID,
  arrays, dictionaries, resources, and typed wrappers.
- [ ] Accept only intentionally supported shorthand forms and document how they
  are disambiguated.
- [ ] Reject unconvertible shapes before executing or reporting success.
- [ ] Include the target property type and accepted shape in conversion errors.
- [ ] Test the historical array-versus-component-object Vector/Color failures.
- [ ] Independently re-read saved values after authoring in E2E tests.

### 3.4 Full-catalog schema quality gates

- [ ] Require descriptions on all properties, union branches, array items, and
  action discriminators.
- [ ] Require examples for complex objects and every action family.
- [ ] Validate committed positive examples against their schemas.
- [ ] Assert committed negative examples fail for the intended reason and field.
- [ ] Assert the advertised schema and runtime validator accept and reject the
  same generated corpus.

### Phase 3 acceptance gate

- [ ] No known handler-only structural requirement is absent from the advertised
  schema.
- [ ] Unknown fields, missing conditional fields, and invalid Variant shapes
  produce actionable tool errors without reaching Godot.
- [ ] All 171 tools and all public actions pass schema parity tests.

## Phase 4 — Structured outputs, errors, annotations, and observability

### 4.1 Define common response contracts

- [ ] Extend tool definitions with MCP `title`, `outputSchema`, `annotations`,
  and supported execution metadata.
- [ ] Define a common metadata object containing effective tool, project, effect
  scope, trace ID, duration, warnings, fallback/synchronization status, and
  cleanup state where applicable.
- [ ] Define a common error object containing stable code/category, message,
  field or engine location, retryability, remediation, and bounded details.
- [ ] Return schema-valid `structuredContent` and equivalent JSON text during the
  compatibility period.
- [ ] Keep image/audio/binary content blocks and place their typed metadata in
  `structuredContent`.

### 4.2 Migrate tools in risk/traffic order

- [ ] Batch 1: `godot_catalog`, `godot_call`, editor session/control/transaction,
  run/stop, wait/scenario, and verification.
- [ ] Batch 2: scene/settings/file reads and mutations, validation, logs/errors,
  screenshots, project tests, import, integrity, .NET, and export.
- [ ] Batch 3: remaining runtime inspection and mutation tools.
- [ ] Batch 4: remaining project, CI/container, networking, and open-world tools.
- [ ] Require schema validation of every structured success and error result in
  unit and E2E tests.

### 4.3 Add conservative human-facing annotations

- [ ] Add accurate `readOnlyHint`, `destructiveHint`, `idempotentHint`, and
  `openWorldHint` to every advertised tool.
- [ ] Mark `godot_catalog` read-only and closed-world.
- [ ] Mark `godot_call` conservatively mutating, potentially destructive, and
  open-world because its effective target varies.
- [ ] Split additional mixed-action tools only when one conservative annotation
  would make normal approval materially misleading.
- [ ] Treat annotations as hints; continue enforcing server policy independently.

### 4.4 Replace text scraping in internal control flow

- [ ] Drive trace outcome, synchronization, fallback, conflict, pause, and retry
  behavior from typed internal results.
- [ ] Remove regex classification over the first text content block.
- [ ] Include child outcomes in scenario and dispatcher parent summaries.
- [ ] Ensure Activity remains concise and cannot expose secrets or unbounded
  response bodies.

### Phase 4 acceptance gate

- [ ] Every tool result validates against its advertised output schema.
- [ ] Older text-only clients continue receiving equivalent content.
- [ ] Activity outcomes remain correct when content order or prose changes.
- [ ] Client UIs can display meaningful titles and conservative operation hints.

## Phase 5 — Lifecycle, workspace boundaries, cancellation, and response size

### 5.1 Make watched editor behavior explicit

- [ ] Document `editor_session` as the canonical attach/status/disconnect flow.
- [ ] Keep `launch_editor` as a compatibility convenience unless usage evidence
  supports later deprecation.
- [ ] Preserve the existing API default where needed, but require skills to call
  `editor_session ensure` with `launchIfNeeded: true` when the human asks to
  watch and no reusable editor is present.
- [ ] Return explicit attached/launched/detached/restart-required states with
  remediation and addon compatibility details.
- [ ] Never interpret “no editor found” as permission to continue detached after
  a watched request. Stop with a clear blocker if launch cannot succeed.
- [ ] Test existing editor, absent editor, stale addon, restart required, editor
  exit, unsaved conflict, and multiple-project selection.

### 5.2 Make runtime startup atomic from the caller's perspective

- [ ] Have `run_project` wait for process start, authenticated bridge connection,
  and an initial usable command response within a bounded timeout.
- [ ] Return `process_started`, `runtime_connected`, project/scene identity,
  engine version, startup duration, and bounded startup diagnostics.
- [ ] On connection failure, stop owned processes, remove transient bridge files,
  release input, and return actionable structured failure.
- [ ] Make repeated run/stop requests deterministic and ownership-aware.
- [ ] Keep an explicit connection wait condition for reconnect and advanced
  workflows, but do not require it after an ordinary successful `run_project`.

### 5.3 Honor MCP cancellation and progress

- [ ] Pass the MCP request `AbortSignal` through registry, execution context,
  subprocesses, editor commands, runtime requests, tests, imports, builds,
  exports, waits, and scenarios.
- [ ] Map cancellation to safe subprocess termination and existing runtime cancel
  commands without deleting user-owned state.
- [ ] Send progress only when the client provides a progress token.
- [ ] Report meaningful completed/total stages for imports, project tests, .NET
  restore/build, export readiness/export, and scenarios.
- [ ] Test cancellation before start, during work, after completion races, and
  while paused; verify cleanup and one terminal result.
- [ ] Do not advertise MCP task support in this program.

### 5.4 Support MCP Roots safely

- [ ] When the client advertises Roots, request and canonicalize file roots and
  refresh them after roots-list changes.
- [ ] Intersect client roots with `GODOT_MCP_ALLOWED_DIRS`; neither source may
  broaden the other.
- [ ] Reject project and relative paths outside the effective session boundary,
  including symlink and case-normalization escapes.
- [ ] Retain the legacy fallback for clients with neither roots nor configured
  directories during the compatibility period, but emit a bounded startup or
  catalog warning explaining the unrestricted boundary.
- [ ] Document a future secure-default change separately if it requires a major
  release.

### 5.5 Make observations concise by default without breaking callers

- [ ] Add `read_scene` selectors for node path, property names, maximum depth,
  authored-only values, defaults, resources, and response limit.
- [ ] Add `compact`, `authored`, and `full` detail modes.
- [ ] During the compatibility period, preserve legacy behavior when no detail
  option is supplied; update skills to request the concise mode explicitly.
- [ ] Measure response bytes and truncation metadata for scene, tree, UI, node,
  logs, errors, and debug reads.
- [ ] Use cursors or continuation tokens where repeated observation can avoid
  retransmitting unchanged history.
- [ ] Never silently truncate without reporting limit, returned count, and a
  continuation/refinement path.

### Phase 5 acceptance gate

- [ ] A successful watched run is immediately usable by the next runtime call.
- [ ] Cancellation leaves no owned process, bridge, held input, or temporary
  artifact behind.
- [ ] Root-aware clients cannot escape their effective workspace boundary.
- [ ] Common scene-inspection scenarios consume materially fewer response bytes
  than the baseline while full detail remains available.

## Phase 6 — Rehaul the four shipped skills

The skills are part of the public agent interface. They must be concise enough
to load reliably, but explicit enough to select valid tools and preserve human
expectations. Critical rules must remain in each `SKILL.md`; optional detail may
live in linked references, but no required safety or lifecycle behavior may
depend on a client automatically loading an extra file.

### 6.1 Establish a shared skill contract

- [ ] Update all four skill trigger descriptions so their boundaries are clear:
  - **build:** create a new game or implement a substantial playable feature;
  - **debug:** reproduce, diagnose, and repair a failure;
  - **verify:** inspect and prove an existing change without assuming permission
    to modify it;
  - **ship:** prepare and gate reproducible release artifacts.
- [ ] Add positive and negative trigger-prompt tests to prevent build/debug/
  verify/ship overlap.
- [ ] Extend adapter metadata with a machine-readable tool contract per skill:
  - tools callable directly on the compact surface;
  - hidden tools that require catalog inspection and `godot_call`;
  - privileged groups that may be used only when already enabled;
  - expected persistent/runtime effect scopes.
- [ ] Test every backticked tool reference against the actual catalog and skill
  tool contract.
- [ ] Fail when a skill directly instructs use of a hidden tool without the
  catalog/detail/dispatch sequence.
- [ ] Give all four skills consistent `agents/openai.yaml` interface metadata,
  generated or checked against the adapter manifest.
- [ ] Keep each primary skill concise, preferably at or below 120 lines. Replace
  the current arbitrary 100-line test with a reviewed context budget and content
  assertions.

Every skill must explicitly cover:

- [ ] supported Godot 4.7 boundary;
- [ ] project/root validation before mutation;
- [ ] watched attach-or-launch versus unattended operation;
- [ ] persistent authoring versus runtime-ephemeral tools;
- [ ] compact direct tools versus hidden catalog tools;
- [ ] bounded wait/scenario use instead of manual polling or sleeps;
- [ ] tap versus hold/release input and cleanup of held state;
- [ ] human Pause Agent semantics and no attempt to bypass it;
- [ ] static validation before runtime proof when persistent files changed;
- [ ] independent evidence rather than trusting mutation responses;
- [ ] errors, warnings, fallbacks, unsupported metrics, subjective gaps, and
  cleanup in the final report;
- [ ] privileged reflection/evaluation only when already enabled and necessary.

### 6.2 Rework `build-godot-game`

- [ ] Begin by extracting a small acceptance contract: playable loop, controls,
  visible feedback, ordinary state, success/failure transitions, and requested
  watch mode.
- [ ] Inspect an existing project in concise mode before writing; create a
  project only when `project.godot` is absent.
- [ ] Attach or launch the editor when watched, and stop if watched operation
  cannot be established.
- [ ] Prefer one coherent editor transaction/undo step per human-readable change.
- [ ] Include canonical Variant/property examples where the skill demonstrates
  scene authoring.
- [ ] Require meaningful persisted scene hierarchy unless the user requests or
  accepts a procedural design.
- [ ] Resolve hidden integrity/import/resource capabilities through catalog
  detail and dispatch rather than naming them as directly available.
- [ ] Use named input actions and use hold/release for continuous movement.
- [ ] Prove baseline play plus requested win/lose or equivalent completion/failure
  transitions with independent observations.
- [ ] Keep asset-license, attribution, performance-budget, and game-only project
  cleanup guidance, but distinguish mandatory gates from conditional polish.

Build evaluation:

- [ ] From an empty compact-surface project, create a watched minimal game using
  continuous movement, visible state, and independently proven success/failure.
- [ ] Verify the agent does not simulate held movement with repeated tap calls,
  silently continue detached, or leave transient bridge/test artifacts.

### 6.3 Rework `debug-godot-game`

- [ ] Require preservation of a reproducible baseline before editing.
- [ ] Classify the failing boundary explicitly: parse/startup, persistent scene
  or resource, import, runtime state, input/timing, rendering, audio, export, or
  platform/toolchain.
- [ ] Use bounded/cursor-based logs and errors and capture the minimum relevant
  scene/UI/screenshot evidence.
- [ ] Require one falsifiable hypothesis and a distinguishing observation before
  mutation; keep one independent variable per trial.
- [ ] Stop runtime before persistent repair unless the chosen editor-native
  operation is explicitly safe during play and the skill records why.
- [ ] Discover hidden resource/debug tools deliberately and preserve reflection
  privilege rules.
- [ ] Repeat the exact reproduction and adjacent regression checks after the
  smallest repair.
- [ ] Separate objective performance measurements from unavailable GPU metrics
  and subjective reports of feel.

Debug evaluation:

- [ ] Diagnose a seeded input/timing or scene-state regression, change only the
  causal artifact, rerun the same reproduction, and report independent evidence.
- [ ] Include a misleading nearby symptom to ensure the agent tests its
  hypothesis instead of applying a broad speculative edit.

### 6.4 Rework `verify-godot-change`

- [ ] State that verification alone authorizes observation, not corrective
  mutation; report a failed criterion unless the user also requested a fix.
- [ ] Translate the requested change into saved-state, runtime, rendered,
  timing, log/error, and subjective/manual-review criteria as applicable.
- [ ] Prefer `verify_project` and project tests, then use realtime interaction
  only for behavior the compound tools cannot prove.
- [ ] Use concise reads, bounded waits, scenarios, and correct tap/hold/release
  semantics.
- [ ] Require a negative-evidence pass for errors, warnings, leaks, fallbacks,
  cleanup, and adjacent regressions.
- [ ] Explicitly reject screenshots as sole proof of behavior, audio quality, or
  game feel.
- [ ] Report unobserved criteria as incomplete rather than inferring success.

Verify evaluation:

- [ ] Verify a supplied change with one objective passing criterion, one
  regression criterion, and one deliberately subjective criterion.
- [ ] Confirm the agent neither edits the project nor claims the subjective
  criterion was automatically proven.

### 6.5 Rework `ship-godot-game`

- [ ] Start with an explicit release matrix: targets, engine/build flavor,
  renderer, .NET, presets, templates, signing, expected outputs, and which gates
  are local versus CI/manual.
- [ ] Discover all hidden integrity, import, addon, .NET, and export-readiness
  tools through the compact catalog contract.
- [ ] Keep inspection actions read-only until the user authorizes repairs or
  release mutations.
- [ ] Require project tests and representative gameplay verification before
  final export.
- [ ] Require independent artifact existence, type, size, sidecar/pack, hash,
  and supported smoke-run evidence.
- [ ] Never imply unavailable export templates, platform SDKs, signing identities,
  or target hardware passed.
- [ ] Preserve user addons and release artifacts; delete only identified
  generated probes and MCP-owned transient files.
- [ ] Produce a concise release verdict with passed, failed, blocked, manual, and
  unsupported gates.

Ship evaluation:

- [ ] Run against a project with one available local export target and one
  intentionally unavailable/signing-dependent target.
- [ ] Confirm the available artifact is independently inspected and the
  unavailable target remains explicitly blocked rather than claimed.

### 6.6 Cross-client skill packaging and behavior

- [ ] Regenerate and validate Claude Code, Codex/ChatGPT, OpenCode, and Pi
  adapter metadata after skill changes.
- [ ] Test the four skill inventories, descriptions, default prompts, OpenAI
  interface files, and MCP surface environment from installed package layouts.
- [ ] Run adapter smoke tests against both `core` and the supported `compact`
  compatibility alias during migration.
- [ ] Test public-package paths from a packed artifact, not only the checkout.

### Phase 6 acceptance gate

- [ ] Every skill references only valid tools using the correct direct or hidden
  invocation flow.
- [ ] All trigger tests and four agent-level scenario evaluations pass.
- [ ] Watched, pause, persistence, input cleanup, evidence, and teardown rules
  are observable in skill behavior, not merely present as prose.
- [ ] All supported adapters install the same four canonical skill versions.

## Phase 7 — Documentation, compatibility, and release evidence

### 7.1 Synchronize current documentation

- [ ] Update README, `docs/tools.md`, `docs/tool-disclosure.md`,
  `docs/agent-plugin.md`, adapter acceptance, and relevant architecture docs.
- [ ] Replace current stale 39-tool references with generated current facts.
- [ ] Use one canonical surface term, `core`, while accepting `compact` as a
  documented compatibility alias.
- [ ] Document `godot_catalog`, `godot_call`, and the `godot_tools` deprecation
  window with examples.
- [ ] Document titles, annotations, structured output, errors, roots, progress,
  cancellation, effect scopes, watched mode, runtime readiness, and Pause Agent.
- [ ] Document concise versus full scene observation.
- [ ] Update public tool and runtime schema artifacts from source.

### 7.2 Add migration and compatibility coverage

- [ ] Test an old client using `godot_tools search`, `describe`, and `call`.
- [ ] Test `GODOT_MCP_TOOL_SURFACE=compact`, `core`, and `full` explicitly;
  reject unknown mode values instead of silently treating them as core.
- [ ] Test text-only response consumption alongside structured clients.
- [ ] Test clients with and without roots, progress tokens, cancellation, and
  annotation display.
- [ ] Record any intentionally breaking behavior for the next major release
  rather than smuggling it into a minor release.

### 7.3 Refresh end-to-end and cold-agent evidence

- [ ] Run `npm run check`.
- [ ] Run `npm run test:godot` with the supported Godot 4.7 binary.
- [ ] Run `npm run test:e2e` through the built MCP server and real engine.
- [ ] Run engine-surface coverage checks and regenerate current reports.
- [ ] Run adapter/package smoke tests from the candidate tarball.
- [ ] Run the compact no-skill and four skill evaluations from Phase 0.
- [ ] Compare against the historical golden run and report selection, invalid
  call, latency, response-size, trace, intervention, and cleanup changes.
- [ ] Capture watched-editor evidence for attach, launch, Activity, pause/resume,
  unsaved conflict, and teardown.
- [ ] Require a clean worktree after generated-file synchronization and tests.

### Phase 7 acceptance gate

- [ ] All automated and real-engine gates pass on the supported Godot baseline.
- [ ] Current docs, schemas, adapter manifests, package contents, and observed
  MCP discovery agree.
- [ ] Cold-agent evaluations show no recurrence of the historical hold,
  property-shape, hidden-discovery, or unbounded-read failures.
- [ ] Release evidence clearly lists any remaining manual or platform-specific
  gates.

## Cross-cutting test matrix

Each affected capability should be assessed against the applicable rows below.
“Not applicable” must be explicit in test metadata rather than silently omitted.

- [ ] Direct advertised call, hidden dispatched call, and scenario-contained call.
- [ ] Read-only, persistent mutation, runtime mutation, process lifecycle,
  destructive, privileged, and open-world behavior.
- [ ] Attached editor, launched editor, detached/unattended, paused editor,
  editor disconnect, and unsaved conflict.
- [ ] Runtime disconnected, starting, connected, stopped, crashed, reconnecting,
  and cancellation states.
- [ ] Valid required/default/optional/union/action arguments and invalid missing,
  unknown, wrong-type, wrong-shape, range, path, and privilege arguments.
- [ ] Paths with spaces, non-ASCII characters, symlinks, and multiple roots.
- [ ] Success, engine/tool failure, timeout, cancellation, partial failure,
  fallback, conflict, cleanup failure, and retry.
- [ ] Structured client, text-only client, client with roots/progress/cancel, and
  client without optional capabilities.
- [ ] Independent persistence/effect observation after mutation.
- [ ] Repeatability, promised idempotency, bounded output, continuation, and
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

- [ ] final advertised/full counts and compact byte/token size;
- [ ] discovery recall and ranking results;
- [ ] schema, structured-output, title, and annotation coverage;
- [ ] direct/hidden/scenario pause and trace evidence;
- [ ] watched editor and runtime-readiness evidence;
- [ ] cancellation, progress, roots, and concise-response evidence;
- [ ] each skill's trigger and scenario-evaluation result;
- [ ] unit, Godot, E2E, adapter, package, and cold-agent commands/results;
- [ ] compatibility aliases and remaining deprecation dates;
- [ ] warnings, unsupported platforms/metrics, manual-review items, and deferred
  work;
- [ ] confirmation that no unexpected owned process, bridge, held input,
  temporary artifact, or dirty generated file remains.
