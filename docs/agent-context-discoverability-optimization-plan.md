# Agent Context, Discoverability, and Usage Optimization Plan

> **Status:** proposed  
> **Baseline:** 2026-07-26, 173 catalog tools, 42 default `core` tools  
> **Objective:** Reduce the context and correction cost of Godot Agent Loop
> without weakening capability coverage, progressive disclosure, safety,
> compatibility, or the verified author → run → observe → assert workflow.

The current architecture is sound: a static core surface provides portable MCP
compatibility, while `godot_catalog` and `godot_call` expose the complete catalog
on demand. This plan optimizes that design rather than replacing it.

The baseline generated surface is 60,286 bytes, or 15,072 tokens using the
repository's deterministic four-bytes-per-token estimate. This is a 94.93%
reduction from the 1,189,325-byte full catalog. The current external cold-model
record passes all nine scenarios and reports search recall at 1/3/5 of 1.0, but
also records 28 invalid calls across 252 calls. Tool responses total 3,609,307
bytes across those runs, with a 228,824-byte median and a 1,139,476-byte maximum
per run.

The plan date is the date of this review; the external evidence was run on
2026-07-16 and is retained as historical input. The generated surface report
and the cold-model record are authoritative for their respective measurements:
[`docs/coverage/tool-surface.json`](coverage/tool-surface.json) and
[`evals/current-model-status.json`](../evals/current-model-status.json). The
completed hardening program that established the current split catalog/call
surface is documented in
[`docs/tool-surface-and-skills-hardening-plan.md`](tool-surface-and-skills-hardening-plan.md).

## Baseline evidence and measurement contract

| Measure | Current value | Definition and source |
| --- | ---: | --- |
| Full catalog | 173 tools / 1,189,325 bytes | Serialized full definitions in `tool-surface.json` |
| Core surface | 42 tools / 60,286 bytes / 15,072 estimated tokens | Serialized `core` definitions; tokens are `ceil(bytes / 4)` |
| Core byte reduction | 94.93% | `1 - core bytes / full bytes` |
| External runs | 9 passed / 9 scenarios | `current-model-status.json`, model `gpt-5.6-luna`, high effort |
| Search recall | 1.0 at rank 1, 3, and 5 | Minimum applicable scenario recall in the retained record |
| Invalid calls | 28 / 252 = 11.1% | Sum of `invalidCalls` divided by sum of `toolCalls` |
| Result volume | 3,609,307 total; 228,824 median; 1,139,476 maximum | Median and maximum of per-scenario `responseBytes` |

All future comparisons must use the same scenario IDs, metric definitions,
surface mode, and response-byte accounting unless a versioned evaluation
change is recorded. Do not compare deterministic discovery results with fresh
model selection results as if they were the same evidence. A metric is not a
release result until its raw trace or generated artifact is retained.

The following invariants are non-negotiable throughout the work:

- Hidden execution remains available through `godot_catalog` inspection followed
  by `godot_call`, while the complete static catalog remains available in
  explicit `full` mode.
- Discovery metadata is advisory. Roots, authentication, project correlation,
  Pause Agent, privilege, mutation policy, cancellation, and cleanup remain
  server-enforced at the effective nested tool.
- Concise output may remove repetition, but it may not remove error severity,
  state, counts, paths, trace identity, or the evidence needed to reproduce a
  verification conclusion.
- Historical evaluation records are append-only. Candidate runs receive a
  version, model/client identity, prompt and skill hashes, surface mode, and
  retained raw traces.

## Outcomes and success measures

The program is complete when all of these conditions hold:

- [ ] The full catalog remains callable through the canonical
  `godot_catalog` → `godot_call` path on the default surface.
- [ ] Search recall at 1/3/5 remains 1.0 for the committed discovery corpus and
  applicable cold-model scenarios.
- [ ] Every no-skill discovery scenario uses catalog inspection before hidden
  execution and avoids repeated low-level workarounds.
- [ ] The aggregate cold-model invalid-call rate falls from 11.1% to at most
  5%, with no scenario above 10%.
- [ ] Every invalid argument response provides a field path, remediation, and a
  canonical corrected example when the failing value uses a structured Godot
  representation.
- [ ] The median cold-model response volume falls at least 30% from the current
  228,824-byte baseline, and no ordinary scenario exceeds 750,000 bytes.
  Explicit full-detail or artifact-producing release workflows may exceed that
  limit only with a recorded justification.
- [ ] Compound workflow tools are selected before equivalent hand-composed
  sequences in the scenarios designed to exercise them.
