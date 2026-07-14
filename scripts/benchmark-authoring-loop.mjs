#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import {
  accessSync, constants, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { cpus, platform, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { performance } from 'node:perf_hooks';

import { AuthoringSessionManager } from '../build/authoring-session-manager.js';
import { GameConnection } from '../build/game-connection.js';
import { GodotProcessManager } from '../build/godot-process-manager.js';
import { HeadlessOperationRunner } from '../build/headless-operation-runner.js';
import { HeadlessOperationService } from '../build/headless-operation-service.js';
import { InteractionServerInstaller } from '../build/interaction-server-installer.js';
import { RENDERING_CONTEXT_CAPABILITY } from '../build/runtime-protocol.js';
import { deterministicSessionArguments, deterministicSessionEnvironment } from '../build/session-timing.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = join(root, 'docs/coverage/loop-latency.json');
const operationsScriptPath = join(root, 'build/scripts/godot_operations.gd');
const interactionScriptPath = join(root, 'build/scripts/mcp_interaction_server.gd');
const iterations = parseIterations(process.argv);

const BUDGETS = {
  sessionCycleMedianMaxMs: 4500,
  sessionToSubprocessMedianRatioMax: 1.6,
  sessionStartupP95MaxMs: 1500,
  warmSessionCommandP95MaxMs: 100,
};

if (platform() === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  throw new Error('Loop benchmark requires a headed rendering context. Run it on a desktop or under Xvfb.');
}

const godot = resolveGodot();
const engineVersion = execFileSync(godot, ['--version'], { encoding: 'utf8' }).trim().split('\n').at(-1);
const samples = { session: [], subprocess: [] };

// Untimed warmups import scripts and populate OS caches before modes alternate.
await runCycle('session', godot);
await runCycle('subprocess', godot);

for (let index = 0; index < iterations; index++) {
  const order = index % 2 === 0 ? ['session', 'subprocess'] : ['subprocess', 'session'];
  for (const mode of order) samples[mode].push(await runCycle(mode, godot));
}

const sessionTotals = samples.session.map(sample => sample.totalMs);
const subprocessTotals = samples.subprocess.map(sample => sample.totalMs);
const sessionMedian = median(sessionTotals);
const subprocessMedian = median(subprocessTotals);
const sessionStartupDurations = samples.session.flatMap(sample => sample.startupEditMs);
const warmSessionDurations = samples.session.flatMap(sample => sample.warmEditMs);
const subprocessOperationDurations = samples.subprocess.flatMap(sample => sample.operationMs);
const ratio = sessionMedian / subprocessMedian;
const reductionPercent = (1 - ratio) * 100;
const warmToSubprocessP95Ratio = p95(warmSessionDurations) / p95(subprocessOperationDurations);

const result = {
  schemaVersion: 1,
  measuredAt: new Date().toISOString(),
  environment: {
    godotVersion: engineVersion,
    platform: platform(),
    cpu: cpus()[0]?.model ?? 'unknown',
    nodeVersion: process.version,
    renderingContext: process.env.WAYLAND_DISPLAY ? 'wayland' : process.env.DISPLAY ? 'display' : 'unknown',
  },
  methodology: {
    measuredIterationsPerMode: iterations,
    warmupIterationsPerMode: 1,
    order: 'Alternating mode order; every sample uses a fresh project.',
    timing: 'Monotonic wall clock around the same engine-backed operations; MCP transport overhead is excluded equally from both modes.',
    workload: [
      'create_scene', 'add_node Label', 'add_node Node2D', 'modify_node',
      'launch headed game', 'authenticated get_scene_tree observation', 'stop game',
      'modify_node after observation',
    ],
  },
  budgets: BUDGETS,
  samples,
  summary: {
    session: summarize(sessionTotals),
    subprocess: summarize(subprocessTotals),
    sessionStartupP95Ms: round(p95(sessionStartupDurations)),
    warmSessionCommandP95Ms: round(p95(warmSessionDurations)),
    subprocessOperationP95Ms: round(p95(subprocessOperationDurations)),
    warmToSubprocessOperationP95Ratio: round(warmToSubprocessP95Ratio, 3),
    warmCommandP95ReductionPercent: round((1 - warmToSubprocessP95Ratio) * 100, 1),
    sessionToSubprocessMedianRatio: round(ratio, 3),
    medianReductionPercent: round(reductionPercent, 1),
  },
  budgetResults: {
    sessionCycleMedian: sessionMedian <= BUDGETS.sessionCycleMedianMaxMs,
    relativeMedian: ratio <= BUDGETS.sessionToSubprocessMedianRatioMax,
    sessionStartupP95: p95(sessionStartupDurations) <= BUDGETS.sessionStartupP95MaxMs,
    warmSessionCommandP95: p95(warmSessionDurations) <= BUDGETS.warmSessionCommandP95MaxMs,
  },
};

const failedBudgets = Object.entries(result.budgetResults).filter(([, passed]) => !passed).map(([name]) => name);
if (failedBudgets.length > 0) {
  throw new Error(`Loop latency budget failed: ${failedBudgets.join(', ')}\n${JSON.stringify(result.summary, null, 2)}`);
}

writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(`wrote ${outputPath}`);
console.log(JSON.stringify(result.summary, null, 2));

async function runCycle(mode, executable) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), `godot-mcp-loop-${mode}-`));
  const projectPath = join(fixtureRoot, 'project');
  mkdirSync(projectPath);
  writeProject(projectPath);

  const installer = new InteractionServerInstaller({ sourceScriptPath: interactionScriptPath });
  const runner = new HeadlessOperationRunner({
    operationsScriptPath,
    resolveGodotPath: async () => executable,
  });
  const sessionProcess = new GodotProcessManager();
  const session = mode === 'session' ? new AuthoringSessionManager({
    operationsScriptPath,
    resolveGodotPath: async () => executable,
    installer,
    processManager: sessionProcess,
  }) : undefined;
  const operations = new HeadlessOperationService(runner, undefined, session);
  const processRecords = [];

  try {
    const cycleStarted = performance.now();
    const editDurations = [];
    for (const [operation, params] of preRunEdits()) {
      editDurations.push(await timedOperation(operations, operation, params, projectPath));
    }

    const transitionStarted = performance.now();
    if (session) await stopSession(session, sessionProcess, processRecords);
    const firstTransitionMs = performance.now() - transitionStarted;

    const runStarted = performance.now();
    await runAndObserve(executable, projectPath, installer, processRecords);
    const runObserveMs = performance.now() - runStarted;

    const postEditMs = await timedOperation(operations, 'modify_node', {
      scenePath: 'cycle.tscn', nodePath: 'Status', properties: { text: 'observed' },
    }, projectPath);

    const finalTransitionStarted = performance.now();
    if (session) await stopSession(session, sessionProcess, processRecords);
    const transitionMs = firstTransitionMs + performance.now() - finalTransitionStarted;
    const totalMs = performance.now() - cycleStarted;

    assertCleanProcesses(processRecords);
    return {
      totalMs: round(totalMs),
      preEditMs: round(editDurations.reduce((sum, value) => sum + value, 0)),
      runObserveMs: round(runObserveMs),
      postEditMs: round(postEditMs),
      transitionMs: round(transitionMs),
      startupEditMs: mode === 'session' ? [round(editDurations[0]), round(postEditMs)] : [],
      warmEditMs: mode === 'session' ? editDurations.slice(1).map(value => round(value)) : [],
      operationMs: editDurations.concat(postEditMs).map(value => round(value)),
    };
  } finally {
    if (session) await stopSession(session, sessionProcess, processRecords).catch(() => undefined);
    installer.reapStaleInstallation(projectPath);
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function preRunEdits() {
  return [
    ['create_scene', { scenePath: 'cycle.tscn', rootNodeType: 'Node2D' }],
    ['add_node', {
      scenePath: 'cycle.tscn', parentNodePath: 'root', nodeType: 'Label', nodeName: 'Status',
      properties: { text: 'draft', position: { x: 12, y: 18 } },
    }],
    ['add_node', {
      scenePath: 'cycle.tscn', parentNodePath: 'root', nodeType: 'Node2D', nodeName: 'Marker',
      properties: { position: { x: 32, y: 48 } },
    }],
    ['modify_node', {
      scenePath: 'cycle.tscn', nodePath: 'Status', properties: { text: 'ready' },
    }],
  ];
}

async function timedOperation(service, operation, params, projectPath) {
  const started = performance.now();
  const result = await service.execute(operation, params, projectPath);
  if (result.exitCode !== 0 || result.signal !== null) {
    throw new Error(`${operation} failed: ${result.stderr || result.stdout}`);
  }
  return performance.now() - started;
}

async function runAndObserve(executable, projectPath, installer, processRecords) {
  const port = await freePort();
  const secret = `loop-benchmark-${port}`;
  const owned = installer.install(projectPath);
  const manager = new GodotProcessManager();
  const connection = new GameConnection({
    port, initialDelayMs: 0, retryDelayMs: 50, maxAttempts: 200, authSecret: secret,
  });
  const record = manager.start({
    executable,
    args: [...deterministicSessionArguments(), '--path', projectPath],
    env: {
      ...deterministicSessionEnvironment(),
      GODOT_MCP_RUNTIME_PORT: String(port),
      GODOT_MCP_RUNTIME_SECRET: secret,
      XDG_DATA_HOME: join(projectPath, '.benchmark-user', 'data'),
      XDG_CONFIG_HOME: join(projectPath, '.benchmark-user', 'config'),
      XDG_CACHE_HOME: join(projectPath, '.benchmark-user', 'cache'),
    },
  });
  processRecords.push(record);
  try {
    await connection.connect(projectPath, () => manager.active);
    if (!connection.isConnected) throw new Error('Benchmark game never exposed its runtime endpoint');
    if (!connection.supportsCapability(RENDERING_CONTEXT_CAPABILITY)) {
      throw new Error('Benchmark game lacks the required rendering context');
    }
    const response = await connection.send('get_scene_tree');
    if ('error' in response || !JSON.stringify(response.result).includes('Status')) {
      throw new Error(`Benchmark observation failed: ${JSON.stringify(response)}`);
    }
  } finally {
    connection.disconnect();
    const stopped = manager.stop();
    if (stopped) await waitForExit(stopped);
    installer.remove(projectPath, owned);
  }
}

async function stopSession(session, manager, processRecords) {
  const record = manager.activeProcess;
  session.stop();
  if (record) {
    processRecords.push(record);
    await waitForExit(record);
  }
}

function waitForExit(record, timeoutMs = 10_000) {
  const child = record.process;
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Godot process ${child.pid ?? 'unknown'} did not exit`)), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function assertCleanProcesses(records) {
  const diagnostic = /^(?:ERROR|SCRIPT ERROR|WARNING):|Segmentation fault|leaked at exit/i;
  const offenders = records.flatMap(record => [...record.output, ...record.errors])
    .map(line => line.trim()).filter(line => diagnostic.test(line));
  if (offenders.length > 0) throw new Error(`Unexpected Godot diagnostics:\n${offenders.join('\n')}`);
}

function writeProject(projectPath) {
  writeFileSync(join(projectPath, 'project.godot'), [
    'config_version=5', '', '[application]', 'config/name="godot-mcp-loop-benchmark"',
    'run/main_scene="res://cycle.tscn"', 'config/features=PackedStringArray("4.4")', '',
    '[display]', 'window/size/viewport_width=320', 'window/size/viewport_height=180', '',
    '[rendering]', 'renderer/rendering_method="gl_compatibility"',
    'renderer/rendering_method.mobile="gl_compatibility"', '',
  ].join('\n'), 'utf8');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a benchmark port'));
        return;
      }
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

function resolveGodot() {
  const candidates = [];
  if (process.env.GODOT_BIN) candidates.push(process.env.GODOT_BIN);
  if (process.env.GODOT_PATH) {
    try {
      for (const file of readdirSync(process.env.GODOT_PATH)) {
        if (file.startsWith('godot')) candidates.push(join(process.env.GODOT_PATH, file));
      }
    } catch {
      candidates.push(process.env.GODOT_PATH);
    }
  }
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    candidates.push(join(directory, 'godot4'), join(directory, 'godot'));
  }
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error('No Godot binary found; set GODOT_BIN or GODOT_PATH');
}

function parseIterations(args) {
  const index = args.indexOf('--iterations');
  const value = index < 0 ? 7 : Number(args[index + 1]);
  if (!Number.isInteger(value) || value < 3) throw new Error('--iterations must be an integer >= 3');
  return value;
}

function summarize(values) {
  return { medianMs: round(median(values)), p95Ms: round(p95(values)), minMs: round(Math.min(...values)), maxMs: round(Math.max(...values)) };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function p95(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

function round(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
