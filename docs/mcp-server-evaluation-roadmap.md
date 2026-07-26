# MCP server evaluation and improvement roadmap

- Status: operational; stochastic calibration evidence pending an authorized run
- Date: 2026-07-26
- Scope: MCP protocol, the 173-tool Godot surface, progressive discovery,
  agent behavior, engine integration, safety, cleanup, and performance

## Executive decision

Adopt a layered evaluation system rather than replacing the repository's
existing tests:

1. Use the official MCP conformance suite and MCP Inspector CLI for protocol
   correctness.
2. Adapt [Inspect AI](https://inspect.aisi.org.uk/) as the controlled behavioral
   evaluation harness.
3. Borrow [MCP-Bench](https://arxiv.org/abs/2508.20453)'s three-level rubric:
   tool/schema use, execution trajectory, and task outcome.
4. Keep the existing Godot cold-model runner as the fixture, state-verification,
   and real-client acceptance layer while its reusable parts move behind common
   interfaces.
5. Add Promptfoo only as an optional security/red-team lane, not as the primary
   task harness.

Inspect AI is the best primary fit because it already supports local stdio MCP
servers, persistent MCP connections, tool filtering, multi-turn agents, custom
scorers, repeated epochs, resumable evaluation sets, sandboxing, and external
agent bridges including Codex CLI. Its logs and viewer also remove much of the
custom reporting work. The relevant facilities are documented in
[MCP tools](https://inspect.aisi.org.uk/tools-mcp.html),
[agent bridges](https://inspect.aisi.org.uk/agent-bridge.html),
[eval sets](https://inspect.aisi.org.uk/eval-sets.html), and
[scoring metrics](https://inspect.aisi.org.uk/metrics.html).

This is an adaptation, not a Python rewrite of the MCP server. Inspect and its
locked Python environment live entirely under `evals/`; the product remains
TypeScript and GDScript.

## Implementation snapshot

The roadmap is implemented as an operational evaluation system. This table
separates completed engineering from evidence that requires an authorized
stochastic model run.

| Area | Status | Evidence |
| --- | --- | --- |
| Versioned corpus and immutable release baseline | Complete | `evals/case.schema.json`, 24 cases, `evals/baselines/v1.1.4/manifest.json` |
| Deterministic A/A evaluator replay | Complete | Two zero-delta batches in `evals/baselines/v1.1.4/aa-calibration.json` |
| Stochastic A/A model calibration | Runnable; evidence pending authorization | `eval:calibrate` runs two baseline/baseline, three-epoch batches over the original nine cases |
| Protocol lane | Complete | Five applicable conformance scenarios, production-stdio Inspector, transport-equivalence E2E |
| Inspect AI controlled harness | Complete | Locked Python environment, native stdio MCP, ReAct tasks, deterministic scorers, no-cost mock smoke |
| Metric repair and corpus growth | Complete | 24 cases, evidence IDs, capability/trajectory/grounding metrics, budgets, scorer audit |
| Paired behavioral comparison | Complete | Immutable baseline launcher, randomized order, three-epoch minimum, clustered bootstrap intervals |
| CI and release enforcement | Complete | Manual paid lane, change-impact selection, artifact attestation; publication remains ungated |
| Real-client cold-model acceptance | Preserved | Existing Codex CLI runner remains the shipping-client lane |

The deterministic gates do not silently substitute for the pending stochastic
evidence. `eval:inspect` and `eval:paired` reject live sampling unless both a
model and explicit confirmation are supplied.

## Desired outcome

Every meaningful server change should answer four questions with evidence:

- Did the MCP protocol and every affected tool contract remain correct?
- Can a fixed agent complete representative Godot tasks more reliably?
- Did safety, user-control, cleanup, or compatibility regress?
- Is any quality improvement worth its latency, call, and context cost?

The framework must support controlled candidate-versus-baseline experiments. A
server change, tool-surface change, skill change, client change, and model change
must not be mixed into one comparison.

## Starting point

The repository is substantially ahead of a greenfield evaluation effort:

- `npm run check`, Godot integration suites, and MCP-to-Godot E2E tests cover
  contracts and real-engine behavior.
- The generated
  [coverage inventory](coverage/coverage-report.md) maps every public tool and
  action to resolving tests.
- The current surface contains 173 tools, while the default `core` surface
  advertises 42 tools and reduces serialized tool-definition bytes by 94.93%.
- [The cold-model corpus](../evals/scenarios.json) contains nine primary and
  edge scenarios with deterministic fixtures and forbidden conditions.
- [The recorded cold-model result](../evals/current-model-status.json) records
  nine passing runs from 2026-07-16 against server version 1.1.1, 28/28
  acceptance criteria, 252 tool calls, 28 invalid calls, 27 recorded
  self-corrections, about 25 minutes of wall time, and 3.61 MB of MCP responses.
  It is a useful starting baseline, not a qualification result for the current
  package version.
- [The result schema](../evals/result.schema.json) already records client,
  model, effort, prompt and skill hashes, server version, surface, criteria,
  trace metrics, and cleanup.
- [The loop benchmark](../scripts/benchmark-authoring-loop.mjs) already enforces
  absolute and relative latency budgets.

At roadmap authoring time, the main gaps were evaluation design rather than raw
test volume. The implementation snapshot above records their current status:

- Each current behavioral scenario has one stochastic sample, so 9/9 is a
  release record rather than an estimate of reliability.
- The corpus primarily evaluates the skill bundle through one model and client;
  it does not isolate the server from the skill, client, or model.
- Scenario scoring is hard-coded into one JavaScript switch, which makes
  expansion and independent review expensive.
- `invalidCalls` is a count rather than a rate, and the current
  `traceAccuracy` is not claim-level accuracy against ground truth.
- Tool-selection precision uses a hand-maintained relevant-tool set but does not
  represent interchangeable valid paths or required capability recall.
- There is no paired candidate-versus-release comparison with uncertainty.
- The server has comprehensive contract tests but does not yet publish a result
  from the official
  [MCP conformance framework](https://github.com/modelcontextprotocol/conformance).
- Raw behavioral evidence remains local, which limits failure review in CI.

## Framework selection

| Candidate | Use | Decision |
| --- | --- | --- |
| Inspect AI | MCP execution, agents, datasets, custom scoring, epochs, logs, comparison inputs | Primary behavioral harness |
| Existing cold-model runner | Godot fixtures, process isolation, project hashes, cleanup, exact client acceptance | Retain and refactor |
| MCP-Bench | Tool/schema, trajectory, and outcome rubric; fuzzy discovery and multi-step tasks | Adapt methodology |
| Official MCP conformance | Specification-level protocol checks and known-failure baselines | Required protocol lane |
| MCP Inspector CLI | Stdio smoke tests and manual debugging | Required developer lane |
| Promptfoo MCP provider | Direct MCP robustness and security probing | Optional after the core harness |

MCP-Bench's implementation is aimed at many live servers and domains, whereas
this server is stateful, engine-backed, local, and cleanup-sensitive. Importing
its complete runner would discard the repository's strongest asset: objective
Godot fixture verification. Its rubric and task-design principles are useful;
its runtime is not the right base.

Promptfoo can treat an MCP server directly as a test target, including for
robustness and red teaming, but its
[MCP provider](https://www.promptfoo.dev/docs/providers/mcp/) is not as natural
a fit for long-lived Godot processes, project snapshots, editor sessions, and
multi-stage runtime evidence.

## Evaluation architecture

```text
case + immutable fixture + environment manifest
                         |
             candidate and baseline launchers
                         |
       +-----------------+-----------------+
       |                 |                 |
 protocol checks   controlled agent   real client/skill
 conformance and   Inspect ReAct or    Codex/Claude/etc.
 Inspector CLI     fixed solver        existing runner
       |                 |                 |
       +---------- trace + state evidence-+
                         |
 deterministic scorers -> semantic scorer if unavoidable
                         |
 per-case result -> paired comparison -> release decision
```

### Layer 0: corpus integrity

Fast, deterministic checks validate:

- unique case IDs and versioned schemas;
- fixture, prompt, skill, tool-inventory, and server hashes;
- declared scorer coverage for every acceptance and forbidden condition;
- no `unobserved` condition in a release-gating case;
- stable case tags, capability groups, budgets, and environment requirements.

This extends `tests/agent-evaluations.test.ts`; it does not sample a model.

### Layer 1: protocol and deterministic behavior

Run on every pull request:

- existing TypeScript contract and schema-parity tests;
- existing real-Godot integration and affected E2E suites;
- MCP Inspector CLI checks for initialization, `tools/list`, representative
  valid calls, invalid calls, and structured errors over stdio;
- the official MCP conformance active server suite.

The official conformance server runner currently accepts an HTTP URL, while the
product exposes stdio. Factor server construction from transport startup and
add an ephemeral, test-only Streamable HTTP entry point backed by the exact same
`McpServer`, registry, handlers, policy, and schemas. An equivalence test must
compare the stdio and HTTP tool-list hash and representative call results before
the HTTP conformance result can gate the stdio product.

Use the conformance tool's expected-failure file only for a documented,
time-bounded exception. A newly passing expected failure must also fail CI until
the stale baseline entry is removed.

### Layer 2: controlled agent behavior

Inspect AI launches the candidate server with `mcp_server_stdio()` and runs a
fixed agent policy against isolated fixture copies. This lane evaluates the
server independently of a particular coding-client implementation.

Two controlled tasks are needed:

- **No-skill server task:** fixed solver, prompt, model, effort, and advertised
  surface. This measures discovery, schema usability, tool behavior, and
  evidence quality.
- **Skill-assisted task:** the same solver with exactly one hashed skill
  instruction. This measures the combined product while keeping the agent
  implementation fixed.

Each comparison changes only one factor:

- candidate server versus latest released server;
- candidate `core` surface versus released `core` surface;
- candidate skill versus released skill on the same server;
- or model/client qualification on the same released product.

### Layer 3: real-client acceptance

The current `evals/cold-model-runner.mjs` remains the black-box acceptance lane.
It proves actual client discovery, permissions, trace shape, skill loading,
human pause behavior, and teardown. Over time, factor its fixture preparation,
snapshotting, trace normalization, scoring primitives, and cleanup into modules
shared with Inspect.

Do not replace this lane with a simulated client. A controlled solver and a
shipping client answer different questions.

## Case contract

Move from scenario-specific scoring code to a declarative case schema. A case
should contain:

- `id`, `version`, `description`, and `risk`;
- tags for domain, backend, effect, required state, platform, build flavor,
  renderer, task length, surface, and skill;
- exact prompt plus fixture builder and initial-state hash;
- allowed and forbidden mutations;
- valid tool groups, required capability groups, and optional reference
  trajectory constraints;
- objective verifiers and their evidence sources;
- forbidden-condition verifiers;
- per-case call, response-byte, wall-time, and cleanup budgets;
- environmental requirements and an explicit unsupported result;
- ownership and the bug or product requirement that motivated the case.

Reference trajectories must describe partial order and capability groups, not
one exact call sequence. For example, a valid verifier can require:

```json
{
  "requiredCapabilities": [
    ["editor_session"],
    ["create_scene", "editor_transaction"],
    ["run_project", "verify_project"],
    ["game_key_hold"],
    ["game_key_release", "stop_project"]
  ],
  "order": [
    ["editor_session", "persistent_mutation"],
    ["persistent_mutation", "runtime_observation"],
    ["runtime_observation", "cleanup"]
  ]
}
```

This allows different correct tool choices while still detecting detached
authoring, missing runtime proof, or cleanup leaks.

### Scorer precedence

Use the strongest available evidence in this order:

1. Engine or protocol assertion.
2. Parsed project/resource state.
3. File hashes and process/input/bridge residue.
4. Structured MCP trace and tool-result metadata.
5. Bounded text or image comparison.
6. Blinded semantic grader.
7. Human review.

Safety, persistent mutation, cleanup, protocol correctness, and objective game
state must never depend on an LLM judge. Semantic grading is reserved for
evidence quality or genuinely subjective output. Any judge should be blinded to
candidate/baseline identity, use a versioned rubric, and be audited against a
small human-labelled set.

## Scorecard

Do not collapse the result into one weighted score. Publish independent outcome,
safety, tool-use, trajectory, performance, and compatibility sections so a
quality gain cannot hide a safety regression.

### Hard gates

These are binary per run:

- protocol and schema conformance;
- no unauthorized persistent mutation;
- no path, privilege, pause, or human-control violation;
- no leaked secret or credential material;
- no held input, owned process, runtime bridge, editor connection, or transient
  artifact after cleanup;
- objective fixture postconditions;
- no unsupported or manual criterion reported as passed.

### Quality metrics

| Area | Metric | Definition |
| --- | --- | --- |
| Outcome | Task success | All required objective criteria, forbidden checks, and cleanup gates pass |
| Outcome | Criterion success | Passed objective criteria divided by all objective criteria |
| Tool use | Valid-call rate | Successful schema-valid calls divided by completed MCP calls |
| Tool use | Repair rate | Invalid-call episodes followed by a successful same-intent call before task end |
| Discovery | Recall at 1/3/5 | Required hidden capability groups represented in ranked catalog results |
| Selection | Precision | Calls belonging to a valid capability path divided by non-cleanup calls |
| Selection | Capability recall | Required capability groups exercised with successful evidence |
| Trajectory | Order compliance | Required partial-order edges satisfied divided by applicable edges |
| Grounding | Claim precision | Final pass/fail claims supported by retained evidence divided by all such claims |
| Efficiency | Redundant-call rate | Repeated calls that add no new state or evidence divided by completed calls |
| Performance | End-to-end latency | Wall time to terminal outcome, reported as median and p95 |
| Performance | Tool latency | Server-side duration by tool/backend, reported as median and p95 |
| Context | Response bytes | MCP result bytes in total and by tool; estimated tokens are secondary |
| Reliability | Flake rate | Same case/environment producing different objective outcomes across epochs |

Metric denominators and exclusions must be stored in every result. For example,
cleanup calls should not reduce selection precision, and vacuous catalog recall
must be reported as `not_applicable`, not `1.0`.

Replace the current `traceAccuracy` with claim precision and claim recall
against explicit evidence IDs. Preserve raw invalid-call counts, but gate on the
rate and repair outcome so longer successful workflows are not penalized merely
for having more calls.

## Comparison and release gates

### Experimental controls

- Compare a candidate with the latest released npm package and, when useful,
  current `main`.
- Pair runs by case, fixture hash, model, effort, solver/client, skill hash,
  surface, Godot version, OS, renderer, and epoch.
- Randomize candidate/baseline order to reduce provider and machine drift.
- Run an A/A study before setting thresholds to measure natural variance.
- Use at least three epochs for stochastic primary cases. Increase epochs for
  cases near a gate rather than averaging more unrelated cases.
- Report per-case results and a scenario-clustered 95% bootstrap interval. Tool
  calls are not independent samples.
- Never compare runs from silently changed model aliases. Record exact model
  identifiers and provider metadata when available.

### Provisional gates

Lock these thresholds after two A/A calibration batches; do not tune them to
rescue a candidate:

- 100% of protocol, deterministic contract, and hard-safety gates pass.
- 100% task success on critical pause, privilege, mutation, and cleanup cases.
- At least 90% task success and 95% objective-criterion success across the
  primary behavioral suite.
- The lower bound of the paired 95% interval for candidate-minus-release task
  success is no worse than -5 percentage points.
- No capability domain loses more than 10 percentage points in its point
  estimate, even when the aggregate gate passes.
- Catalog recall at 5 remains 100% for required hidden capability groups, and
  recall at 3 is non-inferior to the released baseline.
- Median total response bytes, redundant-call rate, and end-to-end latency do
  not regress by more than 10% unless task success improves by at least
  5 percentage points and the trade-off is recorded.
- No new p95 tool latency exceeds its backend-specific budget.

A release may document an environmental `unsupported` result, but it may not
convert it into a pass or omit it from the support matrix.

## Suite matrix and cadence

| Suite | Contents | Cadence | Gate |
| --- | --- | --- | --- |
| Corpus | Schemas, hashes, scorer coverage, fixture determinism | Every PR | Required |
| Protocol | Inspector stdio smoke and official conformance through the equivalent HTTP test transport | Every PR | Required |
| Deterministic | `npm run check`, affected Godot suites, tool/action coverage | Every PR | Required |
| Behavioral smoke | High-risk no-skill cases, one epoch, controlled solver | PR label or tool-surface change | Required when invoked |
| Behavioral primary | All primary cases, three epochs, candidate versus release | Nightly | Required before release |
| Security/adversarial | Policy, path, prompt-injection, pause, malformed-result, and resource-limit cases | Weekly and before release | Required |
| Client qualification | Existing cold-model runner with supported clients and skills | Weekly and before release | Required for claimed clients |
| Platform | Godot floor/latest, Node floor/target, renderers, .NET, Linux plus claimed portable paths | Existing CI cadence and release | Required for support claims |
| Watched acceptance | Headed editor, Activity evidence, pause, undo/redo, visual proof | Release candidate | Required, retained evidence |

Model-sampling jobs should never run for documentation-only changes by default.
Use changed paths and case tags to select the smallest meaningful suite, then
run the full release matrix only at promotion time.

## Corpus expansion

Retain the current nine cases and expand to roughly 24-30 cases before enforcing
aggregate behavioral thresholds.

### Priority 0: isolate server quality

- Single-tool schema comprehension for lifecycle, project, and runtime tools.
- Fuzzy discovery of hidden verification, export, integrity, and runtime tools.
- Equivalent valid authoring paths on `core` and `full`.
- Exact invalid-argument recovery without changing task intent.
- Bounded reads and pagination under large scene, log, and tree results.
- Structured error quality when Godot is absent, exits, or times out.

### Priority 1: long-horizon Godot workflows

- Create, persist, run, observe, modify, re-run, and independently verify.
- Attach to an existing editor, preserve unsaved state, apply one undoable
  transaction, and prove synchronization.
- Diagnose one seeded causal defect while ignoring a nearby misleading warning.
- Prove ordinary, success, failure, and adjacent-regression states.
- Visual-regression baseline, mask, mismatch artifact, and teardown.
- Export readiness, one available artifact, and one honestly blocked target.

### Priority 2: safety and adversarial behavior

- Paused editor before mutation and pause activated mid-run.
- Project file, log line, UI label, or tool result containing instructions that
  conflict with the user's request.
- Path traversal, symlink escape, Unicode path, and out-of-root mutation.
- Privileged reflection, code execution, and networking denied by default.
- Repeated dispatcher calls, recursive dispatch, oversized arguments, and
  response-limit pressure.
- Crashed client/server cleanup with no unrelated process termination.

### Priority 3: scale and compatibility

- Large project inventory and scene tree.
- Repeated warm authoring operations versus subprocess fallback.
- Multiple simultaneous editors with strict project routing.
- Godot compatibility floor versus newest stable release.
- GDScript versus .NET project delivery and supported renderers.

Every escaped production bug adds a minimized regression case before its fix is
considered complete.

## Proposed repository layout

```text
evals/
  cases/
    server.jsonl
    skills.jsonl
    adversarial.jsonl
  fixtures/
    prepare.mjs
    verify.mjs
  inspect/
    pyproject.toml
    uv.lock
    godot_agent_loop_eval/
      tasks.py
      solver.py
      scorers.py
      fixtures.py
      reporting.py
  baselines/
    v1.1.4/
      manifest.json
      summary.json
  runs/                 # ignored raw Inspect and client logs
  reports/              # generated, bounded comparison reports
  result.schema.json
scripts/
  compare-evals.mjs
  generate-eval-report.mjs
```

Fixture creation and verification should remain Node/Godot code invoked through
a stable JSON subprocess contract. Inspect owns orchestration, agent sampling,
epochs, and its native log. This avoids implementing Godot resource semantics
twice.

Suggested package entry points after implementation:

```text
npm run eval:corpus
npm run eval:protocol
npm run eval:smoke
npm run eval:nightly
npm run eval:calibrate -- --model PROVIDER/EXACT_MODEL --confirm-external-run
npm run eval:compare -- --baseline v1.1.4
npm run eval:release
npm run eval:view
```

### Ownership and implementation boundaries

The roadmap assigns each concern to the smallest existing layer that can prove
it. New evaluators must not duplicate Godot semantics or silently redefine the
shipping contract.

| Concern | Owning artifact | Required evidence |
| --- | --- | --- |
| MCP server construction and transport equivalence | `src/index.ts` plus the new test-only HTTP launcher | Same registry, handlers, policy, schemas, tool-list hash, and representative call results over stdio and Streamable HTTP |
| Tool and protocol contracts | `src/`, `docs/`, existing contract suites, Inspector, and conformance results | Versioned check output tied to the candidate commit |
| Fixture preparation, snapshots, state verification, and cleanup | `evals/fixtures/` and existing cold-model helpers | Fixture hash, pre/post state manifest, owned-process and residue report |
| Controlled agent behavior | `evals/inspect/` | Inspect log, solver/model metadata, epoch, trace, scorer output, and bounded failure evidence |
| Shipping-client acceptance | `evals/cold-model-runner.mjs` and `agent-plugin/` | Retained result-schema-compatible run with client, skill, model, and prompt hashes |
| Candidate comparison and release decision | `scripts/compare-evals.mjs`, generated report, and immutable baseline directory | Paired per-case results, interval calculation, every gate decision, and artifact manifest |

The HTTP launcher is a conformance fixture, not a commitment to ship a network
transport. It must bind only to an ephemeral local address, reject unexpected
origins or requests, and terminate with the test. The production entry point
remains stdio unless a separate product decision changes that boundary.

### Reproducibility and evidence policy

- Pin the Inspect, conformance, and Inspector versions in the repository's
  evaluation lockfiles. Do not use an unversioned `npx` invocation in CI.
- Record exact model and client identifiers, Node and Godot versions, OS,
  renderer, environment capability flags, Git commit, package-lock hash, and
  all prompt, skill, fixture, server, and tool-inventory hashes.
- Store bounded summaries and manifests in the repository only when they contain
  no secrets or private project data. Upload raw traces and screenshots as
  access-controlled CI artifacts with a retention period; never put credentials
  in logs or scorer input.
- Use the statuses `passed`, `failed`, `blocked`, `unsupported`, `manual`, and
  `unobserved` explicitly. Only `passed` satisfies a release gate; the others
  remain visible in reports and require the declared handling for that case.
- A report is invalid when a required criterion has no scorer, evidence ID,
  denominator, environment status, or cleanup result. Missing evidence is not
  success.

### Release-decision artifact

Every candidate-versus-baseline run produces a machine-readable summary and a
human-readable report. The summary must include:

- immutable candidate and baseline manifests;
- the exact case set, selected factors, pair/epoch IDs, and environment matrix;
- per-case hard-gate status, criterion evidence IDs, metric values, and
  denominator/exclusion details;
- per-domain aggregate values, scenario-clustered uncertainty intervals, and
  flake classifications;
- every provisional-gate decision with the observed value, threshold, and
  reason for `pass`, `fail`, `blocked`, or `unsupported`;
- links or content hashes for retained traces, screenshots, state manifests,
  conformance output, and cleanup evidence;
- the evaluator version, scorer version, reviewer/audit status, and generated
  timestamp.

The report must keep outcome, safety, tool use, trajectory, performance, and
compatibility independent. A single headline score is not a release artifact.

## Non-goals

- Rewriting the TypeScript MCP server or Godot bridge in Python.
- Replacing objective engine, protocol, policy, or cleanup assertions with an
  LLM judge.
- Treating a controlled solver as evidence that every supported client behaves
  correctly.
- Adding a network transport to the product merely to satisfy conformance.
- Treating more tool calls, more context, or a passing semantic grade as a
  quality improvement when a hard safety or cleanup gate regresses.

## Roadmap

### Phase 0: freeze the baseline and specification

Estimate: 2-3 days

- Version the case contract as scenario set 2.
- Define critical cases, evidence IDs, metric denominators, and unsupported
  semantics.
- Snapshot the latest released package, tool inventory, current result, engine,
  client, model, and fixture hashes.
- Run two A/A batches with the current nine scenarios to measure evaluator and
  model variance.
- Document retention: committed bounded summaries; encrypted or access-limited
  raw traces as CI artifacts; no credentials, tokens, or private project data.

Exit gate: two identical inputs produce schema-valid, comparable reports, and
all current acceptance/forbidden checks have objective scorer coverage.

### Phase 1: protocol lane

Estimate: 1 week

- Factor `McpServer` construction from `StdioServerTransport` startup.
- Add the ephemeral Streamable HTTP conformance launcher.
- Prove tool-list and representative call equivalence across transports.
- Add Inspector CLI stdio smoke commands.
- Pin the official conformance package and run its active server suite in CI.

Exit gate: protocol jobs pass from a clean checkout, and no unexplained
expected-failure entry remains.

### Phase 2: Inspect AI minimum viable harness

Estimate: 1-2 weeks

- Pin Inspect in `evals/inspect/pyproject.toml` and `uv.lock`.
- Import the existing nine prompts without changing their bytes.
- Wrap fixture preparation, engine validation, snapshots, and cleanup.
- Implement deterministic acceptance, forbidden-condition, tool-trace, and
  cleanup scorers.
- Export a compatibility summary matching `evals/result.schema.json`.
- Make Inspect View usable locally and upload bounded logs on CI failure.

Exit gate: the existing runner and Inspect agree on every objective result for a
recorded replay; discrepancies block migration.

### Phase 3: metric repair and corpus growth

Estimate: 2 weeks

- Add capability-group precision/recall and partial-order trajectory scoring.
- Replace vacuous recall and heuristic trace accuracy.
- Add server-only no-skill cases and grow the corpus to at least 24 cases.
- Add three epochs for primary stochastic cases.
- Establish backend latency and response-byte budgets from measured data.
- Human-audit at least 20% of semantic grades and every failed critical case.

Exit gate: inter-reviewer agreement and scorer false-positive/negative rates are
published; provisional gates are frozen from A/A evidence.

### Phase 4: paired regression CI

Estimate: 1 week

- Build candidate and released-baseline launchers from immutable artifacts.
- Randomize paired run order and generate scenario-clustered intervals.
- Add change-impact selection and explicit opt-in for paid model jobs.
- Publish a concise GitHub job summary with links to failing cases and evidence.
- Keep paid behavioral evaluation opt-in and separate from publication.

Exit gate: a deliberately regressed tool description, schema, handler, policy,
cleanup path, and latency budget is independently caught by the expected lane.

### Phase 5: continuous improvement

Ongoing

- Review the top failure clusters weekly.
- Convert each real failure into a minimized case.
- Run controlled ablations of tool names, descriptions, schemas, surface
  membership, outputs, and skills.
- Prefer the smallest change that improves the target metric without moving a
  hard gate.
- Promote a baseline only after the release is published; never overwrite
  historical baselines.
- Requalify models and clients separately from server comparisons.

## Iteration workflow

For each server improvement:

1. Classify the failure as protocol, discovery, selection, arguments,
   execution, observation, grounding, policy, cleanup, performance, or
   environment.
2. Reproduce it with the smallest deterministic fixture possible.
3. Add the failing case and scorer before changing the product.
4. Select one intervention: description, schema, surface, handler, output,
   policy, or skill.
5. Run a paired scoped comparison with all other factors fixed.
6. Inspect traces for metric gaming or shifted failure modes.
7. Run the full relevant deterministic, behavioral, safety, and compatibility
   lanes.
8. Record the decision and promote only after every hard gate passes.

This loop makes a failed eval actionable: it identifies whether to improve
discoverability, argument design, runtime behavior, evidence, or instructions
instead of treating all failures as prompt problems.

## Definition of done

The framework is operational when:

- a clean checkout can run corpus, protocol, deterministic, and controlled
  behavioral suites from documented commands;
- candidate and released server builds can be compared without changing the
  prompt, model, agent, skill, fixture, or environment;
- every release-gating criterion points to retained objective evidence;
- repeated runs report variance and per-domain results rather than one 9/9
  headline;
- CI catches seeded protocol, discovery, schema, behavior, safety, cleanup, and
  performance regressions;
- raw evidence is reviewable without exposing secrets;
- a release decision is reproducible from immutable artifacts and hashes;
- the existing real-client cold-model gate remains intact.

## External references

- [Inspect AI overview](https://inspect.aisi.org.uk/)
- [Inspect AI MCP integration](https://inspect.aisi.org.uk/tools-mcp.html)
- [Inspect AI agent bridge](https://inspect.aisi.org.uk/agent-bridge.html)
- [Inspect AI eval sets](https://inspect.aisi.org.uk/eval-sets.html)
- [Inspect AI scoring metrics](https://inspect.aisi.org.uk/metrics.html)
- [Official MCP conformance framework](https://github.com/modelcontextprotocol/conformance)
- [Official MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector)
- [MCP-Bench paper](https://arxiv.org/abs/2508.20453)
- [MCP-Bench implementation](https://github.com/Accenture/mcp-bench)
- [Promptfoo MCP provider](https://www.promptfoo.dev/docs/providers/mcp/)
