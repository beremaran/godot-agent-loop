# Evaluating the MCP server

Godot Agent Loop uses layered evaluation. No single benchmark is treated as
proof of protocol correctness, real-engine behavior, or agent reliability.

## What runs the evaluation

| Lane | Harness | Agent/client | Model |
| --- | --- | --- | --- |
| Protocol conformance | Pinned `@modelcontextprotocol/conformance` 0.1.16 | Direct MCP protocol client | None |
| Inspector smoke | Pinned MCP Inspector 1.0.0 over production stdio | Direct MCP protocol client | None |
| Deterministic product tests | Vitest plus real Godot shell harnesses | Direct tool calls | None |
| Controlled behavior | Pinned Inspect AI 0.3.249 with Python MCP SDK 1.28.1 | Inspect's ReAct agent and native `mcp_server_stdio()` source | Explicit `--model`; no silent default live model |
| Shipping-client acceptance | `evals/cold-model-runner.mjs` | Codex CLI | Recorded baseline: GPT-5.6 Luna, high effort |

The controlled Inspect lane is provider-neutral. The model identifier is a run
input, is written into result evidence, and must be supplied explicitly for a
live run. The CLI refuses to sample unless both `--model` and
`--confirm-external-run` are present. This prevents CI, a documentation edit, or
a local smoke test from silently incurring model cost.

The no-skill case gives ReAct only a short MCP-only instruction. Skill-assisted
cases load exactly one hashed `SKILL.md` as the agent instruction. The user
prompt remains byte-for-byte equal to the versioned case prompt. The common
harness context states that the MCP server working directory is the isolated
project and that `projectPath: "."` identifies it, matching the cwd context
available to shipping clients.

## Why Inspect AI was previously absent

The original evaluation roadmap was a proposal, not an implementation record.
The repository had a strong custom cold-model runner and nine recorded cases,
but it lacked:

- a locked Python evaluation environment;
- native Inspect tasks and an MCP lifecycle;
- an adapter from Inspect messages to the objective fixture scorer;
- repeated-epoch isolation;
- provider-neutral model selection and a no-cost construction check; and
- CI installation, native MCP probing, and Inspect View entry points.

Those pieces now live under `evals/inspect/`. Inspect orchestrates the agent,
MCP session, logs, and epochs. Node and Godot still own fixture construction,
project hashing, trace normalization, objective verification, and cleanup; the
Python harness does not duplicate Godot semantics.

## Fast, no-model evaluation

Install both locked dependency sets, then run:

```bash
npm ci --ignore-scripts
npm run build
npm run eval:corpus
npm run eval:protocol
npm run eval:inspect:sync
npm run eval:inspect:check
```

`eval:protocol` runs five applicable official conformance scenarios through the
test-only loopback HTTP transport, then uses Inspector against production stdio
to check `tools/list`, one valid catalog call, and one schema-invalid call with
its retryable structured argument error. It writes bounded JSON and Markdown
reports under `evals/reports/protocol/`.
The remaining active conformance scenarios require optional capabilities the
server does not advertise or literal conformance-fixture tools; every exclusion
and reason is versioned in
[`evals/protocol/conformance-scenarios.json`](../evals/protocol/conformance-scenarios.json).
They are reported as non-applicable, never as passes.

`eval:inspect:check` constructs every task, prepares isolated fixtures, opens
each server with Inspect's native Python MCP client, verifies the 42-tool core
surface, executes a recorded scorer replay, and cleans the owned fixture
workspaces. It does not sample a model.

The controlled corpus contains 24 cases: nine retained long-horizon
skill/client cases and 15 no-skill server, discovery, response-bound, recovery,
and adversarial cases. `npm run eval:select -- --base BASE --head HEAD` maps
changed paths to the smallest relevant set and never starts a paid run by
itself.

## Controlled live runs

One case and one epoch:

```bash
npm run eval:inspect -- \
  --scenario compact-no-skill-discovery \
  --model PROVIDER/MODEL \
  --confirm-external-run \
  --result-output ../reports/inspect/candidate-results.json
```

The primary suite uses three independently prepared fixture copies per case:

```bash
npm run eval:nightly -- \
  --model PROVIDER/MODEL \
  --confirm-external-run \
  --result-output ../reports/inspect/candidate-results.json
```

Each epoch has a separate project, home directory, MCP process, pre-state hash,
post-state hash, and cleanup observation. Inspect's local execution environment
does not itself provide OS isolation, so the controlled agent receives only the
MCP tool source; product authority is additionally restricted by
`GODOT_MCP_ALLOWED_DIRS` and the server's privilege policy.

Every v2 result records the declared and observed environment disposition. A
case whose Godot, display, platform, renderer, or other declared requirement is
unavailable is emitted as `unsupported` with all criteria visible, is not sent
to the model, and cannot satisfy a release gate.

Open native logs with:

```bash
npm run eval:view
```

