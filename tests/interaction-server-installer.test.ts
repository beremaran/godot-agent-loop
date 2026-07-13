// @test-kind: unit
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InteractionServerInstaller } from '../src/interaction-server-installer.js';

// The interaction server preloads its domain scripts from res://mcp_runtime/, so
// an installation that copies the server without that directory fails the autoload
// at parse time. These tests run against a real temp project to cover that.
//
// The autoload itself is declared in override.cfg — a file MCP creates and
// deletes — so project.godot is never rewritten; Godot merges override.cfg over
// project.godot at startup (proven in the Phase 6a spike).
describe('InteractionServerInstaller', () => {
  let workspace: string;
  let sourceDir: string;
  let projectPath: string;
  let installer: InteractionServerInstaller;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'godot-mcp-installer-'));
    sourceDir = join(workspace, 'build-scripts');
    projectPath = join(workspace, 'project');
    mkdirSync(join(sourceDir, 'mcp_runtime'), { recursive: true });
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(sourceDir, 'mcp_interaction_server.gd'), 'extends Node');
    writeFileSync(join(sourceDir, 'mcp_runtime', 'input_domain.gd'), 'extends Node # input');
    writeFileSync(join(projectPath, 'project.godot'), 'config_version=5\n');
    installer = new InteractionServerInstaller({
      sourceScriptPath: join(sourceDir, 'mcp_interaction_server.gd'),
    });
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  const domainScript = () => join(projectPath, 'mcp_runtime', 'input_domain.gd');
  const overrideFile = () => join(projectPath, 'override.cfg');
  const projectFile = () => join(projectPath, 'project.godot');
  const serverScript = () => join(projectPath, 'mcp_interaction_server.gd');

  it('installs the server together with the domain scripts it preloads', () => {
    const ownedByMcp = installer.install(projectPath);

    expect(ownedByMcp).toBe(true);
    expect(existsSync(serverScript())).toBe(true);
    expect(existsSync(domainScript())).toBe(true);
    expect(readFileSync(overrideFile(), 'utf8'))
      .toContain('McpInteractionServer="*res://mcp_interaction_server.gd"');
  });

  it('never touches project.godot', () => {
    const before = readFileSync(projectFile());

    installer.install(projectPath);
    const afterInstall = readFileSync(projectFile());
    installer.remove(projectPath, true);
    const afterRemove = readFileSync(projectFile());

    expect(afterInstall.equals(before)).toBe(true);
    expect(afterRemove.equals(before)).toBe(true);
  });

  it('treats an autoload declared in project.godot as user-managed', () => {
    writeFileSync(projectFile(), [
      'config_version=5',
      '',
      '[autoload]',
      '',
      'McpInteractionServer="*res://mcp_interaction_server.gd"',
      '',
    ].join('\n'));
    writeFileSync(serverScript(), 'extends Node # user-managed copy');

    const ownedByMcp = installer.install(projectPath);

    expect(ownedByMcp).toBe(false);
    expect(existsSync(overrideFile())).toBe(false);
    // The user's copy of the script is theirs; only the domain scripts sync.
    expect(readFileSync(serverScript(), 'utf8')).toBe('extends Node # user-managed copy');
    expect(existsSync(domainScript())).toBe(true);
  });

  it('restores a missing script for a user-managed installation', () => {
    writeFileSync(projectFile(), '[autoload]\nMcpInteractionServer="*res://mcp_interaction_server.gd"\n');

    const ownedByMcp = installer.install(projectPath);

    expect(ownedByMcp).toBe(false);
    expect(existsSync(serverScript())).toBe(true);
    expect(existsSync(domainScript())).toBe(true);
  });

  it('refreshes stale domain scripts on reinstall', () => {
    installer.install(projectPath);
    writeFileSync(domainScript(), 'stale');
    writeFileSync(join(sourceDir, 'mcp_runtime', 'input_domain.gd'), 'extends Node # updated');

    const ownedByMcp = installer.install(projectPath);

    expect(ownedByMcp).toBe(true);
    expect(readFileSync(domainScript(), 'utf8')).toBe('extends Node # updated');
  });

  it('removes every artifact of an MCP-owned installation', () => {
    installer.install(projectPath);
    // Godot generates .uid sidecars when the editor scans the project.
    writeFileSync(`${serverScript()}.uid`, 'uid://fake');

    installer.remove(projectPath, true);

    expect(existsSync(serverScript())).toBe(false);
    expect(existsSync(`${serverScript()}.uid`)).toBe(false);
    expect(existsSync(join(projectPath, 'mcp_runtime'))).toBe(false);
    expect(existsSync(overrideFile())).toBe(false);
  });

  it('leaves a user-managed installation untouched on removal', () => {
    installer.install(projectPath);

    installer.remove(projectPath, false);

    expect(existsSync(serverScript())).toBe(true);
    expect(existsSync(domainScript())).toBe(true);
    expect(existsSync(overrideFile())).toBe(true);
  });

  it('preserves user-owned override.cfg content around the autoload block', () => {
    const userContent = '[rendering]\n\nrenderer/rendering_method="mobile"\n';
    writeFileSync(overrideFile(), userContent);

    installer.install(projectPath);
    const merged = readFileSync(overrideFile(), 'utf8');
    expect(merged).toContain('renderer/rendering_method="mobile"');
    expect(merged).toContain('McpInteractionServer="*res://mcp_interaction_server.gd"');

    installer.remove(projectPath, true);
    expect(readFileSync(overrideFile(), 'utf8')).toBe(userContent);
  });

  describe('reapStaleInstallation', () => {
    it('removes everything a crashed MCP-owned installation left behind', () => {
      installer.install(projectPath);
      writeFileSync(`${serverScript()}.uid`, 'uid://fake');
      // No remove(): simulates a SIGKILLed server.

      const reaped = installer.reapStaleInstallation(projectPath);

      expect(reaped.length).toBeGreaterThan(0);
      expect(existsSync(overrideFile())).toBe(false);
      expect(existsSync(serverScript())).toBe(false);
      expect(existsSync(`${serverScript()}.uid`)).toBe(false);
      expect(existsSync(join(projectPath, 'mcp_runtime'))).toBe(false);
    });

    it('removes a shipped-identical script left by a crash before override.cfg was written', () => {
      writeFileSync(serverScript(), 'extends Node');
      mkdirSync(join(projectPath, 'mcp_runtime'), { recursive: true });
      writeFileSync(domainScript(), 'extends Node # input');

      installer.reapStaleInstallation(projectPath);

      expect(existsSync(serverScript())).toBe(false);
      expect(existsSync(join(projectPath, 'mcp_runtime'))).toBe(false);
    });

    it('leaves a script it cannot prove is MCP-owned', () => {
      writeFileSync(serverScript(), 'extends Node # customized by the user');

      const reaped = installer.reapStaleInstallation(projectPath);

      expect(reaped).toEqual([]);
      expect(existsSync(serverScript())).toBe(true);
    });

    it('strips a stale autoload block but keeps the scripts of a user-managed installation', () => {
      writeFileSync(projectFile(), '[autoload]\nMcpInteractionServer="*res://mcp_interaction_server.gd"\n');
      writeFileSync(serverScript(), 'extends Node');
      writeFileSync(overrideFile(), [
        '; godot-mcp: begin interaction server (generated; removed automatically)',
        '[autoload]',
        'McpInteractionServer="*res://mcp_interaction_server.gd"',
        '; godot-mcp: end interaction server',
        '',
      ].join('\n'));

      installer.reapStaleInstallation(projectPath);

      expect(existsSync(overrideFile())).toBe(false);
      expect(existsSync(serverScript())).toBe(true);
    });

    it('removes an orphan mcp_runtime directory that matches the shipped scripts', () => {
      mkdirSync(join(projectPath, 'mcp_runtime'), { recursive: true });
      writeFileSync(domainScript(), 'extends Node # input');
      writeFileSync(join(projectPath, 'mcp_runtime', 'input_domain.gd.uid'), 'uid://fake');

      installer.reapStaleInstallation(projectPath);

      expect(existsSync(join(projectPath, 'mcp_runtime'))).toBe(false);
    });

    it('leaves an mcp_runtime directory containing user files', () => {
      mkdirSync(join(projectPath, 'mcp_runtime'), { recursive: true });
      writeFileSync(join(projectPath, 'mcp_runtime', 'user_owned.gd'), 'extends Node # theirs');

      installer.reapStaleInstallation(projectPath);

      expect(existsSync(join(projectPath, 'mcp_runtime', 'user_owned.gd'))).toBe(true);
    });

    it('restores the project byte-identically across install, crash, and reap', () => {
      const userOverride = '[display]\nwindow/size/viewport_width=320\n';
      writeFileSync(overrideFile(), userOverride);
      const before = {
        project: readFileSync(projectFile(), 'utf8'),
        override: readFileSync(overrideFile(), 'utf8'),
      };

      installer.install(projectPath);
      installer.reapStaleInstallation(projectPath);

      expect(readFileSync(projectFile(), 'utf8')).toBe(before.project);
      expect(readFileSync(overrideFile(), 'utf8')).toBe(before.override);
      expect(existsSync(serverScript())).toBe(false);
      expect(existsSync(join(projectPath, 'mcp_runtime'))).toBe(false);
    });
  });
});
