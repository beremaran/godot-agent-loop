// @test-kind: contract
import { describe, expect, it } from 'vitest';
import { selectCases } from '../scripts/select-evaluation-cases.mjs';

describe('evaluation change-impact selection', () => {
  it('does not trigger paid behavior sampling for documentation-only changes', () => {
    expect(selectCases(['docs/evaluation.md'])).toMatchObject({
      selectedCaseCount: 0,
      paidRunRequired: false,
      paidRunAutomatic: false,
    });
  });

  it('selects focused skill cases and the server corpus for relevant changes', () => {
    const skill = selectCases(['agent-plugin/skills/debug-godot-game/SKILL.md']);
    expect(skill.selectedCases).toEqual([
      'debug-paused-before-repair',
      'debug-seeded-input-regression',
    ]);
    const server = selectCases(['src/tool-manifest.ts']);
    expect(server.selectedCaseCount).toBe(15);
    expect(server.selectedCases).toContain('path-traversal-denied');
    expect(server.paidRunAutomatic).toBe(false);
  });

  it('selects the complete 24-case suite when evaluator semantics change', () => {
    const result = selectCases(['evals/result.schema.json']);
    expect(result.selectedCaseCount).toBe(24);
  });
});
