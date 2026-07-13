// @test-kind: unit
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InteractionServerInstaller } from '../src/interaction-server-installer.js';

// The interaction server preloads its domain scripts from res://mcp_runtime/, so
// an installation that copies the server without that directory fails the autoload
// at parse time. These tests run against a real temp project to cover that.
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

  it('installs the server together with the domain scripts it preloads', () => {
    const ownedByMcp = installer.install(projectPath);

    expect(ownedByMcp).toBe(true);
    expect(existsSync(join(projectPath, 'mcp_interaction_server.gd'))).toBe(true);
    expect(existsSync(domainScript())).toBe(true);
    expect(readFileSync(join(projectPath, 'project.godot'), 'utf8'))
      .toContain('McpInteractionServer="*res://mcp_interaction_server.gd"');
  });

  it('restores domain scripts that are missing from an existing installation', () => {
    installer.install(projectPath);
    rmSync(join(projectPath, 'mcp_runtime'), { recursive: true, force: true });

    // The autoload and script are already present, so install() leaves them alone —
    // but the preloaded domain scripts must come back, or the autoload cannot parse.
    const ownedByMcp = installer.install(projectPath);

    expect(ownedByMcp).toBe(false);
    expect(existsSync(domainScript())).toBe(true);
  });

  it('refreshes stale domain scripts on reinstall', () => {
    installer.install(projectPath);
    writeFileSync(domainScript(), 'stale');
    writeFileSync(join(sourceDir, 'mcp_runtime', 'input_domain.gd'), 'extends Node # updated');

    installer.install(projectPath);

    expect(readFileSync(domainScript(), 'utf8')).toBe('extends Node # updated');
  });

  it('removes the domain scripts along with an MCP-owned installation', () => {
    installer.install(projectPath);

    installer.remove(projectPath, true);

    expect(existsSync(join(projectPath, 'mcp_interaction_server.gd'))).toBe(false);
    expect(existsSync(join(projectPath, 'mcp_runtime'))).toBe(false);
    expect(readFileSync(join(projectPath, 'project.godot'), 'utf8')).not.toContain('McpInteractionServer');
  });

  it('leaves a user-managed installation untouched on removal', () => {
    installer.install(projectPath);

    installer.remove(projectPath, false);

    expect(existsSync(join(projectPath, 'mcp_interaction_server.gd'))).toBe(true);
    expect(existsSync(domainScript())).toBe(true);
  });
});
