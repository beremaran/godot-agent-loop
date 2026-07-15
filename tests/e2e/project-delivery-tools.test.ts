// @test-kind: e2e
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempProject, resolveGodotBinary, startServer, type E2EServer } from './helpers/harness.js';

const execFileAsync = promisify(execFile);
let server: E2EServer | null = null;

afterEach(async () => {
  if (server) {
    const active = server;
    server = null;
    await active.close();
  }
});

async function startedServer(): Promise<E2EServer> {
  const exportDataHome = process.env.GODOT_MCP_EXPORT_XDG_DATA_HOME;
  server = await startServer({
    ...(exportDataHome ? { extraEnv: { XDG_DATA_HOME: exportDataHome } } : {}),
  });
  return server;
}

async function createLinuxExportFixture(game: E2EServer): Promise<string> {
  const projectPath = join(game.root, 'Export Project');
  expect((await game.call('create_project', { projectPath, projectName: 'Export Project' })).isError).toBe(false);
  const godotBinary = resolveGodotBinary();
  const useInstalledExportTemplates = process.env.GODOT_MCP_EXPORT_TEMPLATE_TEST === '1';
  const files: Record<string, string> = {
    'main.gd': [
      'extends Node', '', 'func _ready() -> void:', '\tprint("MCP_EXPORTED_GAME_OK")', '\tget_tree().quit()', '',
    ].join('\n'),
    'main.tscn': [
      '[gd_scene load_steps=2 format=3]', '', '[ext_resource type="Script" path="res://main.gd" id="1"]', '',
      '[node name="Main" type="Node"]', 'script = ExtResource("1")', '',
    ].join('\n'),
    'export_presets.cfg': [
      '[preset.0]', '', 'name="Linux Agent"', 'platform="Linux"', 'runnable=true', 'advanced_options=false',
      'dedicated_server=false', 'custom_features=""', 'export_filter="all_resources"', 'include_filter=""',
      'exclude_filter=""', 'export_path="build/release.x86_64"', 'script_export_mode=2', '', '[preset.0.options]', '',
      `custom_template/debug=${JSON.stringify(useInstalledExportTemplates ? '' : godotBinary)}`,
      `custom_template/release=${JSON.stringify(useInstalledExportTemplates ? '' : godotBinary)}`,
      'binary_format/embed_pck=false', '',
    ].join('\n'),
  };
  for (const [filePath, content] of Object.entries(files)) {
    const written = await game.call('write_file', { projectPath, filePath, content });
    expect(written.isError, `${filePath}: ${written.text}`).toBe(false);
  }
  expect((await game.call('set_main_scene', { projectPath, scenePath: 'main.tscn' })).isError).toBe(false);
  return projectPath;
}

