import { dirname, extname, isAbsolute, join, relative, resolve } from 'path';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { createHash, randomUUID } from 'crypto';
import { homedir } from 'os';

import { createErrorResponse, errorMessage, normalizeParameters, validatePath, type OperationParams, type ToolArguments, type ToolResponse, PathSecurity } from '../utils.js';
import type { ProjectSupport } from '../project-support.js';
import type { GodotExecutableService } from '../godot-executable.js';
import type { HeadlessOperationService } from '../headless-operation-service.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { GODOT_EXPORT_OPTIONS } from '../godot-subprocess.js';
import {
  abortError,
  currentExecutionContext,
  isAbortError,
  reportProgress,
  throwIfCancelled,
} from '../execution-context.js';

const execFileAsync = promisify(execFile);

function executionSignal(): AbortSignal | undefined {
  return currentExecutionContext()?.signal;
}

function rethrowCancellation(error: unknown): void {
  const signal = executionSignal();
  if (isAbortError(error) || signal?.aborted) throw abortError(signal?.reason);
}

/** Dependencies shared by the focused project-tool services. */
export interface ProjectHandlerServiceContext {
  executable: GodotExecutableService;
  operations: HeadlessOperationService;
  pathSecurity: PathSecurity;
  projectSupport: ProjectSupport;
  ownedTransientFiles?: (projectPath: string) => ReadonlySet<string>;
}

function projectFile(projectPath: string): string {
  return join(projectPath, 'project.godot');
}

function projectRelativePath(context: ProjectHandlerServiceContext, projectPath: string, relativePath: string): string {
  const resolved = context.pathSecurity.resolveProjectPath(projectPath, relativePath);
  if (!resolved) throw new Error(`Path is outside the project: ${relativePath}`);
  return resolved;
}

function validProject(context: ProjectHandlerServiceContext, projectPath: unknown): projectPath is string {
  return typeof projectPath === 'string'
    && context.pathSecurity.isProjectPathAllowed(projectPath)
    && existsSync(projectFile(projectPath));
}

/** Owns project-relative file operations and their security checks. */
export class ProjectFileIOService {
  constructor(private readonly context: ProjectHandlerServiceContext) {}

  async read(args: ToolArguments): Promise<ToolResponse> {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.filePath) return createErrorResponse('projectPath and filePath are required.');
    if (!validProject(this.context, args.projectPath) || !validatePath(args.filePath)) return createErrorResponse('Invalid path.');
    try {
      const fullPath = projectRelativePath(this.context, args.projectPath, args.filePath);
      if (!existsSync(fullPath)) return createErrorResponse(`File does not exist: ${args.filePath}`);
      return { content: [{ type: 'text', text: readFileSync(fullPath, 'utf8') }] };
    } catch (error: unknown) { return createErrorResponse(`Failed to read file: ${errorMessage(error)}`); }
  }

  async write(args: ToolArguments): Promise<ToolResponse> {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.filePath || args.content === undefined) return createErrorResponse('projectPath, filePath, and content are required.');
    if (!validProject(this.context, args.projectPath) || !validatePath(args.filePath)) return createErrorResponse('Invalid path.');
    try {
      const fullPath = projectRelativePath(this.context, args.projectPath, args.filePath);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, args.content, 'utf8');
      return { content: [{ type: 'text', text: `File written: ${args.filePath}` }] };
    } catch (error: unknown) { return createErrorResponse(`Failed to write file: ${errorMessage(error)}`); }
  }

  async delete(args: ToolArguments): Promise<ToolResponse> {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.filePath) return createErrorResponse('projectPath and filePath are required.');
    if (!validProject(this.context, args.projectPath) || !validatePath(args.filePath)) return createErrorResponse('Invalid path.');
    try {
      const fullPath = projectRelativePath(this.context, args.projectPath, args.filePath);
      if (!existsSync(fullPath)) return createErrorResponse(`File does not exist: ${args.filePath}`);
      unlinkSync(fullPath);
      return { content: [{ type: 'text', text: `File deleted: ${args.filePath}` }] };
    } catch (error: unknown) { return createErrorResponse(`Failed to delete file: ${errorMessage(error)}`); }
  }

  async createDirectory(args: ToolArguments): Promise<ToolResponse> {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.directoryPath) return createErrorResponse('projectPath and directoryPath are required.');
    if (!validProject(this.context, args.projectPath) || !validatePath(args.directoryPath)) return createErrorResponse('Invalid path.');
    try {
      mkdirSync(projectRelativePath(this.context, args.projectPath, args.directoryPath), { recursive: true });
      return { content: [{ type: 'text', text: `Directory created: ${args.directoryPath}` }] };
    } catch (error: unknown) { return createErrorResponse(`Failed to create directory: ${errorMessage(error)}`); }
  }

  async rename(args: ToolArguments): Promise<ToolResponse> {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.filePath || !args.newPath) return createErrorResponse('projectPath, filePath, and newPath are required.');
    if (!validProject(this.context, args.projectPath) || !validatePath(args.filePath) || !validatePath(args.newPath)) return createErrorResponse('Invalid path.');
    try {
      const source = projectRelativePath(this.context, args.projectPath, args.filePath);
      if (!existsSync(source)) return createErrorResponse(`File not found: ${args.filePath}`);
      const destination = projectRelativePath(this.context, args.projectPath, args.newPath);
      mkdirSync(dirname(destination), { recursive: true });
      renameSync(source, destination);
      return { content: [{ type: 'text', text: `Renamed ${args.filePath} → ${args.newPath}` }] };
    } catch (error: unknown) { return createErrorResponse(`rename_file failed: ${errorMessage(error)}`); }
  }
}

/** Owns direct reads and writes to project.godot settings. */
export class ProjectConfigurationService {
  constructor(private readonly context: ProjectHandlerServiceContext) {}

  async read(args: ToolArguments): Promise<ToolResponse> {
    args = normalizeParameters(args || {});
    if (!args.projectPath) return createErrorResponse('projectPath is required.');
    if (!validProject(this.context, args.projectPath)) return createErrorResponse('Invalid path.');
    try {
      const sections: Record<string, Record<string, string>> = {};
      let currentSection = '';
      for (const line of readFileSync(projectFile(args.projectPath), 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(';')) continue;
        const section = /^\[(.+)\]$/.exec(trimmed);
        if (section) { currentSection = section[1]; sections[currentSection] ??= {}; continue; }
        const setting = /^([^=]+)=(.*)$/.exec(trimmed);
        if (setting && currentSection) sections[currentSection][setting[1].trim()] = setting[2].trim();
      }
      return { content: [{ type: 'text', text: JSON.stringify(sections, null, 2) }] };
    } catch (error: unknown) { return createErrorResponse(`Failed to read project settings: ${errorMessage(error)}`); }
  }

  async modify(args: ToolArguments): Promise<ToolResponse> {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.section || !args.key || args.value === undefined) return createErrorResponse('projectPath, section, key, and value are required.');
    if (!validProject(this.context, args.projectPath)) return createErrorResponse('Invalid path.');
    try {
      let content = readFileSync(projectFile(args.projectPath), 'utf8');
      const header = `[${args.section}]`;
      const serializedValue = serializeProjectSettingValue(args.value);
      const setting = `${args.key}=${serializedValue}`;
      const index = content.indexOf(header);
      if (index === -1) content += `\n\n${header}\n\n${setting}\n`;
      else {
        const end = content.indexOf('\n[', index + header.length);
        const section = content.slice(index, end === -1 ? undefined : end);
        const keyPattern = new RegExp(`^${args.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=.*$`, 'm');
        const updated = keyPattern.test(section) ? section.replace(keyPattern, setting) : `${section}\n${setting}`;
        content = content.slice(0, index) + updated + (end === -1 ? '' : content.slice(end));
      }
      writeFileSync(projectFile(args.projectPath), content, 'utf8');
      return { content: [{ type: 'text', text: `Setting updated: [${args.section}] ${args.key}=${serializedValue}` }] };
    } catch (error: unknown) { return createErrorResponse(`Failed to modify project settings: ${errorMessage(error)}`); }
  }
}

