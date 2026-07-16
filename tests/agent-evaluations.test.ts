// @test-kind: contract
import addFormats from 'ajv-formats';
import Ajv2020 from 'ajv/dist/2020.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './helpers/manifest-sources.js';

function json(path: string): unknown {
  return JSON.parse(readFileSync(join(repoRoot, path), 'utf8')) as unknown;
}

interface TriggerCase {
  id: string;
  expectedSkill: string;
  forbiddenSkills: string[];
}

interface Scenario {
  id: string;
  skill: string | null;
  kind: string;
  acceptance: string[];
  forbidden: string[];
}

interface EvaluationRun {
  scenarioId: string;
  status: string;
  inputs?: {
    runDate: string;
    client: string;
    clientVersion: string;
    model: string;
    effort: string;
    promptSha256: string;
    skillSha256: string | null;
    serverVersion: string;
    surface: string;
    advertisedToolCount: number;
  };
  metrics?: {
    taskSuccess: boolean;
    acceptanceCriteriaPassed: number;
    acceptanceCriteriaTotal: number;
    humanInterventions: number;
    pauseViolations: number;
    cleanupState: {
      clean: boolean;
      ownedProcesses: number;
      bridges: number;
      heldInputs: number;
      temporaryArtifacts: number;
    };
  };
  criteria?: { criterion: string; status: string; evidence: string }[];
}

const adapter = json('agent-plugin/adapter-manifest.json') as { skills: { name: string }[] };
const triggers = json('evals/skill-trigger-cases.json') as {
  schemaVersion: number; skills: string[]; cases: TriggerCase[];
};
const scenarios = json('evals/scenarios.json') as {
  schemaVersion: number;
  evaluationMode: string;
  automatedCoverageRegistry: string;
  surface: Record<string, string>;
  metrics: string[];
  scenarios: Scenario[];
};
const automatedCases = json('evals/automated-cases.json') as {
  schemaVersion: number;
  scenarioSetVersion: number;
  evaluationMode: string;
  cases: { id: string; status: string; command: string; covers: string[]; doesNotCover: string[] }[];
};
const resultSchema = json('evals/result.schema.json') as Record<string, unknown>;
const currentStatus = json('evals/current-model-status.json') as {
  evaluationMode: string; runs: EvaluationRun[];
};
const skillNames = adapter.skills.map((skill: { name: string }) => skill.name);

