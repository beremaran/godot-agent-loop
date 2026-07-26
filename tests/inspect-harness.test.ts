// @test-kind: contract
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './helpers/manifest-sources.js';

function source(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

describe('Inspect AI behavioral harness', () => {
  it('pins Inspect and the stable Python MCP SDK in a committed uv lock', () => {
    const project = source('evals/inspect/pyproject.toml');
    const lock = source('evals/inspect/uv.lock');
    expect(project).toContain('"inspect-ai==0.3.249"');
    expect(project).toContain('"mcp==1.28.1"');
    expect(project).toContain('"openai==2.45.0"');
    expect(lock).toMatch(/name = "inspect-ai"[\s\S]*version = "0\.3\.249"/);
    expect(lock).toMatch(/name = "mcp"[\s\S]*version = "1\.28\.1"/);
    expect(lock).toMatch(/name = "openai"[\s\S]*version = "2\.45\.0"/);
  });

  it('uses native MCP/ReAct tasks and the shared deterministic scorer', () => {
    const tasks = source('evals/inspect/src/godot_agent_loop_eval/tasks.py');
    const scoring = source('evals/inspect/src/godot_agent_loop_eval/scoring.py');
    expect(tasks).toContain('mcp_server_stdio(');
    expect(tasks).toContain('solver=react(');
    expect(tasks).toContain('input=prompt');
    expect(tasks).toContain('GODOT_MCP_ALLOWED_DIRS');
    expect(tasks).toContain('use \\".\\"');
    expect(tasks).toContain('("DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR")');
    expect(tasks).not.toContain('OPENAI_API_KEY');
    expect(tasks).not.toContain('ANTHROPIC_API_KEY');
    expect(scoring).toContain('"score-scenario"');
    expect(scoring).toContain('codex-trace.jsonl');
    expect(scoring).toContain('cleanup');
  });

  it('requires explicit confirmation and a concrete model before sampling', () => {
    const cli = source('evals/inspect/src/godot_agent_loop_eval/cli.py');
    expect(cli).toContain('--confirm-external-run');
    expect(cli).toContain('Refusing to sample a model');
    expect(cli).toContain('--model is required');
    expect(cli).toContain('--emulate-tools');
    expect(cli).toContain('"emulate_tools": options.emulate_tools');
    expect(cli).toContain('"--tool-calling-mode"');
    expect(cli).toContain('range(1, options.epochs + 1)');
    expect(cli).toContain('epochs=1');
  });
});
