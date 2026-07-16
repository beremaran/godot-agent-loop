// @test-kind: unit
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const childProcess = vi.hoisted(() => {
  const state = {
    sleep: false,
    calls: [] as { executable: string; args: string[]; options: Record<string, unknown> }[],
  };
  const promise = vi.fn(async (executable: string, args: string[], options: Record<string, unknown> = {}) => {
    state.calls.push({ executable, args, options });
    const signal = options.signal as AbortSignal | undefined;
    if (state.sleep) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 30_000);
        const onAbort = () => {
          clearTimeout(timer);
          const error = new Error(String(signal?.reason ?? 'cancelled'));
          error.name = 'AbortError';
          reject(error);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    if (args.includes('--version')) {
      return basename(executable).startsWith('dotnet')
        ? { stdout: '8.0.100\n', stderr: '' }
        : { stdout: '4.7.0.stable.mono.official\n', stderr: '' };
    }
    const exportIndex = args.findIndex(value => value === '--export-release' || value === '--export-debug');
    if (exportIndex >= 0) {
      const outputPath = args[exportIndex + 2];
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, 'export-artifact');
      return { stdout: 'exported\n', stderr: '' };
    }
    if (args.includes('--import')) return { stdout: 'WARNING: import fixture warning\n', stderr: '' };
    if (args.includes('--script')) {
      return { stdout: 'GODOT_MCP_TEST_CASE {"name":"fixture","passed":true}\n', stderr: '' };
    }
    return { stdout: 'ok\n', stderr: '' };
  });
  const callback = vi.fn();
  Object.defineProperty(callback, Symbol.for('nodejs.util.promisify.custom'), { value: promise });
  return { callback, promise, state };
});

vi.mock('child_process', () => ({ execFile: childProcess.callback }));

import { createExecutionContext, runWithExecutionContext } from '../src/execution-context.js';
import {
  DotnetWorkflowService,
  ExportReadinessService,
  ImportPipelineService,
  ProjectExportService,
  ProjectTestService,
  type ProjectHandlerServiceContext,
} from '../src/tool-handlers/project-handler-services.js';
import { PathSecurity, type ToolArguments, type ToolResponse } from '../src/utils.js';

const temporaryDirectories: string[] = [];
const previousExportDataHome = process.env.GODOT_MCP_EXPORT_XDG_DATA_HOME;

afterEach(() => {
  childProcess.state.sleep = false;
  childProcess.state.calls.length = 0;
  childProcess.promise.mockClear();
  if (previousExportDataHome === undefined) delete process.env.GODOT_MCP_EXPORT_XDG_DATA_HOME;
  else process.env.GODOT_MCP_EXPORT_XDG_DATA_HOME = previousExportDataHome;
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'godot-lifecycle-context-'));
  temporaryDirectories.push(root);
  writeFileSync(join(root, 'project.godot'), '[application]\nrun/main_scene="res://main.tscn"\n');
  writeFileSync(join(root, 'main.tscn'), '[gd_scene format=3]\n\n[node name="Main" type="Node"]\n');
  return root;
}

function serviceContext(projectPath: string): ProjectHandlerServiceContext {
  return {
    executable: { path: '/fake/godot', detect: vi.fn() } as any,
    operations: {} as any,
    pathSecurity: new PathSecurity([projectPath]),
    projectSupport: {} as any,
  };
}

async function executeWithProgress(
  tool: string,
  args: ToolArguments,
  operation: () => Promise<ToolResponse>,
  controller = new AbortController(),
): Promise<{ response: ToolResponse; reports: { progress: number; total: number; message?: string }[] }> {
  const reports: { progress: number; total: number; message?: string }[] = [];
  const context = createExecutionContext(tool, args, {
    signal: controller.signal,
    progress: { report: async (progress, total, message) => { reports.push({ progress, total, message }); } },
  });
  const response = await runWithExecutionContext(context, operation);
  return { response, reports };
}

