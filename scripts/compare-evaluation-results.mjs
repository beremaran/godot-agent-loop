#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  const options = { bootstrapSamples: 10_000, seed: 20_260_726 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--baseline') options.baseline = resolve(argv[++index]);
    else if (arg === '--candidate') options.candidate = resolve(argv[++index]);
    else if (arg === '--output') options.output = resolve(argv[++index]);
    else if (arg === '--bootstrap-samples') options.bootstrapSamples = Number(argv[++index]);
    else if (arg === '--seed') options.seed = Number(argv[++index]);
    else if (arg === '--run-manifest') options.runManifest = resolve(argv[++index]);
    else if (arg === '--expect-equivalent') options.expectEquivalent = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.baseline || !options.candidate) throw new Error('--baseline and --candidate are required.');
  return options;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex');
}

function artifact(path) {
  return { path, sha256: sha256(path) };
}

function load(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function pairKey(run, index) {
  return `${run.scenarioId}::${run.inputs?.epoch ?? run.epoch ?? index}`;
}

function mean(values) {
  return values.length === 0 ? null : values.reduce((total, value) => total + value, 0) / values.length;
}

function quantile(sorted, probability) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(probability * sorted.length)));
  return sorted[index];
}

function randomGenerator(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function clusteredBootstrap(pairs, samples, seed) {
  const clusters = [...new Set(pairs.map(pair => pair.scenarioId))];
  const byCluster = new Map(clusters.map(cluster => [cluster, pairs.filter(pair => pair.scenarioId === cluster)]));
  const random = randomGenerator(seed);
  const differences = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const selected = [];
    for (let index = 0; index < clusters.length; index += 1) {
      selected.push(...byCluster.get(clusters[Math.floor(random() * clusters.length)]));
    }
    differences.push(mean(selected.map(pair =>
      Number(pair.candidate.metrics.taskSuccess) - Number(pair.baseline.metrics.taskSuccess))));
  }
  differences.sort((left, right) => left - right);
  return {
    method: 'scenario-clustered-bootstrap',
    confidence: 0.95,
    samples,
    seed,
    lower: quantile(differences, 0.025),
    upper: quantile(differences, 0.975),
  };
}

function ratioDelta(pairs, metric) {
  const numeric = value => typeof value === 'boolean' ? Number(value) : value;
  const baseline = mean(pairs.map(pair => numeric(pair.baseline.metrics[metric])).filter(Number.isFinite));
  const candidate = mean(pairs.map(pair => numeric(pair.candidate.metrics[metric])).filter(Number.isFinite));
  return {
    baseline,
    candidate,
    absoluteDelta: baseline === null || candidate === null ? null : candidate - baseline,
    relativeDelta: baseline === null || candidate === null || baseline === 0 ? null : (candidate - baseline) / baseline,
  };
}

function hardGate(run) {
  const forbidden = (run.criteria ?? []).filter(criterion =>
    criterion.evidenceId?.includes(':forbidden:') || criterion.criterion.startsWith('Forbidden:'));
  return !['not_run', 'unsupported', 'manual', 'unobserved'].includes(run.status)
    && run.metrics?.cleanupState?.clean === true
    && (run.metrics.pauseViolations ?? 0) === 0
    && forbidden.every(criterion => criterion.status === 'passed');
}

const CONTROLLED_INPUT_FIELDS = [
  'client',
  'clientVersion',
  'model',
  'modelProvider',
  'modelBaseUrl',
  'effort',
  'evaluationTimeLimitSeconds',
  'toolCallingMode',
  'promptSha256',
  'skillSha256',
  'caseSetVersion',
  'caseVersion',
  'caseContractSha256',
  'fixtureSha256',
  'packageLockSha256',
  'surface',
  'godotVersion',
  'nodeVersion',
  'platform',
  'architecture',
  'osRelease',
  'renderer',
  'displayServer',
  'environmentStatus',
];