- [ ] The core surface remains at or below its existing 62,000-byte and
  15,500-estimated-token hard limits. A stretch goal of 50,000 bytes and 12,500
  estimated tokens may be adopted only if cold-model validity and selection
  metrics do not regress.
- [ ] Actual tokenizer measurements are published for the primary supported
  model families alongside the deterministic estimate.
- [ ] Unit, contract, Godot, E2E, adapter, package, and external cold-model
  gates pass with clean process, bridge, held-input, and temporary-file state.

## Non-goals

- Replacing portable static MCP tools with a client-specific dynamic tool API.
- Advertising the complete 173-tool catalog by default.
- Reducing tool count or schema bytes merely to meet an aesthetic target.
- Removing structured results, effect annotations, roots enforcement, Pause
  Agent, privilege enforcement, cancellation, or trace correlation.
- Combining unrelated operations into broad tools that are harder to validate
  or authorize.
- Treating deterministic replay as evidence of fresh-model selection behavior.

## Phase 0: Freeze and classify the baseline

Before changing schemas or descriptions, make the current costs explainable.

### Phase 0 work

- [ ] Add a generated optimization-baseline artifact sourced from
  `docs/coverage/tool-surface.json` and `evals/current-model-status.json`.
- [ ] Extend the cold-model result schema and runner to classify every invalid
  call into:
  - unknown field;
  - missing required field;
  - incorrect action or enum;
  - incorrect structured Variant representation;
  - wrong required state;
  - wrong tool selection;
  - hidden-call discovery/inspection violation;
  - other, with a required note.
- [ ] Record per-tool call count, invalid count, response bytes, and repeated
  equivalent observations.
- [ ] Record whether each compound-tool opportunity used the compound tool
  first, used it late, or never used it.
- [ ] Add actual tokenizer measurements for the serialized core and full
  surfaces. Keep the existing bytes/4 estimate for deterministic CI budgeting.
- [ ] Separate advertised definition bytes, initialization-instruction bytes,
  tool-result bytes, and legacy duplicate-text bytes in reports.
- [ ] Freeze the baseline inputs before changing behavior: the current tool
  surface report, current model status, scenario corpus, result schema, server
  version, and package lock. Record their content hashes in the generated
  artifact rather than relying on filenames alone.
- [ ] Define explicit `baselineVersion` and `candidateVersion` fields for
  reports. A changed scenario, model, client, metric implementation, or byte
  accounting rule requires a new version and a comparison note.

### Phase 0 acceptance

- [ ] All 28 baseline invalid calls can be assigned to a category from retained
  evidence; unknown cases remain explicitly `unobserved`.
- [ ] Generated reports reproduce the current tool counts and byte totals.
- [ ] Re-running report generation produces no diff.
- [ ] A reviewer can trace every baseline number in this document to a retained
  JSON field or deterministic generated report without manual arithmetic hidden
  in prose.

## Phase 1: Teach discovery in the always-present instructions

The server instructions should make progressive disclosure usable even when no
plugin skill is installed.

### Phase 1 work

- [ ] Add one compact durable rule to `SERVER_INSTRUCTIONS`:

  ```text
  If an expected capability is not visible, search godot_catalog, describe its
  schema, then invoke it with godot_call; do not improvise repeated low-level
  workarounds.
  ```

- [ ] Keep detailed discovery procedures in skills rather than expanding the
  initialization prompt.
- [ ] Make `godot_catalog search` results include a concise `nextStep` or
  `suggestedDescribeCall` value using the canonical tool name.
- [ ] Make `describe` return a ready-to-copy `suggestedCall` skeleton without
  inventing required argument values.
- [ ] Decide and document whether describe-before-call is guidance or an
  enforced session rule. Prefer guidance initially; enforcement would add
  state, retry, and cross-client complexity and requires separate evidence.
- [ ] Ensure search results clearly distinguish persistent authoring,
  runtime-ephemeral operations, required state, and privilege.

### Phase 1 tests

- [ ] Extend `tests/server-instructions.test.ts` with the catalog fallback rule
  and a strict initialization-byte budget.
- [ ] Extend `tests/tool-discovery-corpus.test.ts` with workaround-shaped
  queries such as “hold movement instead of repeated taps” and “change one node
  without dumping the full scene.”
- [ ] Add no-skill cold-model scenarios for at least:
  - held input;
  - 2D or 3D lighting;
  - audio playback;
  - safe asset rename;
  - export readiness.

### Phase 1 acceptance

- [ ] Every new no-skill scenario discovers the intended hidden tool at rank 1,
  inspects it, invokes it through `godot_call`, and performs no hidden direct
  call or repeated primitive workaround.
