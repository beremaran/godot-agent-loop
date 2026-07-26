#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(repoRoot, 'evals/protocol/conformance-scenarios.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const packageLock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'));
const installedConformance = packageLock.packages['node_modules/@modelcontextprotocol/conformance']?.version;
const installedInspector = packageLock.packages['node_modules/@modelcontextprotocol/inspector-cli']?.version;
const outputArgument = process.argv.indexOf('--output');
const outputPath = outputArgument >= 0
  ? resolve(process.argv[outputArgument + 1])
  : join(repoRoot, 'evals/reports/protocol/latest.json');

if (installedConformance !== manifest.package.version) {
  throw new Error(`Conformance manifest pins ${manifest.package.version}, installed ${installedConformance ?? 'none'}.`);
}

const conformanceEntry = join(repoRoot, 'node_modules/@modelcontextprotocol/conformance/dist/index.js');
const inspectorEntry = join(repoRoot, 'scripts/run-inspector-cli.mjs');
const launcher = spawn(process.execPath, [join(repoRoot, 'scripts/evaluation-http-server.mjs')], {
  cwd: repoRoot,
  env: {
    ...process.env,
    // GODOT_PATH is the product's executable variable. Developer shells often
    // use it as an installation directory alongside the more precise
    // GODOT_BIN; prefer the executable for this protocol-only launcher.
    ...(process.env.GODOT_BIN ? { GODOT_PATH: process.env.GODOT_BIN } : {}),
    GODOT_MCP_TOOL_SURFACE: 'core',
    GODOT_MCP_LEGACY_JSON_TEXT: 'false',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

function readiness(child) {
  return new Promise((resolvePromise, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(
      () => reject(new Error(`Evaluation HTTP launcher timed out.\n${stderr}`)),
      30_000,
    );
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      try {
        resolvePromise({ ...JSON.parse(stdout.slice(0, newline)), stderr: () => stderr });
      } catch (error) {
        reject(new Error(`Invalid launcher readiness record: ${stdout}`, { cause: error }));
      }
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Evaluation HTTP launcher exited before readiness: code=${code} signal=${signal}\n${stderr}`));
    });
  });
}

function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolvePromise => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolvePromise();
    }, 10_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolvePromise();
    });
    child.kill('SIGTERM');
  });
}

function command(commandPath, args, options = {}) {
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [commandPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, ...options.env },
  });
  return {
    args,
    status: result.status,
    signal: result.signal,
    elapsedMs: Date.now() - startedAt,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function summaryMarkdown(report) {
  const lines = [
    '# MCP protocol evaluation',
    '',
    `- Conformance: ${report.summary.conformancePassed}/${report.summary.conformanceTotal} applicable scenarios passed`,
    `- Inspector: ${report.inspector.status === 0 ? '3/3 checks passed' : 'failed'} (${report.inspector.toolCount ?? 0} tools)`,
    `- HTTP/stdin equivalence: enforced separately by \`tests/e2e/transport-equivalence.test.ts\``,
    '',
    '| Scenario | Status | Time |',
    '| --- | --- | ---: |',
  ];
  for (const scenario of report.conformance) {
    lines.push(`| \`${scenario.id}\` | ${scenario.status === 0 ? 'passed' : 'failed'} | ${scenario.elapsedMs} ms |`);
  }
  lines.push('', `${manifest.notApplicable.length} active-suite scenarios are explicitly non-applicable in \`evals/protocol/conformance-scenarios.json\`; none are reported as passes.`, '');
  return `${lines.join('\n')}\n`;
}

let ready;
try {
  ready = await readiness(launcher);
  const conformance = manifest.applicable.map(id => {
    const result = command(conformanceEntry, ['server', '--url', ready.url, '--scenario', id]);
    return {
      id,
      status: result.status,
      signal: result.signal,
      elapsedMs: result.elapsedMs,
      output: `${result.stdout}\n${result.stderr}`.trim().slice(-12_000),
    };
  });
  const inspectorEnvironment = {
    GODOT_MCP_TOOL_SURFACE: 'core',
    GODOT_MCP_ALLOWED_DIRS: repoRoot,
    GODOT_MCP_LEGACY_JSON_TEXT: 'false',
  };
  const inspectorListRun = command(inspectorEntry, [
    process.execPath,
    join(repoRoot, 'build', 'index.js'),
    '--method',
    'tools/list',
  ], { env: inspectorEnvironment });
  const inspectorValidCallRun = command(inspectorEntry, [
    process.execPath,
    join(repoRoot, 'build', 'index.js'),
    '--method',
    'tools/call',
    '--tool-name',
    'godot_catalog',
    '--tool-arg',
    'action=describe',
    '--tool-arg',
    'toolName=get_godot_version',
  ], { env: inspectorEnvironment });
  const inspectorInvalidCallRun = command(inspectorEntry, [
    process.execPath,
    join(repoRoot, 'build', 'index.js'),
    '--method',
    'tools/call',
    '--tool-name',
    'godot_catalog',
    '--tool-arg',
    'action=invalid',
  ], { env: inspectorEnvironment });
  const parseInspectorOutput = run => {
    try { return JSON.parse(run.stdout); } catch { return null; }
  };
  const inspectorList = parseInspectorOutput(inspectorListRun);
  const inspectorValidCall = parseInspectorOutput(inspectorValidCallRun);
  const inspectorInvalidCall = parseInspectorOutput(inspectorInvalidCallRun);
  const inspectorTools = inspectorList?.tools;
  const inspectorChecks = {
    toolsList: inspectorListRun.status === 0 && Array.isArray(inspectorTools),
    representativeValidCall: inspectorValidCallRun.status === 0
      && inspectorValidCall?.structuredContent?.ok === true
      && inspectorValidCall.structuredContent?.data?.name === 'get_godot_version',
    invalidCallStructuredError: inspectorInvalidCallRun.status === 0
      && inspectorInvalidCall?.isError === true
      && inspectorInvalidCall?.structuredContent?.ok === false
      && inspectorInvalidCall.structuredContent?.error?.code === 'invalid_arguments'
      && inspectorInvalidCall.structuredContent?.error?.category === 'argument'
      && inspectorInvalidCall.structuredContent?.error?.retryable === true,
  };
  const inspectorStatus = Object.values(inspectorChecks).every(Boolean) ? 0 : 1;
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    packages: {
      conformance: installedConformance,
      inspector: installedInspector,
    },
    transport: {
      kind: 'ephemeral-loopback-streamable-http',
      url: ready.url,
      productionTransport: 'stdio',
      equivalenceTest: 'tests/e2e/transport-equivalence.test.ts',
    },
    conformance,
    inspector: {
      transport: 'production-stdio',
      status: inspectorStatus,
      checks: inspectorChecks,
      elapsedMs: inspectorListRun.elapsedMs
        + inspectorValidCallRun.elapsedMs
        + inspectorInvalidCallRun.elapsedMs,
      toolCount: Array.isArray(inspectorTools) ? inspectorTools.length : null,
      toolListSha256: Array.isArray(inspectorTools) ? sha256(JSON.stringify(inspectorTools)) : null,
      representativeValidCall: inspectorValidCall?.structuredContent ?? null,
      representativeInvalidCall: inspectorInvalidCall?.structuredContent ?? null,
      output: inspectorStatus === 0 ? undefined : [
        inspectorListRun.stdout, inspectorListRun.stderr,
        inspectorValidCallRun.stdout, inspectorValidCallRun.stderr,
        inspectorInvalidCallRun.stdout, inspectorInvalidCallRun.stderr,
      ].join('\n').trim().slice(-12_000),
    },
    notApplicable: manifest.notApplicable,
    serverDiagnostics: ready.stderr().split(/\r?\n/).filter(Boolean).slice(-100),
    summary: {
      conformanceTotal: conformance.length,
      conformancePassed: conformance.filter(entry => entry.status === 0).length,
    },
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(outputPath.replace(/\.json$/, '.md'), summaryMarkdown(report), 'utf8');
  process.stdout.write(`${outputPath}\n`);
  if (report.summary.conformancePassed !== report.summary.conformanceTotal
    || report.inspector.status !== 0) process.exitCode = 1;
} finally {
  await stop(launcher);
}
