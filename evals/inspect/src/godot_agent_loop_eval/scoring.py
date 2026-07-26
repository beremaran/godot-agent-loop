"""Adapter from Inspect transcripts to the repository's deterministic scorers."""

from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path
from typing import Any

from inspect_ai.scorer import Metric, SampleScore, Score, Scorer, metric, scorer
from inspect_ai.solver import TaskState

METRICS = (
    "taskSuccess",
    "validCallRate",
    "repairRate",
    "toolSelectionPrecision",
    "capabilityRecall",
    "orderCompliance",
    "searchRecallAt1",
    "searchRecallAt3",
    "searchRecallAt5",
    "invalidCalls",
    "selfCorrections",
    "toolCalls",
    "responseBytes",
    "redundantCallRate",
    "detachedEditorRuntimeMistakes",
    "humanInterventions",
    "pauseViolations",
    "claimPrecision",
    "claimRecall",
)

NOT_APPLICABLE = -1.0


@metric
def applicable_mean() -> Metric:
    """Average applicable values without converting null to zero."""

    def calculate(scores: list[SampleScore]):
        values = [
            score.score.value
            for score in scores
            if isinstance(score.score.value, (int, float))
            and score.score.value != NOT_APPLICABLE
        ]
        if not values:
            return NOT_APPLICABLE
        return sum(float(value) for value in values) / len(values)

    return calculate


def _content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            str(getattr(item, "text", getattr(item, "reasoning", item)))
            for item in content
        )
    return str(content)


def _trace_events(state: TaskState) -> list[dict[str, Any]]:
    results = {
        message.tool_call_id: message
        for message in state.messages
        if getattr(message, "role", None) == "tool"
        and getattr(message, "tool_call_id", None)
    }
    events: list[dict[str, Any]] = []
    for message in state.messages:
        if getattr(message, "role", None) != "assistant":
            continue
        text = _content_text(message.content)
        if text:
            events.append({"item": {"type": "agent_message", "text": text}})
        for call in message.tool_calls or []:
            response = results.get(call.id)
            events.append(
                {
                    "type": "item.completed",
                    "item": {
                        "type": "mcp_tool_call",
                        "tool": call.function,
                        "arguments": call.arguments,
                        "result": (
                            _content_text(response.content)
                            if response is not None
                            else "Inspect transcript has no matching tool response."
                        ),
                        "status": (
                            "failed"
                            if response is None or getattr(response, "error", None)
                            else "completed"
                        ),
                    },
                }
            )
    return events


@scorer(
    metrics={metric_name: [applicable_mean()] for metric_name in METRICS},
    name="godot_agent_loop_objective",
)
def objective_scorer(
    *,
    repo_root: str,
    batch_path: str,
    scenario_id: str,
) -> Scorer:
    """Run the same state/trace scorer used by the preserved Codex runner."""

    async def score(state: TaskState, _target: Any) -> Score:
        batch = Path(batch_path)
        scenario = batch / scenario_id
        evidence = scenario / "evidence"
        trace_path = evidence / "codex-trace.jsonl"
        events = _trace_events(state)
        trace_path.write_text(
            "".join(json.dumps(event, separators=(",", ":")) + "\n" for event in events),
            encoding="utf-8",
        )
        store = getattr(state, "store", None)
        started_ns = store.get("godot_agent_loop_started_ns", time.time_ns()) if store else time.time_ns()
        elapsed_ms = max(0, round((time.time_ns() - started_ns) / 1_000_000))
        (evidence / "codex-exit.json").write_text(
            json.dumps({"code": 0, "signal": None, "elapsedMs": elapsed_ms}, indent=2) + "\n",
            encoding="utf-8",
        )
        process = subprocess.run(
            [
                "node",
                str(Path(repo_root) / "evals" / "cold-model-runner.mjs"),
                "score-scenario",
                "--batch",
                str(batch),
                "--scenario",
                scenario_id,
            ],
            cwd=repo_root,
            text=True,
            capture_output=True,
            check=False,
        )
        if process.returncode != 0:
            return Score(
                value={metric: 0 for metric in METRICS},
                explanation="Deterministic scorer failed.",
                metadata={"stderr": process.stderr[-4000:]},
            )
        result = json.loads(process.stdout)
        values = {
            metric: (
                NOT_APPLICABLE
                if result["metrics"][metric] is None
                else result["metrics"][metric]
            )
            for metric in METRICS
        }
        return Score(
            value=values,
            explanation=(
                f"{sum(item['status'] == 'passed' for item in result['criteria'])}/"
                f"{len(result['criteria'])} declared checks passed."
            ),
            metadata={
                "scenario_id": scenario_id,
                "criteria": result["criteria"],
                "cleanup": result["metrics"]["cleanupState"],
                "budget": result["metrics"]["budgetCompliance"],
                "not_applicable_sentinel": NOT_APPLICABLE,
                "result_path": str(scenario / "result.json"),
            },
        )

    return score
