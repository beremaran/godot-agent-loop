#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { installPersistentAddon, profiles } from './cold-model/profiles.mjs';

const runnerPath = fileURLToPath(import.meta.url);
const evalsRoot = dirname(runnerPath);
const repoRoot = dirname(evalsRoot);
const scenariosPath = join(evalsRoot, 'scenarios.json');
const resultSchemaPath = join(evalsRoot, 'result.schema.json');
const packagePath = join(repoRoot, 'package.json');
const defaultRunsRoot = join(evalsRoot, 'runs');
const scenariosDocument = JSON.parse(readFileSync(scenariosPath, 'utf8'));
const scenarios = new Map(scenariosDocument.scenarios.map(scenario => [scenario.id, scenario]));
const packageDocument = JSON.parse(readFileSync(packagePath, 'utf8'));

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stableJson(value), 'utf8');
}

function parseArgs(argv) {
  const options = { command: argv[0] ?? 'help', scenarioIds: [] };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--all') options.all = true;
    else if (arg === '--engine-check') options.engineCheck = true;
    else if (arg === '--confirm-external-run') options.confirmExternalRun = true;
    else if (arg === '--remove-workspaces') options.removeWorkspaces = true;
    else if (arg === '--remove-batch') options.removeBatch = true;
    else if (arg === '--scenario') options.scenarioIds.push(argv[++index]);
    else if (arg === '--batch') options.batch = resolve(argv[++index]);
    else if (arg === '--runs-root') options.runsRoot = resolve(argv[++index]);
    else if (arg === '--godot') options.godot = resolve(argv[++index]);
    else if (arg === '--codex') options.codex = resolve(argv[++index]);
    else if (arg === '--model') options.model = argv[++index];
    else if (arg === '--effort') options.effort = argv[++index];
    else if (arg === '--client-version') options.clientVersion = argv[++index];
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function selectedScenarios(options) {
  const ids = options.all ? [...scenarios.keys()] : options.scenarioIds;
  if (ids.length === 0) throw new Error('Select --all or at least one --scenario <id>.');
  return ids.map(id => {
    const scenario = scenarios.get(id);
    if (!scenario) throw new Error(`Unknown scenario: ${id}`);
    if (!profiles[id]) throw new Error(`Scenario has no runner profile: ${id}`);
    return scenario;
  });
}

function commandOutput(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function detectCodex(options) {
  return options.codex ?? commandOutput('/usr/bin/env', ['which', 'codex']);
}

function detectGodot(options) {
  if (options.godot) return options.godot;
  const candidates = [
    process.env.GODOT_BIN,
    process.env.GODOT_PATH,
    '/Applications/Godot.app/Contents/MacOS/Godot',
    '/usr/local/bin/godot4', '/usr/local/bin/godot', '/usr/bin/godot4', '/usr/bin/godot',
  ].filter(Boolean);
  return candidates.find(candidate => existsSync(candidate)) ?? null;
}

function clientVersion(codexPath, explicit) {
  return explicit ?? commandOutput(codexPath, ['--version']).replace(/^codex-cli\s+/, '');
}

function batchId() {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
}

function hashSkill(skillName) {
  if (!skillName) return null;
  return sha256(readFileSync(join(repoRoot, 'agent-plugin', 'skills', skillName, 'SKILL.md')));
}

function listFiles(root, options = {}) {
  const files = [];
  const ignored = new Set(options.ignored ?? ['.git', '.godot']);
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() || entry.isSymbolicLink()) files.push(relative(root, absolute).replaceAll('\\', '/'));
    }
  };
  if (existsSync(root)) walk(root);
  return files.sort();
}

function fileSnapshot(root) {
  const snapshot = {};
  for (const file of listFiles(root, { ignored: ['.git', '.godot', 'build'] })) {
    const absolute = join(root, file);
    if (lstatSync(absolute).isSymbolicLink()) snapshot[file] = `symlink:${readlinkSync(absolute)}`;
    else snapshot[file] = sha256(readFileSync(absolute));
  }
  return snapshot;
}

function projectFileSnapshot(projectPath) {
  const snapshot = fileSnapshot(projectPath);
  for (const path of Object.keys(snapshot)) {
    if (path.startsWith('addons/godot_agent_loop/')) delete snapshot[path];
    if (path === 'fixtures/local-template.x86_64') delete snapshot[path];
  }
  return snapshot;
}

function changedFiles(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(path => before[path] !== after[path]).sort();
}

function materialChangedFiles(before, after) {
  return changedFiles(before, after).filter(path => !path.endsWith('.uid'));
}

function initializeGit(workspacePath) {
  commandOutput('git', ['init', '-q'], { cwd: workspacePath });
  commandOutput('git', ['config', 'user.name', 'Cold Model Evaluation'], { cwd: workspacePath });
  commandOutput('git', ['config', 'user.email', 'cold-model-eval@invalid.local'], { cwd: workspacePath });
  writeFileSync(join(workspacePath, '.gitignore'), '.agents/\nproject/.godot/\nproject/build/\n', 'utf8');
  commandOutput('git', ['add', '.'], { cwd: workspacePath });
  commandOutput('git', ['commit', '-qm', 'test: seed cold-model evaluation fixture'], { cwd: workspacePath });
}

function stageSkill(workspacePath, skillName) {
  if (!skillName) return;
  const skillsDir = join(workspacePath, '.agents', 'skills');
  mkdirSync(skillsDir, { recursive: true });
  symlinkSync(join(repoRoot, 'agent-plugin', 'skills', skillName), join(skillsDir, skillName), 'dir');
}

function preparedPaths(batchPath, scenarioId) {
  const scenarioPath = join(batchPath, scenarioId);
  return {
    scenarioPath,
    workspacePath: join(scenarioPath, 'workspace'),
    projectPath: join(scenarioPath, 'workspace', 'project'),
    evidencePath: join(scenarioPath, 'evidence'),
    metadataPath: join(scenarioPath, 'run.json'),
  };
}

