# External cold-model runner

This runner executes the nine prompts from `../scenarios.json` without changing
their bytes. It uses the installed Codex CLI, `gpt-5.6-luna` at high reasoning
effort, the locally built MCP server, and the `core` surface. Every skill run
symlinks exactly one current `agent-plugin/skills/*` directory into an isolated
fixture repository; the no-skill run exposes none.

Codex starts with `--ignore-user-config`, `--ignore-rules`, a read-only shell
sandbox, and the evaluation MCP server as a required server. The exact
evaluation server is pre-approved so prompt-authorized destructive-annotated
MCP calls can run without a human prompt; shell writes remain sandboxed. The MCP
process is restricted to the fixture project. The isolated `HOME` prevents
personal skills from entering the run, while the original `CODEX_HOME` remains
available only to the Codex process for authentication. No credential value is
copied into the fixture or evidence.

## Prepare and validate

Build the final candidate first, then inspect the exact launch contract without
sampling a model:

```sh
npm run build
node evals/cold-model-runner.mjs dry-run --all \
  --godot /Applications/Godot.app/Contents/MacOS/Godot
```

Prepare deterministic fixture repositories and validate them with Godot:

```sh
BATCH="$(node evals/cold-model-runner.mjs prepare --all \
  --godot /Applications/Godot.app/Contents/MacOS/Godot)"
node evals/cold-model-runner.mjs validate --batch "$BATCH" --engine-check
```

`prepare` writes the exact prompt, prompt and skill hashes, client/server
versions, tool inventory, initial project hashes, and launch metadata. Build
fixtures start with an empty `project/`; all other fixtures contain a bounded,
text-authored Godot project. The watched-unavailable fixture pins an invalid
engine path. The paused-debug fixture starts the shipped persistent editor add-on
with `GODOT_MCP_EDITOR_START_PAUSED=true` only when the model run begins.

## Run, score, and clean

Model sampling is deliberately gated by an explicit flag:

```sh
node evals/cold-model-runner.mjs run --batch "$BATCH" \
  --confirm-external-run
```

The runner passes each prompt through stdin exactly as recorded. It retains raw
Codex JSONL, stderr, the final message, before/after hashes, process and bridge
observations, cleanup evidence, criterion evidence, and a result validated
against `../result.schema.json`. A criterion becomes `passed` only when its
declared trace or fixture-state check establishes it. Semantic evidence that the
runner cannot establish remains `unobserved`; subjective evidence remains manual
unless the final response explicitly classifies it that way.

After scoring, the runner terminates only PIDs it started or processes whose
command contains the exact fixture path, records any pre-clean residue, and
removes the owned fixture workspace. Raw evidence and `results.json` remain under
the ignored `evals/runs/` batch directory.

Prepared batches that were not run can be removed explicitly:

```sh
node evals/cold-model-runner.mjs clean --batch "$BATCH" \
  --remove-workspaces --remove-batch
```

Do not replace external results with deterministic tests or historical metrics.
Review every `unobserved`, `manual`, `unsupported`, or failed criterion before
publishing a batch as `evals/current-model-status.json`.