/** Convert common JSON values to valid project.godot Variant text. */
export function serializeProjectSettingValue(value: unknown): string {
  if (typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (typeof value !== 'string') throw new Error('value must be a string, number, or boolean');
  const trimmed = value.trim();
  if (!trimmed) return '""';
  if (/^(?:true|false|null|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)$/.test(trimmed)) return trimmed;
  if (/^(?:[A-Za-z_][A-Za-z0-9_]*\s*\(|[[{"&^])/.test(trimmed)) return trimmed;
  return JSON.stringify(value);
}

/** Owns GDScript validation and keeps batch limits in one place. */
export class ScriptValidationService {
  constructor(private readonly context: ProjectHandlerServiceContext) {}

  async validate(args: ToolArguments): Promise<ToolResponse> {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.scriptPath) return createErrorResponse('projectPath and scriptPath are required.');
    if (!validProject(this.context, args.projectPath) || !validatePath(args.scriptPath)) return createErrorResponse('Invalid path.');
    if (!/\.gd$/i.test(args.scriptPath)) return createErrorResponse('validate_script only checks GDScript (.gd) files.');
    const projectPath = this.context.pathSecurity.canonicalProjectPath(args.projectPath);
    if (!projectPath) return createErrorResponse('Invalid path.');
    const scriptPath = projectRelativePath(this.context, projectPath, args.scriptPath);
    if (!existsSync(scriptPath)) return createErrorResponse(`Script does not exist: ${args.scriptPath}`);
    if (!this.context.executable.path) await this.context.executable.detect();
    if (!this.context.executable.path) return createErrorResponse('Could not find a valid Godot executable path');
    const check = await this.context.projectSupport.runGdScriptCheck(projectPath, scriptPath);
    if (!check.completed) return createErrorResponse(`validate_script could not check the script; ${check.error}`);
    return { content: [{ type: 'text', text: JSON.stringify({ valid: check.errors.length === 0, scriptPath: args.scriptPath, errorCount: check.errors.length, errors: check.errors }, null, 2) }] };
  }
}

/** Owns invocation of Godot's export command. */
export class ProjectExportService {
  constructor(private readonly context: ProjectHandlerServiceContext) {}

  async export(args: ToolArguments): Promise<ToolResponse> {
    args = normalizeParameters(args || {});
    throwIfCancelled();
    await reportProgress(0, 3, 'Validating export request and Godot executable');
    if (!args.projectPath || !args.presetName || !args.outputPath) return createErrorResponse('projectPath, presetName, and outputPath are required.');
    if (!validProject(this.context, args.projectPath)) return createErrorResponse('Invalid project path.');
    const outputPath = isAbsolute(args.outputPath)
      ? (this.context.pathSecurity.isProjectPathAllowed(args.outputPath, true) ? resolve(args.outputPath) : null)
      : this.context.pathSecurity.resolveProjectPath(args.projectPath, args.outputPath);
    if (!outputPath) return createErrorResponse('Invalid output path.');
    if (!this.context.executable.path) await this.context.executable.detect();
    if (!this.context.executable.path) return createErrorResponse('Could not find Godot executable.');
    try {
      mkdirSync(dirname(outputPath), { recursive: true });
      const flag = args.debug ? '--export-debug' : '--export-release';
      await reportProgress(1, 3, `Exporting preset ${args.presetName}`);
      const { stdout } = await execFileAsync(this.context.executable.path, ['--headless', '--path', args.projectPath, flag, args.presetName, outputPath], {
        ...GODOT_EXPORT_OPTIONS,
        signal: executionSignal(),
      });
      throwIfCancelled();
      await reportProgress(2, 3, 'Godot export process completed');
      await reportProgress(3, 3, 'Export complete');
      return { content: [{ type: 'text', text: `Export succeeded.\n\nOutput: ${stdout || outputPath}` }] };
    } catch (error: unknown) {
      rethrowCancellation(error);
      if (error instanceof Error && 'code' in error) {
        const processError = error as Error & { code?: number | string; signal?: NodeJS.Signals | null; stdout?: string; stderr?: string };
        if (typeof processError.code !== 'number' && !processError.signal) {
          return createErrorResponse(`Export failed: ${errorMessage(error)}`);
        }
        const status = processError.signal
          ? `terminated by signal ${processError.signal}`
          : `exited with code ${processError.code}`;
        const output = processError.stderr || processError.stdout;
        return createErrorResponse(`Export failed (${status})${output ? `: ${output}` : '.'}`);
      }
      return createErrorResponse(`Export failed: ${errorMessage(error)}`);
    }
  }
}

interface ProjectTestCaseResult {
  name: string;
  path: string;
  passed: boolean;
  duration_ms?: number;
  message?: string;
}

interface TestProcessResult {
  exitCode: number | string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/** Discovers and runs bounded project-native, GUT, and GdUnit4 test workflows. */
export class ProjectTestService {
  constructor(private readonly context: ProjectHandlerServiceContext) {}

  async execute(args: ToolArguments): Promise<ToolResponse> {
    args = normalizeParameters(args || {});
    throwIfCancelled();
    if (!args.projectPath || !args.action) return createErrorResponse('projectPath and action are required.');
    if (!validProject(this.context, args.projectPath)) return createErrorResponse('Invalid project path.');
    const discovery = this.discover(args.projectPath);
    if (args.action === 'discover') {
      await reportProgress(1, 1, 'Project test discovery complete');
      return { content: [{ type: 'text', text: JSON.stringify(discovery, null, 2) }] };
    }

    if (!this.context.executable.path) await this.context.executable.detect();
    const godot = this.context.executable.path;
    if (!godot) return createErrorResponse('Could not find Godot executable.');
    const requestedFramework = args.framework ?? 'auto';
    const framework = requestedFramework === 'auto'
      ? (discovery.frameworks.gut ? 'gut' : discovery.frameworks.gdunit4 ? 'gdunit4' : 'native')
      : requestedFramework;
    const paths = this.resolveTestPaths(args.projectPath, args.testPaths, discovery.native_tests);
    if ('error' in paths) return createErrorResponse(paths.error);
    const artifacts = this.resolveArtifactPaths(args.projectPath, args.artifactPaths);
    if ('error' in artifacts) return createErrorResponse(artifacts.error);
    const timeoutMs = Math.round((args.timeoutSeconds ?? 60) * 1000);
    throwIfCancelled();
    const progressTotal = framework === 'native' ? paths.paths.length + 2 : 3;
    await reportProgress(0, progressTotal, `Discovered tests and selected ${framework} framework`);

    if (framework === 'gut') {
      if (!discovery.frameworks.gut) return createErrorResponse('GUT is not installed at addons/gut/gut_cmdln.gd.');
      return this.runGut(godot, args.projectPath, paths.paths, artifacts.paths, timeoutMs);
    }
    if (framework === 'gdunit4') {
      if (!discovery.frameworks.gdunit4 || !discovery.gdunit_runner) {
        return createErrorResponse('GdUnit4 runner is not installed at addons/gdUnit4/runtest(.sh/.cmd).');
      }
      return this.runGdUnit(godot, args.projectPath, discovery.gdunit_runner, paths.paths, artifacts.paths, timeoutMs);
    }
    return this.runNative(godot, args.projectPath, paths.paths, artifacts.paths, timeoutMs, args.failFast === true);
  }

  private discover(projectPath: string): Record<string, unknown> & {
    native_tests: string[];
    frameworks: { native: true; gut: boolean; gdunit4: boolean };
    gdunit_runner: string | null;
  } {
    const nativeTests: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === '.godot' || entry.name === '.git' || entry.name === 'node_modules') continue;
        const full = join(directory, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && /^(test_.*|.*_test)\.gd$/i.test(entry.name)) {
          const relativePath = full.slice(projectPath.length + 1).replaceAll('\\', '/');
          if (!relativePath.startsWith('addons/')) nativeTests.push(relativePath);
        }
      }
    };
    walk(projectPath);
    nativeTests.sort();
    const gut = existsSync(join(projectPath, 'addons', 'gut', 'gut_cmdln.gd'));
    const runnerCandidates = process.platform === 'win32'
      ? ['addons/gdUnit4/runtest.cmd', 'addons/gdUnit4/runtest.bat', 'addons/gdUnit4/runtest']
      : ['addons/gdUnit4/runtest', 'addons/gdUnit4/runtest.sh'];
    const gdunitRunner = runnerCandidates.find(candidate => existsSync(join(projectPath, candidate))) ?? null;
    return {
      frameworks: { native: true, gut, gdunit4: gdunitRunner !== null },
      native_tests: nativeTests,
      gdunit_runner: gdunitRunner,
      count: nativeTests.length,
    };
  }

  private resolveTestPaths(projectPath: string, supplied: unknown, discovered: string[]): { paths: string[] } | { error: string } {
    const candidates = Array.isArray(supplied) && supplied.length > 0 ? supplied.map(String) : discovered;
    if (candidates.length === 0) return { error: 'No tests discovered; pass testPaths or add test_*.gd/*_test.gd files.' };
    const paths: string[] = [];
    for (const candidate of candidates) {
      if (!validatePath(candidate)) return { error: `Invalid test path: ${candidate}` };
      const resolved = this.context.pathSecurity.resolveProjectPath(projectPath, candidate);
      if (!resolved || !existsSync(resolved)) return { error: `Test path does not exist: ${candidate}` };
      paths.push(candidate.replaceAll('\\', '/'));
    }
    return { paths };
  }

  private resolveArtifactPaths(projectPath: string, supplied: unknown): { paths: string[] } | { error: string } {
    if (!Array.isArray(supplied)) return { paths: [] };
    const paths: string[] = [];
    for (const candidate of supplied.map(String)) {
      if (!validatePath(candidate) || !this.context.pathSecurity.resolveProjectPath(projectPath, candidate)) {
        return { error: `Invalid artifact path: ${candidate}` };
      }
      paths.push(candidate.replaceAll('\\', '/'));
    }
    return { paths };
  }

  private async runNative(godot: string, projectPath: string, paths: string[], artifactPaths: string[], timeoutMs: number, failFast: boolean): Promise<ToolResponse> {
    const cases: ProjectTestCaseResult[] = [];
    const runs: Record<string, unknown>[] = [];
    const total = paths.length + 2;
    await reportProgress(1, total, `Prepared ${paths.length} native project test file${paths.length === 1 ? '' : 's'}`);
    for (const [index, path] of paths.entries()) {
      throwIfCancelled();
      const result = await this.runProcess(godot, ['--headless', '--path', projectPath, '--script', join(projectPath, path)], projectPath, timeoutMs);
      const parsed = this.parseCaseMarkers(`${result.stdout}\n${result.stderr}`, path);
      this.applyProcessOutcome(parsed, result);
      cases.push(...(parsed.length > 0 ? parsed : [{
        name: path, path, passed: result.exitCode === 0 && !result.timedOut,
        duration_ms: result.durationMs,
        ...(result.timedOut ? { message: 'Timed out' } : result.exitCode === 0 ? {} : { message: `Exited with code ${result.exitCode}` }),
      }]));
      runs.push(this.processEvidence(path, result));
      await reportProgress(index + 2, total, `Completed project test ${index + 1}/${paths.length}: ${path}`);
      if (failFast && cases.some(testCase => !testCase.passed)) break;
    }
    const response = this.testResponse('native', projectPath, artifactPaths, cases, runs);
    await reportProgress(total, total, 'Collected project test results and artifacts');
    return response;
  }

  private async runGut(godot: string, projectPath: string, paths: string[], artifactPaths: string[], timeoutMs: number): Promise<ToolResponse> {
    await reportProgress(1, 3, `Prepared GUT run for ${paths.length} test path${paths.length === 1 ? '' : 's'}`);
    const resources = paths.map(path => `res://${path}`).join(',');
    const result = await this.runProcess(godot, [
      '--headless', '--path', projectPath, '--script', 'res://addons/gut/gut_cmdln.gd',
      '-gexit', '-glog=2', `-gtest=${resources}`,
    ], projectPath, timeoutMs);
    const cases = this.parseCaseMarkers(`${result.stdout}\n${result.stderr}`, 'gut');
    this.applyProcessOutcome(cases, result);
    if (cases.length === 0) cases.push({ name: 'GUT suite', path: resources, passed: result.exitCode === 0 && !result.timedOut, duration_ms: result.durationMs });
    await reportProgress(2, 3, 'GUT process completed');
    const response = this.testResponse('gut', projectPath, artifactPaths, cases, [this.processEvidence('GUT', result)]);
    await reportProgress(3, 3, 'Collected GUT results and artifacts');
    return response;
  }

  private async runGdUnit(godot: string, projectPath: string, runner: string, paths: string[], artifactPaths: string[], timeoutMs: number): Promise<ToolResponse> {
    await reportProgress(1, 3, `Prepared GdUnit4 run for ${paths.length} test path${paths.length === 1 ? '' : 's'}`);
    const runnerPath = join(projectPath, runner);
    const runnerArgs = ['--godot_binary', godot, ...paths.flatMap(path => ['-a', join(projectPath, path)])];
    const result = await this.runProcess(runnerPath, runnerArgs, projectPath, timeoutMs);
    const cases = this.parseCaseMarkers(`${result.stdout}\n${result.stderr}`, 'gdunit4');
    this.applyProcessOutcome(cases, result);
    const acceptedExit = result.exitCode === 0;
    if (cases.length === 0) cases.push({
      name: 'GdUnit4 suite', path: paths.join(','), passed: acceptedExit && !result.timedOut,
      duration_ms: result.durationMs,
      ...([100, 101, '100', '101'].includes(result.exitCode ?? '') ? { message: `GdUnit4 outcome ${result.exitCode}` } : {}),
    });
    await reportProgress(2, 3, 'GdUnit4 process completed');
    const response = this.testResponse('gdunit4', projectPath, artifactPaths, cases, [this.processEvidence('GdUnit4', result)]);
    await reportProgress(3, 3, 'Collected GdUnit4 results and artifacts');
    return response;
  }

  private async runProcess(executable: string, args: string[], cwd: string, timeoutMs: number): Promise<TestProcessResult> {
    const started = performance.now();
    const signal = executionSignal();
    throwIfCancelled(signal);
    try {
      const { stdout, stderr } = await execFileAsync(executable, args, {
        cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, signal,
      });
      return { exitCode: 0, stdout: stdout ?? '', stderr: stderr ?? '', timedOut: false, durationMs: Math.round(performance.now() - started) };
    } catch (error: unknown) {
      rethrowCancellation(error);
      const failure = error as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean; signal?: string };
      return {
        exitCode: failure.code ?? null,
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? '',
        timedOut: failure.killed === true || failure.signal != null || failure.code === 'ETIMEDOUT',
        durationMs: Math.round(performance.now() - started),
      };
    }
  }

  private parseCaseMarkers(output: string, fallbackPath: string): ProjectTestCaseResult[] {
    const cases: ProjectTestCaseResult[] = [];
    for (const line of output.split(/\r?\n/)) {
      const marker = /^GODOT_MCP_TEST_CASE\s+(.+)$/.exec(line.trim());
      if (!marker) continue;
      try {
        const value = JSON.parse(marker[1]) as Record<string, unknown>;
        if (typeof value.name !== 'string' || typeof value.passed !== 'boolean') continue;
        cases.push({
          name: value.name, path: typeof value.path === 'string' ? value.path : fallbackPath,
          passed: value.passed,
          ...(typeof value.duration_ms === 'number' ? { duration_ms: value.duration_ms } : {}),
          ...(typeof value.message === 'string' ? { message: value.message } : {}),
        });
      } catch {
        // Malformed markers remain in bounded raw output but are not trusted as cases.
      }
    }
    return cases;
  }

  private applyProcessOutcome(cases: ProjectTestCaseResult[], result: TestProcessResult): void {
    if (result.exitCode === 0 && !result.timedOut) return;
    const message = result.timedOut ? 'Timed out' : `Exited with code ${result.exitCode}`;
    for (const testCase of cases) {
      testCase.passed = false;
      testCase.message ??= message;
    }
  }

  private processEvidence(name: string, result: TestProcessResult): Record<string, unknown> {
    return {
      name, exit_code: result.exitCode, timed_out: result.timedOut, duration_ms: result.durationMs,
      stdout: result.stdout.slice(-64 * 1024), stderr: result.stderr.slice(-64 * 1024),
      output_truncated: result.stdout.length > 64 * 1024 || result.stderr.length > 64 * 1024,
    };
  }

  private testResponse(framework: string, projectPath: string, artifactPaths: string[], cases: ProjectTestCaseResult[], runs: Record<string, unknown>[]): ToolResponse {
    const failed = cases.filter(testCase => !testCase.passed).length;
    const artifacts = artifactPaths.flatMap(path => {
      const fullPath = this.context.pathSecurity.resolveProjectPath(projectPath, path);
      if (!fullPath || !existsSync(fullPath) || !statSync(fullPath).isFile()) return [];
      const stat = statSync(fullPath);
      return [{ path, bytes: stat.size, modified_at: stat.mtime.toISOString() }];
    });
    const missingArtifacts = artifactPaths.filter(path => !artifacts.some(artifact => artifact.path === path));
    const result = { framework, passed: failed === 0, total: cases.length, failed, cases, runs, artifacts, missing_artifacts: missingArtifacts };
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], ...(failed === 0 ? {} : { isError: true }) };
  }
}

type IniDocument = Record<string, Record<string, string>>;

function parseIniDocument(content: string): IniDocument {
  const result: IniDocument = {};
  let section = '';
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) { section = header[1]; result[section] ??= {}; continue; }
    const setting = /^([^=]+)=(.*)$/.exec(line);
    if (setting && section) result[section][setting[1].trim()] = setting[2].trim();
  }
  return result;
}