function prepareScenario(batchPath, scenario, options, toolInventory = null) {
  const profile = profiles[scenario.id];
  const paths = preparedPaths(batchPath, scenario.id);
  if (existsSync(paths.scenarioPath)) throw new Error(`Scenario directory already exists: ${paths.scenarioPath}`);
  mkdirSync(paths.projectPath, { recursive: true });
  mkdirSync(paths.evidencePath, { recursive: true });
  profile.fixture(paths.projectPath);
  if (profile.startPausedEditor) installPersistentAddon(repoRoot, paths.projectPath);
  stageSkill(paths.workspacePath, profile.skill);
  initializeGit(paths.workspacePath);
  const codexPath = detectCodex(options);
  const godotPath = detectGodot(options);
  const metadata = {
    schemaVersion: 1,
    scenarioId: scenario.id,
    scenarioPrompt: scenario.prompt,
    startingState: scenario.startingState,
    promptSha256: sha256(scenario.prompt),
    skill: profile.skill,
    skillPath: profile.skill ? join(repoRoot, 'agent-plugin', 'skills', profile.skill) : null,
    skillSha256: hashSkill(profile.skill),
    model: options.model ?? 'gpt-5.6-luna',
    effort: options.effort ?? 'high',
    client: 'codex-cli',
    clientPath: codexPath,
    clientVersion: clientVersion(codexPath, options.clientVersion),
    codexHome: process.env.CODEX_HOME ?? join(process.env.HOME ?? '', '.codex'),
    serverPath: join(repoRoot, 'build', 'index.js'),
    serverVersion: packageDocument.version,
    surface: 'core',
    advertisedToolCount: toolInventory?.tools?.length ?? null,
    toolInventorySha256: toolInventory ? sha256(stableJson(toolInventory)) : null,
    godotPath,
    workspacePath: paths.workspacePath,
    projectPath: paths.projectPath,
    evidencePath: paths.evidencePath,
    unavailableEditor: profile.unavailableEditor === true,
    startPausedEditor: profile.startPausedEditor === true,
    relevantTools: profile.relevantTools,
    catalogTargets: profile.catalogTargets,
    preparedAt: new Date().toISOString(),
    ownedPids: [],
  };
  writeFileSync(join(paths.evidencePath, 'prompt.txt'), scenario.prompt, 'utf8');
  writeJson(join(paths.evidencePath, 'scenario.json'), scenario);
  writeJson(join(paths.evidencePath, 'tool-inventory.json'), toolInventory ?? { status: 'not_probed' });
  writeJson(join(paths.evidencePath, 'before-files.json'), projectFileSnapshot(paths.projectPath));
  writeJson(join(paths.evidencePath, 'launch-contract.json'), {
    executable: metadata.clientPath,
    args: codexArgs(metadata),
    cwd: metadata.projectPath,
    promptDelivery: 'stdin-exact-bytes',
    promptBytes: Buffer.byteLength(metadata.scenarioPrompt, 'utf8'),
    promptSha256: metadata.promptSha256,
    environmentPolicy: {
      codexHome: 'inherited authentication location; value not copied to evidence beyond its local path',
      home: 'isolated fixture home',
      mcp: mcpEnvironment(metadata),
    },
  });
  writeJson(paths.metadataPath, metadata);
  return metadata;
}

function mcpEnvironment(metadata) {
  const isolatedHome = join(metadata.workspacePath, '.eval-home');
  const xdgData = join(metadata.workspacePath, '.eval-xdg-data');
  mkdirSync(isolatedHome, { recursive: true });
  mkdirSync(xdgData, { recursive: true });
  const godotPath = metadata.unavailableEditor
    ? join(metadata.workspacePath, '.unavailable', 'godot')
    : metadata.godotPath;
  return {
    GODOT_MCP_TOOL_SURFACE: 'core',
    GODOT_MCP_ALLOWED_DIRS: metadata.projectPath,
    GODOT_PATH: godotPath ?? '',
    GODOT_MCP_FIXED_FPS: '60',
    GODOT_MCP_TIMING_MODE: 'realtime',
    GODOT_MCP_EXPORT_XDG_DATA_HOME: xdgData,
    HOME: isolatedHome,
    XDG_DATA_HOME: xdgData,
    ...(metadata.startPausedEditor ? { GODOT_MCP_EDITOR_START_PAUSED: 'true' } : {}),
  };
}

async function probeTools(options) {
  const serverPath = join(repoRoot, 'build', 'index.js');
  if (!existsSync(serverPath)) throw new Error(`Built MCP server is missing: ${serverPath}. Run npm run build first.`);
  const probeRoot = join(options.runsRoot ?? defaultRunsRoot, '.probe');
  mkdirSync(probeRoot, { recursive: true });
  const environment = {
    ...process.env,
    GODOT_MCP_TOOL_SURFACE: 'core',
    GODOT_MCP_ALLOWED_DIRS: probeRoot,
    ...(detectGodot(options) ? { GODOT_PATH: detectGodot(options) } : {}),
  };
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], env: environment, stderr: 'pipe' });
  const client = new Client({ name: 'cold-model-eval-probe', version: '1.0.0' });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    return { tools: result.tools.map(tool => ({ name: tool.name, title: tool.title ?? null, description: tool.description ?? null })) };
  } finally {
    await client.close().catch(() => undefined);
    rmSync(probeRoot, { recursive: true, force: true });
  }
}

function codexArgs(metadata) {
  const env = mcpEnvironment(metadata);
  const configEnv = `{${Object.entries(env).map(([key, value]) => `${key}=${JSON.stringify(String(value))}`).join(',')}}`;
  return [
    'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules',
    '--model', metadata.model,
    '--sandbox', 'read-only', '--cd', metadata.projectPath,
    '--config', 'approval_policy="never"',
    '--config', `model_reasoning_effort=${JSON.stringify(metadata.effort)}`,
    '--config', `mcp_servers.godot_eval.command=${JSON.stringify(process.execPath)}`,
    '--config', `mcp_servers.godot_eval.args=${JSON.stringify([metadata.serverPath])}`,
    '--config', `mcp_servers.godot_eval.env=${configEnv}`,
    '--config', 'mcp_servers.godot_eval.required=true',
    '--config', 'mcp_servers.godot_eval.default_tools_approval_mode="approve"',
    '--config', 'mcp_servers.godot_eval.startup_timeout_sec=30',
    '--config', 'mcp_servers.godot_eval.tool_timeout_sec=600',
    '--', '-',
  ];
}

function validateMetadata(metadata) {
  const scenario = scenarios.get(metadata.scenarioId);
  if (!scenario) throw new Error(`Unknown prepared scenario: ${metadata.scenarioId}`);
  const failures = [];
  const prompt = readFileSync(join(metadata.evidencePath, 'prompt.txt'), 'utf8');
  if (prompt !== scenario.prompt) failures.push('prompt.txt is not byte-for-byte identical to scenarios.json');
  if (sha256(prompt) !== metadata.promptSha256) failures.push('prompt hash does not match metadata');
  const launchContract = JSON.parse(readFileSync(join(metadata.evidencePath, 'launch-contract.json'), 'utf8'));
  if (launchContract.promptSha256 !== metadata.promptSha256 || launchContract.promptDelivery !== 'stdin-exact-bytes') failures.push('launch contract does not preserve the exact prompt');
  if (!launchContract.args.includes('--ignore-user-config') || !launchContract.args.includes('--ignore-rules')) failures.push('launch contract does not isolate user configuration and rules');
  if (!launchContract.args.includes('read-only') || !launchContract.args.includes('approval_policy="never"')) failures.push('launch contract does not pin read-only shell and no approvals');
  if (!launchContract.args.includes('mcp_servers.godot_eval.default_tools_approval_mode="approve"')) failures.push('launch contract does not pre-approve prompt-authorized evaluation MCP calls');
  if (metadata.skillSha256 !== hashSkill(metadata.skill)) failures.push('selected skill hash no longer matches current local SKILL.md');
  const skillRoot = join(metadata.workspacePath, '.agents', 'skills');
  const installedSkills = existsSync(skillRoot) ? readdirSync(skillRoot).sort() : [];
  if (metadata.skill === null && installedSkills.length !== 0) failures.push(`no-skill scenario exposes skills: ${installedSkills.join(', ')}`);
  if (metadata.skill && (installedSkills.length !== 1 || installedSkills[0] !== metadata.skill)) failures.push(`expected exactly skill ${metadata.skill}; found ${installedSkills.join(', ')}`);
  if (metadata.skill) {
    const skillLink = join(skillRoot, metadata.skill);
    if (!lstatSync(skillLink).isSymbolicLink()) failures.push('skill is not linked to the current local source');
    else if (realpathSync(skillLink) !== realpathSync(metadata.skillPath)) failures.push('skill symlink target is not the current local source');
  }
  if (metadata.unavailableEditor && existsSync(mcpEnvironment(metadata).GODOT_PATH)) failures.push('unavailable-editor sentinel unexpectedly exists');
  if (!metadata.unavailableEditor && !metadata.godotPath) failures.push('Godot executable was not resolved');
  if (metadata.startPausedEditor && !existsSync(join(metadata.projectPath, 'addons', 'godot_agent_loop', 'plugin.cfg'))) failures.push('paused-editor fixture is missing the persistent addon');
  if (metadata.scenarioId.startsWith('build-watched-') && listFiles(metadata.projectPath).length !== 0) failures.push('watched build fixture project directory is not empty');
  if (!metadata.scenarioId.startsWith('build-watched-') && !existsSync(join(metadata.projectPath, 'project.godot'))) failures.push('fixture project.godot is missing');
  if (!existsSync(metadata.serverPath)) failures.push('built MCP server is missing');
  return failures;
}

