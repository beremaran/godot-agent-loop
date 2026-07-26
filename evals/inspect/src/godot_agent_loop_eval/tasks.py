"""Native Inspect AI tasks for the versioned Godot Agent Loop corpus."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

from inspect_ai import Task, task
from inspect_ai.agent import AgentPrompt, react
from inspect_ai.dataset import Sample
from inspect_ai.solver import Generate, Solver, TaskState, solver
from inspect_ai.tool import mcp_server_stdio

from .scoring import objective_scorer


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _mcp_environment(metadata: dict[str, Any]) -> dict[str, str]:
    workspace = Path(metadata["workspacePath"])
    godot_path = (
        workspace / ".unavailable" / "godot"
        if metadata["unavailableEditor"]
        else metadata["godotPath"]
    )
    environment = {
        "GODOT_MCP_TOOL_SURFACE": "core",
        "GODOT_MCP_ALLOWED_DIRS": metadata["projectPath"],
        "GODOT_PATH": str(godot_path or ""),
        "GODOT_MCP_FIXED_FPS": "60",
        "GODOT_MCP_TIMING_MODE": "realtime",
        "GODOT_MCP_EXPORT_XDG_DATA_HOME": str(workspace / ".eval-xdg-data"),
        "HOME": str(workspace / ".eval-home"),
        "XDG_DATA_HOME": str(workspace / ".eval-xdg-data"),
    }
    if metadata["startPausedEditor"]:
        environment["GODOT_MCP_EDITOR_START_PAUSED"] = "true"
    for name in ("DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR"):
        value = os.environ.get(name)
        if value:
            environment[name] = value
    return environment


def mcp_server(metadata: dict[str, Any]):
    """Create the native Inspect MCP source for prepared run metadata."""
    return mcp_server_stdio(
        name="godot_eval",
        command="node",
        args=[metadata["serverPath"]],
        cwd=metadata["projectPath"],
        env=_mcp_environment(metadata),
    )


@solver
def record_evaluation_start() -> Solver:
    """Record wall-clock start for deterministic budget scoring."""

    async def solve(state: TaskState, _generate: Generate) -> TaskState:
        state.store.set("godot_agent_loop_started_ns", time.time_ns())
        return state

    return solve


@task
def godot_agent_loop(
    *,
    repo_root: str,
    batch_path: str,
    scenario_id: str,
    epoch: int = 1,
    require_submit: bool = True,
) -> Task:
    """Create one isolated, versioned task from a prepared corpus fixture."""

    repo = Path(repo_root)
    scenario_path = Path(batch_path) / scenario_id
    metadata = _load_json(scenario_path / "run.json")
    cases = _load_json(repo / "evals" / "cases.json")
    server_cases = _load_json(repo / "evals" / "server-cases.json")
    scenarios = _load_json(repo / "evals" / "scenarios.json")
    case = next(
        item
        for item in [*cases["cases"], *server_cases["cases"]]
        if item["id"] == scenario_id
    )
    prompt_path = scenario_path / "evidence" / "prompt.txt"
    prompt = prompt_path.read_text(encoding="utf-8")
    if prompt != case["prompt"]:
        raise ValueError(f"Prepared prompt drifted for {scenario_id}")

    case_instructions = (
        Path(metadata["skillPath"]).joinpath("SKILL.md").read_text(encoding="utf-8")
        if metadata["skillPath"]
        else "Use only the provided MCP tools. Keep actions bounded and clean up runtime state."
    )
    instructions = (
        "The MCP server working directory is the isolated Godot project under "
        "evaluation. When a tool requires projectPath and the task does not "
        "supply another path, use \".\".\n\n"
        + case_instructions
    )
    server = mcp_server(metadata)
    return Task(
        dataset=[
            Sample(
                id=f"{scenario_id}::epoch-{epoch}",
                input=prompt,
                target="Satisfy every declared acceptance and forbidden-condition verifier.",
                metadata={
                    "case_version": case["version"],
                    "case_contract_sha256": metadata["caseContractSha256"],
                    "prompt_sha256": metadata["promptSha256"],
                    "skill_sha256": metadata["skillSha256"],
                    "fixture_sha256": metadata["fixtureSha256"],
                    "server_sha256": metadata["serverSha256"],
                    "tool_inventory_sha256": metadata["toolInventorySha256"],
                    "epoch": epoch,
                },
            )
        ],
        setup=record_evaluation_start(),
        solver=react(
            tools=[server],
            prompt=AgentPrompt(
                instructions=instructions,
                handoff_prompt=None,
            ),
            submit=require_submit,
        ),
        scorer=objective_scorer(
            repo_root=str(repo),
            batch_path=batch_path,
            scenario_id=scenario_id,
        ),
        message_limit=case["budgets"]["toolCalls"] * 2 + 4,
        time_limit=metadata["evaluationTimeLimitSeconds"],
        version=case["version"],
        name=f"godot_agent_loop_{scenario_id.replace('-', '_')}_epoch_{epoch}",
        metadata={
            "corpus_version": cases["schemaVersion"],
            "evaluation_mode": scenarios["evaluationMode"],
            "local_sandbox_isolation": "none; authority is confined to MCP-only tools and GODOT_MCP_ALLOWED_DIRS",
            "epoch": epoch,
        },
    )
