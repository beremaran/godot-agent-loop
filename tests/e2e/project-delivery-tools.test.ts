// @test-kind: e2e
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveGodotBinary, startServer, type E2EServer } from './helpers/harness.js';

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
  server = await startServer();
  return server;
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
    expect(readFileSync(csprojPath, 'utf8')).toMatch(/<Project Sdk="Godot\.NET\.Sdk\/4\.7\.0">/);

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
    const compileDir = join(dotnetProject, 'compile-check');
    await game.call('create_directory', { projectPath: dotnetProject, directoryPath: 'compile-check' });
    writeFileSync(join(compileDir, 'GodotStubs.cs'), [
      'namespace Godot;',
      'public class Node { public virtual void _Ready() {} public virtual void _Process(double delta) {} }',
    ].join('\n'));
    writeFileSync(join(compileDir, 'CompileCheck.csproj'), [
      '<Project Sdk="Microsoft.NET.Sdk">',
      '  <PropertyGroup><TargetFramework>net8.0</TargetFramework><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup>',
      '  <ItemGroup><Compile Include="GodotStubs.cs"/><Compile Include="../scripts/PlayerController.cs"/></ItemGroup>',
      '</Project>',
    ].join('\n'));
    await expect(execFileAsync('dotnet', [
      'build', join(compileDir, 'CompileCheck.csproj'), '--nologo', '--verbosity', 'quiet', '-p:RestoreIgnoreFailedSources=true',
    ], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })).resolves.toMatchObject({ stdout: expect.stringContaining('Build succeeded') });

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

  it('export_project creates release/debug artifacts and the release boots its packed project', async () => {
    const game = await startedServer();
    const projectPath = join(game.root, 'Export Project');
    expect((await game.call('create_project', { projectPath, projectName: 'Export Project' })).isError).toBe(false);
    const godotBinary = resolveGodotBinary();
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
        `custom_template/debug=${JSON.stringify(godotBinary)}`, `custom_template/release=${JSON.stringify(godotBinary)}`,
        'binary_format/embed_pck=false', '',
      ].join('\n'),
    };
    for (const [filePath, content] of Object.entries(files)) {
      const written = await game.call('write_file', { projectPath, filePath, content });
      expect(written.isError, `${filePath}: ${written.text}`).toBe(false);
    }
    expect((await game.call('set_main_scene', { projectPath, scenePath: 'main.tscn' })).isError).toBe(false);

    const release = await game.call('export_project', {
      projectPath, presetName: 'Linux Agent', outputPath: 'build/release.x86_64',
    });
    expect(release.isError, release.text).toBe(false);
    const releaseBinary = join(projectPath, 'build', 'release.x86_64');
    expect(existsSync(releaseBinary)).toBe(true);
    expect(existsSync(join(projectPath, 'build', 'release.pck'))).toBe(true);
    const smoke = await execFileAsync(releaseBinary, ['--headless', '--quit-after', '5'], {
      cwd: join(projectPath, 'build'), timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
    });
    expect(smoke.stdout).toContain('MCP_EXPORTED_GAME_OK');

    const debug = await game.call('export_project', {
      projectPath, presetName: 'Linux Agent', outputPath: 'build/debug.x86_64', debug: true,
    });
    expect(debug.isError, debug.text).toBe(false);
    expect(existsSync(join(projectPath, 'build', 'debug.x86_64'))).toBe(true);
    expect(existsSync(join(projectPath, 'build', 'debug.pck'))).toBe(true);

    const escaped = await game.call('export_project', {
      projectPath, presetName: 'Linux Agent', outputPath: '../../outside-build',
    });
    expect(escaped.isError).toBe(true);
    expect(escaped.text).toMatch(/Invalid output path/i);
  });
});