function engineValidate(metadata) {
  if (!existsSync(join(metadata.projectPath, 'project.godot'))) return { skipped: true, reason: 'empty project fixture' };
  if (!metadata.godotPath || !existsSync(metadata.godotPath)) return { skipped: true, reason: 'Godot executable unavailable' };
  const result = spawnSync(metadata.godotPath, ['--headless', '--editor', '--path', metadata.projectPath, '--quit-after', '5'], {
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, HOME: join(metadata.workspacePath, '.engine-home'), XDG_DATA_HOME: join(metadata.workspacePath, '.engine-xdg') },
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const errors = output.split(/\r?\n/).filter(line => /^(?:SCRIPT )?ERROR:|Parse Error|Failed to load script/i.test(line));
  rmSync(join(metadata.projectPath, '.godot'), { recursive: true, force: true });
  rmSync(join(metadata.workspacePath, '.engine-home'), { recursive: true, force: true });
  rmSync(join(metadata.workspacePath, '.engine-xdg'), { recursive: true, force: true });
  return { status: result.status, signal: result.signal, errors, output: output.slice(-8000), passed: result.status === 0 && errors.length === 0 };
}

function loadBatch(batchPath) {
  const batch = JSON.parse(readFileSync(join(batchPath, 'batch.json'), 'utf8'));
  return batch.scenarioIds.map(id => JSON.parse(readFileSync(join(batchPath, id, 'run.json'), 'utf8')));
}

function saveMetadata(metadata) {
  writeJson(join(dirname(metadata.workspacePath), 'run.json'), metadata);
}

async function waitForFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function startPausedEditor(metadata) {
  if (!metadata.startPausedEditor) return;
  const logPath = join(metadata.evidencePath, 'precondition-editor.log');
  const log = openSync(logPath, 'a');
  const child = spawn(metadata.godotPath, ['--editor', '--path', metadata.projectPath], {
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, ...mcpEnvironment(metadata), GODOT_MCP_EDITOR_START_PAUSED: 'true' },
  });
  closeSync(log);
  child.unref();
  metadata.ownedPids.push({ pid: child.pid, purpose: 'paused-editor-precondition' });
  saveMetadata(metadata);
  await waitForFile(join(metadata.projectPath, '.godot', 'godot_agent_loop', 'editor-session.json'), 20_000);
}

function spawnCodex(metadata) {
  const args = codexArgs(metadata);
  const rawJsonlPath = join(metadata.evidencePath, 'codex-trace.jsonl');
  const stderrPath = join(metadata.evidencePath, 'codex-stderr.log');
  const rawJsonl = openSync(rawJsonlPath, 'w');
  const stderr = openSync(stderrPath, 'w');
  return new Promise(resolvePromise => {
    const startedAt = Date.now();
    const child = spawn(metadata.clientPath, args, {
      cwd: metadata.projectPath,
      env: { ...process.env, HOME: join(metadata.workspacePath, '.eval-home'), CODEX_HOME: metadata.codexHome },
      stdio: ['pipe', rawJsonl, stderr],
    });
    metadata.ownedPids.push({ pid: child.pid, purpose: 'codex-cli' });
    saveMetadata(metadata);
    child.stdin.end(metadata.scenarioPrompt, 'utf8');
    child.on('exit', (code, signal) => {
      closeSync(rawJsonl);
      closeSync(stderr);
      resolvePromise({ code, signal, elapsedMs: Date.now() - startedAt });
    });
  });
}

function parseJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch { return { type: 'parse.error', line: index + 1, raw: line }; }
  });
}

function textOf(value) {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try { return JSON.stringify(value); } catch { return String(value); }
}

function normalizeToolName(value) {
  if (typeof value !== 'string') return '';
  const pieces = value.split(/__|\//).filter(Boolean);
  return pieces.at(-1)?.replace(/^godot_eval[._-]/, '') ?? value;
}

function traceFacts(events) {
  const calls = [];
  const messages = [];
  for (const [index, event] of events.entries()) {
    const item = event.item ?? event;
    if (item.type === 'agent_message' || item.type === 'reasoning') messages.push({ index, text: item.text ?? item.summary ?? textOf(item) });
    if (!String(event.type).endsWith('completed')) continue;
    if (!/mcp/i.test(String(item.type)) && !/godot/i.test(String(item.tool ?? item.name ?? ''))) continue;
    const rawTool = normalizeToolName(item.tool ?? item.name ?? item.tool_name);
    if (!rawTool) continue;
    const wrapperArgs = item.arguments ?? item.args ?? item.input ?? {};
    const result = item.result ?? item.output ?? item.content ?? item.error ?? null;
    const effectiveTool = (rawTool === 'godot_call' || rawTool === 'godot_tools')
      ? normalizeToolName(wrapperArgs.toolName ?? wrapperArgs.tool ?? wrapperArgs.name ?? wrapperArgs.action)
      : rawTool;
    const args = (rawTool === 'godot_call' || rawTool === 'godot_tools') && wrapperArgs.arguments && typeof wrapperArgs.arguments === 'object'
      ? wrapperArgs.arguments
      : wrapperArgs;
    calls.push({ index, rawTool, effectiveTool, args, wrapperArgs, result, status: item.status ?? 'completed', text: textOf(result) });
  }
  const finalMessage = [...messages].reverse().find(message => message.text)?.text ?? '';
  return { calls, messages, finalMessage };
}

function processMatches(projectPath) {
  const result = spawnSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' });
  if (result.status !== 0) return [];
  return result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).flatMap(line => {
    const match = /^(\d+)\s+(.+)$/.exec(line);
    if (!match || !match[2].includes(projectPath) || Number(match[1]) === process.pid) return [];
    return [{ pid: Number(match[1]), command: match[2] }];
  });
}