describe('project lifecycle execution context', () => {
  it('reports completed stages for imports, project tests, export readiness/export, and .NET restore/build', async () => {
    const projectPath = project();
    const context = serviceContext(projectPath);

    const imported = await executeWithProgress('manage_import_pipeline', {
      projectPath, action: 'reimport', timeoutSeconds: 10,
    }, () => new ImportPipelineService(context).execute({ projectPath, action: 'reimport', timeoutSeconds: 10 }));
    expect(imported.response.isError).not.toBe(true);
    expect(imported.reports.map(item => [item.progress, item.total])).toEqual([[0, 3], [1, 3], [2, 3], [3, 3]]);

    writeFileSync(join(projectPath, 'test_fixture.gd'), 'extends SceneTree\n');
    const tested = await executeWithProgress('run_project_tests', {
      projectPath, action: 'run', framework: 'native', testPaths: ['test_fixture.gd'],
    }, () => new ProjectTestService(context).execute({
      projectPath, action: 'run', framework: 'native', testPaths: ['test_fixture.gd'],
    }));
    expect(tested.response.isError).not.toBe(true);
    expect(tested.reports.map(item => [item.progress, item.total])).toEqual([[0, 3], [1, 3], [2, 3], [3, 3]]);

    const exported = await executeWithProgress('export_project', {
      projectPath, presetName: 'Fixture', outputPath: 'build/fixture.bin', debug: false,
    }, () => new ProjectExportService(context).export({
      projectPath, presetName: 'Fixture', outputPath: 'build/fixture.bin', debug: false,
    }));
    expect(exported.response.isError).not.toBe(true);
    expect(exported.reports.map(item => [item.progress, item.total])).toEqual([[0, 3], [1, 3], [2, 3], [3, 3]]);

    const platform = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux';
    const template = platform === 'macOS' ? 'macos.zip'
      : platform === 'win32' ? 'windows_release_x86_64.exe' : 'linux_release.x86_64';
    const dataHome = join(projectPath, 'export-data');
    process.env.GODOT_MCP_EXPORT_XDG_DATA_HOME = dataHome;
    const templateDirectory = join(dataHome, 'godot', 'export_templates', '4.7.stable');
    mkdirSync(templateDirectory, { recursive: true });
    writeFileSync(join(templateDirectory, template), 'template');
    writeFileSync(join(projectPath, 'export_presets.cfg'), [
      '[preset.0]', 'name="Fixture"', `platform="${platform}"`, 'runnable=true', '',
      '[preset.0.options]', 'custom_template/release=""', '',
    ].join('\n'));
    const readiness = await executeWithProgress('verify_export_readiness', {
      projectPath, action: 'export_smoke', presetName: 'Fixture', outputPath: 'build/readiness.bin', smoke: false,
    }, () => new ExportReadinessService(context).execute({
      projectPath, action: 'export_smoke', presetName: 'Fixture', outputPath: 'build/readiness.bin', smoke: false,
    }));
    expect(readiness.response.isError).not.toBe(true);
    expect(readiness.reports.map(item => [item.progress, item.total])).toEqual([[0, 4], [1, 4], [2, 4], [3, 4], [4, 4]]);

    writeFileSync(join(projectPath, 'Fixture.csproj'), [
      '<Project Sdk="Godot.NET.Sdk/4.7.0">',
      '  <PropertyGroup><TargetFramework>net8.0</TargetFramework><RootNamespace>Fixture</RootNamespace></PropertyGroup>',
      '</Project>',
    ].join('\n'));
    const dotnet = await executeWithProgress('verify_dotnet_project', {
      projectPath, action: 'build', csprojPath: 'Fixture.csproj', configuration: 'Debug',
    }, () => new DotnetWorkflowService(context).execute({
      projectPath, action: 'build', csprojPath: 'Fixture.csproj', configuration: 'Debug',
    }));
    expect(dotnet.response.isError).not.toBe(true);
    expect(dotnet.reports.map(item => [item.progress, item.total])).toEqual([[0, 4], [1, 4], [2, 4], [3, 4], [4, 4]]);
    expect(childProcess.state.calls.every(call => 'signal' in call.options)).toBe(true);
  });

  it('terminates an in-flight project-test subprocess when the request is cancelled', async () => {
    const projectPath = project();
    writeFileSync(join(projectPath, 'test_cancel.gd'), 'extends SceneTree\n');
    const context = serviceContext(projectPath);
    const controller = new AbortController();
    childProcess.state.sleep = true;
    const execution = createExecutionContext('run_project_tests', {
      projectPath, action: 'run', framework: 'native', testPaths: ['test_cancel.gd'],
    }, { signal: controller.signal });
    const pending = runWithExecutionContext(execution, () => new ProjectTestService(context).execute({
      projectPath, action: 'run', framework: 'native', testPaths: ['test_cancel.gd'],
    }));
    setTimeout(() => { controller.abort('cancel project tests'); }, 10);

    await expect(pending).rejects.toMatchObject({ name: 'AbortError', message: 'cancel project tests' });
    expect(childProcess.state.calls.at(-1)?.options.signal).toBe(controller.signal);
  });
});