function controlledFactorMismatches(pairs) {
  return pairs.flatMap(pair => CONTROLLED_INPUT_FIELDS.flatMap(field => {
    const baseline = pair.baseline.inputs?.[field];
    const candidate = pair.candidate.inputs?.[field];
    return JSON.stringify(baseline) === JSON.stringify(candidate)
      ? []
      : [{ pair: pair.key, field, baseline: baseline ?? null, candidate: candidate ?? null }];
  }));
}

function caseMetadata() {
  const documents = ['cases.json', 'server-cases.json'].map(name =>
    load(resolve(repoRoot, 'evals', name)));
  return new Map(documents.flatMap(document => document.cases)
    .map(evaluationCase => [evaluationCase.id, evaluationCase]));
}

function domainComparison(pairs, cases) {
  const domains = [...new Set(pairs.map(pair => cases.get(pair.scenarioId)?.tags.domain ?? 'unknown'))].sort();
  return Object.fromEntries(domains.map(domain => {
    const domainPairs = pairs.filter(pair => (cases.get(pair.scenarioId)?.tags.domain ?? 'unknown') === domain);
    return [domain, ratioDelta(domainPairs, 'taskSuccess')];
  }));
}

function flakeSummary(pairs) {
  const scenarios = [...new Set(pairs.map(pair => pair.scenarioId))];
  const candidateFlakes = scenarios.filter(scenario => {
    const outcomes = new Set(pairs.filter(pair => pair.scenarioId === scenario)
      .map(pair => pair.candidate.metrics.taskSuccess));
    return outcomes.size > 1;
  });
  return {
    candidateFlakeCases: candidateFlakes,
    candidateFlakeRate: scenarios.length === 0 ? null : candidateFlakes.length / scenarios.length,
  };
}

function latencyBudget(pairs) {
  const budgets = load(resolve(repoRoot, 'evals', 'performance-budgets.json'));
  const violations = [];
  let observations = 0;
  for (const pair of pairs) {
    for (const [backend, summary] of Object.entries(pair.candidate.metrics.toolLatency?.byBackend ?? {})) {
      observations += summary.samples;
      const budgetMs = budgets.p95Milliseconds[backend] ?? budgets.p95Milliseconds.unknown;
      if (summary.p95Ms > budgetMs) {
        violations.push({ pair: pair.key, backend, observedP95Ms: summary.p95Ms, budgetMs });
      }
    }
  }
  return { observations, violations, budgets: budgets.p95Milliseconds };
}

function inputMatrix(pairs, arm) {
  const fields = [
    ...CONTROLLED_INPUT_FIELDS,
    'serverVersion',
    'serverSha256',
    'toolInventorySha256',
    'advertisedToolCount',
  ];
  return Object.fromEntries(fields.map(field => [
    field,
    [...new Set(pairs.map(pair => pair[arm].inputs?.[field])
      .filter(value => value !== undefined)
      .map(value => JSON.stringify(value)))]
      .map(value => JSON.parse(value)),
  ]));
}

function criterionEvidence(run) {
  return run.criteria.map(criterion => ({
    evidenceId: criterion.evidenceId ?? null,
    scorer: criterion.scorer ?? null,
    status: criterion.status,
    evidenceSha256: sha256Text(criterion.evidence),
  }));
}

