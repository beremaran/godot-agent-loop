import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSkillFrontmatter } from './skill-frontmatter.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const write = process.argv.includes('--write');

function formatted(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} is out of sync with agent-plugin/adapter-manifest.json`);
  }
}

function syncJson(path, expected, options = { write, root }) {
  const target = join(options.root, path);
  if (options.write) {
    writeFileSync(target, formatted(expected));
  } else {
    assertEqual(JSON.parse(readFileSync(target, 'utf8')), expected, path);
  }
}

export function normalizeNewlines(text) {
  return text.replace(/\r\n/g, '\n');
}

export function assertGeneratedTextCurrent(actual, expected, path) {
  if (normalizeNewlines(actual) !== expected) {
    throw new Error(`${path} is out of sync with agent-plugin/adapter-manifest.json`);
  }
}

function syncText(path, expected, options = { write, root }) {
  const target = join(options.root, path);
  if (options.write) {
    writeFileSync(target, expected);
    return;
  }
  const actual = readFileSync(target, 'utf8');
  assertGeneratedTextCurrent(actual, expected, path);
}

function skillFrontmatter(name, options = { root }) {
  const source = readFileSync(join(options.root, 'agent-plugin', 'skills', name, 'SKILL.md'), 'utf8');
  return parseSkillFrontmatter(source, name);
}

export function syncAgentAdapters(options = { write, root }) {
  const manifest = JSON.parse(readFileSync(join(options.root, 'agent-plugin/adapter-manifest.json'), 'utf8'));
  const product = JSON.parse(readFileSync(join(options.root, 'product.json'), 'utf8'));
  const packageJson = JSON.parse(readFileSync(join(options.root, 'package.json'), 'utf8'));

  assertEqual(
    { name: manifest.displayName, version: manifest.version, package: manifest.package },
    { name: product.name, version: product.version, package: product.npm.package },
    'adapter identity',
  );
  assertEqual(manifest.mcp.command, ['npx', '-y', `${product.npm.package}@${product.version}`], 'MCP command');
  assertEqual(manifest.skills.map(({ name }) => name), [...manifest.skills.map(({ name }) => name)].sort(), 'skill inventory order');
  for (const declared of manifest.skills) {
    assertEqual(
      skillFrontmatter(declared.name, options),
      { name: declared.name, description: declared.description },
      `skill ${declared.name}`,
    );
    const ui = declared.interface;
    const openaiYaml = [
      'interface:',
      `  display_name: ${JSON.stringify(ui.displayName)}`,
      `  short_description: ${JSON.stringify(ui.shortDescription)}`,
      `  default_prompt: ${JSON.stringify(ui.defaultPrompt)}`,
      '',
    ].join('\n');
    syncText(`agent-plugin/skills/${declared.name}/agents/openai.yaml`, openaiYaml, options);
  }

  const mcpServers = {
    mcpServers: {
      [manifest.name]: {
        command: manifest.mcp.command[0],
        args: manifest.mcp.command.slice(1),
        env: manifest.mcp.environment,
      },
    },
  };

  const claudePlugin = {
    $schema: 'https://json.schemastore.org/claude-code-plugin-manifest.json',
    name: manifest.name,
    displayName: manifest.displayName,
    version: manifest.version,
    description: manifest.description,
    author: { name: 'Berke Arslan' },
    homepage: product.repository.url,
    repository: product.repository.url,
    license: 'MIT',
    keywords: ['godot', 'mcp', 'game-development'],
    mcpServers: './.mcp.json',
  };

  const codexPlugin = {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    author: { name: 'Berke Arslan', url: 'https://github.com/beremaran' },
    homepage: product.repository.url,
    repository: product.repository.url,
    license: 'MIT',
    keywords: ['godot', 'mcp', 'game-development'],
    skills: './skills/',
    mcpServers: './.mcp.json',
    interface: {
      displayName: manifest.displayName,
      shortDescription: 'Build, playtest, and prove Godot games',
      longDescription: manifest.description,
      developerName: 'Berke Arslan',
      category: 'Developer Tools',
      capabilities: ['Read', 'Write'],
      websiteURL: product.repository.url,
      defaultPrompt: manifest.defaultPrompts,
      brandColor: '#478CBF',
    },
  };

  const claudeMarketplace = {
    name: manifest.name,
    owner: { name: 'Berke Arslan' },
    description: 'Godot game-development tools and agent workflows.',
    plugins: [{
      name: manifest.name,
      source: './agent-plugin',
      description: 'Build, playtest, and prove Godot games through MCP.',
      category: 'development',
    }],
  };

  const codexMarketplace = {
    name: manifest.name,
    interface: { displayName: manifest.displayName },
    plugins: [{
      name: manifest.name,
      source: { source: 'local', path: './agent-plugin' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Developer Tools',
    }],
  };

  syncJson('agent-plugin/.mcp.json', mcpServers, options);
  syncJson('agent-plugin/.claude-plugin/plugin.json', claudePlugin, options);
  syncJson('agent-plugin/.codex-plugin/plugin.json', codexPlugin, options);
  syncJson('.claude-plugin/marketplace.json', claudeMarketplace, options);
  syncJson('.agents/plugins/marketplace.json', codexMarketplace, options);

  const expectedPackage = {
    files: ['build', 'agent-plugin', 'addons/godot_agent_loop', 'product.json', 'scripts/prepare-package.js'],
    pi: {
      extensions: ['./agent-plugin/pi/extension.ts'],
      skills: ['./agent-plugin/skills'],
    },
  };
  if (options.write) {
    packageJson.files = expectedPackage.files;
    packageJson.pi = expectedPackage.pi;
    packageJson.keywords = [...new Set([...packageJson.keywords, 'pi-package'])];
    writeFileSync(join(options.root, 'package.json'), formatted(packageJson));
  } else {
    assertEqual(packageJson.files, expectedPackage.files, 'package.json files');
    assertEqual(packageJson.pi, expectedPackage.pi, 'package.json pi');
    if (!packageJson.keywords.includes('pi-package')) throw new Error('package.json is missing the pi-package keyword');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  syncAgentAdapters();
  console.error(write ? 'Agent adapters synchronized' : 'Agent adapters are current');
}