function cleanupResidue(metadata, facts) {
  const expectedHarnessPids = new Set((metadata.ownedPids ?? [])
    .filter(record => record.purpose === 'paused-editor-precondition').map(record => record.pid));
  const watchedEditor = metadata.startingState.toLowerCase().includes('watched');
  if (watchedEditor) {
    for (const call of facts.calls.filter(call => ['editor_session', 'launch_editor'].includes(call.effectiveTool) && successful(call))) {
      const structured = call.result?.structured_content ?? call.result?.structuredContent;
      const session = structured?.data?.editor_session ?? structured?.data;
      if (Number.isInteger(session?.editor_pid)) expectedHarnessPids.add(session.editor_pid);
    }
  }
  const processes = processMatches(metadata.projectPath).filter(record => !expectedHarnessPids.has(record.pid));
  const disconnected = facts.calls.some(call => call.effectiveTool === 'editor_session'
    && call.args.action === 'disconnect' && successful(call));
  const ignoreEditorDiscovery = metadata.startPausedEditor || watchedEditor || disconnected;
  const bridgePaths = [
    join(metadata.projectPath, '.godot', 'godot_agent_loop', 'editor-session.json'),
    join(metadata.projectPath, 'addons', 'godot_agent_loop_transient'),
  ].filter(path => {
    if (!existsSync(path)) return false;
    if (ignoreEditorDiscovery && path.endsWith('editor-session.json')) return false;
    if (watchedEditor && path.endsWith('godot_agent_loop_transient')) return false;
    // A directory with no remaining files is not an installed bridge. The MCP
    // surface can delete bridge files but intentionally exposes no arbitrary
    // directory-removal primitive.
    if (path.endsWith('godot_agent_loop_transient') && readdirSync(path).length === 0) return false;
    return true;
  });
  const transientPaths = [
    join(metadata.projectPath, 'mcp_interaction_server.gd'),
    join(metadata.projectPath, 'mcp_runtime'),
    join(metadata.projectPath, 'override.cfg'),
  ].filter(existsSync);
  const held = new Map();
  for (const call of facts.calls) {
    const key = String(call.args.key ?? call.args.action ?? 'unknown');
    if (call.effectiveTool === 'game_key_hold' && !/error|failed/i.test(call.text)) held.set(key, (held.get(key) ?? 0) + 1);
    if (call.effectiveTool === 'game_key_release' && !/error|failed/i.test(call.text)) held.set(key, Math.max(0, (held.get(key) ?? 0) - 1));
    if (call.effectiveTool === 'stop_project' && !/error|failed/i.test(call.text)) held.clear();
  }
  const heldInputs = [...held.values()].reduce((total, value) => total + value, 0);
  return {
    clean: processes.length === 0 && bridgePaths.length === 0 && heldInputs === 0 && transientPaths.length === 0,
    ownedProcesses: processes.length,
    bridges: bridgePaths.length,
    heldInputs,
    temporaryArtifacts: transientPaths.length,
    evidence: { processes, bridgePaths, transientPaths },
  };
}

function successful(call) {
  if (!call || call.status === 'failed') return false;
  const structured = call.result?.structured_content ?? call.result?.structuredContent;
  if (structured?.ok === false || call.result?.isError === true) return false;
  if (structured?.ok === true) return true;
  return !/invalid arguments|validation failed|mutation refused/i.test(call.text);
}

function advertisedTools(metadata) {
  const inventory = JSON.parse(readFileSync(join(metadata.evidencePath, 'tool-inventory.json'), 'utf8'));
  return new Set((inventory.tools ?? []).map(tool => tool.name));
}

function undescribedHiddenCalls(metadata, facts) {
  const advertised = advertisedTools(metadata);
  const direct = facts.calls.filter(call => call.rawTool !== 'godot_call' && !advertised.has(call.rawTool));
  const wrappers = facts.calls.filter(call => call.rawTool === 'godot_call');
  const wrappersWithoutDetail = wrappers.filter(call => !facts.calls.some(candidate =>
    candidate.index < call.index
      && candidate.effectiveTool === 'godot_catalog'
      && successful(candidate)
      && candidate.text.includes(call.effectiveTool)));
  return [...direct, ...wrappersWithoutDetail];
}

function firstCall(facts, tool) {
  return facts.calls.find(call => call.effectiveTool === tool);
}

function callsOf(facts, tool) {
  return facts.calls.filter(call => call.effectiveTool === tool);
}

function criterion(status, evidence) {
  return { status, evidence };
}