function formatGodotSetting(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new Error('Import setting values must be strings, numbers, or booleans.');
}

function decodeGodotSetting(value: string | undefined): unknown {
  if (value === undefined) return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value); } catch { return value.slice(1, -1); }
  }
  return value;
}

/** Inspects, edits, and synchronously reimports Godot source assets. */
export class ImportPipelineService {
  constructor(private readonly context: ProjectHandlerServiceContext) {}

  async execute(args: ToolArguments): Promise<ToolResponse> {
    const importSettings = args?.settings;
    args = normalizeParameters(args || {});
    throwIfCancelled();
    if (importSettings !== undefined) args.settings = importSettings;
    if (!args.projectPath || !args.action) return createErrorResponse('projectPath and action are required.');
    if (!validProject(this.context, args.projectPath)) return createErrorResponse('Invalid project path.');
    if (args.action === 'reimport') return this.reimport(args.projectPath, args.timeoutSeconds ?? 120);
    if (!args.sourcePath || !validatePath(args.sourcePath)) return createErrorResponse('A valid sourcePath is required.');
    const sourcePath = this.context.pathSecurity.resolveProjectPath(args.projectPath, args.sourcePath);
    if (!sourcePath || !existsSync(sourcePath)) return createErrorResponse(`Source asset does not exist: ${args.sourcePath}`);
    const metadataPath = `${sourcePath}.import`;
    if (!existsSync(metadataPath)) return createErrorResponse(`Import metadata does not exist: ${args.sourcePath}.import; run reimport first.`);
    const document = parseIniDocument(readFileSync(metadataPath, 'utf8'));
    if (args.action === 'inspect') {
      await reportProgress(1, 1, 'Import metadata inspection complete');
      return this.response(args.sourcePath, document);
    }
    if (args.action === 'dependencies') {
      await reportProgress(1, 1, 'Import dependency inspection complete');
      return this.response(args.sourcePath, document, true);
    }
    if (args.action !== 'change') return createErrorResponse('action must be inspect, change, reimport, or dependencies.');
    if (!args.settings || typeof args.settings !== 'object' || Array.isArray(args.settings)) {
      return createErrorResponse('settings is required for change.');
    }
    try {
      await reportProgress(0, 2, 'Validating import metadata changes');
      let content = readFileSync(metadataPath, 'utf8');
      for (const [key, value] of Object.entries(args.settings)) {
        if (!/^[A-Za-z0-9_./-]+$/.test(key)) return createErrorResponse(`Invalid import setting key: ${key}`);
        const formatted = formatGodotSetting(value);
        const sectionIndex = content.indexOf('[params]');
        if (sectionIndex < 0) content += `\n[params]\n\n${key}=${formatted}\n`;
        else {
          const sectionEnd = content.indexOf('\n[', sectionIndex + 8);
          const end = sectionEnd < 0 ? content.length : sectionEnd;
          const section = content.slice(sectionIndex, end);
          const pattern = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=.*$`, 'm');
          const replacement = `${key}=${formatted}`;
          content = content.slice(0, sectionIndex)
            + (pattern.test(section) ? section.replace(pattern, replacement) : `${section.trimEnd()}\n${replacement}\n`)
            + content.slice(end);
        }
      }
      writeFileSync(metadataPath, content, 'utf8');
      await reportProgress(1, 2, 'Import metadata updated');
      await reportProgress(2, 2, 'Import metadata change complete');
      return this.response(args.sourcePath, parseIniDocument(content));
    } catch (error: unknown) { return createErrorResponse(`Failed to change import settings: ${errorMessage(error)}`); }
  }

  private response(sourcePath: string, document: IniDocument, dependenciesOnly = false): ToolResponse {
    const dependencies = {
      source_file: decodeGodotSetting(document.deps?.source_file),
      destination_files: this.parseArray(document.deps?.dest_files),
      imported_path: decodeGodotSetting(document.remap?.path),
    };
    const result = dependenciesOnly ? { source_path: sourcePath, dependencies } : {
      source_path: sourcePath, importer: decodeGodotSetting(document.remap?.importer),
      resource_type: decodeGodotSetting(document.remap?.type),
      settings: Object.fromEntries(Object.entries(document.params ?? {}).map(([key, value]) => [key, decodeGodotSetting(value)])),
      dependencies,
    };
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }

  private parseArray(value: string | undefined): string[] {
    if (!value) return [];
    return [...value.matchAll(/"([^"]+)"/g)].map(match => match[1]);
  }

  private async reimport(projectPath: string, timeoutSeconds: number): Promise<ToolResponse> {
    await reportProgress(0, 3, 'Resolving Godot executable for project import');
    if (!this.context.executable.path) await this.context.executable.detect();
    if (!this.context.executable.path) return createErrorResponse('Could not find Godot executable.');
    const started = performance.now();
    const signal = executionSignal();
    throwIfCancelled(signal);
    try {
      await reportProgress(1, 3, 'Importing project resources');
      const { stdout, stderr } = await execFileAsync(this.context.executable.path, [
        '--headless', '--path', projectPath, '--import',
      ], { cwd: projectPath, timeout: Math.round(timeoutSeconds * 1000), maxBuffer: 4 * 1024 * 1024, signal });
      const diagnostics = `${stdout ?? ''}\n${stderr ?? ''}`.split(/\r?\n/)
        .filter(line => /\b(?:warning|error)\b/i.test(line)).slice(0, 256);
      await reportProgress(2, 3, 'Collected bounded import diagnostics');
      await reportProgress(3, 3, 'Project import complete');
      return { content: [{ type: 'text', text: JSON.stringify({
        imported: true, duration_ms: Math.round(performance.now() - started), diagnostics,
        stdout: (stdout ?? '').slice(-64 * 1024), stderr: (stderr ?? '').slice(-64 * 1024),
      }, null, 2) }] };
    } catch (error: unknown) {
      rethrowCancellation(error);
      const failure = error as { code?: number | string; signal?: string; stdout?: string; stderr?: string; killed?: boolean };
      return createErrorResponse(JSON.stringify({ imported: false, exit_code: failure.code ?? null,
        timed_out: failure.killed === true || failure.signal != null, stdout: (failure.stdout ?? '').slice(-64 * 1024),
        stderr: (failure.stderr ?? '').slice(-64 * 1024) }, null, 2));
    }
  }
}

/** Builds a bounded static dependency and integrity report for project resources. */
export class ProjectIntegrityService {
  private static readonly resourceExtensions = new Set(['.tscn', '.tres', '.gd', '.gdshader', '.res', '.scn']);

  constructor(private readonly context: ProjectHandlerServiceContext) {}

  async execute(args: ToolArguments): Promise<ToolResponse> {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.action) return createErrorResponse('projectPath and action are required.');
    if (!validProject(this.context, args.projectPath)) return createErrorResponse('Invalid project path.');
    const inventory = this.scan(args.projectPath, args.maxFiles ?? 10000);
    if ('error' in inventory) return createErrorResponse(inventory.error);
    if (args.action === 'analyze') return { content: [{ type: 'text', text: JSON.stringify(
      this.analyze(args.projectPath, inventory.files, args.allowProceduralMainScene === true), null, 2,
    ) }] };
    if (args.action === 'leaks') {
      const report = this.analyze(args.projectPath, inventory.files);
      return { content: [{ type: 'text', text: JSON.stringify({
        source: 'static-project-audit',
        runtime_snapshot_required: true,
        orphan_resources: report.orphan_resources,
        orphan_nodes: report.orphan_nodes,
        broken_references: report.broken_references,
        cycles: report.cycles,
        note: 'Static candidates are reported without mutating the project; use game_performance action=leaks for live ObjectDB counters.',
      }, null, 2) }] };
    }
    if (args.action === 'assets') return { content: [{ type: 'text', text: JSON.stringify(this.auditAssets(args.projectPath, args.maxFiles ?? 10000), null, 2) }] };
    if (args.action === 'localization') return { content: [{ type: 'text', text: JSON.stringify(this.auditLocalization(args.projectPath, args.maxFiles ?? 10000), null, 2) }] };
    if (args.action === 'accessibility') return { content: [{ type: 'text', text: JSON.stringify(this.auditAccessibility(args.projectPath, args.maxFiles ?? 10000), null, 2) }] };
    if (args.action === 'extensions') return { content: [{ type: 'text', text: JSON.stringify(this.auditExtensions(args.projectPath, args.maxFiles ?? 10000), null, 2) }] };
    if (args.action !== 'preview_rename') return createErrorResponse('action must be analyze, preview_rename, assets, localization, accessibility, extensions, or leaks.');
    if (!args.sourcePath || !args.destinationPath || !validatePath(args.sourcePath) || !validatePath(args.destinationPath)) {
      return createErrorResponse('Valid sourcePath and destinationPath are required for preview_rename.');
    }
    const source = `res://${args.sourcePath.replaceAll('\\', '/')}`;
    const destination = this.context.pathSecurity.resolveProjectPath(args.projectPath, args.destinationPath);
    const references = inventory.files.filter(file => readFileSync(join(args.projectPath, file), 'utf8').includes(source));
    return { content: [{ type: 'text', text: JSON.stringify({ source_path: args.sourcePath,
      destination_path: args.destinationPath, source_exists: existsSync(join(args.projectPath, args.sourcePath)),
      destination_exists: destination ? existsSync(destination) : false, referencing_files: references,
      uid_sidecar: existsSync(join(args.projectPath, `${args.sourcePath}.uid`)) ? `${args.sourcePath}.uid` : null,
      changes_applied: false }, null, 2) }] };
  }

  private scan(projectPath: string, maxFiles: number): { files: string[] } | { error: string } {
    const files: string[] = [];
    const ownedTransientFiles = this.context.ownedTransientFiles?.(projectPath) ?? new Set<string>();
    const walk = (directory: string): boolean => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (['.godot', '.git', 'node_modules'].includes(entry.name)) continue;
        const full = join(directory, entry.name);
        if (entry.isDirectory()) { if (!walk(full)) return false; }
        else if (entry.isFile() && ProjectIntegrityService.resourceExtensions.has(extname(entry.name).toLowerCase())) {
          const projectRelative = relative(projectPath, full).replaceAll('\\', '/');
          if (ownedTransientFiles.has(projectRelative)) continue;
          files.push(projectRelative);
          if (files.length > maxFiles) return false;
        }
      }
      return true;
    };
    return walk(projectPath) ? { files: files.sort() } : { error: `Project exceeds maxFiles limit (${maxFiles}).` };
  }

  private analyze(projectPath: string, files: string[], allowProceduralMainScene = false): Record<string, unknown> {
    const fileSet = new Set(files);
    const graph: Record<string, string[]> = {};
    const uidOwners = new Map<string, string[]>();
    const brokenReferences: { source: string; target: string }[] = [];
    const orphanNodes: { scene: string; node: string; parent: string }[] = [];
    for (const file of files) {
      const content = readFileSync(join(projectPath, file), 'utf8');
      const references = [...new Set([...content.matchAll(/res:\/\/([^"'\s)\]]+)/g)].map(match => match[1]))];
      graph[file] = references.filter(target => fileSet.has(target));
      for (const target of references) if (!existsSync(join(projectPath, target))) brokenReferences.push({ source: file, target });
      for (const match of content.matchAll(/uid(?:=|\s*=\s*)"(uid:\/\/[^"\s]+)"/g)) {
        const owners = uidOwners.get(match[1]) ?? []; owners.push(file); uidOwners.set(match[1], owners);
      }
      if (extname(file) === '.tscn') this.findOrphanNodes(file, content, orphanNodes);
    }
    const incoming = new Set(Object.values(graph).flat());
    const projectConfig = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    const roots = new Set([...projectConfig.matchAll(/res:\/\/([^"\s]+)/g)].map(match => match[1]));
    return {
      scanned_files: files.length, graph, broken_references: brokenReferences,
      duplicate_uids: [...uidOwners.entries()].filter(([, owners]) => new Set(owners).size > 1)
        .map(([uid, owners]) => ({ uid, files: [...new Set(owners)] })),
      cycles: this.cycles(graph), orphan_resources: files.filter(file => !incoming.has(file) && !roots.has(file)),
      orphan_nodes: orphanNodes,
      main_scene_structure: this.mainSceneStructure(projectPath, projectConfig, allowProceduralMainScene),
      limits: { max_files: files.length },
    };
  }

  private mainSceneStructure(
    projectPath: string,
    projectConfig: string,
    allowProceduralMainScene: boolean,
  ): Record<string, unknown> {
    const configured = /run\/main_scene\s*=\s*"res:\/\/([^"]+)"/.exec(projectConfig)?.[1];
    if (!configured) return { configured: false, warning: 'main_scene_not_configured' };
    const scenePath = join(projectPath, configured);
    if (!existsSync(scenePath) || extname(configured).toLowerCase() !== '.tscn') {
      return { configured: true, scene_path: configured, inspectable: false, warning: 'main_scene_not_text_inspectable' };
    }
    const scene = readFileSync(scenePath, 'utf8');
    const nodeCount = [...scene.matchAll(/^\[node\s+/gm)].length;
    const scriptRefs = new Map(
      [...scene.matchAll(/^\[ext_resource\s+type="Script"\s+path="res:\/\/([^"]+)"\s+id="([^"]+)"/gm)]
        .map(match => [match[2], match[1]] as const),
    );
    const rootBlock = /^\[node\s+[^\]]+\]\s*\n([\s\S]*?)(?=^\[|$)/m.exec(scene)?.[1] ?? '';
    const rootScriptId = /script\s*=\s*ExtResource\("([^"]+)"\)/.exec(rootBlock)?.[1];
    const rootScriptPath = rootScriptId ? scriptRefs.get(rootScriptId) : undefined;
    const rootScript = rootScriptPath && existsSync(join(projectPath, rootScriptPath))
      ? readFileSync(join(projectPath, rootScriptPath), 'utf8')
      : '';
    const constructsAtStartup = /func\s+_ready\s*\([^)]*\)[\s\S]{0,12000}\b(?:add_child|instantiate|new)\s*\(/.test(rootScript);
    const trivial = nodeCount <= 1;
    const warning = trivial && constructsAtStartup && !allowProceduralMainScene
      ? 'trivial_main_scene_with_procedural_startup_hierarchy'
      : null;
    return {
      configured: true,
      scene_path: configured,
      inspectable: true,
      persisted_node_count: nodeCount,
      root_script: rootScriptPath ?? null,
      constructs_persistent_hierarchy_at_startup: constructsAtStartup,
      explicit_procedural_requirement: allowProceduralMainScene,
      meaningful_persisted_structure: !trivial || allowProceduralMainScene,
      warning,
      recommendation: warning
        ? 'Persist meaningful game hierarchy/resources in the scene, or rerun with allowProceduralMainScene only when procedural construction is intentional.'
        : null,
    };
  }

  private findOrphanNodes(scene: string, content: string, output: { scene: string; node: string; parent: string }[]): void {
    const known = new Set(['.']);
    for (const match of content.matchAll(/^\[node\s+([^\]]+)\]$/gm)) {
      const name = /(?:^|\s)name="([^"]+)"/.exec(match[1])?.[1];
      if (!name) continue;
      const parent = /(?:^|\s)parent="([^"]+)"/.exec(match[1])?.[1] ?? '.';
      if (parent !== '.' && !known.has(parent)) output.push({ scene, node: name, parent });
      known.add(parent === '.' ? name : `${parent}/${name}`);
    }
  }

  private cycles(graph: Record<string, string[]>): string[][] {
    const cycles: string[][] = []; const visiting = new Set<string>(); const visited = new Set<string>();
    const visit = (node: string, path: string[]): void => {
      if (visiting.has(node)) { const start = path.indexOf(node); cycles.push([...path.slice(start), node]); return; }
      if (visited.has(node)) return;
      visiting.add(node); for (const next of graph[node] ?? []) visit(next, [...path, node]);
      visiting.delete(node); visited.add(node);
    };
    for (const node of Object.keys(graph)) visit(node, []);
    return cycles;
  }

  private allProjectFiles(projectPath: string, maxFiles: number): string[] {
    const files: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (['.godot', '.git', 'node_modules'].includes(entry.name)) continue;
        const full = join(directory, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) {
          files.push(relative(projectPath, full).replaceAll('\\', '/'));
          if (files.length > maxFiles) throw new Error(`Project exceeds maxFiles limit (${maxFiles}).`);
        }
      }
    };
    walk(projectPath);
    return files.sort();
  }

  private auditAssets(projectPath: string, maxFiles: number): Record<string, unknown> {
    let files: string[];
    try { files = this.allProjectFiles(projectPath, maxFiles); }
    catch (error: unknown) { return { error: errorMessage(error), complete: false }; }
    const categories: Record<string, string[]> = {
      scenes: [], textures: [], models: [], animations: [], audio: [], fonts: [], shaders: [], imported: [],
    };
    const extensionMap: Record<string, string> = {
      '.tscn': 'scenes', '.scn': 'scenes', '.png': 'textures', '.svg': 'textures', '.jpg': 'textures', '.jpeg': 'textures',
      '.webp': 'textures', '.glb': 'models', '.gltf': 'models', '.obj': 'models', '.fbx': 'models', '.anim': 'animations',
      '.wav': 'audio', '.ogg': 'audio', '.mp3': 'audio', '.ttf': 'fonts', '.otf': 'fonts', '.gdshader': 'shaders',
    };
    for (const file of files) {
      const lower = file.toLowerCase();
      const category = extensionMap[extname(lower)];
      if (category) categories[category].push(file);
      if (lower.startsWith('.godot/imported/')) categories.imported.push(file);
    }
    return { complete: true, files_scanned: files.length, categories, bounded: files.length >= maxFiles };
  }

  private auditLocalization(projectPath: string, maxFiles: number): Record<string, unknown> {
    let files: string[];
    try { files = this.allProjectFiles(projectPath, maxFiles); }
    catch (error: unknown) { return { error: errorMessage(error), complete: false }; }
    const sources = files.filter(file => /\.(csv|po|pot)$/i.test(file));
    const entries: Record<string, unknown>[] = [];
    for (const file of sources) {
      const content = readFileSync(join(projectPath, file), 'utf8');
      if (/\.csv$/i.test(file)) {
        const lines = content.split(/\r?\n/).filter(Boolean);
        const headers = (lines.shift() ?? '').split(',').map(value => value.trim());
        const missing: string[] = [];
        for (const line of lines) {
          const columns = line.split(',');
          headers.forEach((header, index) => { if (index > 0 && !columns[index]?.trim()) missing.push(`${columns[0] ?? '?'}:${header}`); });
        }
        entries.push({ file, format: 'csv', locales: headers.slice(1), keys: lines.length, missing });
      } else {
        const ids = [...content.matchAll(/^msgid\s+"(.*)"$/gm)].map(match => match[1]);
        const untranslated = [...content.matchAll(/^msgstr\s+""$/gm)].length;
        entries.push({ file, format: 'po', keys: ids.length, untranslated });
      }
    }
    return { complete: true, source_files: entries, source_count: entries.length };
  }

  private auditAccessibility(projectPath: string, maxFiles: number): Record<string, unknown> {
    let files: string[];
    try { files = this.allProjectFiles(projectPath, maxFiles); }
    catch (error: unknown) { return { error: errorMessage(error), complete: false }; }
    const scenes = files.filter(file => /\.(tscn|scn)$/i.test(file));
    const controls: Record<string, unknown>[] = [];
    for (const file of scenes) {
      const content = readFileSync(join(projectPath, file), 'utf8');
      for (const match of content.matchAll(/^\[node\s+([^\]]+type="([A-Za-z0-9_]+)"[^\]]*)\]$/gm)) {
        const attributes = match[1];
        const type = match[2];
        if (!type.endsWith('Control') && !['Button', 'Label', 'LineEdit', 'TextEdit', 'CheckBox', 'Slider', 'Tree'].includes(type)) continue;
        const name = /name="([^"]+)"/.exec(attributes)?.[1] ?? '?';
        const hasText = new RegExp(`^text\\s*=`, 'm').test(content.slice(match.index ?? 0, (match.index ?? 0) + 1200));
        const hasMinimum = new RegExp(`^custom_minimum_size\\s*=`, 'm').test(content.slice(match.index ?? 0, (match.index ?? 0) + 1200));
        controls.push({ file, name, type, has_text: hasText, has_minimum_size: hasMinimum,
          warnings: type === 'Button' && !hasText ? ['button_without_text_or_label'] : [] });
      }
    }
    return { complete: true, scenes_scanned: scenes.length, controls, warning_count: controls.reduce((n, control) => n + (control.warnings as string[]).length, 0) };
  }

  private auditExtensions(projectPath: string, maxFiles: number): Record<string, unknown> {
    let files: string[];
    try { files = this.allProjectFiles(projectPath, maxFiles); }
    catch (error: unknown) { return { error: errorMessage(error), complete: false }; }
    const extensionFiles = files.filter(file => file.toLowerCase().endsWith('.gdextension'));
    const records = extensionFiles.map(file => {
      const content = readFileSync(join(projectPath, file), 'utf8');
      return { file, has_entry_symbol: /entry_symbol\s*=/.test(content), libraries: [...content.matchAll(/library\/[A-Za-z0-9_]+\s*=\s*"([^"]+)"/g)].map(match => match[1]),
        has_native_library: /library\/|entry_symbol\s*=/.test(content) };
    });
    return { complete: true, extensions: records, extension_count: records.length, build_required: records.length > 0 };
  }
}

