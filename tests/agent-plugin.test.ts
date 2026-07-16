// @test-kind: contract
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { resolvePiServerLaunch } from '../agent-plugin/pi/extension.js';
import { parseSkillFrontmatter } from '../scripts/skill-frontmatter.js';
import { toolCatalogMetadata } from '../src/tool-catalog-metadata.js';
import { toolDefinitions } from '../src/tool-definitions.js';
import { CORE_TOOL_NAMES } from '../src/tool-surface.js';
import { repoRoot } from './helpers/manifest-sources.js';

const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const pluginRoot = join(repoRoot, 'agent-plugin');
const adapter = JSON.parse(readFileSync(join(pluginRoot, 'adapter-manifest.json'), 'utf8'));
const claude = JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin/plugin.json'), 'utf8'));
const codex = JSON.parse(readFileSync(join(pluginRoot, '.codex-plugin/plugin.json'), 'utf8'));
const mcp = JSON.parse(readFileSync(join(pluginRoot, '.mcp.json'), 'utf8'));
const claudeMarketplace = JSON.parse(readFileSync(join(repoRoot, '.claude-plugin/marketplace.json'), 'utf8'));
const codexMarketplace = JSON.parse(readFileSync(join(repoRoot, '.agents/plugins/marketplace.json'), 'utf8'));
const adapterSchema = JSON.parse(readFileSync(join(repoRoot, 'docs/agent-adapter.schema.json'), 'utf8'));
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
  it('validates the adapter manifest against its public schema', () => {
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(adapterSchema);
    expect(validate(adapter), JSON.stringify(validate.errors)).toBe(true);
  });

  it('keeps Claude, Codex, MCP, Pi, and marketplaces on one adapter release', () => {
    expect(adapter).toMatchObject({
      name: 'godot-agent-loop',
      version: packageJson.version,
      package: packageJson.name,
      mcp: {
        canonicalSurface: 'core',
        surfaceAliases: ['compact'],
        catalogTool: 'godot_catalog',
        callTool: 'godot_call',
        deprecatedCompatibilityTool: 'godot_tools',
        compatibilityThrough: '1.x',
      },
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
      env: { GODOT_MCP_TOOL_SURFACE: 'core' },
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

  it('ships one canonical four-skill inventory with exact trigger and interface metadata', () => {
    expect(readdirSync(join(pluginRoot, 'skills')).sort()).toEqual(expectedSkills);
    expect(adapter.skills.map((entry: { name: string }) => entry.name)).toEqual(expectedSkills);
    for (const declared of adapter.skills) {
      const source = skill(declared.name);
      expect(source).toMatch(new RegExp(`^---\\nname: ${declared.name}\\ndescription: ${declared.description.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n---`));
      expect(source).not.toContain('[TODO:');
      expect(source.split('\n').length, declared.name).toBeLessThanOrEqual(121);
      const ui = declared.interface;
      expect(ui.shortDescription.length).toBeGreaterThanOrEqual(25);
      expect(ui.shortDescription.length).toBeLessThanOrEqual(64);
      expect(ui.defaultPrompt).toContain(`$${declared.name}`);
      expect(readFileSync(join(pluginRoot, 'skills', declared.name, 'agents/openai.yaml'), 'utf8')).toBe([
        'interface:',
        `  display_name: ${JSON.stringify(ui.displayName)}`,
        `  short_description: ${JSON.stringify(ui.shortDescription)}`,
        `  default_prompt: ${JSON.stringify(ui.defaultPrompt)}`,
        '',
      ].join('\n'));
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

  it('keeps the complete safety and lifecycle contract in every primary skill', () => {
    for (const name of expectedSkills) {
      const source = skill(name);
      for (const required of [
        /Godot 4\.7/i,
        /effective MCP roots/i,
        /watched or unattended|watched work/i,
        /runtime-ephemeral/i,
        /godot_catalog/,
        /godot_call/,
        /bounded/i,
        /game_key_press/,
        /game_key_hold/,
        /game_key_release/,
        /Pause Agent/,
        /already enabled/i,
        /static validation|validate_scripts|validate_script/i,
        /independent/i,
        /warning/i,
        /fallback/i,
        /subjective/i,
        /cleanup|teardown/i,
      ]) expect(source, `${name}: ${required}`).toMatch(required);
      expect(source).not.toContain('`godot_tools`');
    }
    expect(skill('verify-godot-change')).toMatch(/not corrective persistent mutation/i);
    expect(skill('build-godot-game')).toMatch(/Stop with a blocker.*cannot be attached or launched/is);
    expect(skill('debug-godot-game')).toMatch(/one falsifiable hypothesis/i);
    expect(skill('ship-godot-game')).toMatch(/passed, failed, blocked, manual, and\s+unsupported/is);
  });

  it('keeps backticked tool references valid and inside each direct/hidden contract', () => {
    const catalog = new Set(toolDefinitions.map(tool => tool.name));
    const documentedNonTools = new Set([
      '_ready()', 'compact', 'ensure', 'game_*', 'project.godot', 'projectPath',
      '{ "r": 0.2, "g": 0.7, "b": 1.0, "a": 1.0 }',
      '{ "x": 120, "y": 80 }',
    ]);
    for (const declared of adapter.skills) {
      const source = skill(declared.name);
      const contract = declared.toolContract as {
        direct: string[]; hidden: string[]; privilegedGroups: string[]; effectScopes: string[];
      };
      expect(new Set(contract.direct).size).toBe(contract.direct.length);
      expect(new Set(contract.hidden).size).toBe(contract.hidden.length);
      expect(contract.direct.filter(name => contract.hidden.includes(name))).toEqual([]);
      for (const name of contract.direct) {
        expect(catalog.has(name), `${declared.name}: unknown direct tool ${name}`).toBe(true);
        expect(
          CORE_TOOL_NAMES.has(name as (typeof toolDefinitions)[number]['name']),
          `${declared.name}: ${name} is not direct on core`,
        ).toBe(true);
        expect(contract.effectScopes, `${declared.name}: missing effect for ${name}`)
          .toContain(toolCatalogMetadata[name as (typeof toolDefinitions)[number]['name']].effectScope);
      }
      for (const name of contract.hidden) {
        expect(catalog.has(name), `${declared.name}: unknown hidden tool ${name}`).toBe(true);
        expect(
          CORE_TOOL_NAMES.has(name as (typeof toolDefinitions)[number]['name']),
          `${declared.name}: ${name} is unexpectedly core`,
        ).toBe(false);
        expect(contract.effectScopes, `${declared.name}: missing effect for ${name}`)
          .toContain(toolCatalogMetadata[name as (typeof toolDefinitions)[number]['name']].effectScope);
        const containingParagraphs = source.split(/\n\s*\n/).filter(paragraph => paragraph.includes(`\`${name}\``));
        for (const paragraph of containingParagraphs) {
          expect(paragraph, `${declared.name}: hidden ${name} bypasses catalog/call`).toContain('`godot_catalog`');
          expect(paragraph, `${declared.name}: hidden ${name} bypasses catalog/call`).toContain('`godot_call`');
          expect(paragraph).toMatch(/never\s+call\s+a\s+hidden\s+tool\s+directly/i);
        }
      }
      const referenced = [...new Set([...source.matchAll(/`([^`\n]+)`/g)].map(match => match[1]))];
      for (const reference of referenced) {
        if (catalog.has(reference)) {
          expect(
            [...contract.direct, ...contract.hidden],
            `${declared.name}: undeclared tool reference ${reference}`,
          ).toContain(reference);
        } else {
          expect(documentedNonTools, `${declared.name}: unknown backticked reference ${reference}`).toContain(reference);
        }
      }
    }
  });

  it('ships the Pi extension as a thin manifest-selected MCP client', () => {
    const extension = readFileSync(join(pluginRoot, 'pi/extension.ts'), 'utf8');
    expect(extension).toContain('StdioClientTransport');
    expect(extension).toContain('await next.connect(transport)');
    expect(extension).toContain('await next.listTools()');
    expect(extension).toContain('pi.registerTool');
    expect(extension).toContain('...launch.environment');
    expect(extension).toContain('tool.title ?? tool.annotations?.title ?? tool.name');
    expect(extension).toContain("pi.on('session_shutdown', close)");
    expect(extension).not.toContain('toolDefinitions');

    expect(resolvePiServerLaunch({
      localServerEntry: '/installed/package/build/index.js',
      exists: () => true,
    })).toEqual({
      command: process.execPath,
      args: ['/installed/package/build/index.js'],
      environment: { GODOT_MCP_TOOL_SURFACE: 'core' },
    });
    expect(resolvePiServerLaunch({ exists: () => false })).toEqual({
      command: 'npx',
      args: ['-y', `${packageJson.name}@${packageJson.version}`],
      environment: { GODOT_MCP_TOOL_SURFACE: 'core' },
    });
  });
});