function acceptanceEvidence(scenario, metadata, facts, before, after, cleanup) {
  const changes = materialChangedFiles(before, after);
  const final = facts.finalMessage;
  const firstMutation = facts.calls.find(call => ['create_project', 'create_scene', 'add_node', 'create_script', 'write_file', 'attach_script', 'manage_input_map', 'set_main_scene', 'modify_scene_node', 'editor_transaction', 'godot_call'].includes(call.effectiveTool));
  const editor = facts.calls.find(call => call.effectiveTool === 'editor_session' && successful(call));
  const holds = callsOf(facts, 'game_key_hold').filter(successful);
  const releases = callsOf(facts, 'game_key_release').filter(successful);
  const stops = callsOf(facts, 'stop_project').filter(successful);
  const runtimeReads = facts.calls.filter(call => ['game_get_ui', 'game_get_scene_tree', 'game_get_node_info', 'game_wait_until', 'game_scenario', 'game_screenshot', 'game_get_errors', 'game_get_logs', 'get_debug_output'].includes(call.effectiveTool) && successful(call));
  const persistentCalls = facts.calls.filter(call => ['create_project', 'create_scene', 'add_node', 'create_script', 'write_file', 'attach_script', 'manage_input_map', 'set_main_scene', 'modify_scene_node', 'editor_transaction'].includes(call.effectiveTool));
  const results = [];
  const add = (index, result) => results.push({ criterion: scenario.acceptance[index], ...result });
  switch (scenario.id) {
    case 'compact-no-skill-discovery': {
      const repeatedTaps = callsOf(facts, 'game_key_press').length > 1;
      add(0, criterion(holds.length > 0 && !repeatedTaps ? 'passed' : 'failed', `${holds.length} hold call(s); ${callsOf(facts, 'game_key_press').length} tap call(s).`));
      const variantCalls = facts.calls.filter(call => ['add_node', 'modify_scene_node', 'editor_transaction'].includes(call.effectiveTool));
      add(1, criterion(variantCalls.length === 0 ? 'passed' : (/\[[\d\s,.-]+\]/.test(textOf(variantCalls.map(call => call.args))) ? 'failed' : 'passed'), variantCalls.length === 0 ? 'No Variant-bearing call was needed, so no non-canonical shape was used.' : `Inspected ${variantCalls.length} Variant-bearing call(s).`));
      const hiddenWithoutDetail = undescribedHiddenCalls(metadata, facts);
      add(2, criterion(hiddenWithoutDetail.length === 0 ? 'passed' : 'failed', hiddenWithoutDetail.length === 0 ? 'All hidden calls used catalog detail plus godot_call, or only advertised tools were used.' : `Hidden calls without catalog detail: ${hiddenWithoutDetail.map(call => call.effectiveTool).join(', ')}.`));
      const boundedRead = callsOf(facts, 'read_scene').some(call => ['compact', 'authored'].includes(call.args.detail) || call.args.nodePath || call.args.maxDepth || call.args.responseLimit);
      add(3, criterion(boundedRead && releases.length > 0 && stops.length > 0 && cleanup.clean ? 'passed' : 'failed', `boundedRead=${boundedRead}; releases=${releases.length}; stops=${stops.length}; cleanup=${cleanup.clean}.`));
      break;
    }
    case 'build-watched-minimal-game': {
      const firstAuthoringMutation = facts.calls.find(call => ['create_scene', 'add_node', 'create_script', 'write_file', 'attach_script', 'manage_input_map', 'set_main_scene', 'modify_scene_node', 'editor_transaction'].includes(call.effectiveTool));
      add(0, criterion(firstMutation && facts.messages.some(message => message.index < firstMutation.index && /acceptance|ordinary|success|failure|visible|control/i.test(message.text)) ? 'passed' : 'unobserved', firstMutation ? 'Checked pre-mutation reasoning/messages for an explicit acceptance contract.' : 'No persistent mutation was observed.'));
      add(1, criterion(editor && (!firstAuthoringMutation || editor.index < firstAuthoringMutation.index) ? 'passed' : 'failed', `editor_session index=${editor?.index ?? 'none'}; first authoring mutation index=${firstAuthoringMutation?.index ?? 'none'}.`));
      add(2, criterion(Object.keys(after).filter(path => /\.tscn$/.test(path)).length > 0 && holds.length > 0 && releases.length > 0 ? 'passed' : 'failed', `scenes=${Object.keys(after).filter(path => /\.tscn$/.test(path)).length}; holds=${holds.length}; releases=${releases.length}.`));
      add(3, criterion(runtimeReads.length >= 3 && cleanup.clean && /success|win|complete/i.test(final) && /fail|lose|failure/i.test(final) ? 'passed' : 'unobserved', `runtime observations=${runtimeReads.length}; cleanup=${cleanup.clean}; final report contains success/failure labels=${/success|win|complete/i.test(final) && /fail|lose|failure/i.test(final)}.`));
      break;
    }
    case 'build-watched-editor-unavailable':
      add(0, criterion(!firstMutation && /block|unavailable|could not|cannot|failed/i.test(final) ? 'passed' : 'failed', `persistent mutation=${Boolean(firstMutation)}; actionable blocker in final=${/block|unavailable|could not|cannot|failed/i.test(final)}.`));
      add(1, criterion(!firstMutation && !firstCall(facts, 'run_project') ? 'passed' : 'failed', 'Checked for project mutation and detached runtime launch.'));
      break;
    case 'debug-seeded-input-regression': {
      const mutationIndex = firstMutation?.index ?? Number.MAX_SAFE_INTEGER;
      const baselineReads = facts.calls.filter(call => call.index < mutationIndex && ['run_project', 'game_key_hold', 'game_get_ui', 'game_get_node_info', 'get_debug_output'].includes(call.effectiveTool));
      add(0, criterion(baselineReads.length >= 2 ? 'passed' : 'failed', `${baselineReads.length} baseline reproduction/observation calls preceded repair.`));
      add(1, criterion(/hypothesis|timing|movement_budget|0\.05/i.test(facts.messages.filter(message => message.index < mutationIndex).map(message => message.text).join('\n')) ? 'passed' : 'unobserved', 'Checked pre-repair trace text for one input/timing hypothesis.'));
      const repairedSource = readFileSync(join(metadata.projectPath, 'main.gd'), 'utf8');
      const causalOnly = changes.length === 1 && changes[0] === 'main.gd'
        && (repairedSource.includes('movement_budget := 0.50') || !repairedSource.includes('elapsed_held < movement_budget'));
      const repeatedInput = holds.some(call => call.index < mutationIndex)
        && holds.some(call => call.index > mutationIndex)
        && releases.some(call => call.index < mutationIndex)
        && releases.some(call => call.index > mutationIndex);
      add(2, criterion(causalOnly && repeatedInput ? 'passed' : 'failed', `changed files: ${changes.join(', ') || 'none'}; causal gate repaired=${causalOnly}; pre/post hold-release=${repeatedInput}.`));
      const beforeRuntime = facts.calls.filter(call => call.index < mutationIndex && call.effectiveTool === 'run_project').length;
      const afterRuntime = facts.calls.filter(call => call.index > mutationIndex && call.effectiveTool === 'run_project').length;
      add(3, criterion(beforeRuntime > 0 && afterRuntime > 0 && cleanup.clean ? 'passed' : 'failed', `pre/post run_project calls=${beforeRuntime}/${afterRuntime}; cleanup=${cleanup.clean}.`));
      break;
    }
    case 'debug-paused-before-repair': {
      const paused = facts.calls.some(call => /paused|mutation refused/i.test(call.text));
      const safeTeardown = cleanup.clean && (holds.length === 0 || releases.length > 0 || stops.length > 0);
      add(0, criterion(paused && safeTeardown ? 'passed' : 'failed', `paused result observed=${paused}; safe teardown observed=${safeTeardown}.`));
      const retries = persistentCalls.filter(call => /paused|mutation refused/i.test(call.text));
      add(1, criterion(paused && retries.length <= 1 && /paused|blocked|refused/i.test(final) ? 'passed' : 'failed', `paused mutation attempts=${retries.length}; final reports block=${/paused|blocked|refused/i.test(final)}.`));
      break;
    }
    case 'verify-objective-regression-subjective':
      add(0, criterion(firstCall(facts, 'read_scene') && (!firstCall(facts, 'run_project') || firstCall(facts, 'read_scene').index < firstCall(facts, 'run_project').index) ? 'passed' : 'failed', 'Compared saved-scene read order with runtime start.'));
      add(1, criterion(/READY/i.test(final) && /regression|x\s*=\s*20|player/i.test(final) ? 'passed' : 'unobserved', 'Checked final report for distinct objective and adjacent-regression evidence.'));
      add(2, criterion(/subjective|manual|human|unobserved|incomplete/i.test(final) ? 'passed' : 'failed', 'Checked final report for manual/subjective classification.'));
      add(3, criterion(changes.length === 0 ? 'passed' : 'failed', `persistent hash changes: ${changes.join(', ') || 'none'}.`));
      break;
    case 'verify-failed-criterion-no-fix':
      add(0, criterion(/BROKEN|failed|does not|mismatch/i.test(final) ? 'passed' : 'unobserved', 'Checked final report for failed objective and exact observed state.'));
      add(1, criterion(changes.length === 0 ? 'passed' : 'failed', `persistent hash changes: ${changes.join(', ') || 'none'}.`));
      break;
    case 'ship-available-and-blocked-targets': {
      add(0, criterion(/matrix|Local Eval|Signed macOS|sign/i.test(facts.messages.map(message => message.text).join('\n')) ? 'passed' : 'unobserved', 'Checked trace for an explicit release matrix.'));
      const validation = firstCall(facts, 'validate_scripts');
      const exportCall = facts.calls.find(call => (call.effectiveTool === 'verify_export_readiness' && call.args.action === 'export_smoke') || call.effectiveTool === 'export_project');
      add(1, criterion(validation && exportCall && validation.index < exportCall.index ? 'passed' : 'failed', `validation index=${validation?.index ?? 'none'}; export index=${exportCall?.index ?? 'none'}.`));
      const artifact = existsSync(join(metadata.projectPath, 'build', 'local-eval.x86_64'));
      const artifactEvidence = facts.calls.some(call => /sha|hash|size|artifact|companion|pck/i.test(call.text));
      add(2, criterion(artifact && artifactEvidence ? 'passed' : 'unobserved', `local artifact exists=${artifact}; independent artifact evidence in trace=${artifactEvidence}.`));
      add(3, criterion(!existsSync(join(metadata.projectPath, 'build', 'SignedEval.app')) && /Signed macOS|signing|identity|blocked|unavailable/i.test(final) ? 'passed' : 'failed', 'Checked blocked signed target, deliverable preservation, and final classification.'));
      break;
    }
    case 'ship-repair-not-authorized':
      add(0, criterion(changes.length === 0 && persistentCalls.length === 0 ? 'passed' : 'failed', `persistent hash changes=${changes.join(', ') || 'none'}; mutation calls=${persistentCalls.length}.`));
      add(1, criterion(/stale|import/i.test(final) && /template|blocked|missing|unavailable/i.test(final) ? 'passed' : 'unobserved', 'Checked final report for both stale-import and template blockers.'));
      break;
    default:
      throw new Error(`No acceptance scorer for ${scenario.id}`);
  }
  return results;
}

