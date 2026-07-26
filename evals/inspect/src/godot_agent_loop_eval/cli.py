"""Command-line entry point for checking and running the Inspect harness."""

from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

from inspect_ai import eval as inspect_eval
from inspect_ai.model import ChatMessageAssistant

from .scoring import objective_scorer
from .tasks import godot_agent_loop, mcp_server


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[4]


def _prepare(
    repo: Path,
    scenario_ids: list[str],
    godot: str | None,
    server: str | None,
    server_version: str | None,
    epoch: int,
    model: str | None,
    evaluation_time_limit: int | None,
    emulate_tools: bool,
) -> Path:
    args = [
        "node",
        str(repo / "evals" / "cold-model-runner.mjs"),
        "prepare",
        "--client",
        "inspect-ai",
        "--client-version",
        "0.3.249",
        "--epoch",
        str(epoch),
    ]
    for scenario_id in scenario_ids:
        args.extend(["--scenario", scenario_id])
    if not scenario_ids:
        args.append("--all")
    if godot:
        args.extend(["--godot", godot])
    if server:
        args.extend(["--server", server])
    if server_version:
        args.extend(["--server-version", server_version])
    if model:
        args.extend(["--model", model])
    if evaluation_time_limit:
        args.extend(["--evaluation-time-limit", str(evaluation_time_limit)])
    args.extend([
        "--tool-calling-mode",
        "emulated" if emulate_tools else "native",
    ])
    process = subprocess.run(args, cwd=repo, text=True, capture_output=True, check=True)
    return Path(process.stdout.strip())


def _clean(repo: Path, batch: Path, remove_batch: bool = False) -> None:
    args = [
        "node",
        str(repo / "evals" / "cold-model-runner.mjs"),
        "clean",
        "--batch",
        str(batch),
        "--remove-workspaces",
    ]
    if remove_batch:
        args.append("--remove-batch")
    subprocess.run(args, cwd=repo, text=True, check=True, capture_output=True)


def _scenario_ids(repo: Path, selected: list[str]) -> list[str]:
    documents = [
        json.loads((repo / "evals" / name).read_text(encoding="utf-8"))
        for name in ("cases.json", "server-cases.json")
    ]
    available = [case["id"] for document in documents for case in document["cases"]]
    unknown = sorted(set(selected) - set(available))
    if unknown:
        raise ValueError(f"Unknown scenarios: {', '.join(unknown)}")
    return selected or available


async def _probe_native_mcp(batch: Path, scenario_ids: list[str]) -> list[dict]:
    reports = []
    for scenario_id in scenario_ids:
        metadata = json.loads(
            (batch / scenario_id / "run.json").read_text(encoding="utf-8")
        )
        server = mcp_server(metadata)
        async with server:
            tools = await server.tools()
        expected = metadata["advertisedToolCount"]
        if len(tools) != expected:
            raise RuntimeError(
                f"{scenario_id}: Inspect discovered {len(tools)} tools; expected {expected}"
            )
        reports.append({"scenarioId": scenario_id, "toolCount": len(tools)})
    return reports