interface ExportPresetRecord {
  name: string;
  platform: string;
  runnable: boolean;
  export_path: string | null;
  options: Record<string, unknown>;
}

/** Validates export prerequisites and owns export/artifact/smoke evidence. */
export class ExportReadinessService {
  constructor(private readonly context: ProjectHandlerServiceContext) {}

  async execute(args: ToolArguments): Promise<ToolResponse> {
    args = normalizeParameters(args || {});
    throwIfCancelled();
    const total = args.action === 'export_smoke' ? 4 : 2;
    await reportProgress(0, total, 'Validating export preset and project');
    if (!args.projectPath || !args.action || !args.presetName) {
      return createErrorResponse('projectPath, action, and presetName are required.');
    }
    if (!validProject(this.context, args.projectPath)) return createErrorResponse('Invalid project path.');
    const presetResult = this.readPreset(args.projectPath, args.presetName);
    if ('error' in presetResult) return createErrorResponse(JSON.stringify({ ready: false, category: presetResult.category, message: presetResult.error }, null, 2));
    if (!this.context.executable.path) await this.context.executable.detect();
    if (!this.context.executable.path) return createErrorResponse('Could not find Godot executable.');
    const engine = await this.engineInfo(this.context.executable.path);
    if ('error' in engine) return createErrorResponse(engine.error);
    const readiness = this.readiness(presetResult.preset, engine.version, args.debug === true);
    await reportProgress(1, total, 'Inspected engine, export preset, and templates');
    if (args.action === 'inspect') {
      await reportProgress(2, 2, 'Export readiness inspection complete');
      return this.response({ engine, preset: presetResult.preset, ...readiness });
    }
    if (args.action !== 'export_smoke') return createErrorResponse('action must be inspect or export_smoke.');
    if (typeof args.outputPath !== 'string') return createErrorResponse('outputPath is required for export_smoke.');
    const outputPath = isAbsolute(args.outputPath)
      ? (this.context.pathSecurity.isProjectPathAllowed(args.outputPath, true) ? resolve(args.outputPath) : null)
      : this.context.pathSecurity.resolveProjectPath(args.projectPath, args.outputPath);
    if (!outputPath) return createErrorResponse('Invalid output path.');
    if (!readiness.ready) return createErrorResponse(JSON.stringify({ engine,
      preset: presetResult.preset, ...readiness,
      category: readiness.platform_known ? 'missing_templates' : 'unsupported_platform' }, null, 2));
    try { mkdirSync(dirname(outputPath), { recursive: true }); }
    catch (error: unknown) {
      return createErrorResponse(JSON.stringify({ ready: true, category: 'output_path_invalid',
        message: errorMessage(error), output_path: args.outputPath }, null, 2));
    }
    const exported = await this.run(this.context.executable.path, [
      '--headless', '--path', args.projectPath, args.debug ? '--export-debug' : '--export-release', args.presetName, outputPath,
    ], args.projectPath, Math.round((args.timeoutSeconds ?? 120) * 1000));
    await reportProgress(2, total, 'Godot export process completed');
    if (!exported.ok) return createErrorResponse(JSON.stringify({ ready: true, category: this.classifyExportFailure(exported),
      engine, preset: presetResult.preset, process: exported }, null, 2));
    if (!existsSync(outputPath)) return createErrorResponse(JSON.stringify({ ready: true, category: 'artifact_missing',
      message: 'Godot exited successfully but did not create the requested artifact.', process: exported }, null, 2));
    const artifact = this.artifact(outputPath, args.projectPath);
    await reportProgress(3, total, 'Inspected exported artifact');
    const smokeEnabled = args.smoke !== false;
    let smoke: Record<string, unknown> = { attempted: false, supported: false };
    if (smokeEnabled && presetResult.preset.platform === 'Linux' && process.platform === 'linux') {
      const result = await this.run(outputPath, ['--headless', '--quit-after', String(args.smokeTimeoutSeconds ?? 5)],
        dirname(outputPath), Math.round(((args.smokeTimeoutSeconds ?? 5) + 10) * 1000));
      const expected = typeof args.expectedOutput === 'string' ? args.expectedOutput : null;
      const matched = expected === null || result.stdout.includes(expected);
      smoke = { attempted: true, supported: true, passed: result.ok && matched,
        expected_output: expected, output_matched: matched, process: result };
      if (!result.ok || !matched) return createErrorResponse(JSON.stringify({ ready: true, category: 'smoke_failed', engine,
        preset: presetResult.preset, artifact, smoke }, null, 2));
    }
    await reportProgress(4, total, smoke.attempted ? 'Export smoke run complete' : 'Export readiness workflow complete');
    return this.response({ ready: true, category: 'success', engine, preset: presetResult.preset,
      process: exported, artifact, smoke });
  }