describe('project creation and delivery tools through MCP', () => {
  it('create_project produces engine-loadable GDScript and .NET projects and create_csharp_script compiles', async () => {
    const game = await startedServer();
    const gdProject = join(game.root, 'Created GDScript Ω');
    const created = await game.call('create_project', { projectPath: gdProject, projectName: 'Agent "Demo" Ω' });
    expect(created.isError, created.text).toBe(false);
    const gdConfig = readFileSync(join(gdProject, 'project.godot'), 'utf8');
    expect(gdConfig).toContain('config/name="Agent \\"Demo\\" Ω"');
    expect(gdConfig).toContain('config/features=PackedStringArray("4.4")');
    await expect(execFileAsync(resolveGodotBinary(), [
      '--headless', '--editor', '--path', gdProject, '--quit-after', '2',
    ], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })).resolves.toMatchObject({ stdout: expect.stringContaining('Godot Engine') });
    const duplicate = await game.call('create_project', { projectPath: gdProject, projectName: 'Duplicate' });
    expect(duplicate.isError).toBe(true);
    expect(duplicate.text).toMatch(/already exists/i);

    const dotnetProject = join(game.root, 'Created Dotnet Project');
    const dotnetCreated = await game.call('create_project', {
      projectPath: dotnetProject, projectName: '9 Agent.Game', dotnet: true,
    });
    expect(dotnetCreated.isError, dotnetCreated.text).toBe(false);
    const projectConfig = readFileSync(join(dotnetProject, 'project.godot'), 'utf8');
    expect(projectConfig).toContain('config/features=PackedStringArray("4.4", "C#")');
    expect(projectConfig).toContain('project/assembly_name="_9_Agent_Game"');
    const csprojPath = join(dotnetProject, '_9_Agent_Game.csproj');
    const { stdout: godotVersion } = await execFileAsync(resolveGodotBinary(), ['--version']);
    const version = /^(\d+)\.(\d+)/.exec(godotVersion);
    expect(version).not.toBeNull();
    expect(readFileSync(csprojPath, 'utf8')).toContain(
      `<Project Sdk="Godot.NET.Sdk/${version![1]}.${version![2]}.0">`,
    );

    const dotnetInspection = await game.call('verify_dotnet_project', {
      projectPath: dotnetProject, action: 'inspect', csprojPath: '_9_Agent_Game.csproj',
      configuration: 'Debug', timeoutSeconds: 120, runTimeoutSeconds: 5,
    });
    expect(dotnetInspection.isError, dotnetInspection.text).toBe(false);
    expect(JSON.parse(dotnetInspection.text)).toMatchObject({
      ready: process.env.GODOT_MCP_DOTNET_TEST === '1',
      dotnet: { available: true },
      project: { sdk_version: `${version![1]}.${version![2]}.0`, target_framework: 'net8.0' },
    });

    const script = await game.call('create_csharp_script', {
      projectPath: dotnetProject,
      scriptPath: 'scripts/PlayerController.cs',
      className: 'PlayerController',
      baseClass: 'Node',
      namespaceName: 'Agent.Game',
      methods: ['_Ready', '_Process', 'Reset'],
    });
    expect(script.isError, script.text).toBe(false);
    const scriptPath = join(dotnetProject, 'scripts', 'PlayerController.cs');
    const source = readFileSync(scriptPath, 'utf8');
    expect(source).toContain('namespace Agent.Game;');
    expect(source).toContain('public partial class PlayerController : Node');
    expect(source).toContain('public override void _Process(double delta)');
    expect(source).toContain('public void Reset()');

    // Compile the exact generated source with a minimal Godot API surface. The
    // installed engine is a standard build, so its matching Godot.NET.Sdk is
    // not locally available; this still proves emitted C# syntax and overrides.
    const compileDir = join(game.root, 'generated-csharp-compile-check');
    mkdirSync(compileDir);
    writeFileSync(join(compileDir, 'GodotStubs.cs'), [
      'namespace Godot;',
      'public class Node { public virtual void _Ready() {} public virtual void _Process(double delta) {} }',
    ].join('\n'));
    copyFileSync(scriptPath, join(compileDir, 'PlayerController.cs'));
    writeFileSync(join(compileDir, 'CompileCheck.csproj'), [
      '<Project Sdk="Microsoft.NET.Sdk">',
      '  <PropertyGroup><TargetFramework>net8.0</TargetFramework><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup>',
      '  <ItemGroup><Compile Include="GodotStubs.cs"/><Compile Include="PlayerController.cs"/></ItemGroup>',
      '</Project>',
    ].join('\n'));
    await expect(execFileAsync('dotnet', [
      'build', join(compileDir, 'CompileCheck.csproj'), '--nologo', '--verbosity', 'quiet', '-p:RestoreIgnoreFailedSources=true',
    ], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })).resolves.toMatchObject({ stdout: expect.stringContaining('Build succeeded') });

    if (process.env.GODOT_MCP_DOTNET_TEST === '1') {
      const restored = await game.call('verify_dotnet_project', {
        projectPath: dotnetProject, action: 'restore', configuration: 'Release',
      });
      expect(restored.isError, restored.text).toBe(false);
      expect(JSON.parse(restored.text)).toMatchObject({ category: 'success', restore: { ok: true, diagnostics: [] } });

      writeFileSync(join(dotnetProject, 'Broken.cs'), 'public class Broken { this is not valid C# }\n');
      const failedBuild = await game.call('verify_dotnet_project', {
        projectPath: dotnetProject, action: 'build', configuration: 'Debug',
      });
      expect(failedBuild.isError).toBe(true);
      const failure = JSON.parse(failedBuild.text);
      expect(failure).toMatchObject({ category: 'build_failed', build: { ok: false } });
      expect(failure.build.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ severity: 'error', file: expect.stringContaining('Broken.cs') }),
      ]));
      unlinkSync(join(dotnetProject, 'Broken.cs'));

      const built = await game.call('verify_dotnet_project', {
        projectPath: dotnetProject, action: 'build', configuration: 'Release',
      });
      expect(built.isError, built.text).toBe(false);
      const buildResult = JSON.parse(built.text);
      expect(buildResult).toMatchObject({ category: 'success', build: { ok: true, diagnostics: [] } });
      expect(buildResult.artifact.path).toMatch(/_9_Agent_Game\.dll$/);
      expect(existsSync(join(dotnetProject, buildResult.artifact.path))).toBe(true);

      writeFileSync(join(dotnetProject, 'Main.cs'), [
        'using Godot;', 'public partial class Main : Node {',
        '  public override void _Ready() { GD.Print("MCP_DOTNET_RUN_OK"); GetTree().Quit(); }', '}', '',
      ].join('\n'));
      writeFileSync(join(dotnetProject, 'main.tscn'), [
        '[gd_scene load_steps=2 format=3]', '',
        '[ext_resource type="Script" path="res://Main.cs" id="1"]', '',
        '[node name="Main" type="Node"]', 'script = ExtResource("1")', '',
      ].join('\n'));
      expect((await game.call('set_main_scene', { projectPath: dotnetProject, scenePath: 'main.tscn' })).isError).toBe(false);
      const ran = await game.call('verify_dotnet_project', {
        projectPath: dotnetProject, action: 'run', configuration: 'Debug',
        expectedOutput: 'MCP_DOTNET_RUN_OK', runTimeoutSeconds: 5,
      });
      expect(ran.isError, ran.text).toBe(false);
      expect(JSON.parse(ran.text)).toMatchObject({
        category: 'success', run: { ok: true, output_matched: true, expected_output: 'MCP_DOTNET_RUN_OK' },
      });
    } else {
      const refused = await game.call('verify_dotnet_project', {
        projectPath: dotnetProject, action: 'build', configuration: 'Release',
      });
      expect(refused.isError).toBe(true);
      expect(JSON.parse(refused.text)).toMatchObject({ ready: false, category: 'dotnet_editor_required' });
    }

    const mismatch = await game.call('create_csharp_script', {
      projectPath: dotnetProject, scriptPath: 'Mismatch.cs', className: 'Different',
    });
    expect(mismatch.isError).toBe(true);
    expect(mismatch.text).toMatch(/must match/i);
  });

  it('manage_ci_pipeline and manage_docker_export create and read validated automation artifacts', async () => {
    const game = await startedServer();
    const projectPath = join(game.root, 'Delivery Project');
    expect((await game.call('create_project', { projectPath, projectName: 'Delivery Project' })).isError).toBe(false);

    const ci = await game.call('manage_ci_pipeline', {
      projectPath, action: 'create', godotVersion: '4.7-stable', platforms: ['windows', 'linux', 'macos', 'web'],
    });
    expect(ci.isError, ci.text).toBe(false);
    const workflowPath = join(projectPath, '.github', 'workflows', 'godot-export.yml');
    const workflow = readFileSync(workflowPath, 'utf8');
    for (const platform of ['windows', 'linux', 'macos', 'web']) {
      expect(workflow).toContain(`--export-release "${platform}" build/${platform}/game`);
    }
    expect(workflow).toMatch(/^name: Godot Export\non:\n {2}push:/);
    expect(workflow).toContain('image: barichello/godot-ci:4.7-stable');
    const ciRead = await game.call('manage_ci_pipeline', { projectPath, action: 'read' });
    expect(ciRead.isError, ciRead.text).toBe(false);
    expect(ciRead.text).toBe(workflow);
    const duplicatePlatforms = await game.call('manage_ci_pipeline', {
      projectPath, action: 'create', platforms: ['linux', 'linux'],
    });
    expect(duplicatePlatforms.isError).toBe(true);
    expect(duplicatePlatforms.text).toMatch(/duplicates/i);

    const olderBase = await game.call('manage_docker_export', {
      projectPath, action: 'create', baseImage: 'ubuntu:22.04',
    });
    expect(olderBase.isError, olderBase.text).toBe(false);
    expect(readFileSync(join(projectPath, 'Dockerfile'), 'utf8')).toMatch(/^FROM ubuntu:22\.04\n/);

    const docker = await game.call('manage_docker_export', {
      projectPath, action: 'create', godotVersion: '4.7-stable', baseImage: 'ubuntu:24.04', exportPreset: 'Linux Agent Build',
    });
    expect(docker.isError, docker.text).toBe(false);
    const dockerfile = readFileSync(join(projectPath, 'Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/^FROM ubuntu:24\.04\n/);
    expect(dockerfile).toContain('ARG GODOT_VERSION=4.7-stable');
    expect(dockerfile).toContain('CMD ["godot", "--headless", "--export-release", "Linux Agent Build", "build/game"]');
    const dockerRead = await game.call('manage_docker_export', { projectPath, action: 'read' });
    expect(dockerRead.isError, dockerRead.text).toBe(false);
    expect(dockerRead.text).toBe(dockerfile);
    await expect(game.call('manage_docker_export', {
      projectPath, action: 'create', exportPreset: 'Linux"; RUN touch /tmp/pwned',
    })).rejects.toThrow(/exportPreset must match/i);
  });

  it('keeps export inspection, classification, and output paths portable', async () => {
    const game = await startedServer();
    const projectPath = await createLinuxExportFixture(game);

    const readiness = await game.call('verify_export_readiness', {
      projectPath, action: 'inspect', presetName: 'Linux Agent',
    });
    expect(readiness.isError, readiness.text).toBe(false);
    expect(JSON.parse(readiness.text)).toMatchObject({ ready: true, preset: { platform: 'Linux' } });

    const missingPreset = await game.call('verify_export_readiness', {
      projectPath, action: 'inspect', presetName: 'Missing Preset',
    });
    expect(missingPreset.isError).toBe(true);
    expect(JSON.parse(missingPreset.text)).toMatchObject({ ready: false, category: 'preset_not_found' });

    writeFileSync(join(projectPath, 'export_presets.cfg'), `${readFileSync(join(projectPath, 'export_presets.cfg'), 'utf8')}\n[preset.1]\n\nname="Unsupported Agent"\nplatform="Unsupported"\nrunnable=false\nexport_path="build/unsupported"\n\n[preset.1.options]\n`);
    const unsupported = await game.call('verify_export_readiness', {
      projectPath, action: 'export_smoke', presetName: 'Unsupported Agent',
      outputPath: 'build/unsupported', smoke: false,
    });
    expect(unsupported.isError).toBe(true);
    expect(JSON.parse(unsupported.text)).toMatchObject({ ready: false, category: 'unsupported_platform', platform_known: false });

    mkdirSync(join(projectPath, 'build'), { recursive: true });
    writeFileSync(join(projectPath, 'build', 'release.x86_64'), 'existing artifact');
    const invalidOutput = await game.call('verify_export_readiness', {
      projectPath, action: 'export_smoke', presetName: 'Linux Agent',
      outputPath: 'build/release.x86_64/child', smoke: false,
    });
    expect(invalidOutput.isError).toBe(true);
    expect(JSON.parse(invalidOutput.text)).toMatchObject({ ready: true, category: 'output_path_invalid' });

    const escaped = await game.call('export_project', {
      projectPath, presetName: 'Linux Agent', outputPath: '../../outside-build',
    });
    expect(escaped.isError).toBe(true);
    expect(escaped.text).toMatch(/Invalid output path/i);
  });

  it.runIf(process.platform === 'linux')('export_project creates release/debug artifacts and the release boots its packed project', async () => {
    const game = await startedServer();
    const projectPath = await createLinuxExportFixture(game);

    const release = await game.call('verify_export_readiness', {
      projectPath, action: 'export_smoke', presetName: 'Linux Agent',
      outputPath: 'build/release.x86_64', smoke: true, expectedOutput: 'MCP_EXPORTED_GAME_OK',
      timeoutSeconds: 120, smokeTimeoutSeconds: 5,
    });
    expect(release.isError, release.text).toBe(false);
    expect(JSON.parse(release.text)).toMatchObject({
      category: 'success', artifact: { path: 'build/release.x86_64', executable: true,
        companion_pck: 'build/release.pck' }, smoke: { attempted: true, passed: true, output_matched: true },
    });
    expect(existsSync(join(projectPath, 'build', 'release.x86_64'))).toBe(true);
    expect(existsSync(join(projectPath, 'build', 'release.pck'))).toBe(true);

    const debug = await game.call('export_project', {
      projectPath, presetName: 'Linux Agent', outputPath: 'build/debug.x86_64', debug: true,
    });
    expect(debug.isError, debug.text).toBe(false);
    expect(existsSync(join(projectPath, 'build', 'debug.x86_64'))).toBe(true);
    expect(existsSync(join(projectPath, 'build', 'debug.pck'))).toBe(true);
  });

  it('verify_export_readiness classifies missing templates before export work', async () => {
    const project = createTempProject({ name: 'No Templates' });
    writeFileSync(join(project.projectPath, 'export_presets.cfg'), [
      '[preset.0]', '', 'name="Linux Missing"', 'platform="Linux"', 'runnable=true',
      'export_path="build/game.x86_64"', '', '[preset.0.options]', '',
      'custom_template/debug=""', 'custom_template/release=""', '',
    ].join('\n'));
    server = await startServer({ project, extraEnv: {
      HOME: project.root, XDG_DATA_HOME: join(project.root, 'empty-data'),
      GODOT_MCP_EXPORT_XDG_DATA_HOME: '',
    } });
    const inspected = await server.call('verify_export_readiness', {
      projectPath: project.projectPath, action: 'inspect', presetName: 'Linux Missing', debug: false,
    });
    expect(inspected.isError, inspected.text).toBe(false);
    expect(JSON.parse(inspected.text)).toMatchObject({
      ready: false, expected_template_file: 'linux_release.x86_64', custom_template_exists: false,
    });
    const failed = await server.call('verify_export_readiness', {
      projectPath: project.projectPath, action: 'export_smoke', presetName: 'Linux Missing',
      outputPath: 'build/game.x86_64', smoke: true,
    });
    expect(failed.isError).toBe(true);
    expect(JSON.parse(failed.text)).toMatchObject({ ready: false, category: 'missing_templates' });
    expect(existsSync(join(project.projectPath, 'build', 'game.x86_64'))).toBe(false);
  });
});