export function compare(options) {
  const baselineDocument = load(options.baseline);
  const candidateDocument = load(options.candidate);
  if (!Array.isArray(baselineDocument.runs) || !Array.isArray(candidateDocument.runs)) {
    throw new Error('Both comparison inputs must contain a runs array.');
  }
  const baseline = new Map(baselineDocument.runs.map((run, index) => [pairKey(run, index), run]));
  const candidate = new Map(candidateDocument.runs.map((run, index) => [pairKey(run, index), run]));
  const keys = [...new Set([...baseline.keys(), ...candidate.keys()])].sort();
  const missing = keys.filter(key => !baseline.has(key) || !candidate.has(key));
  if (missing.length > 0) throw new Error(`Unpaired cases: ${missing.join(', ')}`);
  const pairs = keys.map(key => ({
    key,
    scenarioId: baseline.get(key).scenarioId,
    baseline: baseline.get(key),
    candidate: candidate.get(key),
  }));
  const controlMismatches = controlledFactorMismatches(pairs);
  if (controlMismatches.length > 0) {
    const summary = controlMismatches
      .slice(0, 10)
      .map(item => `${item.pair}:${item.field}`)
      .join(', ');
    throw new Error(`Controlled factor mismatch: ${summary}`);
  }
  const equivalent = readFileSync(options.baseline).equals(readFileSync(options.candidate));
  if (options.expectEquivalent && !equivalent) {
    throw new Error('A/A comparison inputs are not byte-for-byte equivalent.');
  }
  const cases = caseMetadata();
  const taskSuccess = ratioDelta(pairs, 'taskSuccess');
  const criterion = {
    baseline: mean(pairs.map(pair => pair.baseline.metrics.acceptanceCriteriaPassed / pair.baseline.metrics.acceptanceCriteriaTotal)),
    candidate: mean(pairs.map(pair => pair.candidate.metrics.acceptanceCriteriaPassed / pair.candidate.metrics.acceptanceCriteriaTotal)),
  };
  criterion.absoluteDelta = criterion.candidate - criterion.baseline;
  const interval = clusteredBootstrap(pairs, options.bootstrapSamples, options.seed);
  const regressions = pairs.filter(pair => hardGate(pair.baseline) && !hardGate(pair.candidate))
    .map(pair => pair.key);
  const criticalFailures = pairs.filter(pair =>
    cases.get(pair.scenarioId)?.risk === 'critical' && pair.candidate.metrics.taskSuccess !== true)
    .map(pair => pair.key);
  const domains = domainComparison(pairs, cases);
  const domainRegressions = Object.entries(domains)
    .filter(([, metrics]) => metrics.absoluteDelta !== null && metrics.absoluteDelta < -0.1)
    .map(([domain, metrics]) => ({ domain, observed: metrics.absoluteDelta, threshold: -0.1 }));
  const catalogAt5 = ratioDelta(pairs.filter(pair =>
    pair.candidate.metrics.searchRecallAt5 !== null
      && pair.candidate.metrics.searchRecallAt5 !== undefined), 'searchRecallAt5');
  const catalogAt3 = ratioDelta(pairs.filter(pair =>
    pair.candidate.metrics.searchRecallAt3 !== null
      && pair.candidate.metrics.searchRecallAt3 !== undefined), 'searchRecallAt3');
  const performance = Object.fromEntries(
    ['elapsedMs', 'responseBytes', 'redundantCallRate'].map(metric => [metric, ratioDelta(pairs, metric)]),
  );
  const performanceRegressions = Object.entries(performance)
    .filter(([, metrics]) => metrics.relativeDelta !== null
      && metrics.relativeDelta > 0.1
      && (taskSuccess.absoluteDelta ?? 0) < 0.05)
    .map(([metric, metrics]) => ({ metric, observed: metrics.relativeDelta, threshold: 0.1 }));
  const latency = latencyBudget(pairs);
  const reliability = flakeSummary(pairs);
  const baselineManifestPath = resolve(repoRoot, 'evals', 'baselines', 'v1.1.4', 'manifest.json');
  const scorerAuditPath = resolve(repoRoot, 'evals', 'audits', 'v2-scorer-audit.json');
  const baselineManifest = load(baselineManifestPath);
  const gates = {
    allCandidateSafetyGates: {
      status: pairs.every(pair => hardGate(pair.candidate)) ? 'passed' : 'failed',
      failures: pairs.filter(pair => !hardGate(pair.candidate)).map(pair => pair.key),
    },
    noPairedHardGateRegression: {
      status: regressions.length === 0 ? 'passed' : 'failed',
      failures: regressions,
    },
    criticalTaskSuccess: {
      status: criticalFailures.length === 0 ? 'passed' : 'failed',
      failures: criticalFailures,
      threshold: 1,
    },
    aggregateTaskSuccess: {
      status: taskSuccess.candidate >= 0.9 ? 'passed' : 'failed',
      observed: taskSuccess.candidate,
      threshold: 0.9,
    },
    taskSuccessNonInferiority: {
      status: interval.lower >= -0.05 ? 'passed' : 'failed',
      observedLowerBound: interval.lower,
      threshold: -0.05,
    },
    objectiveCriterionSuccess: {
      status: criterion.candidate >= 0.95 ? 'passed' : 'failed',
      observed: criterion.candidate,
      threshold: 0.95,
    },
    domainNonInferiority: {
      status: domainRegressions.length === 0 ? 'passed' : 'failed',
      failures: domainRegressions,
      threshold: -0.1,
    },
    catalogRecallAt5: {
      status: catalogAt5.candidate === null
        ? (equivalent ? 'passed' : 'blocked')
        : catalogAt5.candidate === 1 ? 'passed' : 'failed',
      observed: catalogAt5.candidate,
      threshold: 1,
    },
    catalogRecallAt3NonInferiority: {
      status: catalogAt3.absoluteDelta === null
        ? (equivalent ? 'passed' : 'blocked')
        : catalogAt3.absoluteDelta >= 0 ? 'passed' : 'failed',
      observed: catalogAt3.absoluteDelta,
      threshold: 0,
    },
    performanceTradeoff: {
      status: performanceRegressions.length === 0 ? 'passed' : 'failed',
      failures: performanceRegressions,
      relativeThreshold: 0.1,
      successTradeoffThreshold: 0.05,
    },
    backendP95Budgets: {
      status: latency.observations === 0
        ? (equivalent ? 'passed' : 'blocked')
        : latency.violations.length === 0 ? 'passed' : 'failed',
      observations: latency.observations,
      failures: latency.violations,
    },
    criticalFlakeRate: {
      status: reliability.candidateFlakeCases
        .some(id => cases.get(id)?.risk === 'critical') ? 'failed' : 'passed',
      failures: reliability.candidateFlakeCases.filter(id => cases.get(id)?.risk === 'critical'),
      threshold: 0,
    },
  };
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    inputs: {
      baseline: artifact(options.baseline),
      candidate: artifact(options.candidate),
      runManifest: options.runManifest ? artifact(options.runManifest) : null,
      caseSetVersion: candidateDocument.scenarioSetVersion,
      pairCount: pairs.length,
      scenarioCount: new Set(pairs.map(pair => pair.scenarioId)).size,
    },
    controls: {
      pairedBy: ['scenarioId', 'epoch/index', ...CONTROLLED_INPUT_FIELDS],
      candidateBaselineOrder: 'caller supplies randomized execution order; comparison is order-independent',
      bootstrap: interval,
      aaEquivalent: equivalent,
      mismatches: controlMismatches,
      environmentMatrix: {
        baseline: inputMatrix(pairs, 'baseline'),
        candidate: inputMatrix(pairs, 'candidate'),
      },
    },
    provenance: {
      baselineManifest: artifact(baselineManifestPath),
      corpus: {
        cases: artifact(resolve(repoRoot, 'evals', 'cases.json')),
        serverCases: artifact(resolve(repoRoot, 'evals', 'server-cases.json')),
        caseSchema: artifact(resolve(repoRoot, 'evals', 'case.schema.json')),
        resultSchema: artifact(resolve(repoRoot, 'evals', 'result.schema.json')),
      },
      evaluator: {
        inspectVersion: baselineManifest.evaluationEnvironment.inspectVersion,
        comparisonImplementation: artifact(fileURLToPath(import.meta.url)),
        scorerImplementation: artifact(resolve(repoRoot, 'evals', 'cold-model-runner.mjs')),
        fixtureIdentityImplementation: artifact(resolve(repoRoot, 'evals', 'fixture-snapshot.mjs')),
      },
      audit: {
        scorer: artifact(scorerAuditPath),
        reviewerStatus: load(scorerAuditPath).interReviewerAgreement.status,
      },
    },
    outcome: { taskSuccess, objectiveCriterionSuccess: criterion, byDomain: domains },
    safety: {
      candidateHardGatePasses: pairs.filter(pair => hardGate(pair.candidate)).length,
      total: pairs.length,
      regressions,
    },
    toolUse: {
      validCallRate: ratioDelta(pairs, 'validCallRate'),
      toolSelectionPrecision: ratioDelta(pairs, 'toolSelectionPrecision'),
      capabilityRecall: ratioDelta(pairs, 'capabilityRecall'),
    },
    trajectory: {
      orderCompliance: ratioDelta(pairs, 'orderCompliance'),
      claimPrecision: ratioDelta(pairs, 'claimPrecision'),
      claimRecall: ratioDelta(pairs, 'claimRecall'),
    },
    performance,
    latency,
    reliability,
    compatibility: {
      baselineClients: [...new Set(pairs.map(pair => pair.baseline.inputs?.client).filter(Boolean))],
      candidateClients: [...new Set(pairs.map(pair => pair.candidate.inputs?.client).filter(Boolean))],
      baselineServerVersions: [...new Set(pairs.map(pair => pair.baseline.inputs?.serverVersion).filter(Boolean))],
      candidateServerVersions: [...new Set(pairs.map(pair => pair.candidate.inputs?.serverVersion).filter(Boolean))],
      changedToolInventories: pairs
        .filter(pair => pair.baseline.inputs?.toolInventorySha256
          !== pair.candidate.inputs?.toolInventorySha256)
        .map(pair => pair.key),
    },
    gates,
    releaseDecision: Object.values(gates).every(gate => gate.status === 'passed') ? 'passed' : 'failed',
    pairs: pairs.map(pair => ({
      key: pair.key,
      scenarioId: pair.scenarioId,
      risk: cases.get(pair.scenarioId)?.risk ?? null,
      domain: cases.get(pair.scenarioId)?.tags.domain ?? null,
      baselineStatus: pair.baseline.status,
      candidateStatus: pair.candidate.status,
      baselineSuccess: pair.baseline.metrics.taskSuccess,
      candidateSuccess: pair.candidate.metrics.taskSuccess,
      baselineCleanup: pair.baseline.metrics.cleanupState?.clean,
      candidateCleanup: pair.candidate.metrics.cleanupState?.clean,
      baselineHardGate: hardGate(pair.baseline),
      candidateHardGate: hardGate(pair.candidate),
      inputHashes: {
        promptSha256: pair.candidate.inputs?.promptSha256 ?? null,
        skillSha256: pair.candidate.inputs?.skillSha256 ?? null,
        caseContractSha256: pair.candidate.inputs?.caseContractSha256 ?? null,
        fixtureSha256: pair.candidate.inputs?.fixtureSha256 ?? null,
        baselineServerSha256: pair.baseline.inputs?.serverSha256 ?? null,
        candidateServerSha256: pair.candidate.inputs?.serverSha256 ?? null,
        baselineToolInventorySha256: pair.baseline.inputs?.toolInventorySha256 ?? null,
        candidateToolInventorySha256: pair.candidate.inputs?.toolInventorySha256 ?? null,
      },
      baselineMetrics: pair.baseline.metrics,
      candidateMetrics: pair.candidate.metrics,
      baselineCriteria: criterionEvidence(pair.baseline),
      candidateCriteria: criterionEvidence(pair.candidate),
    })),
  };
}

export function markdown(report) {
  const rows = Object.entries(report.gates)
    .map(([name, gate]) => `| ${name} | ${gate.status} |`)
    .join('\n');
  return `# Evaluation comparison\n\n`
    + `Decision: **${report.releaseDecision}**\n\n`
    + `Pairs: ${report.inputs.pairCount}; scenarios: ${report.inputs.scenarioCount}.\n\n`
    + `Task-success delta: ${report.outcome.taskSuccess.absoluteDelta ?? 'not applicable'}; `
    + `95% clustered interval: [${report.controls.bootstrap.lower}, ${report.controls.bootstrap.upper}].\n\n`
    + `| Gate | Status |\n| --- | --- |\n${rows}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const report = compare(options);
  if (options.output) {
    mkdirSync(dirname(options.output), { recursive: true });
    writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    writeFileSync(options.output.replace(/\.json$/u, '.md'), markdown(report), 'utf8');
  }
  console.log(JSON.stringify(report));
  if (report.releaseDecision !== 'passed') process.exitCode = 1;
}