  private readPreset(projectPath: string, name: unknown): { preset: ExportPresetRecord } | { error: string; category: string } {
    const configPath = join(projectPath, 'export_presets.cfg');
    if (!existsSync(configPath)) return { error: 'export_presets.cfg does not exist.', category: 'preset_config_missing' };
    const document = parseIniDocument(readFileSync(configPath, 'utf8'));
    for (const [section, values] of Object.entries(document)) {
      const match = /^preset\.(\d+)$/.exec(section);
      if (!match || decodeGodotSetting(values.name) !== name) continue;
      const options = document[`preset.${match[1]}.options`] ?? {};
      const platform = decodeGodotSetting(values.platform);
      const exportPath = decodeGodotSetting(values.export_path);
      return { preset: { name: String(name), platform: typeof platform === 'string' ? platform : '',
        runnable: decodeGodotSetting(values.runnable) === true,
        export_path: typeof exportPath === 'string' ? exportPath : null,
        options: Object.fromEntries(Object.entries(options).map(([key, value]) => [key, decodeGodotSetting(value)])) } };
    }
    return { error: `Export preset not found: ${String(name)}`, category: 'preset_not_found' };
  }

  private async engineInfo(executable: string): Promise<{ version: string; executable: string } | { error: string }> {
    const result = await this.run(executable, ['--version'], process.cwd(), 10_000);
    if (!result.ok) return { error: `Could not query Godot version: ${result.stderr || result.stdout}` };
    const raw = result.stdout.trim();
    const match = /^(\d+\.\d+)(?:\.\d+)?\.([A-Za-z]+)/.exec(raw);
    return { version: match ? `${match[1]}.${match[2].toLowerCase()}` : raw.split('.')[0], executable };
  }

