// @test-kind: contract
import addFormats from 'ajv-formats';
import Ajv2020 from 'ajv/dist/2020.js';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizedFixtureSnapshot } from '../evals/fixture-snapshot.mjs';
import { compare } from '../scripts/compare-evaluation-results.mjs';
import { toolDefinitions } from '../src/tool-definitions.js';
import { toolManifest } from '../src/tool-manifest.js';
import { repoRoot } from './helpers/manifest-sources.js';
import { registryMappings } from './helpers/manifest-sources.js';

let temporaryRoot: string | null = null;

function document(path: string): any {
  return JSON.parse(readFileSync(join(repoRoot, path), 'utf8'));
}

function candidate(mutator: (value: any) => void): string {
  temporaryRoot ??= mkdtempSync(join(tmpdir(), 'godot-eval-sentinel-'));
  const value = document('evals/current-model-status.json');
  mutator(value);
  const path = join(temporaryRoot, `${Math.random()}.json`);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return path;
}

function comparison(path: string) {
  return compare({
    baseline: join(repoRoot, 'evals/current-model-status.json'),
    candidate: path,
    bootstrapSamples: 1000,
    seed: 7,
  });
}

afterEach(() => {
  if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = null;
});

describe('evaluation regression sentinels', () => {
  it('detects a seeded protocol tool-list mismatch across transports', () => {
    const fingerprint = (tools: unknown) =>
      createHash('sha256').update(JSON.stringify(tools)).digest('hex');
    const stdioTools = structuredClone(toolDefinitions);
    const httpTools = structuredClone(toolDefinitions);
    httpTools.pop();
    expect(fingerprint(httpTools)).not.toBe(fingerprint(stdioTools));
  });

  it('normalizes isolated project roots without hiding fixture content drift', () => {
    temporaryRoot = mkdtempSync(join(tmpdir(), 'godot-fixture-identity-'));
    const first = join(temporaryRoot, 'arm-a', 'project');
    const second = join(temporaryRoot, 'arm-b', 'project');
    for (const root of [first, second]) {
      mkdirSync(join(root, 'fixtures'), { recursive: true });
      writeFileSync(join(root, 'project.godot'), '[application]\nconfig/name="Fixture"\n', 'utf8');
      writeFileSync(join(root, 'export_presets.cfg'),
        `custom_template/release="${root}/fixtures/local-template.x86_64"\n`, 'utf8');
      writeFileSync(join(root, 'fixtures', 'local-template.x86_64'), root, 'utf8');
      symlinkSync(join(root, '..', 'outside.txt'), join(root, 'escape-link.txt'));
    }
    expect(normalizedFixtureSnapshot(first)).toEqual(normalizedFixtureSnapshot(second));
    writeFileSync(join(second, 'project.godot'), '[application]\nconfig/name="Drift"\n', 'utf8');
    expect(normalizedFixtureSnapshot(first)).not.toEqual(normalizedFixtureSnapshot(second));
  });

  it('refuses stochastic A/A calibration without explicit sampling authorization', () => {
    const result = spawnSync(process.execPath, [
      join(repoRoot, 'scripts/run-aa-calibration.mjs'),
      '--model', 'mockllm/model',
    ], { cwd: repoRoot, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/without --confirm-external-run/);
  });

  it('requires at least three epochs for stochastic A/A calibration', () => {
    const result = spawnSync(process.execPath, [
      join(repoRoot, 'scripts/run-aa-calibration.mjs'),
      '--model', 'mockllm/model',
      '--epochs', '1',
      '--confirm-external-run',
    ], { cwd: repoRoot, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/at least 3/);
  });

  it('rejects a case contract whose schema/scorer coverage is removed', () => {
    const schema = document('evals/case.schema.json');
    const cases = document('evals/server-cases.json');
    delete cases.cases[0].acceptanceVerifiers;
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    expect(ajv.compile(schema)(cases)).toBe(false);
  });

  it('detects a deliberately regressed tool description through inventory and behavioral evidence', () => {
    const report = comparison(candidate(value => {
      value.runs[0].inputs.toolInventorySha256 = 'b'.repeat(64);
      value.runs[0].metrics.taskSuccess = false;
      value.runs[0].metrics.acceptanceCriteriaPassed = 0;
      value.runs[0].criteria[0].status = 'failed';
    }));
    expect(report.compatibility.changedToolInventories).toContain('compact-no-skill-discovery::0');
    expect(report.gates.aggregateTaskSuccess.status).toBe('failed');
    expect(report.releaseDecision).toBe('failed');
  });

  it('detects a deliberately drifted tool action schema', () => {
    const definition = structuredClone(
      toolDefinitions.find(tool => tool.name === 'manage_input_map')!,
    );
    definition.inputSchema.properties.action.enum = ['list', 'add'];
    expect([...definition.inputSchema.properties.action.enum].sort())
      .not.toEqual([...(toolManifest.manage_input_map.actions ?? [])].sort());
  });

  it('detects a deliberately misrouted handler', () => {
    const registry = registryMappings();
    registry.set('run_project', { domain: 'lifecycle', handler: 'handleStopProject' });
    expect(registry.get('run_project')).not.toEqual({
      domain: toolManifest.run_project.domain,
      handler: toolManifest.run_project.handler,
    });
  });

  it('fails a deliberately regressed policy result', () => {
    const report = comparison(candidate(value => {
      value.runs[0].metrics.pauseViolations = 1;
    }));
    expect(report.gates.allCandidateSafetyGates.status).toBe('failed');
    expect(report.gates.noPairedHardGateRegression.status).toBe('failed');
    expect(report.releaseDecision).toBe('failed');
  });

  it('fails a deliberately regressed cleanup result', () => {
    const report = comparison(candidate(value => {
      value.runs[0].metrics.cleanupState.clean = false;
      value.runs[0].metrics.cleanupState.heldInputs = 1;
    }));
    expect(report.gates.allCandidateSafetyGates.status).toBe('failed');
    expect(report.gates.noPairedHardGateRegression.status).toBe('failed');
    expect(report.releaseDecision).toBe('failed');
  });

  it('rejects a deliberately changed controlled model factor', () => {
    expect(() => comparison(candidate(value => {
      value.runs[0].inputs.model = 'different/model';
    }))).toThrow(/Controlled factor mismatch.*model/);
  });

  it('fails a deliberately regressed latency budget', () => {
    const report = comparison(candidate(value => {
      value.runs[0].metrics.toolLatency = {
        byTool: { run_project: { samples: 3, medianMs: 31_000, p95Ms: 31_000 } },
        byBackend: { process: { samples: 3, medianMs: 31_000, p95Ms: 31_000 } },
      };
    }));
    expect(report.gates.backendP95Budgets.status).toBe('failed');
    expect(report.releaseDecision).toBe('failed');
  });

  it('keeps an unsupported environment visible and out of passing hard gates', () => {
    const report = comparison(candidate(value => {
      value.runs[0].status = 'unsupported';
      value.runs[0].reason = 'headed editor unavailable';
      value.runs[0].metrics.taskSuccess = false;
      value.runs[0].criteria.forEach((criterion: { status: string }) => {
        criterion.status = 'unsupported';
      });
    }));
    expect(report.pairs.find((pair: { scenarioId: string }) =>
      pair.scenarioId === 'compact-no-skill-discovery')).toMatchObject({
      candidateStatus: 'unsupported',
      candidateHardGate: false,
    });
    expect(report.releaseDecision).toBe('failed');
  });
});
