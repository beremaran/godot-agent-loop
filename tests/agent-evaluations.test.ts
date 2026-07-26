// @test-kind: contract
import addFormats from 'ajv-formats';
import Ajv2020 from 'ajv/dist/2020.js';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './helpers/manifest-sources.js';

function json(path: string): unknown {
  return JSON.parse(readFileSync(join(repoRoot, path), 'utf8')) as unknown;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(join(repoRoot, path))).digest('hex');
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
  prompt: string;
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

interface CaseVerifier {
  criterionIndex: number;
  scorer: string;
  evidenceSources: string[];
  criterionType: 'objective' | 'subjective' | 'unsupported';
}

interface EvaluationCase {
  id: string;
  version: number;
  releaseGating: boolean;
  sourceScenarioId: string;
  prompt: string;
  skill: string | null;
  acceptanceVerifiers: CaseVerifier[];
  forbiddenVerifiers: CaseVerifier[];
  budgets: { toolCalls: number; responseBytes: number; wallTimeMs: number };
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
const caseSchema = json('evals/case.schema.json') as Record<string, unknown>;
const caseSet = json('evals/cases.json') as {
  schemaVersion: number;
  cases: EvaluationCase[];
};
const serverScenarios = json('evals/server-scenarios.json') as {
  schemaVersion: number;
  evaluationMode: string;
  scenarios: Scenario[];
};
const serverCaseSet = json('evals/server-cases.json') as {
  schemaVersion: number;
  cases: EvaluationCase[];
};
const baseline = json('evals/baselines/v1.1.4/manifest.json') as {
  baselineId: string;
  package: { version: string; integrity: string; sha256: string };
  caseContract: { path: string; sha256: string; schemaPath: string; schemaSha256: string };
  controlledCorpusExtension: {
    caseCount: number;
    combinedCaseCount: number;
    casesPath: string;
    casesSha256: string;
    scenariosPath: string;
    scenariosSha256: string;
  };
  toolSurface: { path: string; sha256: string };
  skills: { name: string; sha256: string }[];
  historicalBehavioralEvidence: { path: string; sha256: string; qualification: string; serverVersion: string };
};
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
      'taskSuccess', 'acceptanceCriterionSuccess', 'validCallRate', 'repairRate',
      'toolSelectionPrecision', 'capabilityRecall', 'orderCompliance',
      'searchRecallAt1', 'searchRecallAt3', 'searchRecallAt5', 'invalidCalls',
      'selfCorrections', 'toolCalls', 'elapsedMs', 'responseBytes',
      'redundantCallRate',
      'detachedEditorRuntimeMistakes', 'humanInterventions', 'pauseViolations',
      'claimPrecision', 'claimRecall', 'cleanupState',
    ]);
  });

  it('publishes a schema-valid version 2 declarative case contract', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(caseSchema);
    expect(validate(caseSet), JSON.stringify(validate.errors)).toBe(true);
    expect(caseSet.schemaVersion).toBe(2);
    expect(caseSet.cases.map(entry => entry.id).sort())
      .toEqual(scenarios.scenarios.map(entry => entry.id).sort());

    for (const entry of caseSet.cases) {
      const scenario = scenarios.scenarios.find(candidate => candidate.id === entry.sourceScenarioId);
      expect(scenario, `${entry.id}: source scenario`).toBeDefined();
      expect(entry.id).toBe(entry.sourceScenarioId);
      expect(entry.prompt).toBe(scenario?.prompt);
      expect(entry.skill).toBe(scenario?.skill);
      expect(entry.acceptanceVerifiers.map(verifier => verifier.criterionIndex))
        .toEqual(scenario?.acceptance.map((_, index) => index));
      expect(entry.forbiddenVerifiers.map(verifier => verifier.criterionIndex))
        .toEqual(scenario?.forbidden.map((_, index) => index));
      expect(entry.budgets.toolCalls).toBeGreaterThan(0);
      expect(entry.budgets.responseBytes).toBeGreaterThan(0);
      expect(entry.budgets.wallTimeMs).toBeGreaterThan(0);
      if (entry.releaseGating) {
        expect([...entry.acceptanceVerifiers, ...entry.forbiddenVerifiers]
          .every(verifier => verifier.scorer.length > 0 && verifier.evidenceSources.length > 0)).toBe(true);
      }
    }
  });

  it('expands the controlled corpus to 24 versioned cases with objective coverage', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(caseSchema);
    expect(validate(serverCaseSet), JSON.stringify(validate.errors)).toBe(true);
    expect(serverScenarios.schemaVersion).toBe(2);
    expect(serverScenarios.evaluationMode).toBe('controlled-server-behavior');
    expect(serverCaseSet.schemaVersion).toBe(2);
    expect(caseSet.cases.length + serverCaseSet.cases.length).toBe(24);
    expect(serverCaseSet.cases.map(entry => entry.id).sort())
      .toEqual(serverScenarios.scenarios.map(entry => entry.id).sort());
    const allIds = [...caseSet.cases, ...serverCaseSet.cases].map(entry => entry.id);
    expect(new Set(allIds).size).toBe(allIds.length);
    for (const entry of serverCaseSet.cases) {
      const scenario = serverScenarios.scenarios.find(candidate => candidate.id === entry.sourceScenarioId);
      expect(scenario, `${entry.id}: source scenario`).toBeDefined();
      expect(entry.prompt).toBe(scenario?.prompt);
      expect(entry.skill).toBeNull();
      expect(entry.acceptanceVerifiers.map(verifier => verifier.criterionIndex))
        .toEqual(scenario?.acceptance.map((_, index) => index));
      expect(entry.forbiddenVerifiers.map(verifier => verifier.criterionIndex))
        .toEqual(scenario?.forbidden.map((_, index) => index));
      expect([...entry.acceptanceVerifiers, ...entry.forbiddenVerifiers]
        .every(verifier => verifier.criterionType === 'objective')).toBe(true);
    }
  });

  it('pins an immutable release baseline without misqualifying historical model evidence', () => {
    expect(baseline).toMatchObject({
      baselineId: 'v1.1.4',
      package: {
        version: '1.1.4',
        integrity: expect.stringMatching(/^sha512-/),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      historicalBehavioralEvidence: {
        qualification: 'starting-point-only',
        serverVersion: '1.1.1',
      },
    });
    expect(sha256(baseline.caseContract.path)).toBe(baseline.caseContract.sha256);
    expect(sha256(baseline.caseContract.schemaPath)).toBe(baseline.caseContract.schemaSha256);
    expect(baseline.controlledCorpusExtension).toMatchObject({
      caseCount: 15,
      combinedCaseCount: 24,
    });
    expect(sha256(baseline.controlledCorpusExtension.casesPath))
      .toBe(baseline.controlledCorpusExtension.casesSha256);
    expect(sha256(baseline.controlledCorpusExtension.scenariosPath))
      .toBe(baseline.controlledCorpusExtension.scenariosSha256);
    expect(sha256(baseline.toolSurface.path)).toBe(baseline.toolSurface.sha256);
    expect(sha256(baseline.historicalBehavioralEvidence.path))
      .toBe(baseline.historicalBehavioralEvidence.sha256);
    for (const skill of baseline.skills) {
      expect(sha256(`agent-plugin/skills/${skill.name}/SKILL.md`), skill.name).toBe(skill.sha256);
    }
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
          skillSha256: null, serverVersion: '1.1.3', surface: 'core', advertisedToolCount: 1,
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

  it('requires immutable artifacts and exact environment metadata for version 2 inputs', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(resultSchema);
    const inputs = {
      runDate: '2026-07-26',
      client: 'inspect-ai',
      clientVersion: '0.3.249',
      model: 'provider/exact-model',
      modelProvider: 'provider',
      modelBaseUrl: 'https://models.example.test/v1',
      effort: 'high',
      evaluationTimeLimitSeconds: 600,
      toolCallingMode: 'emulated',
      epoch: 1,
      promptSha256: 'a'.repeat(64),
      skillSha256: null,
      caseSetVersion: 2,
      caseVersion: 1,
      caseContractSha256: 'b'.repeat(64),
      fixtureSha256: 'c'.repeat(64),
      serverSha256: 'd'.repeat(64),
      toolInventorySha256: 'e'.repeat(64),
      packageLockSha256: 'f'.repeat(64),
      godotVersion: '4.7.stable.official',
      nodeVersion: 'v24.4.1',
      platform: 'linux',
      architecture: 'x64',
      osRelease: '6.8.0',
      renderer: 'project-default',
      displayServer: 'x11',
      environmentStatus: {
        status: 'supported',
        requirements: {
          godot: '>=4.7',
          renderer: 'gl_compatibility',
          headed: true,
          unsupportedWhen: [],
        },
        reasons: [],
      },
      serverVersion: '1.1.4',
      surface: 'core',
      advertisedToolCount: 42,
    };
    const document = {
      schemaVersion: 1,
      scenarioSetVersion: 2,
      evaluationMode: 'external-cold-model',
      runs: [{
        scenarioId: 'schema-comprehension-lifecycle',
        status: 'passed',
        inputs,
        metrics: {
          taskSuccess: true,
          acceptanceCriteriaPassed: 1,
          acceptanceCriteriaTotal: 1,
          toolSelectionPrecision: 1,
          searchRecallAt1: null,
          searchRecallAt3: null,
          searchRecallAt5: null,
          invalidCalls: 0,
          selfCorrections: 0,
          toolCalls: 1,
          elapsedMs: 1,
          responseBytes: 1,
          detachedEditorRuntimeMistakes: 0,
          humanInterventions: 0,
          pauseViolations: 0,
          traceAccuracy: 1,
          cleanupState: {
            clean: true,
            ownedProcesses: 0,
            bridges: 0,
            heldInputs: 0,
            temporaryArtifacts: 0,
          },
        },
        criteria: [{ criterion: 'example', status: 'passed', evidence: 'recorded evidence' }],
      }],
    };
    expect(validate(document), JSON.stringify(validate.errors)).toBe(true);
    delete (inputs as Partial<typeof inputs>).renderer;
    expect(validate(document)).toBe(false);
  });
});