  private readiness(preset: ExportPresetRecord, version: string, debug: boolean): Record<string, unknown> & { ready: boolean } {
    const mode = debug ? 'debug' : 'release';
    const customTemplate = preset.options[`custom_template/${mode}`];
    const templateDirs = this.templateDirectories(version);
    const templateName = this.templateName(preset.platform, mode);
    const installed = templateName
      ? templateDirs.find(path => existsSync(join(path, templateName))) ?? null
      : null;
    const customExists = typeof customTemplate === 'string' && customTemplate.length > 0 && existsSync(customTemplate);
    const platformKnown = templateName !== null;
    return { ready: platformKnown && (customExists || installed !== null), template_version: version,
      template_directory: installed, searched_template_directories: templateDirs,
      expected_template_file: templateName, platform_known: platformKnown,
      custom_template: customTemplate || null, custom_template_exists: customExists,
      platform_supported_for_smoke: preset.platform === 'Linux' && process.platform === 'linux' };
  }

  private templateName(platform: string, mode: 'debug' | 'release'): string | null {
    return ({
      Linux: `linux_${mode}.x86_64`, Windows: `windows_${mode}_x86_64.exe`,
      macOS: `macos.zip`, Web: `web_${mode}.zip`,
    } as Record<string, string>)[platform] ?? null;
  }

  private templateDirectories(version: string): string[] {
    const roots = new Set<string>();
    if (process.env.GODOT_MCP_EXPORT_XDG_DATA_HOME) roots.add(process.env.GODOT_MCP_EXPORT_XDG_DATA_HOME);
    if (process.env.XDG_DATA_HOME) roots.add(process.env.XDG_DATA_HOME);
    roots.add(join(homedir(), '.local', 'share'));
    if (process.env.APPDATA) roots.add(process.env.APPDATA);
    roots.add(join(homedir(), 'Library', 'Application Support'));
    return [...roots].map(root => join(root, 'godot', 'export_templates', version));
  }

  private artifact(path: string, projectPath: string): Record<string, unknown> {
    const data = readFileSync(path); const stat = statSync(path);
    const pckPath = path.replace(/\.[^./]+$/, '.pck');
    return { path: relative(projectPath, path).replaceAll('\\', '/'), bytes: stat.size,
      sha256: createHash('sha256').update(data).digest('hex'), executable: (stat.mode & 0o111) !== 0,
      companion_pck: existsSync(pckPath) ? relative(projectPath, pckPath).replaceAll('\\', '/') : null };
  }

  private classifyExportFailure(result: { timed_out: boolean; stdout: string; stderr: string }): string {
    if (result.timed_out) return 'timeout';
    const output = `${result.stdout}\n${result.stderr}`;
    if (/template|export templates/i.test(output)) return 'missing_templates';
    if (/preset.*not found|invalid preset/i.test(output)) return 'preset_not_found';
    if (/project\.godot|main scene|parse error/i.test(output)) return 'invalid_project';
    return 'export_failed';
  }

  private async run(executable: string, args: string[], cwd: string, timeout: number): Promise<{
    ok: boolean; exit_code: number | string | null; timed_out: boolean; duration_ms: number; stdout: string; stderr: string;
  }> {
    const started = performance.now();
    const signal = executionSignal();
    throwIfCancelled(signal);
    try {
      const { stdout, stderr } = await execFileAsync(executable, args, {
        cwd, timeout, maxBuffer: 16 * 1024 * 1024, signal,
      });
      return { ok: true, exit_code: 0, timed_out: false, duration_ms: Math.round(performance.now() - started),
        stdout: (stdout ?? '').slice(-128 * 1024), stderr: (stderr ?? '').slice(-128 * 1024) };
    } catch (error: unknown) {
      rethrowCancellation(error);
      const failure = error as { code?: number | string; signal?: string; killed?: boolean; stdout?: string; stderr?: string };
      return { ok: false, exit_code: failure.code ?? null, timed_out: failure.killed === true || failure.signal != null,
        duration_ms: Math.round(performance.now() - started), stdout: (failure.stdout ?? '').slice(-128 * 1024),
        stderr: (failure.stderr ?? '').slice(-128 * 1024) };
    }
  }

  private response(value: Record<string, unknown>): ToolResponse {
    return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
  }
}

interface DotnetProcessResult {
  ok: boolean;
  exit_code: number | string | null;
  timed_out: boolean;
  duration_ms: number;
  stdout: string;
  stderr: string;
}

/** Detects, restores, builds, and runs projects against the matching Godot.NET.Sdk. */
export class DotnetWorkflowService {
  constructor(private readonly context: ProjectHandlerServiceContext) {}

  async execute(args: ToolArguments): Promise<ToolResponse> {
    args = normalizeParameters(args || {});
    throwIfCancelled();
    const total = args.action === 'run' ? 5 : args.action === 'build' ? 4 : args.action === 'restore' ? 3 : 2;
    await reportProgress(0, total, 'Inspecting Godot .NET project');
    if (!args.projectPath || !args.action) return createErrorResponse('projectPath and action are required.');
    if (!validProject(this.context, args.projectPath)) return createErrorResponse('Invalid project path.');
    const project = this.projectInfo(args.projectPath, args.csprojPath);
    if ('error' in project) return createErrorResponse(JSON.stringify({ ready: false, category: project.category, message: project.error }, null, 2));
    if (!this.context.executable.path) await this.context.executable.detect();
    if (!this.context.executable.path) return createErrorResponse('Could not find Godot executable.');
    const engineResult = await this.run(this.context.executable.path, ['--version'], args.projectPath, 10_000);
    const dotnetResult = await this.run('dotnet', ['--version'], args.projectPath, 10_000);
    const engineVersion = engineResult.stdout.trim();
    const engineMatch = /^(\d+\.\d+)(?:\.\d+)?/.exec(engineVersion);
    const sdkMatch = /^Godot\.NET\.Sdk\/(\d+\.\d+\.\d+)$/.exec(project.sdk);
    const mono = /(?:^|\.)mono(?:\.|$)/i.test(engineVersion);
    const dotnetAvailable = dotnetResult.ok;
    const versionCompatible = Boolean(engineMatch && sdkMatch && sdkMatch[1].startsWith(`${engineMatch[1]}.`));
    const readiness = { ready: engineResult.ok && mono && dotnetAvailable && versionCompatible,
      engine: { executable: this.context.executable.path, version: engineVersion, dotnet_enabled: mono },
      dotnet: { available: dotnetAvailable, version: dotnetResult.ok ? dotnetResult.stdout.trim() : null },
      project };
    await reportProgress(1, total, 'Inspected Godot and .NET SDK compatibility');
    if (args.action === 'inspect') {
      await reportProgress(2, 2, '.NET readiness inspection complete');
      return this.response(readiness);
    }
    if (!['restore', 'build', 'run'].includes(String(args.action))) {
      return createErrorResponse('action must be inspect, restore, build, or run.');
    }
    if (!readiness.ready) return createErrorResponse(JSON.stringify({ ...readiness,
      category: !mono ? 'dotnet_editor_required' : !dotnetAvailable ? 'dotnet_sdk_missing' : 'sdk_version_mismatch' }, null, 2));
    const timeoutMs = Math.round((args.timeoutSeconds ?? 120) * 1000);
    const restore = await this.run('dotnet', ['restore', project.path, '--nologo'], args.projectPath, timeoutMs);
    const restoreEvidence = { ...restore, diagnostics: this.diagnostics(restore) };
    await reportProgress(2, total, '.NET restore completed');
    if (!restore.ok) return createErrorResponse(JSON.stringify({ ...readiness,
      category: restore.timed_out ? 'timeout' : 'restore_failed', restore: restoreEvidence }, null, 2));
    if (args.action === 'restore') {
      await reportProgress(3, 3, '.NET restore workflow complete');
      return this.response({ ...readiness, category: 'success', restore: restoreEvidence });
    }
    const configuration = args.configuration === 'Release' ? 'Release' : 'Debug';
    const build = await this.run('dotnet', ['build', project.path, '--no-restore', '--nologo',
      '--configuration', configuration], args.projectPath, timeoutMs);
    const buildEvidence = { ...build, diagnostics: this.diagnostics(build) };
    await reportProgress(3, total, `.NET ${configuration} build completed`);
    if (!build.ok) return createErrorResponse(JSON.stringify({ ...readiness,
      category: build.timed_out ? 'timeout' : 'build_failed', restore: restoreEvidence, build: buildEvidence }, null, 2));
    const artifact = this.assemblyArtifact(args.projectPath, project, configuration);
    if (args.action === 'build') {
      await reportProgress(4, 4, '.NET build workflow complete');
      return this.response({ ...readiness, category: 'success', restore: restoreEvidence, build: buildEvidence, artifact });
    }
    const run = await this.run(this.context.executable.path, ['--headless', '--path', args.projectPath,
      '--quit-after', String(args.runTimeoutSeconds ?? 5)], args.projectPath,
    Math.round(((args.runTimeoutSeconds ?? 5) + 10) * 1000));
    const expected = typeof args.expectedOutput === 'string' ? args.expectedOutput : null;
    const matched = expected === null || run.stdout.includes(expected);
    await reportProgress(4, total, '.NET project smoke run completed');
    if (!run.ok || !matched) return createErrorResponse(JSON.stringify({ ...readiness,
      category: run.timed_out ? 'timeout' : 'run_failed', restore: restoreEvidence,
      build: buildEvidence, artifact, run: { ...run, expected_output: expected, output_matched: matched } }, null, 2));
    await reportProgress(5, 5, '.NET restore, build, and run workflow complete');
    return this.response({ ...readiness, category: 'success', restore: restoreEvidence,
      build: buildEvidence, artifact, run: { ...run, expected_output: expected, output_matched: matched } });
  }