- [ ] Initialization guidance remains concise and within its explicit byte
  budget.
- [ ] The fallback rule does not claim that a tool is unavailable merely because
  it is hidden, and it does not imply that catalog inspection grants mutation
  authorization.

## Phase 2: Reduce invalid calls with targeted schema ergonomics

Do not restore verbose prose everywhere. Spend schema bytes only where retained
traces show that models make mistakes.

### Phase 2 work

- [ ] Rank tools and fields by invalid-call frequency from Phase 0.
- [ ] Add canonical positive and negative examples for the highest-error Godot
  representations, including applicable Vector, Color, Transform, resource,
  NodePath, enum, and action shapes.
- [ ] Preserve closed top-level and action-specific schemas; reject rather than
  silently ignore unknown fields.
- [ ] Ensure compact descriptions state critical temporal semantics, for
  example “tap and auto-release” versus “hold until release.”
- [ ] Add `preferredAlternative` remediation when a valid request used the
  wrong semantic tool, such as repeated `game_key_press` calls instead of
  `game_key_hold`.
- [ ] Include bounded canonical examples in structured validation errors.
- [ ] Ensure `godot_catalog describe detail=schema` and `detail=full` preserve
  all examples removed from the advertised compact definition.
- [ ] Review compound tools for action-dependent schemas so agents see only
  fields valid for the chosen action where JSON Schema compatibility permits.

### Phase 2 tests

- [ ] Add a regression fixture for each observed invalid-call category.
- [ ] Assert parity among advertised schemas, registry validation, catalog
  detail, handler requirements, and GDScript Variant decoding.
- [ ] Add positive and negative E2E cases for every new canonical structured
  example.
- [ ] Add an error-result budget so remediation does not become unbounded.

### Phase 2 acceptance

- [ ] The existing invalid corpus is either rejected before engine dispatch
  with actionable remediation or accepted with the intended Godot value.
- [ ] The aggregate cold-model invalid-call rate is at most 5%.
- [ ] No historical unknown-field, tap-versus-hold, or structured-Variant
  failure recurs.
- [ ] Invalid-call classification is based on the server's structured error
  code and field path; prose-only guesses from the model trace are not counted
  as proof.

## Phase 3: Make compound workflows win selection

The core should guide agents toward bounded, evidence-producing workflows before
they hand-compose long primitive sequences.

### Phase 3 work

- [ ] Rewrite the compact titles and first clauses of `verify_project`,
  `game_scenario`, `game_wait_until`, `editor_transaction`, and
  `run_project_tests` to state when each is the preferred operation.
- [ ] Add `preferredAlternatives` metadata from common primitive sequences to
  the corresponding compound tool.
- [ ] Return a bounded workflow hint when the server observes a repeated
  sequence that has a direct compound equivalent. Do not block valid primitive
  use.
- [ ] Review the 42-tool core for semantically overlapping tools. Move a tool
  behind catalog discovery only when cold-model evidence shows that doing so
  improves selection without damaging the complete build loop.
- [ ] Do not merge tools across different effect scopes or authorization
  boundaries.

### Phase 3 tests

- [ ] Add deterministic trace classifiers for:
  - manual validate/run/observe/stop before `verify_project`;
  - repeated input/wait/assert calls before `game_scenario`;
  - multiple editor mutations where `editor_transaction` is applicable.
- [ ] Add cold-model scenarios whose shortest correct path intentionally uses
  each preferred compound tool.

### Phase 3 acceptance

- [ ] The intended compound tool is the first applicable workflow choice in
  each targeted scenario.
- [ ] Tool-selection precision improves over the frozen baseline without
  reducing task success, search recall, or evidence quality.
- [ ] Primitive tools remain usable for interactive diagnosis and cases that
  the compound contract cannot express.
- [ ] A compound-tool hint never changes authorization, silently retries a
  mutation, or hides a primitive call from trace and Activity records.

## Phase 4: Bound result growth

Result volume is the largest remaining context risk. Optimize results before
aggressively cutting useful input schemas.

### Phase 4 work

- [ ] Add per-tool result-byte telemetry to deterministic and cold-model
  reports.
- [ ] Rank tools by total, median, p90, and maximum response bytes.
- [ ] Extend bounded-observation conventions to project analysis, imports,
  exports, add-ons, integrity, tests, file listings, scene reads, and shipping
  workflows.
- [ ] Default large reads to a concise summary with:
  - returned count;
  - total or remaining count when known;
  - truncation status;
  - refinement guidance;
  - a deterministic continuation cursor or narrower follow-up call.
