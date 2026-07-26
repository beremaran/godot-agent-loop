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
  const options = { epochs: 3 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--model') options.model = argv[++index];
    else if (arg === '--epochs') options.epochs = Number(argv[++index]);
    else if (arg === '--output') options.output = resolve(argv[++index]);
    else if (arg === '--godot') options.godot = resolve(argv[++index]);
    else if (arg === '--time-limit') options.timeLimit = Number(argv[++index]);
    else if (arg === '--emulate-tools') options.emulateTools = true;
    else if (arg === '--confirm-external-run') options.confirm = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.confirm) throw new Error('Refusing paired model sampling without --confirm-external-run.');
  if (!options.model) throw new Error('--model is required.');
  if (!Number.isInteger(options.epochs) || options.epochs < 3) {
    throw new Error('--epochs must be an integer of at least 3 for a paired stochastic comparison.');
  }
  if (options.timeLimit !== undefined
    && (!Number.isInteger(options.timeLimit) || options.timeLimit < 1)) {
    throw new Error('--time-limit must be a positive integer.');
  }
  options.output ??= join(repoRoot, 'evals', 'reports', 'paired');
  return options;
}

function run(command, args, cwd = repoRoot) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`);
}

function runInspect(options, name, serverPath, serverVersion) {
  const args = [
    'run',
    '--epochs', String(options.epochs),
    '--model', options.model,
    '--confirm-external-run',
    '--result-output', join(options.output, `${name}-results.json`),
    '--log-dir', join(options.output, `${name}-logs`),
  ];
  if (options.godot) args.push('--godot', options.godot);
  if (options.timeLimit) args.push('--time-limit', String(options.timeLimit));
  if (options.emulateTools) args.push('--emulate-tools');
  if (serverPath) args.push('--server', serverPath, '--server-version', serverVersion);
  run(join(repoRoot, 'evals', 'inspect', '.venv', 'bin', 'godot-agent-loop-eval'), args);
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function godotVersion(path) {
  if (!path) return null;
  const result = spawnSync(path, ['--version'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

const options = parseArgs(process.argv.slice(2));
mkdirSync(options.output, { recursive: true });
const baseline = prepareBaseline();
const orderSeed = Number(process.env.GITHUB_RUN_ID ?? randomInt(1, 2 ** 30));
const order = orderSeed % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
const gitCommit = spawnSync('git', ['rev-parse', 'HEAD'], {
  cwd: repoRoot,
  encoding: 'utf8',
}).stdout.trim();
const runManifestPath = join(options.output, 'run-manifest.json');
writeFileSync(runManifestPath, `${JSON.stringify({
  schemaVersion: 1,
  model: options.model,
  effort: 'high',
  client: {
    name: 'inspect-ai',
    version: '0.3.249',
    solver: 'react',
  },
  epochs: options.epochs,
  evaluationTimeLimitSeconds: options.timeLimit ?? 'case-default',
  toolCallingMode: options.emulateTools ? 'emulated' : 'native',
  orderSeed,
  order,
  baseline: {
    id: baseline.baselineId,
    packageVersion: baseline.packageVersion,
    packageSha256: baseline.packageSha256,
  },
  candidate: {
    packageVersion: JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version,
    gitCommit,
  },
  retainedEvidence: {
    baselineResults: 'baseline-results.json',
    candidateResults: 'candidate-results.json',
    baselineInspectLogs: 'baseline-logs/',
    candidateInspectLogs: 'candidate-logs/',
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
  generatedAt: new Date().toISOString(),
}, null, 2)}\n`, 'utf8');
for (const name of order) {
  if (name === 'baseline') {
    runInspect(options, name, baseline.serverPath, baseline.packageVersion);
  } else {
    runInspect(options, name);
  }
}
const report = compare({
  baseline: join(options.output, 'baseline-results.json'),
  candidate: join(options.output, 'candidate-results.json'),
  bootstrapSamples: 10_000,
  seed: orderSeed,
  runManifest: runManifestPath,
});
writeFileSync(join(options.output, 'comparison.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
writeFileSync(join(options.output, 'comparison.md'), markdown(report), 'utf8');
console.log(join(options.output, 'comparison.json'));
if (report.releaseDecision !== 'passed') process.exitCode = 1;