  private projectInfo(projectPath: string, supplied: unknown): {
    path: string; relative_path: string; sdk: string; sdk_version: string; target_framework: string; assembly_name: string;
  } | { error: string; category: string } {
    const candidates = typeof supplied === 'string' ? [supplied] : readdirSync(projectPath)
      .filter(name => name.endsWith('.csproj'));
    if (candidates.length !== 1) return { error: candidates.length === 0
      ? 'No .csproj was found; pass csprojPath or create a .NET project.'
      : 'Multiple .csproj files found; pass csprojPath.', category: 'csproj_not_found' };
    const relativePath = candidates[0].replaceAll('\\', '/');
    if (!validatePath(relativePath)) return { error: 'Invalid csprojPath.', category: 'invalid_path' };
    const fullPath = this.context.pathSecurity.resolveProjectPath(projectPath, relativePath);
    if (!fullPath || !existsSync(fullPath)) return { error: `Project file does not exist: ${relativePath}`, category: 'csproj_not_found' };
    const content = readFileSync(fullPath, 'utf8');
    const sdk = /<Project\s+Sdk="([^"]+)"/.exec(content)?.[1] ?? '';
    const sdkVersion = /^Godot\.NET\.Sdk\/(.+)$/.exec(sdk)?.[1] ?? '';
    const target = /<TargetFramework>([^<]+)<\/TargetFramework>/.exec(content)?.[1] ?? '';
    const assembly = /<RootNamespace>([^<]+)<\/RootNamespace>/.exec(content)?.[1]
      ?? /<AssemblyName>([^<]+)<\/AssemblyName>/.exec(content)?.[1]
      ?? relativePath.replace(/\.csproj$/i, '');
    if (!sdkVersion) return { error: 'The project does not use a versioned Godot.NET.Sdk.', category: 'invalid_csproj' };
    return { path: fullPath, relative_path: relativePath, sdk, sdk_version: sdkVersion,
      target_framework: target, assembly_name: assembly };
  }

  private diagnostics(result: DotnetProcessResult): { severity: string; code: string | null; file: string | null; line: number | null; message: string }[] {
    const output = `${result.stdout}\n${result.stderr}`;
    const diagnostics: { severity: string; code: string | null; file: string | null; line: number | null; message: string }[] = [];
    for (const line of output.split(/\r?\n/)) {
      const match = /^(?:(.+?)\((\d+)(?:,\d+)?\):\s*)?(error|warning)\s+([A-Z]+\d+)?\s*:\s*(.+?)(?:\s+\[[^\]]+\])?$/i.exec(line.trim());
      if (!match) continue;
      diagnostics.push({ file: match[1] ?? null, line: match[2] ? Number(match[2]) : null,
        severity: match[3].toLowerCase(), code: match[4] ?? null, message: match[5] });
      if (diagnostics.length >= 512) break;
    }
    return diagnostics;
  }

  private assemblyArtifact(projectPath: string, project: { target_framework: string; assembly_name: string }, configuration: string): Record<string, unknown> | null {
    const candidates = [
      join(projectPath, 'bin', configuration, project.target_framework, `${project.assembly_name}.dll`),
      join(projectPath, '.godot', 'mono', 'temp', 'bin', configuration, `${project.assembly_name}.dll`),
      join(projectPath, '.godot', 'mono', 'temp', 'bin', configuration, project.target_framework, `${project.assembly_name}.dll`),
    ];
    const path = candidates.find(existsSync);
    if (!path) return null;
    const data = readFileSync(path);
    return { path: relative(projectPath, path).replaceAll('\\', '/'), bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex') };
  }

  private async run(executable: string, args: string[], cwd: string, timeout: number): Promise<DotnetProcessResult> {
    const started = performance.now();
    const signal = executionSignal();
    throwIfCancelled(signal);
    try {
      const { stdout, stderr } = await execFileAsync(executable, args, {
        cwd, timeout, maxBuffer: 16 * 1024 * 1024, signal,
      });
      return { ok: true, exit_code: 0, timed_out: false, duration_ms: Math.round(performance.now() - started),
        stdout: (stdout ?? '').slice(-256 * 1024), stderr: (stderr ?? '').slice(-256 * 1024) };
    } catch (error: unknown) {
      rethrowCancellation(error);
      const failure = error as { code?: number | string; signal?: string; killed?: boolean; stdout?: string; stderr?: string };
      return { ok: false, exit_code: failure.code ?? null, timed_out: failure.killed === true || failure.signal != null,
        duration_ms: Math.round(performance.now() - started), stdout: (failure.stdout ?? '').slice(-256 * 1024),
        stderr: (failure.stderr ?? '').slice(-256 * 1024) };
    }
  }

  private response(value: Record<string, unknown>): ToolResponse {
    return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
  }
}

/** Installs hash-pinned local EditorPlugins and validates real editor reloads. */
export class AddonManagementService {
  private static readonly maxFiles = 2048;
  private static readonly maxBytes = 64 * 1024 * 1024;

  constructor(private readonly context: ProjectHandlerServiceContext) {}