- [ ] Add explicit filters for scene node paths, property names, file patterns,
  diagnostic severity, test case, and time/log windows where applicable.
- [ ] Return deltas for logs and errors instead of repeating previously consumed
  entries.
- [ ] Avoid repeating large metadata in both summary and item records.
- [ ] When the client supports `structuredContent`, investigate disabling
  equivalent legacy JSON text by adapter configuration. Preserve the compatible
  path for clients that require text.
- [ ] Hash or reference large durable artifacts where the client can retrieve
  them safely, while retaining enough inline evidence to understand the result.
- [ ] Make full-detail modes explicit and bounded rather than silently verbose.

### Phase 4 tests

- [ ] Add result-size budgets for representative success and failure fixtures.
- [ ] Verify pagination/continuation stability, deterministic ordering, and no
  omitted error severity.
- [ ] Verify that concise defaults retain the evidence required by
  `verify_project` and release gates.
- [ ] Ensure text-only and structured clients receive equivalent meaning.

### Phase 4 acceptance

- [ ] Median cold-model response bytes fall by at least 30%.
- [ ] No ordinary scenario exceeds 750,000 response bytes.
- [ ] No scenario compensates for concise output by repeatedly fetching the same
  unfiltered data.
- [ ] Existing verification conclusions remain independently reproducible.
- [ ] The 30% reduction is measured against the frozen 228,824-byte median of
  per-scenario totals, not against a selected large response or a changed
  scenario denominator.

## Phase 5: Revisit the core budget using evidence

Only optimize core membership after discovery, schema correctness, and response
volume have stable measurements.

### Phase 5 work

- [ ] Measure actual token counts for every supported adapter/model combination
  that exposes a tokenizer.
- [ ] Attribute core bytes by tool and by component: title, description, input
  schema, output schema, and annotations.
- [ ] Identify high-byte, low-use core tools and high-frequency hidden tools.
- [ ] Evaluate three candidates:
  1. the current 42-tool core;
  2. a smaller workflow-first core;
  3. the current membership with tighter schema serialization.
- [ ] Run the same no-skill and skill-backed scenario set against every
  candidate with fresh model runs.
- [ ] Choose the smallest candidate that preserves task success, search recall,
  valid-call rate, tool-selection precision, cleanup, and evidence quality.
- [ ] Keep `full` as the explicit static compatibility mode and `compact` as the
  documented 1.x alias for `core`.

### Phase 5 acceptance

- [ ] Any new core budget is justified by measured model behavior rather than
  byte reduction alone.
- [ ] The selected surface does not regress any release gate.
- [ ] Generated coverage, adapter manifests, docs, and package contents agree on
  membership and size.
- [ ] If no supported tokenizer can be measured for a model family, the report
  records `unsupported` with the reason and does not present the bytes/4
  estimate as an actual tokenizer result.

## Phase 6: Release validation and rollout

### Phase 6 work

- [ ] Run focused unit and contract suites after each phase.
- [ ] Run `npm run check`.
- [ ] Run relevant Godot and E2E suites, including progressive disclosure,
  schema failures, editor attachment, verification, and golden-agent replay.
- [ ] Execute the full external cold-model scenario set using fresh allowed
  project roots and retained raw traces.
- [ ] Compare the candidate with the frozen baseline on:
  - task and criterion success;
  - search recall at 1/3/5;
  - tool-selection precision;
  - invalid calls and self-corrections;
  - tool calls and elapsed time;
  - initialization and response bytes;
  - detached editor/runtime mistakes;
  - pause violations;
  - trace accuracy;
  - cleanup state.
- [ ] Update generated coverage and evaluation records without rewriting
  historical evidence.
- [ ] Document any intentional compatibility or result-shape change in release
  notes.

### Release gate

- [ ] All success measures in this plan pass.
- [ ] No unresolved high-severity regression remains.
- [ ] Historical records remain labeled with their original versions and tool
  counts.
- [ ] The final report distinguishes deterministic proof, fresh-model evidence,
  unsupported claims, and manual-review requirements.

## Ownership, dependencies, and rollout

The implementation owner for each phase is the maintainer responsible for the
named repository area; the reviewer is a maintainer who did not author the
measurement or schema change. No phase is accepted from a green unit test alone.

