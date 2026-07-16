# Metric definitions

The runner computes metrics only from the retained Codex JSONL trace and fixture
state. It does not infer model behavior from deterministic tests.

- `taskSuccess`: Codex exits successfully, every acceptance criterion passes,
  every forbidden-condition check passes, and the pre-clean residue check is
  clean.
- `acceptanceCriteriaPassed`: acceptance entries with objective `passed`
  evidence. `manual`, `unsupported`, and `unobserved` are never counted.
- `toolSelectionPrecision`: scenario-relevant effective MCP calls divided by all
  completed MCP calls. A `godot_call` is attributed to its nested tool.
- `searchRecallAt1/3/5`: expected hidden tools appearing in the first one, three,
  or five names returned by `godot_catalog`. Recall for an empty target set is
  one by the standard vacuous-set convention.
- `invalidCalls`: completed tool results containing argument/schema validation
  failures.
- `selfCorrections`: invalid calls followed by a successful call to the same
  effective tool.
- `toolCalls`: completed MCP calls in Codex JSONL.
- `elapsedMs`: wall time from Codex process start to exit.
- `responseBytes`: UTF-8 bytes in completed MCP result payloads retained by
  Codex JSONL.
- `detachedEditorRuntimeMistakes`: watched runs that start runtime without a
  preceding editor-session call.
- `humanInterventions`: zero for this non-interactive runner. A run that cannot
  continue without intervention exits blocked instead of accepting input.
- `pauseViolations`: mutation attempts after the first observed pause refusal.
- `traceAccuracy`: objectively evidenced acceptance entries divided by explicit
  passed/failed/blocked/manual/unsupported/unobserved status words in the final
  response, capped at one. It is zero when the response contains no explicit
  status. This intentionally conservative proxy must be reviewed with the raw
  trace; it is not a semantic judge.
- `cleanupState`: pre-harness-clean counts for unexpected fixture-path
  processes, bridge/discovery residue, unmatched held inputs, and runtime bridge
  artifacts. The intentionally pre-launched paused editor is harness state and
  excluded from the model's cleanup score, then terminated by harness cleanup.

Criterion checks are scenario-specific and written into `result.json` with the
evidence used. Unknown conditions are `unobserved`, never passing by default.
