# Agent skill evaluations

The committed corpus under `evals/` separates executable deterministic coverage
from external cold-model evidence. Passing automation never changes a cold-model
scenario to passed.

- `skill-trigger-cases.json` contains positive and negative prompts for the four
  non-overlapping build, debug, verify, and ship trigger boundaries.
- `automated-cases.json` registers runnable Vitest commands, their exact scope,
  and what they cannot establish.
- `scenarios.json` marks the compatibility-alias no-skill scenario plus primary
  and edge scenarios for every shipped skill as `external-cold-model`.
- `result.schema.json` requires the client, client version, model, effort, prompt
  and skill hashes, server version, tool surface/count, criteria, metrics, trace
  accuracy, interventions, pause violations, and cleanup state for a completed
  run.
- `current-model-status.json` is the validated `external-cold-model` result set.
  All nine scenarios passed on GPT-5.6 Luna at high effort: 28/28 acceptance
  criteria and 58/58 total acceptance/forbidden-condition checks, with zero
  human interventions, zero pause violations, and clean teardown in every run.

The deterministic golden MCP replay and the commands in `automated-cases.json`
remain valuable capability, packaging, compatibility, and cleanup coverage, but
they neither select a skill nor sample a fresh model and therefore do not satisfy
the external cold-model evaluation gate.

## Recording a run

Use a fresh allowed project root and the scenario's exact prompt and starting
state. Record the actual client/model inputs and retain the raw tool trace,
Activity evidence, project hashes, process/input cleanup checks, and acceptance
observations. Validate the result against `evals/result.schema.json`; do not copy
historical metrics into the new scenario set.

A release comparison should aggregate task and criterion success, tool-selection
precision, search recall at 1/3/5, invalid calls, self-corrections, calls, elapsed
time, response bytes, detached/editor/runtime mistakes, human interventions,
pause violations, trace accuracy, and cleanup. Platform-specific, signing,
subjective, and unsupported gates remain explicit instead of being scored as
passes.

## Current run

The 2026-07-17 candidate used Codex CLI 0.144.5, server 1.1.1, the 42-tool
`core` surface, and exact prompt/skill hashes recorded per scenario. Search
recall at 1/3/5 was 1.0 throughout. The nine runs made 252 tool calls; 28 invalid
calls were followed by 27 recorded self-corrections, and no historical hold,
Variant-shape, hidden-discovery, or unbounded-read failure recurred. Raw JSONL,
workspace snapshots, and cleanup observations remain local evaluator artifacts;
the schema-valid aggregate is committed as the durable release record.