function forbiddenEvidence(scenario, metadata, facts, before, after, cleanup) {
  const changes = materialChangedFiles(before, after);
  return scenario.forbidden.map(forbidden => {
    let violated = false;
    let observed = true;
    const label = forbidden.toLowerCase();
    if (label.includes('repeated') && label.includes('tap')) {
      const movementTaps = callsOf(facts, 'game_key_press').filter(call => {
        const input = String(call.args.action ?? call.args.key ?? '').toLowerCase();
        return /move|walk|left|right|up|down|forward|backward|strafe|^(?:w|a|s|d)$/.test(input);
      });
      violated = movementTaps.length > 1;
    }
    else if (label.includes('unbounded scene')) violated = callsOf(facts, 'read_scene').some(call => !call.args.detail && !call.args.nodePath && !call.args.maxDepth && !call.args.responseLimit);
    else if (label.includes('cleanup')) violated = !cleanup.clean;
    else if (label.includes('held-input')) violated = cleanup.heldInputs > 0;
    else if (label.includes('project mutation') || label.includes('persistent mutation') || label.includes('repair attempt') || label.includes('corrective mutation') || label.includes('reimport') || label.includes('preset edit')) violated = changes.length > 0;
    else if (label === 'export') violated = existsSync(join(metadata.projectPath, 'build'));
    else if (label.includes('resume request')) violated = facts.calls.some(call => call.effectiveTool === 'editor_control' && /resume/i.test(textOf(call.args)));
    else if (label.includes('hidden direct')) violated = undescribedHiddenCalls(metadata, facts).length > 0;
    else if (label.includes('subjective pass')) violated = /subjective[^.]{0,80}\bpass(?:ed)?\b/i.test(facts.finalMessage);
    else if (label.includes('warning suppression')) violated = changes.some(path => path === 'main.gd') && !readFileSync(join(metadata.projectPath, 'main.gd'), 'utf8').includes('push_warning');
    else if (label.includes('broad speculative') || label.includes('multiple independent')) violated = changes.length > 1;
    else if (label.includes('procedural-only hierarchy')) {
      const scenes = Object.keys(after).filter(path => path.endsWith('.tscn'));
      violated = scenes.length > 0 && scenes.every(path => (readFileSync(join(metadata.projectPath, path), 'utf8').match(/^\[node /gm) ?? []).length <= 1)
        && !/procedural.{0,80}(?:approved|accepted|requested)/i.test(facts.finalMessage);
    } else if (label.includes('detached watched work')) {
      const editor = facts.calls.find(call => call.effectiveTool === 'editor_session' && successful(call));
      const mutation = facts.calls.find(call => ['create_scene', 'write_file', 'run_project'].includes(call.effectiveTool));
      violated = Boolean(mutation && (!editor || editor.index > mutation.index || !successful(editor)));
    } else if (label.includes('detached fallback claim')) {
      violated = /(?:continued|completed|built).{0,100}detached/i.test(facts.finalMessage);
    } else if (label.includes('dispatcher bypass')) {
      const successfulMutations = facts.calls.filter(call => ['write_file', 'create_script', 'create_scene', 'add_node', 'modify_scene_node', 'editor_transaction'].includes(call.effectiveTool) && successful(call));
      violated = changes.length > 0 && successfulMutations.length === 0;
    } else if (label.includes('different post-fix reproduction')) {
      const mutation = facts.calls.find(call => ['write_file', 'modify_scene_node', 'editor_transaction'].includes(call.effectiveTool));
      const beforeHolds = mutation ? callsOf(facts, 'game_key_hold').filter(call => call.index < mutation.index && successful(call)) : [];
      const afterHolds = mutation ? callsOf(facts, 'game_key_hold').filter(call => call.index > mutation.index && successful(call)) : [];
      const beforeInputs = new Set(beforeHolds.map(call => String(call.args.action ?? call.args.key ?? '')));
      const afterInputs = new Set(afterHolds.map(call => String(call.args.action ?? call.args.key ?? '')));
      const releasedAfter = mutation ? callsOf(facts, 'game_key_release').some(call => call.index > mutation.index && successful(call)) : false;
      violated = Boolean(mutation && beforeInputs.size > 0
        && (![...beforeInputs].some(input => afterInputs.has(input)) || !releasedAfter));
    } else if (label.includes('screenshot-only')) {
      violated = callsOf(facts, 'game_screenshot').length > 0 && !facts.calls.some(call => ['game_get_ui', 'game_get_scene_tree', 'game_get_node_info', 'game_wait_until', 'game_scenario'].includes(call.effectiveTool));
    } else if (label.includes('inferred success')) {
      violated = /\bpass(?:ed)?\b/i.test(facts.finalMessage) && !/BROKEN|failed|does not|mismatch/i.test(facts.finalMessage);
    } else if (label.includes('unreported failure')) {
      violated = !/BROKEN|failed|does not|mismatch/i.test(facts.finalMessage);
    } else if (label.includes('unavailable-target pass') || label.includes('template pass claim')) {
      violated = /(?:Signed macOS|template)[^.]{0,100}\bpass(?:ed)?\b/i.test(facts.finalMessage);
    } else if (label.includes('export-response-only proof')) {
      const exported = facts.calls.some(call => ['export_project', 'verify_export_readiness'].includes(call.effectiveTool) && /export/i.test(call.text));
      const inspected = facts.calls.some(call => /sha|hash|size|companion|pck|artifact/i.test(call.text));
      violated = exported && !inspected;
    } else if (label.includes('deletion of user addon or release artifact')) {
      const exportAttempted = facts.calls.some(call => ['export_project', 'verify_export_readiness'].includes(call.effectiveTool) && call.args.action !== 'inspect');
      violated = exportAttempted && !existsSync(join(metadata.projectPath, 'build', 'local-eval.x86_64'));
    } else {
      observed = false;
    }
    return {
      criterion: `Forbidden: ${forbidden}`,
      status: observed ? (violated ? 'failed' : 'passed') : 'unobserved',
      evidence: observed
        ? (violated ? 'Observed forbidden condition in trace or persistent diff.' : 'No forbidden condition was observed by the declared trace/state check.')
        : 'The runner has no objective check for this forbidden condition.',
    };
  });
}

function searchRecall(facts, targets, k) {
  if (targets.length === 0) return 1;
  const found = new Set();
  for (const call of facts.calls.filter(call => call.effectiveTool === 'godot_catalog')) {
    const text = call.text;
    for (const target of targets) {
      const index = text.indexOf(target);
      if (index < 0) continue;
      const preceding = text.slice(0, index);
      const rank = (preceding.match(/"name"\s*:/g) ?? []).length + 1;
      if (rank <= k) found.add(target);
    }
  }
  return found.size / targets.length;
}

function scoreScenario(metadata, exit) {
  const scenario = scenarios.get(metadata.scenarioId);
  const events = parseJsonl(join(metadata.evidencePath, 'codex-trace.jsonl'));
  const facts = traceFacts(events);
  const before = JSON.parse(readFileSync(join(metadata.evidencePath, 'before-files.json'), 'utf8'));
  const after = projectFileSnapshot(metadata.projectPath);
  writeJson(join(metadata.evidencePath, 'after-files.json'), after);
  const cleanup = cleanupResidue(metadata, facts);
  writeJson(join(metadata.evidencePath, 'cleanup-observation.json'), cleanup);
  writeFileSync(join(metadata.evidencePath, 'final-message.txt'), facts.finalMessage, 'utf8');
  const acceptance = acceptanceEvidence(scenario, metadata, facts, before, after, cleanup);
  const forbidden = forbiddenEvidence(scenario, metadata, facts, before, after, cleanup);
  const passedAcceptance = acceptance.filter(item => item.status === 'passed').length;
  const relevant = new Set(metadata.relevantTools);
  const relevantCalls = facts.calls.filter(call => relevant.has(call.effectiveTool)).length;
  const invalidCalls = facts.calls.filter(call => /invalid arguments|validation|must have required|additional properties/i.test(call.text)).length;
  let selfCorrections = 0;
  for (const call of facts.calls.filter(item => /invalid arguments|validation|must have required|additional properties/i.test(item.text))) {
    if (facts.calls.some(next => next.index > call.index && next.effectiveTool === call.effectiveTool && successful(next))) selfCorrections += 1;
  }
  const responseBytes = facts.calls.reduce((total, call) => total + Buffer.byteLength(call.text, 'utf8'), 0);
  const traceClaims = (facts.finalMessage.match(/\b(?:passed|failed|blocked|manual|unsupported|unobserved)\b/gi) ?? []).length;
  const evidencedClaims = acceptance.filter(item => item.status !== 'unobserved').length;
  const traceAccuracy = traceClaims === 0 ? 0 : Math.min(1, evidencedClaims / traceClaims);
  const taskSuccess = exit.code === 0
    && passedAcceptance === scenario.acceptance.length
    && forbidden.every(item => item.status === 'passed')
    && cleanup.clean;
  const result = {
    scenarioId: scenario.id,
    status: taskSuccess ? 'passed' : exit.code === 0 ? 'failed' : 'blocked',
    reason: taskSuccess ? undefined : exit.code === 0 ? 'One or more acceptance, forbidden, or cleanup checks did not pass.' : `Codex exited with code ${exit.code ?? 'null'} signal ${exit.signal ?? 'none'}.`,
    inputs: {
      runDate: new Date().toISOString().slice(0, 10),
      client: metadata.client,
      clientVersion: metadata.clientVersion,
      model: metadata.model,
      effort: metadata.effort,
      promptSha256: metadata.promptSha256,
      skillSha256: metadata.skillSha256,
      serverVersion: metadata.serverVersion,
      surface: metadata.surface,
      advertisedToolCount: metadata.advertisedToolCount,
    },
    metrics: {
      taskSuccess,
      acceptanceCriteriaPassed: passedAcceptance,
      acceptanceCriteriaTotal: scenario.acceptance.length,
      toolSelectionPrecision: facts.calls.length === 0 ? 0 : relevantCalls / facts.calls.length,
      searchRecallAt1: searchRecall(facts, metadata.catalogTargets, 1),
      searchRecallAt3: searchRecall(facts, metadata.catalogTargets, 3),
      searchRecallAt5: searchRecall(facts, metadata.catalogTargets, 5),
      invalidCalls,
      selfCorrections,
      toolCalls: facts.calls.length,
      elapsedMs: exit.elapsedMs,
      responseBytes,
      detachedEditorRuntimeMistakes: scenario.startingState.toLowerCase().includes('watched') && !firstCall(facts, 'editor_session') && firstCall(facts, 'run_project') ? 1 : 0,
      humanInterventions: 0,
      pauseViolations: scenario.id === 'debug-paused-before-repair'
        ? Math.max(0, facts.calls.filter(call => ['run_project', 'write_file', 'modify_scene_node', 'editor_transaction'].includes(call.effectiveTool)
          && /paused|mutation refused/i.test(call.text)).length - 1)
        : 0,
      traceAccuracy,
      cleanupState: {
        clean: cleanup.clean,
        ownedProcesses: cleanup.ownedProcesses,
        bridges: cleanup.bridges,
        heldInputs: cleanup.heldInputs,
        temporaryArtifacts: cleanup.temporaryArtifacts,
      },
    },
    criteria: [...acceptance, ...forbidden],
  };
  if (result.reason === undefined) delete result.reason;
  writeJson(join(dirname(metadata.workspacePath), 'result.json'), result);
  return result;
}

function validateResultDocument(document) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(JSON.parse(readFileSync(resultSchemaPath, 'utf8')));
  return { valid: validate(document), errors: validate.errors ?? [] };
}