The manual **Opt-in behavioral evaluation** GitHub workflow requires an explicit
cost confirmation. Select either a randomized released-baseline versus
candidate comparison or two stochastic A/A calibration batches against the
immutable release. It uploads retained evidence for 14 days and attests the
bounded decision or calibration manifests with GitHub artifact provenance. Its
protected environment must define `BEHAVIORAL_EVAL_PROVIDER_ENV` as
newline-delimited provider environment variables. The workflow validates the
variable names, exports them only to the Inspect parent process, and the task
launcher does not forward them into either MCP server. This evaluation remains
an optional, separate workflow and is not required for npm publication.

## Released baseline and paired comparison

`npm run eval:baseline` downloads the immutable npm 1.1.4 tarball, verifies its
recorded SHA-256, extracts it under the ignored `evals/cache/` directory, and
installs production dependencies. Pass its reported `serverPath` and
`packageVersion` to the Inspect CLI with `--server` and `--server-version`.

Compare result documents with:

```bash
npm run eval:compare -- \
  --baseline path/to/baseline-results.json \
  --candidate path/to/candidate-results.json \
  --output evals/reports/comparison/latest.json
```

The comparison pairs by case and epoch, keeps safety and cleanup as hard gates,
reports outcome/tool-use/trajectory/performance sections independently, and
calculates a deterministic scenario-clustered 95% bootstrap interval. An A/A
mode (`--expect-equivalent`) is used in contract tests to prove zero-difference
replay behavior.

Run the roadmap's two stochastic A/A batches over the original nine cases with:

```bash
npm run eval:calibrate -- \
  --model PROVIDER/EXACT_MODEL \
  --epochs 3 \
  --batches 2 \
  --time-limit 600 \
  --emulate-tools \
  --godot /absolute/path/to/godot \
  --confirm-external-run
```

This performs 108 model-backed tasks (two batches, two arms, nine cases, three
epochs), records per-batch clustered intervals and outcome disagreements, and
never interprets a release gate as the calibration result. It requires explicit
authorization because it can incur provider cost.

### Local OpenAI-compatible router

Claude and GPT are not required. Inspect can use a local or privately hosted
OpenAI-compatible endpoint. The locked harness includes the compatible client,
and result controls retain the provider plus a credential-free base URL.

For a llama.cpp router serving a Qwen model:

```bash
export OPENAI_BASE_URL=https://your-router.example/v1
export OPENAI_API_KEY=replace-with-your-router-credential

npm run eval:calibrate -- \
  --model openai-api/local/qwen-35b \
  --epochs 3 \
  --batches 2 \
  --time-limit 600 \
  --godot /absolute/path/to/godot \
  --confirm-external-run
```

`OPENAI_API_KEY` satisfies Inspect's OpenAI-compatible provider contract. If a
local router does not authenticate requests, use a non-secret placeholder. For
GitHub execution, put both assignments in the protected
`BEHAVIORAL_EVAL_PROVIDER_ENV` secret. Provider variables remain in the Inspect
parent and are not forwarded to either MCP server. The task launcher forwards
only the active display-session variables (`DISPLAY`, `WAYLAND_DISPLAY`,
`XAUTHORITY`, and `XDG_RUNTIME_DIR`) needed by headed Godot cases.

The 600-second ceiling accommodates cold or locally queued generation. It does
not alter the case's scorer wall-time budget: measured latency and budget
violations remain visible in the result.

Before a full calibration, run one selected case to verify that the model emits
valid native tool calls. If a compatible endpoint emits tool-call markup in
assistant text instead, add `--emulate-tools`. Native and emulated tool modes
are recorded controlled inputs and must not be mixed within one comparison.

The committed 2026-07-16 result was produced against server 1.1.1. It is
historical starting evidence, not a qualification result for 1.1.4. A current
release claim requires an explicitly authorized, paid (or otherwise
provider-backed), paired three-epoch run; smoke checks do not manufacture that
evidence.

Two deterministic A/A replays with independent bootstrap seeds are recorded in
[`aa-calibration.json`](../evals/baselines/v1.1.4/aa-calibration.json). They show
zero evaluator/report variance. They deliberately do not claim stochastic model
variance; `eval:calibrate` or the workflow's stochastic A/A mode produces that
evidence when authorized.

## Scoring

Every release-gating acceptance and forbidden condition has a stable evidence
ID and named objective scorer. The scorer records:

- task and criterion success;
- valid-call and invalid-call repair rates;
- tool-selection precision and required-capability recall;
- catalog recall at 1, 3, and 5, with no-target cases marked not applicable;
- declared partial-order compliance;
- claim precision and recall against criterion evidence;
- redundant-call rate, response bytes, and elapsed time; and
- held input, owned process, bridge, editor, and transient-artifact cleanup.

Metric numerators, denominators, and exclusions are retained in each new result.
Protocol, mutation, privilege, pause, cleanup, and objective project state never
depend on an LLM judge.
