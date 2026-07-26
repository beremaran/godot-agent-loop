#!/usr/bin/env node

import { createHash, randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compare, markdown } from './compare-evaluation-results.mjs';
import { prepareBaseline } from './prepare-evaluation-baseline.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  const options = { batches: 2, epochs: 3 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--model') options.model = argv[++index];
    else if (arg === '--batches') options.batches = Number(argv[++index]);
    else if (arg === '--epochs') options.epochs = Number(argv[++index]);
    else if (arg === '--output') options.output = resolve(argv[++index]);
    else if (arg === '--godot') options.godot = resolve(argv[++index]);
    else if (arg === '--time-limit') options.timeLimit = Number(argv[++index]);
    else if (arg === '--emulate-tools') options.emulateTools = true;
    else if (arg === '--confirm-external-run') options.confirm = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.confirm) {
    throw new Error('Refusing stochastic A/A model sampling without --confirm-external-run.');
  }
  if (!options.model) throw new Error('--model is required.');
  if (!Number.isInteger(options.batches) || options.batches < 2) {
    throw new Error('--batches must be an integer of at least 2.');
  }
  if (!Number.isInteger(options.epochs) || options.epochs < 3) {
    throw new Error('--epochs must be an integer of at least 3.');
  }
  if (options.timeLimit !== undefined
    && (!Number.isInteger(options.timeLimit) || options.timeLimit < 1)) {
    throw new Error('--time-limit must be a positive integer.');
  }
  options.output ??= join(repoRoot, 'evals', 'reports', 'aa-calibration');
  return options;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`);
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function godotVersion(path) {
  if (!path) return null;
  const result = spawnSync(path, ['--version'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function currentScenarioIds() {
  const document = JSON.parse(readFileSync(join(repoRoot, 'evals', 'cases.json'), 'utf8'));
  if (document.cases.length !== 9) {
    throw new Error(`The Phase 0 calibration corpus must contain exactly 9 cases; found ${document.cases.length}.`);
  }
  return document.cases.map(evaluationCase => evaluationCase.id);
}

function runInspect(options, name, baseline, scenarioIds) {
  const args = [
    'run',
    '--epochs', String(options.epochs),
    '--model', options.model,
    '--confirm-external-run',
    '--result-output', join(options.output, `${name}-results.json`),
    '--log-dir', join(options.output, `${name}-logs`),
    '--server', baseline.serverPath,
    '--server-version', baseline.packageVersion,
  ];
  for (const scenarioId of scenarioIds) args.push('--scenario', scenarioId);
  if (options.godot) args.push('--godot', options.godot);
  if (options.timeLimit) args.push('--time-limit', String(options.timeLimit));
  if (options.emulateTools) args.push('--emulate-tools');
  run(join(repoRoot, 'evals', 'inspect', '.venv', 'bin', 'godot-agent-loop-eval'), args);
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  mkdirSync(options.output, { recursive: true });
  const baseline = prepareBaseline();
  const scenarioIds = currentScenarioIds();
  const seed = Number(process.env.GITHUB_RUN_ID ?? randomInt(1, 2 ** 30));
  const reports = [];

  for (let batch = 1; batch <= options.batches; batch += 1) {
    const order = (seed + batch) % 2 === 0 ? ['a', 'b'] : ['b', 'a'];
    for (const arm of order) {
      runInspect(options, `batch-${batch}-${arm}`, baseline, scenarioIds);
    }
    const report = compare({
      baseline: join(options.output, `batch-${batch}-a-results.json`),
      candidate: join(options.output, `batch-${batch}-b-results.json`),
      bootstrapSamples: 10_000,
      seed: seed + batch,
    });
    const reportPath = join(options.output, `batch-${batch}-comparison.json`);
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    writeFileSync(reportPath.replace(/\.json$/u, '.md'), markdown(report), 'utf8');
    reports.push({
      id: `stochastic-aa-${batch}`,
      order,
      comparison: {
        path: reportPath,
        sha256: sha256(reportPath),
      },
      pairCount: report.inputs.pairCount,
      taskSuccessDelta: report.outcome.taskSuccess.absoluteDelta,
      objectiveCriterionDelta: report.outcome.objectiveCriterionSuccess.absoluteDelta,
      clustered95PercentInterval: [
        report.controls.bootstrap.lower,
        report.controls.bootstrap.upper,
      ],
      pairedOutcomeDisagreements: report.pairs.filter(pair =>
        pair.baselineSuccess !== pair.candidateSuccess).length,
      armBFlakeRate: report.reliability.candidateFlakeRate,
    });
  }

  const summary = {
    schemaVersion: 1,
    calibrationType: 'stochastic-model-aa',
    generatedAt: new Date().toISOString(),
    baseline: {
      id: baseline.baselineId,
      packageVersion: baseline.packageVersion,
      packageSha256: baseline.packageSha256,
    },
    controlledInputs: {
      model: options.model,
      effort: 'high',
      client: 'inspect-ai',
      clientVersion: '0.3.249',
      solver: 'react',
      epochs: options.epochs,
      evaluationTimeLimitSeconds: options.timeLimit ?? 'case-default',
      toolCallingMode: options.emulateTools ? 'emulated' : 'native',
      scenarioIds,
      surface: 'core',
    },
    environment: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      godot: godotVersion(options.godot),
      renderer: process.env.GODOT_MCP_E2E_RENDERER ?? 'project-default',
      displayServer: process.env.DISPLAY
        ? 'x11'
        : process.env.WAYLAND_DISPLAY ? 'wayland' : 'none',
      packageLockSha256: sha256(join(repoRoot, 'package-lock.json')),
    },
    seed,
    reports,
    observedVariance: {
      maximumAbsoluteTaskSuccessDelta: Math.max(...reports.map(report =>
        Math.abs(report.taskSuccessDelta ?? 0))),
      maximumPairedOutcomeDisagreements: Math.max(...reports.map(report =>
        report.pairedOutcomeDisagreements)),
      batchesWithArmBFlakes: reports.filter(report => (report.armBFlakeRate ?? 0) > 0).length,
    },
    thresholdPolicy: 'Calibration records variance; release thresholds are reviewed and frozen separately, never tuned automatically.',
  };
  const summaryPath = join(options.output, 'calibration.json');
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  writeFileSync(join(options.output, 'calibration.md'),
    `# Stochastic A/A calibration\n\n`
    + `Model: \`${options.model}\`; baseline: \`${baseline.baselineId}\`; `
    + `${options.batches} batches × 2 arms × 9 cases × ${options.epochs} epochs.\n\n`
    + `Maximum absolute task-success delta: `
    + `${summary.observedVariance.maximumAbsoluteTaskSuccessDelta}.\n\n`
    + `Maximum paired outcome disagreements: `
    + `${summary.observedVariance.maximumPairedOutcomeDisagreements}.\n`,
    'utf8');
  console.log(summaryPath);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