  async execute(args: ToolArguments): Promise<ToolResponse> {
    args = normalizeParameters(args || {});
    if (!args.projectPath || !args.action || typeof args.pluginName !== 'string') {
      return createErrorResponse('projectPath, action, and pluginName are required.');
    }
    if (!validProject(this.context, args.projectPath)) return createErrorResponse('Invalid project path.');
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(args.pluginName)) return createErrorResponse('Invalid pluginName.');
    const target = join(args.projectPath, 'addons', args.pluginName);
    if (args.action === 'inspect') return this.inspect(args.projectPath, args.pluginName, target);
    if (args.action === 'enable' || args.action === 'disable') {
      if (!existsSync(join(target, 'plugin.cfg'))) return createErrorResponse(`Add-on is not installed: ${args.pluginName}`);
      return this.setEnabledAndReload(args.projectPath, args.pluginName, args.action === 'enable', args.expectedOutput);
    }
    if (args.action === 'remove') {
      if (!existsSync(target)) return createErrorResponse(`Add-on is not installed: ${args.pluginName}`);
      const disabled = await this.setEnabledAndReload(args.projectPath, args.pluginName, false, undefined);
      if (disabled.isError) return disabled;
      rmSync(target, { recursive: true, force: true });
      return this.response({ action: 'remove', plugin_name: args.pluginName, removed: true, enabled: false });
    }
    if (args.action !== 'install' && args.action !== 'update') {
      return createErrorResponse('action must be inspect, install, update, remove, enable, or disable.');
    }
    if (typeof args.sourcePath !== 'string' || typeof args.expectedSha256 !== 'string') {
      return createErrorResponse('sourcePath and expectedSha256 are required for install/update.');
    }
    const source = isAbsolute(args.sourcePath) ? resolve(args.sourcePath)
      : this.context.pathSecurity.resolveProjectPath(args.projectPath, args.sourcePath);
    if (!source || !this.context.pathSecurity.isProjectPathAllowed(source) || !existsSync(source) || !lstatSync(source).isDirectory()) {
      return createErrorResponse('sourcePath must be an allowed local add-on directory.');
    }
    const installed = existsSync(target);
    if (args.action === 'install' && installed) return createErrorResponse(`Add-on is already installed: ${args.pluginName}`);
    if (args.action === 'update' && !installed) return createErrorResponse(`Add-on is not installed: ${args.pluginName}`);
    const sourceEvidence = this.hashTree(source);
    if ('error' in sourceEvidence) return createErrorResponse(sourceEvidence.error);
    if (sourceEvidence.sha256 !== args.expectedSha256.toLowerCase()) {
      return createErrorResponse(JSON.stringify({ category: 'hash_mismatch', expected_sha256: args.expectedSha256,
        actual_sha256: sourceEvidence.sha256, files: sourceEvidence.files, bytes: sourceEvidence.bytes }, null, 2));
    }
    const metadata = await this.metadata(source);
    if ('error' in metadata) return createErrorResponse(JSON.stringify({ category: 'invalid_plugin', message: metadata.error }, null, 2));
    const compatibility = await this.compatibility(metadata);
    if (!compatibility.compatible) return createErrorResponse(JSON.stringify({ category: 'incompatible_plugin',
      metadata, compatibility }, null, 2));
    const wasEnabled = this.enabledPlugins(args.projectPath).includes(this.pluginPath(args.pluginName));
    const staging = join(args.projectPath, 'addons', `.${args.pluginName}.staging-${randomUUID()}`);
    const backup = join(args.projectPath, 'addons', `.${args.pluginName}.backup-${randomUUID()}`);
    mkdirSync(dirname(staging), { recursive: true });
    try {
      this.copyTree(source, staging);
      if (installed) renameSync(target, backup);
      renameSync(staging, target);
      const reload = await this.reload(args.projectPath, wasEnabled ? args.expectedOutput : undefined);
      if (!reload.ok) {
        rmSync(target, { recursive: true, force: true });
        if (installed && existsSync(backup)) renameSync(backup, target);
        return createErrorResponse(JSON.stringify({ category: 'reload_failed', rolled_back: true, reload }, null, 2));
      }
      rmSync(backup, { recursive: true, force: true });
      let enabled = this.enabledPlugins(args.projectPath).includes(this.pluginPath(args.pluginName));
      if (args.enable === true && !enabled) {
        const enabledResult = await this.setEnabledAndReload(args.projectPath, args.pluginName, true, args.expectedOutput);
        if (enabledResult.isError) return enabledResult;
        enabled = true;
      }
      return this.response({ action: args.action, plugin_name: args.pluginName, installed: true, enabled,
        pin: sourceEvidence, metadata, compatibility, reload });
    } catch (error: unknown) {
      rmSync(staging, { recursive: true, force: true });
      if (!existsSync(target) && existsSync(backup)) renameSync(backup, target);
      rethrowCancellation(error);
      return createErrorResponse(`Add-on ${args.action} failed: ${errorMessage(error)}`);
    } finally { rmSync(backup, { recursive: true, force: true }); }
  }

  private async inspect(projectPath: string, pluginName: string, target: string): Promise<ToolResponse> {
    if (!existsSync(target)) return this.response({ plugin_name: pluginName, installed: false, enabled: false });
    const hash = this.hashTree(target);
    if ('error' in hash) return createErrorResponse(hash.error);
    const metadata = await this.metadata(target);
    const compatibility = 'error' in metadata ? null : await this.compatibility(metadata);
    return this.response({ plugin_name: pluginName, installed: true,
      enabled: this.enabledPlugins(projectPath).includes(this.pluginPath(pluginName)), pin: hash,
      ...('error' in metadata ? { valid: false, error: metadata.error }
        : { valid: compatibility?.compatible === true, metadata, compatibility }) });
  }

  private async metadata(root: string): Promise<Record<string, unknown> | { error: string }> {
    const configPath = join(root, 'plugin.cfg');
    if (!existsSync(configPath)) return { error: 'plugin.cfg is required.' };
    const values = parseIniDocument(readFileSync(configPath, 'utf8')).plugin;
    if (!values) return { error: 'plugin.cfg must contain a [plugin] section.' };
    const script = decodeGodotSetting(values.script);
    if (typeof script !== 'string' || !validatePath(script) || !existsSync(join(root, script))) {
      return { error: 'The [plugin] script must reference an existing project-relative file.' };
    }
    const source = readFileSync(join(root, script), 'utf8');
    if (!/@tool\b/.test(source) || !/extends\s+EditorPlugin\b/.test(source)) {
      return { error: 'The plugin script must use @tool and extend EditorPlugin.' };
    }
    return { name: decodeGodotSetting(values.name), description: decodeGodotSetting(values.description),
      author: decodeGodotSetting(values.author), version: decodeGodotSetting(values.version), script,
      minimum_godot_version: decodeGodotSetting(values.minimum_godot_version) };
  }

  private hashTree(root: string): { sha256: string; files: number; bytes: number } | { error: string } {
    const files: { relativePath: string; fullPath: string; bytes: number }[] = [];
    let bytes = 0;
    const walk = (directory: string): string | null => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const fullPath = join(directory, entry.name); const stat = lstatSync(fullPath);
        if (stat.isSymbolicLink()) return `Symbolic links are not allowed in add-ons: ${relative(root, fullPath)}`;
        if (entry.isDirectory()) { const error = walk(fullPath); if (error) return error; }
        else if (entry.name.endsWith('.uid')) continue;
        else if (entry.isFile()) {
          bytes += stat.size;
          files.push({ relativePath: relative(root, fullPath).replaceAll('\\', '/'), fullPath, bytes: stat.size });
          if (files.length > AddonManagementService.maxFiles) return `Add-on exceeds ${AddonManagementService.maxFiles} files.`;
          if (bytes > AddonManagementService.maxBytes) return `Add-on exceeds ${AddonManagementService.maxBytes} bytes.`;
        }
      }
      return null;
    };
    const error = walk(root); if (error) return { error };
    const hash = createHash('sha256');
    for (const file of files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
      hash.update(file.relativePath).update('\0').update(readFileSync(file.fullPath)).update('\0');
    }
    return { sha256: hash.digest('hex'), files: files.length, bytes };
  }

  private copyTree(source: string, destination: string): void {
    mkdirSync(destination, { recursive: true });
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const from = join(source, entry.name); const to = join(destination, entry.name);
      if (entry.isDirectory()) this.copyTree(from, to);
      else if (entry.isFile()) copyFileSync(from, to);
    }
  }

  private async compatibility(metadata: Record<string, unknown>): Promise<Record<string, unknown> & { compatible: boolean }> {
    if (!this.context.executable.path) await this.context.executable.detect();
    if (!this.context.executable.path) return { compatible: false, reason: 'godot_not_found' };
    const versionResult = await this.run(this.context.executable.path, ['--version'], process.cwd(), 10_000);
    const version = /^(\d+)\.(\d+)/.exec(versionResult.stdout);
    const minimumRaw = metadata.minimum_godot_version;
    const minimum = typeof minimumRaw === 'string' ? /^(\d+)\.(\d+)/.exec(minimumRaw) : null;
    const compatible = versionResult.ok && (!minimum || Boolean(version)
      && (Number(version![1]) > Number(minimum[1])
        || Number(version![1]) === Number(minimum[1]) && Number(version![2]) >= Number(minimum[2])));
    return { compatible, engine_version: versionResult.stdout.trim(), minimum_godot_version: minimumRaw ?? null,
      reason: compatible ? null : minimum ? 'minimum_version_not_met' : 'godot_version_unavailable' };
  }

  private pluginPath(pluginName: string): string { return `res://addons/${pluginName}/plugin.cfg`; }

  private enabledPlugins(projectPath: string): string[] {
    const content = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    const document = parseIniDocument(content);
    const value = document.editor_plugins?.enabled;
    return value ? [...value.matchAll(/"([^"]+)"/g)].map(match => match[1]) : [];
  }

  private writeEnabledPlugins(projectPath: string, plugins: string[]): void {
    const configPath = join(projectPath, 'project.godot'); let content = readFileSync(configPath, 'utf8');
    const line = `enabled=PackedStringArray(${plugins.map(value => JSON.stringify(value)).join(', ')})`;
    const section = /\[editor_plugins\][\s\S]*?(?=\n\[|$)/.exec(content);
    if (!section) content += `\n[editor_plugins]\n\n${line}\n`;
    else {
      const updated = /^enabled=.*$/m.test(section[0]) ? section[0].replace(/^enabled=.*$/m, line)
        : `${section[0].trimEnd()}\n${line}\n`;
      content = content.slice(0, section.index) + updated + content.slice(section.index + section[0].length);
    }
    writeFileSync(configPath, content, 'utf8');
  }

  private async setEnabledAndReload(projectPath: string, pluginName: string, enabled: boolean, expectedOutput: unknown): Promise<ToolResponse> {
    const before = readFileSync(join(projectPath, 'project.godot'), 'utf8');
    const path = this.pluginPath(pluginName); const plugins = this.enabledPlugins(projectPath).filter(item => item !== path);
    if (enabled) plugins.push(path);
    this.writeEnabledPlugins(projectPath, plugins.sort());
    const reload = await this.reload(projectPath, expectedOutput);
    if (!reload.ok) {
      writeFileSync(join(projectPath, 'project.godot'), before, 'utf8');
      return createErrorResponse(JSON.stringify({ category: 'reload_failed', rolled_back: true, reload }, null, 2));
    }
    return this.response({ action: enabled ? 'enable' : 'disable', plugin_name: pluginName, enabled, reload });
  }

  private async reload(projectPath: string, expectedOutput: unknown): Promise<Record<string, unknown> & { ok: boolean }> {
    if (!this.context.executable.path) await this.context.executable.detect();
    if (!this.context.executable.path) return { ok: false, category: 'godot_not_found' };
    const result = await this.run(this.context.executable.path, ['--headless', '--editor', '--path', projectPath,
      '--quit-after', '3'], projectPath, 60_000);
    const expected = typeof expectedOutput === 'string' ? expectedOutput : null;
    const matched = expected === null || result.stdout.includes(expected);
    const rawDiagnostics = `${result.stdout}\n${result.stderr}`.split(/\r?\n/)
      .filter(line => /SCRIPT ERROR|Parse Error|\bERROR:/i.test(line)).slice(0, 256);
    const knownDiagnostics: string[] = [];
    const diagnostics = rawDiagnostics;
    return { ...result, ok: result.ok && matched && diagnostics.length === 0,
      expected_output: expected, output_matched: matched, diagnostics, known_diagnostics: knownDiagnostics };
  }

  private async run(executable: string, args: string[], cwd: string, timeout: number): Promise<DotnetProcessResult> {
    const started = performance.now();
    const signal = executionSignal();
    throwIfCancelled(signal);
    try {
      const { stdout, stderr } = await execFileAsync(executable, args, {
        cwd, timeout, maxBuffer: 16 * 1024 * 1024, signal,
      });
      return { ok: true, exit_code: 0, timed_out: false, duration_ms: Math.round(performance.now() - started),
        stdout: (stdout ?? '').slice(-128 * 1024), stderr: (stderr ?? '').slice(-128 * 1024) };
    } catch (error: unknown) {
      rethrowCancellation(error);
      const failure = error as { code?: number | string; signal?: string; killed?: boolean; stdout?: string; stderr?: string };
      return { ok: false, exit_code: failure.code ?? null, timed_out: failure.killed === true || failure.signal != null,
        duration_ms: Math.round(performance.now() - started), stdout: (failure.stdout ?? '').slice(-128 * 1024),
        stderr: (failure.stderr ?? '').slice(-128 * 1024) };
    }
  }

  private response(value: Record<string, unknown>): ToolResponse {
    return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
  }
}

/** Owns the common headless scene-operation delegation. */
export class SceneOperationService {
  constructor(private readonly context: ProjectHandlerServiceContext) {}

  async run(operation: string, args: ToolArguments, params: OperationParams): Promise<ToolResponse> {
    args = normalizeParameters(args || {});
    if (!args.projectPath) return createErrorResponse('projectPath is required.');
    if (!validProject(this.context, args.projectPath)) return createErrorResponse('Invalid path.');
    return this.context.operations.run(operation, args.projectPath, params);
  }
}