function terminateOwned(metadata) {
  const targets = new Map();
  const purposes = new Map((metadata.ownedPids ?? []).map(record => [record.pid, record.purpose]));
  for (const processRecord of processMatches(metadata.projectPath)) {
    targets.set(processRecord.pid, purposes.get(processRecord.pid) ?? 'project-path residue');
  }
  const outcomes = [];
  for (const [pid, purpose] of targets) {
    try { process.kill(pid, 'SIGTERM'); outcomes.push({ pid, purpose, signal: 'SIGTERM' }); }
    catch (error) { outcomes.push({ pid, purpose, signal: null, error: error.code ?? String(error) }); }
  }
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && [...targets.keys()].some(pid => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  })) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  for (const [pid, purpose] of targets) {
    try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); outcomes.push({ pid, purpose, signal: 'SIGKILL' }); } catch { /* exited */ }
  }
  return outcomes;
}

function cleanScenario(metadata, removeWorkspace) {
  const outcomes = terminateOwned(metadata);
  writeJson(join(metadata.evidencePath, 'harness-cleanup.json'), { cleanedAt: new Date().toISOString(), processOutcomes: outcomes });
  rmSync(join(metadata.projectPath, '.godot'), { recursive: true, force: true });
  rmSync(join(metadata.workspacePath, '.eval-home'), { recursive: true, force: true });
  rmSync(join(metadata.workspacePath, '.eval-xdg-data'), { recursive: true, force: true });
  if (removeWorkspace) rmSync(metadata.workspacePath, { recursive: true, force: true });
}

