// @test-kind: unit
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InteractionServerInstaller } from '../src/interaction-server-installer.js';
import { ProjectSupport } from '../src/project-support.js';
import { ProjectToolHandlers } from '../src/tool-handlers/project-tool-handlers.js';

describe('MCP-owned transient runtime filtering', () => {
  let workspace: string;
  let sourceDirectory: string;
  let projectPath: string;
  let installer: InteractionServerInstaller;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'godot-agent-loop-transient-filter-'));
    sourceDirectory = join(workspace, 'source');
    projectPath = join(workspace, 'project');
    mkdirSync(join(sourceDirectory, 'mcp_runtime'), { recursive: true });
    mkdirSync(join(projectPath, 'scripts'), { recursive: true });
    writeFileSync(join(sourceDirectory, 'mcp_interaction_server.gd'), [
      'extends Node',
      'const Domain = preload("res://mcp_runtime/input_domain.gd")',
      'const Missing = preload("res://mcp_runtime/missing_domain.gd")',
      '',
    ].join('\n'));
    writeFileSync(join(sourceDirectory, 'mcp_runtime', 'input_domain.gd'), [
      'extends "res://mcp_interaction_server.gd"',
      '',
    ].join('\n'));
    writeFileSync(join(projectPath, 'project.godot'), 'config_version=5\n');
    writeFileSync(join(projectPath, 'scripts', 'game.gd'), 'extends Node\n');
    installer = new InteractionServerInstaller({
      sourceScriptPath: join(sourceDirectory, 'mcp_interaction_server.gd'),
    });
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  function handlers(runGdScriptCheck = vi.fn().mockResolvedValue({ completed: true, errors: [] })) {
    const support = new ProjectSupport({
      getGodotPath: () => 'godot',
      detectGodotPath: () => Promise.resolve(),
      logDebug: () => undefined,
    });
    return {
      handlers: new ProjectToolHandlers({
        executable: { path: 'godot' } as any,
        logDebug: () => undefined,
        operations: {} as any,
        projectSupport: {
          listAllGdFiles: (path: string) => support.listAllGdFiles(path),
          listChangedGdFiles: vi.fn().mockResolvedValue({ files: [] }),
          runGdScriptCheck,
        } as any,
        ownedTransientFiles: path => installer.ownedTransientFiles(path),
      }),
      runGdScriptCheck,
    };
  }

  function json(response: any): Record<string, any> {
    return JSON.parse(response.content.find((item: any) => item.type === 'text').text) as Record<string, any>;
  }

  it('keeps integrity results clean during an owned install and after teardown', async () => {
    const tools = handlers().handlers;
    installer.install(projectPath);

    const active = json(await tools.handleAnalyzeProjectIntegrity({
      projectPath, action: 'analyze', maxFiles: 10,
    }));

    expect(active).toMatchObject({
      scanned_files: 1,
      graph: { 'scripts/game.gd': [] },
      broken_references: [],
      cycles: [],
      orphan_resources: ['scripts/game.gd'],
    });

    installer.remove(projectPath, true);
    const cleaned = json(await tools.handleAnalyzeProjectIntegrity({
      projectPath, action: 'analyze', maxFiles: 10,
    }));
    expect(cleaned).toMatchObject(active);
  });

  it('keeps user-owned, modified, and extra files at transient paths visible', async () => {
    const tools = handlers().handlers;
    installer.install(projectPath);
    writeFileSync(join(projectPath, 'mcp_interaction_server.gd'), [
      'extends Node',
      'const Missing = preload("res://user_missing.gd")',
      '',
    ].join('\n'));
    writeFileSync(join(projectPath, 'mcp_runtime', 'user_owned.gd'), 'extends Node\n');

    const report = json(await tools.handleAnalyzeProjectIntegrity({
      projectPath, action: 'analyze', maxFiles: 10,
    }));

    expect(report.scanned_files).toBe(3);
    expect(report.graph).toHaveProperty('mcp_interaction_server.gd');
    expect(report.graph).not.toHaveProperty('mcp_runtime/input_domain.gd');
    expect(report.graph).toHaveProperty('mcp_runtime/user_owned.gd');
    expect(report.broken_references).toContainEqual({
      source: 'mcp_interaction_server.gd', target: 'user_missing.gd',
    });

    installer.remove(projectPath, true);
    writeFileSync(join(projectPath, 'mcp_interaction_server.gd'), 'extends Node\n');
    mkdirSync(join(projectPath, 'mcp_runtime'), { recursive: true });
    writeFileSync(join(projectPath, 'mcp_runtime', 'input_domain.gd'), 'extends Node\n');
    const userManaged = json(await tools.handleAnalyzeProjectIntegrity({
      projectPath, action: 'analyze', maxFiles: 10,
    }));
    expect(userManaged.graph).toHaveProperty('mcp_interaction_server.gd');
    expect(userManaged.graph).toHaveProperty('mcp_runtime/input_domain.gd');
  });

  it('omits only proven transient scripts from validate_scripts scope all', async () => {
    const { handlers: tools, runGdScriptCheck } = handlers();
    installer.install(projectPath);
    writeFileSync(join(projectPath, 'mcp_runtime', 'user_owned.gd'), 'extends Node\n');

    const result = json(await tools.handleValidateScripts({ projectPath, scope: 'all' }));

    expect(result).toMatchObject({ scope: 'all', fileCount: 2, allValid: true });
    expect(result.results.map((entry: Record<string, unknown>) => entry.scriptPath).sort())
      .toEqual(['mcp_runtime/user_owned.gd', 'scripts/game.gd']);
    expect(runGdScriptCheck).toHaveBeenCalledTimes(2);
  });

  it('does not report changed scope as valid when no files matched', async () => {
    const { handlers: tools, runGdScriptCheck } = handlers();

    const result = json(await tools.handleValidateScripts({ projectPath, scope: 'changed' }));

    expect(result).toMatchObject({
      scope: 'changed', fileCount: 0, filesWithErrors: 0, allValid: false,
      warning: expect.stringContaining('validation did not run'),
    });
    expect(runGdScriptCheck).not.toHaveBeenCalled();
  });
});