async def _replay_scorer(repo: Path, batch: Path, scenario_id: str) -> dict:
    scorer = objective_scorer(
        repo_root=str(repo),
        batch_path=str(batch),
        scenario_id=scenario_id,
    )
    score = await scorer(
        SimpleNamespace(messages=[
            ChatMessageAssistant(content="No model was sampled during harness check.")
        ]),
        None,
    )
    return {
        "scenarioId": scenario_id,
        "metricKeys": sorted(score.value.keys()),
        "resultPath": score.metadata["result_path"],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["check", "smoke", "run"])
    parser.add_argument("--scenario", action="append", default=[])
    parser.add_argument("--godot")
    parser.add_argument("--model")
    parser.add_argument("--server")
    parser.add_argument("--server-version")
    parser.add_argument("--epochs", type=int, default=1)
    parser.add_argument("--time-limit", type=int)
    parser.add_argument("--emulate-tools", action="store_true")
    parser.add_argument("--confirm-external-run", action="store_true")
    parser.add_argument("--log-dir")
    parser.add_argument("--result-output")
    options = parser.parse_args()
    if options.time_limit is not None and options.time_limit < 1:
        parser.error("--time-limit must be a positive integer")
    repo = _repo_root()
    scenario_ids = _scenario_ids(
        repo,
        options.scenario
        or (["compact-no-skill-discovery"] if options.command == "smoke" else []),
    )
    batches = [
        _prepare(
            repo,
            scenario_ids,
            options.godot,
            options.server,
            options.server_version,
            epoch,
            options.model,
            options.time_limit,
            options.emulate_tools,
        )
        for epoch in range(1, options.epochs + 1)
    ]
    tasks = [
        godot_agent_loop(
            repo_root=str(repo),
            batch_path=str(batch),
            scenario_id=scenario_id,
            epoch=epoch,
            require_submit=options.command != "smoke",
        )
        for epoch, batch in enumerate(batches, start=1)
        for scenario_id in scenario_ids
    ]
    supported_tasks = [
        task
        for task, (epoch, batch, scenario_id) in zip(
            tasks,
            (
                (epoch, batch, scenario_id)
                for epoch, batch in enumerate(batches, start=1)
                for scenario_id in scenario_ids
            ),
            strict=True,
        )
        if json.loads(
            (batch / scenario_id / "run.json").read_text(encoding="utf-8")
        )["environmentStatus"]["status"] == "supported"
    ]
    if options.command == "check":
        native_mcp = asyncio.run(_probe_native_mcp(batches[0], scenario_ids))
        scorer_replay = [
            asyncio.run(_replay_scorer(repo, batches[0], scenario_id))
            for scenario_id in scenario_ids
        ]
        print(json.dumps({
            "valid": True,
            "preparedBatchCount": len(batches),
            "scenarios": scenario_ids,
            "tasks": [task.name for task in tasks],
            "modelSampled": False,
            "nativeMcp": native_mcp,
            "scorerReplay": scorer_replay,
        }, indent=2))
        for batch in batches:
            _clean(repo, batch, remove_batch=True)
        return
    if options.command == "smoke":
        smoke_log_dir = Path(
            options.log_dir
            or repo / "evals" / "reports" / "inspect-smoke"
        )
        logs = inspect_eval(
            supported_tasks,
            model="mockllm/model",
            model_args={"emulate_tools": options.emulate_tools},
            epochs=1,
            log_dir=str(smoke_log_dir),
        ) if supported_tasks else []
        results = [
            batch / scenario_id / "result.json"
            for batch in batches
            for scenario_id in scenario_ids
        ]
        valid = (
            all(log.status == "success" for log in logs)
            and all(path.exists() for path in results)
        )
        print(json.dumps({
            "valid": valid,
            "model": "mockllm/model",
            "modelSampled": False,
            "scenarios": scenario_ids,
            "inspectLogs": len(logs),
            "deterministicResults": len(results),
            "unsupportedTasks": len(tasks) - len(supported_tasks),
        }, indent=2))
        for batch in batches:
            _clean(repo, batch)
        if not valid:
            raise SystemExit(1)
        return
    if not options.confirm_external_run:
        raise SystemExit("Refusing to sample a model without --confirm-external-run.")
    if not options.model:
        raise SystemExit("--model is required for an external run.")
    logs = inspect_eval(
        supported_tasks,
        model=options.model,
        model_args={"emulate_tools": options.emulate_tools},
        epochs=1,
        log_dir=options.log_dir or str(repo / "evals" / "reports" / "inspect"),
    ) if supported_tasks else []
    runs = []
    for batch in batches:
        for scenario_id in scenario_ids:
            result_path = batch / scenario_id / "result.json"
            runs.append(
                json.loads(result_path.read_text(encoding="utf-8"))
                if result_path.exists()
                else {
                    "scenarioId": scenario_id,
                    "status": "not_run",
                    "reason": "Inspect did not produce deterministic scorer output.",
                }
            )
    output = Path(
        options.result_output
        or repo / "evals" / "reports" / "inspect" / "results.json"
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({
        "schemaVersion": 1,
        "scenarioSetVersion": 2,
        "evaluationMode": "external-cold-model",
        "runs": runs,
    }, indent=2) + "\n", encoding="utf-8")
    subprocess.run(
        [
            "node",
            str(repo / "evals" / "cold-model-runner.mjs"),
            "validate-result",
            "--result",
            str(output),
        ],
        cwd=repo,
        text=True,
        check=True,
    )
    for batch in batches:
        _clean(repo, batch)
    if any(log.status != "success" for log in logs):
        raise SystemExit(1)