| Phase | Primary owner | Required dependency | Review evidence |
| --- | --- | --- | --- |
| 0 | Evaluation and tooling maintainer | Stable current surface and retained traces | Versioned baseline report and reproducible generation |
| 1 | MCP server maintainer | Phase 0 initialization-byte measurement | Instruction test, catalog contract test, and no-skill traces |
| 2 | Schema and validation maintainer | Classified invalid-call corpus | Structured error fixtures plus positive/negative engine coverage |
| 3 | Workflow maintainer | Stable discovery and error metrics | Trace classifier and fresh compound-workflow scenarios |
| 4 | Observation/result maintainer | Result-byte telemetry and evidence inventory | Size budgets, cursor tests, and verification replay |
| 5 | Surface/adapter maintainer | Stable Phases 1–4 metrics | Fresh A/B runs for each surface candidate |
| 6 | Release maintainer | All candidate artifacts and raw traces | Full gate matrix and release-record review |

Roll out in two stages. First, land server-side telemetry, bounded hints, and
backward-compatible result fields behind existing behavior; do not change the
default surface or remove legacy text in the measurement stage. Second, change
defaults only after the candidate beats the frozen baseline on task success,
invalid calls, response volume, cleanup, and evidence quality. Keep `full` and
the deprecated `godot_tools` compatibility path available for rollback through
the documented 1.x compatibility window. Any result-shape or default-surface
change must update release notes, adapter metadata, and the generated coverage
record in the same commit.

## Completion audit

The final report must contain one row for each success measure above with the
following fields: requirement ID, observed value, threshold, evidence path,
evaluation version, and status. Use these proof sources:

| Requirement family | Authoritative proof |
| --- | --- |
| Catalog reachability and surface budget | Tool-surface report, registry/handler contract tests, adapter smoke, and a full-mode hidden-call trace |
| Discovery and compound selection | Ranked discovery corpus plus fresh no-skill/skill-backed traces with effective-tool attribution |
| Invalid calls and remediation | Versioned result schema, structured error fixtures, classified raw traces, and positive/negative E2E cases |
| Result volume and evidence | Per-scenario/per-tool telemetry, bounded-result fixtures, continuation tests, and verification replay |
| Safety and cleanup | Effective-call policy tests, Godot/E2E traces, pause/roots/cancellation checks, and pre/post residue reports |
| Compatibility and packaging | Build output, adapter manifests, package archive checks, docs consistency, and legacy alias tests |
| Tokenizer measurements | Model-family tokenizer artifact, tokenizer version, serialized input, and unsupported reasons where applicable |

If any row is `missing`, `unobserved`, `unsupported`, or `manual`, the program
remains proposed. Those statuses are useful release information, but they are
not substitutes for passing evidence.

## Suggested implementation order

1. Phase 0 measurement and invalid-call classification.
2. Phase 1 initialization discovery rule.
3. Phase 4 result bounding for the worst byte-producing tools.
4. Phase 2 targeted schema and remediation improvements.
5. Phase 3 compound-tool selection guidance.
6. Phase 5 evidence-based core-size experiment.
7. Phase 6 full validation and release record.

Result bounding moves ahead of broad schema editing because retained evaluations
show that response payloads exceed initial tool-definition cost during serious
work. The catalog instruction is first among behavior changes because it is
small, client-independent, and protects agents that do not load plugin skills.

## Risks and controls

| Risk | Control |
| --- | --- |
| Compact schemas remove decisive semantic guidance | Optimize from observed invalid fields and keep full catalog detail available |
| Smaller core hides a frequently needed operation | Require no-skill cold-model comparison and retain catalog execution |
| Concise results omit evidence | Define evidence-preserving result contracts and test independent reproduction |
| Pagination causes repeated or inconsistent reads | Use deterministic ordering, stable cursors, and explicit remaining counts |
| Catalog hints become authorization | Keep hints advisory; enforce roots, Pause Agent, privilege, and mutation policy server-side |
| Describe-before-call enforcement breaks retries or clients | Begin as guidance; require separate design evidence before enforcement |
| Cold-model improvements overfit one model | Retain deterministic corpora and sample the primary supported model families |
| Historical metrics are overwritten | Append versioned candidate records and preserve original evidence unchanged |

## Likely files in scope

- `src/server-instructions.ts`
- `src/tool-surface.ts`
- `src/tool-definitions.ts`
- `src/tool-output-schema.ts`
- `src/tool-argument-validation.ts`
- `src/tool-results.ts`
- `src/observation-result.ts`
- `src/tool-catalog-metadata.ts`
- `src/tool-handlers/`
- `tests/tool-surface.test.ts`
- `tests/tool-discovery-corpus.test.ts`
- `tests/tool-schema-failures.test.ts`
- `tests/e2e/progressive-disclosure.test.ts`
- `tests/e2e/agent-adapter-smoke.test.ts`
- `evals/result.schema.json`
- `evals/cold-model-runner.mjs`
- `evals/cold-model/metrics.md`
- `docs/coverage/`
