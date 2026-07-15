// @test-kind: contract
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePiServerLaunch } from '../agent-plugin/pi/extension.js';
import { parseSkillFrontmatter } from '../scripts/skill-frontmatter.js';
import { repoRoot } from './helpers/manifest-sources.js';

const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const pluginRoot = join(repoRoot, 'agent-plugin');
const adapter = JSON.parse(readFileSync(join(pluginRoot, 'adapter-manifest.json'), 'utf8'));
const claude = JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin/plugin.json'), 'utf8'));
const codex = JSON.parse(readFileSync(join(pluginRoot, '.codex-plugin/plugin.json'), 'utf8'));
const mcp = JSON.parse(readFileSync(join(pluginRoot, '.mcp.json'), 'utf8'));
const claudeMarketplace = JSON.parse(readFileSync(join(repoRoot, '.claude-plugin/marketplace.json'), 'utf8'));
const codexMarketplace = JSON.parse(readFileSync(join(repoRoot, '.agents/plugins/marketplace.json'), 'utf8'));
const expectedSkills = [
  'build-godot-game',
  'debug-godot-game',
  'ship-godot-game',
  'verify-godot-change',
];

function skill(name: string): string {
  return readFileSync(join(pluginRoot, 'skills', name, 'SKILL.md'), 'utf8');
}

describe('portable agent plugin package', () => {
  it('keeps Claude, Codex, MCP, Pi, and marketplaces on one adapter release', () => {
    expect(adapter).toMatchObject({
      name: 'godot-agent-loop',
      version: packageJson.version,
      package: packageJson.name,
      mcp: { defaultToolCount: 39, discoveryTool: 'godot_tools' },
    });
    expect(claude).toMatchObject({ name: adapter.name, version: adapter.version, mcpServers: './.mcp.json' });
    expect(codex).toMatchObject({
      name: adapter.name,
      version: adapter.version,
      skills: './skills/',
      mcpServers: './.mcp.json',
    });
    expect(mcp.mcpServers[adapter.name]).toEqual({
      command: 'npx',
      args: ['-y', `${packageJson.name}@${packageJson.version}`],
      env: { GODOT_MCP_TOOL_SURFACE: 'compact' },
    });
    expect(claudeMarketplace.plugins[0]).toMatchObject({ name: adapter.name, source: './agent-plugin' });
    expect(codexMarketplace.plugins[0]).toMatchObject({
      name: adapter.name,
      source: { source: 'local', path: './agent-plugin' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    });
    expect(packageJson).toMatchObject({
      files: ['build', 'agent-plugin', 'addons/godot_agent_loop', 'product.json', 'scripts/prepare-package.js'],
      pi: {
        extensions: ['./agent-plugin/pi/extension.ts'],
        skills: ['./agent-plugin/skills'],
      },
    });
    expect(packageJson.keywords).toContain('pi-package');
    expect(packageJson.dependencies).toMatchObject({
      'jsonc-parser': expect.any(String),
      pngjs: expect.any(String),
    });
    expect(packageJson.devDependencies.pngjs).toBeUndefined();
  });

  it('ships one canonical four-skill inventory with exact trigger metadata', () => {
    expect(readdirSync(join(pluginRoot, 'skills')).sort()).toEqual(expectedSkills);
    expect(adapter.skills.map((entry: { name: string }) => entry.name)).toEqual(expectedSkills);
    for (const declared of adapter.skills) {
      const source = skill(declared.name);
      expect(source).toMatch(new RegExp(`^---\\nname: ${declared.name}\\ndescription: ${declared.description.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n---`));
      expect(source).not.toContain('[TODO:');
      expect(source.split('\n').length, declared.name).toBeLessThan(100);
    }
  });

  it('parses canonical skill metadata after LF or CRLF checkout conversion', () => {
    const expected = { name: 'build-godot-game', description: 'Build a tested Godot game.' };
    const frontmatter = [
      '---',
      `name: ${expected.name}`,
      `description: ${expected.description}`,
      '---',
      '',
      '# Build',
    ];

    expect(parseSkillFrontmatter(frontmatter.join('\n'), expected.name)).toEqual(expected);
    expect(parseSkillFrontmatter(frontmatter.join('\r\n'), expected.name)).toEqual(expected);
  });

  it('requires verification evidence in build, debug, verify, and shipping workflows', () => {
    const build = skill('build-godot-game');
    expect(build.indexOf('1. Inspect before writing.')).toBeLessThan(build.indexOf('2. Author the smallest complete game.'));
    expect(build).toContain('`verify_project`');
    expect(build).toContain('`run_project_tests`');

    const verify = skill('verify-godot-change');
    expect(verify.indexOf('`validate_script`')).toBeLessThan(verify.indexOf('`verify_project`'));
    expect(verify).toMatch(/successful mutation response is not evidence/i);

    const debug = skill('debug-godot-game');
    expect(debug.indexOf('`run_project`')).toBeLessThan(debug.indexOf('`get_debug_output`'));
    expect(debug).toMatch(/independent passing evidence/i);

    const ship = skill('ship-godot-game');
    for (const tool of [
      'analyze_project_integrity', 'manage_import_pipeline', 'manage_addon', 'run_project_tests',
      'verify_project', 'verify_dotnet_project', 'verify_export_readiness',
    ]) expect(ship).toContain(`\`${tool}\``);
    expect(ship).toMatch(/tear down/i);
    expect(ship).toMatch(/Never claim an unavailable platform/);
  });

  it('ships the Pi extension as a thin compact-surface MCP client', () => {
    const extension = readFileSync(join(pluginRoot, 'pi/extension.ts'), 'utf8');
    expect(extension).toContain('StdioClientTransport');
    expect(extension).toContain('await next.connect(transport)');
    expect(extension).toContain('await next.listTools()');
    expect(extension).toContain('pi.registerTool');
    expect(extension).toContain("GODOT_MCP_TOOL_SURFACE: 'compact'");
    expect(extension).toContain("pi.on('session_shutdown', close)");
    expect(extension).not.toContain('toolDefinitions');

    expect(resolvePiServerLaunch({
      localServerEntry: '/installed/package/build/index.js',
      exists: () => true,
    })).toEqual({
      command: process.execPath,
      args: ['/installed/package/build/index.js'],
    });
    expect(resolvePiServerLaunch({ exists: () => false })).toEqual({
      command: 'npx',
      args: ['-y', `${packageJson.name}@${packageJson.version}`],
    });
  });
});