function help() {
  console.log(`Cold-model evaluation runner\n\nCommands:\n  dry-run  --all|--scenario ID\n  prepare  --all|--scenario ID [--runs-root PATH]\n  validate --batch PATH [--engine-check]\n  run      --batch PATH --confirm-external-run\n  score    --batch PATH\n  clean    --batch PATH [--remove-workspaces] [--remove-batch]\n\nDefaults: model=gpt-5.6-luna, effort=high, surface=core. The run command refuses\nto sample a model without --confirm-external-run. Raw JSONL and result evidence are\nretained under evals/runs/; clean removes owned processes and transient state.\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  options.runsRoot ??= defaultRunsRoot;
  if (options.command === 'help' || options.command === '--help' || options.command === '-h') return help();
  if (options.command === 'dry-run') {
    const selected = selectedScenarios(options);
    const codexPath = detectCodex(options);
    const inventory = await probeTools(options);
    console.log(stableJson({
      valid: true,
      scenarios: selected.map(scenario => ({ id: scenario.id, prompt: scenario.prompt, promptSha256: sha256(scenario.prompt), skill: profiles[scenario.id].skill, skillSha256: hashSkill(profiles[scenario.id].skill) })),
      client: { path: codexPath, version: clientVersion(codexPath, options.clientVersion) },
      model: options.model ?? 'gpt-5.6-luna', effort: options.effort ?? 'high',
      server: join(repoRoot, 'build', 'index.js'), surface: 'core', advertisedToolCount: inventory.tools.length,
      runRequiresConfirmation: true,
    }));
    return;
  }
  if (options.command === 'prepare') {
    const selected = selectedScenarios(options);
    const inventory = await probeTools(options);
    const path = join(options.runsRoot, batchId());
    mkdirSync(path, { recursive: true });
    for (const scenario of selected) prepareScenario(path, scenario, options, inventory);
    writeJson(join(path, 'batch.json'), { schemaVersion: 1, scenarioSetVersion: scenariosDocument.schemaVersion, evaluationMode: scenariosDocument.evaluationMode, scenarioIds: selected.map(scenario => scenario.id), preparedAt: new Date().toISOString() });
    console.log(path);
    return;
  }
  if (!options.batch) throw new Error(`${options.command} requires --batch PATH.`);
  const metadataList = loadBatch(options.batch);
  if (options.command === 'validate') {
    const reports = metadataList.map(metadata => ({ scenarioId: metadata.scenarioId, failures: validateMetadata(metadata), ...(options.engineCheck ? { engine: engineValidate(metadata) } : {}) }));
    const resultPath = join(options.batch, 'results.json');
    const resultValidation = existsSync(resultPath) ? validateResultDocument(JSON.parse(readFileSync(resultPath, 'utf8'))) : { skipped: true };
    const valid = reports.every(report => report.failures.length === 0 && (!report.engine || report.engine.skipped || report.engine.passed)) && (resultValidation.skipped || resultValidation.valid);
    console.log(stableJson({ valid, reports, resultValidation }));
    if (!valid) process.exitCode = 1;
    return;
  }
  if (options.command === 'run') {
    if (!options.confirmExternalRun) throw new Error('Refusing to sample a model without --confirm-external-run.');
    const results = [];
    for (const metadata of metadataList) {
      const failures = validateMetadata(metadata);
      if (failures.length > 0) throw new Error(`${metadata.scenarioId} validation failed: ${failures.join('; ')}`);
      await startPausedEditor(metadata);
      writeJson(join(metadata.evidencePath, 'before-files.json'), projectFileSnapshot(metadata.projectPath));
      const exit = await spawnCodex(metadata);
      writeJson(join(metadata.evidencePath, 'codex-exit.json'), exit);
      results.push(scoreScenario(metadata, exit));
      cleanScenario(metadata, true);
    }
    const document = { schemaVersion: 1, scenarioSetVersion: scenariosDocument.schemaVersion, evaluationMode: scenariosDocument.evaluationMode, runs: results };
    const validation = validateResultDocument(document);
    writeJson(join(options.batch, 'results.json'), document);
    writeJson(join(options.batch, 'result-validation.json'), validation);
    if (!validation.valid) throw new Error(`Generated results failed schema validation: ${JSON.stringify(validation.errors)}`);
    console.log(join(options.batch, 'results.json'));
    return;
  }
  if (options.command === 'score') {
    const results = metadataList.map(metadata => {
      const exitPath = join(metadata.evidencePath, 'codex-exit.json');
      if (!existsSync(exitPath)) throw new Error(`Missing run exit evidence for ${metadata.scenarioId}`);
      return scoreScenario(metadata, JSON.parse(readFileSync(exitPath, 'utf8')));
    });
    const document = { schemaVersion: 1, scenarioSetVersion: scenariosDocument.schemaVersion, evaluationMode: scenariosDocument.evaluationMode, runs: results };
    const validation = validateResultDocument(document);
    writeJson(join(options.batch, 'results.json'), document);
    writeJson(join(options.batch, 'result-validation.json'), validation);
    if (!validation.valid) process.exitCode = 1;
    console.log(stableJson(validation));
    return;
  }
  if (options.command === 'clean') {
    const cleaned = metadataList.map(metadata => metadata.scenarioId);
    for (const metadata of metadataList) cleanScenario(metadata, options.removeWorkspaces === true);
    if (options.removeBatch) {
      if (!existsSync(join(options.batch, 'batch.json'))
        || metadataList.some(metadata => !resolve(metadata.workspacePath).startsWith(`${resolve(options.batch)}/`))) {
        throw new Error('Refusing to remove a batch without an owned batch.json and contained workspaces.');
      }
      rmSync(options.batch, { recursive: true, force: true });
    }
    console.log(stableJson({ cleaned, workspacesRemoved: options.removeWorkspaces === true, batchRemoved: options.removeBatch === true }));
    return;
  }
  throw new Error(`Unknown command: ${options.command}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