describe('agent skill evaluation corpus', () => {
  it('contains positive and negative trigger boundaries for every canonical skill', () => {
    expect(triggers.schemaVersion).toBe(1);
    expect(triggers.skills).toEqual(skillNames);
    const ids = triggers.cases.map(entry => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const skill of skillNames) {
      const positive = triggers.cases.filter(entry => entry.expectedSkill === skill);
      const negative = triggers.cases.filter(entry => entry.forbiddenSkills.includes(skill));
      expect(positive.length, `${skill} positive triggers`).toBeGreaterThanOrEqual(2);
      expect(negative.length, `${skill} negative triggers`).toBeGreaterThanOrEqual(2);
      for (const entry of positive) {
        expect(entry.forbiddenSkills).toEqual(skillNames.filter((name: string) => name !== skill));
      }
    }
  });

  it('versions a no-skill scenario and primary plus edge scenarios for every skill', () => {
    expect(scenarios.schemaVersion).toBe(1);
    expect(scenarios.evaluationMode).toBe('external-cold-model');
    expect(scenarios.automatedCoverageRegistry).toBe('automated-cases.json');
    expect(scenarios.surface).toEqual({ canonical: 'core', compatibilityAlias: 'compact', fullCatalog: 'full' });
    const ids = scenarios.scenarios.map(entry => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(scenarios.scenarios.filter(entry => entry.skill === null)).toHaveLength(1);
    for (const skill of skillNames) {
      const entries = scenarios.scenarios.filter(entry => entry.skill === skill);
      expect(entries.map(entry => entry.kind).sort()).toEqual(['edge', 'primary']);
      for (const entry of entries) {
        expect(entry.acceptance.length).toBeGreaterThan(0);
        expect(entry.forbidden.length).toBeGreaterThan(0);
      }
    }
    expect(scenarios.metrics).toEqual([
      'taskSuccess', 'acceptanceCriterionSuccess', 'toolSelectionPrecision',
      'searchRecallAt1', 'searchRecallAt3', 'searchRecallAt5', 'invalidCalls',
      'selfCorrections', 'toolCalls', 'elapsedMs', 'responseBytes',
      'detachedEditorRuntimeMistakes', 'humanInterventions', 'pauseViolations',
      'traceAccuracy', 'cleanupState',
    ]);
  });

  it('separates executable automation from external cold-model evidence', () => {
    expect(automatedCases).toMatchObject({
      schemaVersion: 1,
      scenarioSetVersion: scenarios.schemaVersion,
      evaluationMode: 'automated',
    });
    const ids = automatedCases.cases.map(entry => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of automatedCases.cases) {
      expect(entry.status).toBe('executable');
      expect(entry.command).toMatch(/^npx vitest run /);
      expect(entry.covers.length).toBeGreaterThan(0);
      expect(entry.doesNotCover).toEqual(expect.arrayContaining([expect.stringMatching(/model|native client/i)]));
      for (const path of entry.command.match(/tests\/[\w./-]+\.test\.ts/g) ?? []) {
        expect(existsSync(join(repoRoot, path)), `${entry.id}: missing ${path}`).toBe(true);
      }
    }
    expect(currentStatus.evaluationMode).toBe('external-cold-model');
  });

  it('validates complete, passing external cold-model evidence for every scenario', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(resultSchema);
    expect(validate(currentStatus), JSON.stringify(validate.errors)).toBe(true);
    expect(currentStatus.runs.map(run => run.scenarioId).sort())
      .toEqual(scenarios.scenarios.map(entry => entry.id).sort());
    for (const run of currentStatus.runs) {
      expect(run.status, run.scenarioId).toBe('passed');
      expect(run.inputs).toMatchObject({
        client: 'codex-cli',
        model: 'gpt-5.6-luna',
        effort: 'high',
        surface: 'core',
      });
      expect(run.inputs?.runDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(run.inputs?.promptSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(run.inputs?.advertisedToolCount).toBeGreaterThan(0);
      expect(run.metrics).toMatchObject({
        taskSuccess: true,
        humanInterventions: 0,
        pauseViolations: 0,
        cleanupState: {
          clean: true,
          ownedProcesses: 0,
          bridges: 0,
          heldInputs: 0,
          temporaryArtifacts: 0,
        },
      });
      expect(run.metrics?.acceptanceCriteriaPassed).toBe(run.metrics?.acceptanceCriteriaTotal);
      expect(run.criteria?.length).toBeGreaterThan(0);
      expect(run.criteria?.every(criterion => criterion.status === 'passed')).toBe(true);
    }
  });

  it('requires versioned inputs, complete metrics, and criterion evidence for a completed run', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(resultSchema);
    const completed = {
      schemaVersion: 1,
      scenarioSetVersion: 1,
      evaluationMode: 'external-cold-model',
      runs: [{
        scenarioId: 'compact-no-skill-discovery',
        status: 'passed',
        inputs: {
          runDate: '2026-07-17', client: 'recorded-client', clientVersion: '1.0.0',
          model: 'recorded-model', effort: 'high', promptSha256: 'a'.repeat(64),
          skillSha256: null, serverVersion: '1.1.1', surface: 'core', advertisedToolCount: 1,
        },
        metrics: {
          taskSuccess: true, acceptanceCriteriaPassed: 1, acceptanceCriteriaTotal: 1,
          toolSelectionPrecision: 1, searchRecallAt1: 1, searchRecallAt3: 1,
          searchRecallAt5: 1, invalidCalls: 0, selfCorrections: 0, toolCalls: 1,
          elapsedMs: 1, responseBytes: 1, detachedEditorRuntimeMistakes: 0,
          humanInterventions: 0, pauseViolations: 0, traceAccuracy: 1,
          cleanupState: {
            clean: true, ownedProcesses: 0, bridges: 0, heldInputs: 0, temporaryArtifacts: 0,
          },
        },
        criteria: [{ criterion: 'example', status: 'passed', evidence: 'recorded evidence' }],
      }],
    };
    expect(validate(completed), JSON.stringify(validate.errors)).toBe(true);
    delete (completed.runs[0] as { inputs?: unknown }).inputs;
    expect(validate(completed)).toBe(false);
  });
});
