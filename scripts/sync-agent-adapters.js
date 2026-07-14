import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSkillFrontmatter } from './skill-frontmatter.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const write = process.argv.includes('--write');
const manifest = json('agent-plugin/adapter-manifest.json');
const product = json('product.json');
const packageJson = json('package.json');

function json(path) {
  return JSON.parse(readFileSync(join(root, path), 'utf8'));
}

function formatted(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} is out of sync with agent-plugin/adapter-manifest.json`);
  }
}

function syncJson(path, expected) {
  const target = join(root, path);
  if (write) {
    writeFileSync(target, formatted(expected));
  } else {
    assertEqual(json(path), expected, path);
  }
}

function skillFrontmatter(name) {
  const source = readFileSync(join(root, 'agent-plugin', 'skills', name, 'SKILL.md'), 'utf8');
  return parseSkillFrontmatter(source, name);
}

assertEqual(
  { name: manifest.displayName, version: manifest.version, package: manifest.package },
  { name: product.name, version: product.version, package: product.npm.package },
  'adapter identity',
);
assertEqual(manifest.mcp.command, ['npx', '-y', `${product.npm.package}@${product.version}`], 'MCP command');
assertEqual(manifest.skills.map(({ name }) => name), [...manifest.skills.map(({ name }) => name)].sort(), 'skill inventory order');
for (const declared of manifest.skills) assertEqual(skillFrontmatter(declared.name), declared, `skill ${declared.name}`);

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
  description: 'Evidence-first Godot game-development tools and agent workflows.',
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

syncJson('agent-plugin/.mcp.json', mcpServers);
syncJson('agent-plugin/.claude-plugin/plugin.json', claudePlugin);
syncJson('agent-plugin/.codex-plugin/plugin.json', codexPlugin);
syncJson('.claude-plugin/marketplace.json', claudeMarketplace);
syncJson('.agents/plugins/marketplace.json', codexMarketplace);

const expectedPackage = {
  files: ['build', 'agent-plugin', 'addons/godot_agent_loop', 'product.json'],
  pi: {
    extensions: ['./agent-plugin/pi/extension.ts'],
    skills: ['./agent-plugin/skills'],
  },
};
if (write) {
  packageJson.files = expectedPackage.files;
  packageJson.pi = expectedPackage.pi;
  packageJson.keywords = [...new Set([...packageJson.keywords, 'pi-package'])];
  writeFileSync(join(root, 'package.json'), formatted(packageJson));
} else {
  assertEqual(packageJson.files, expectedPackage.files, 'package.json files');
  assertEqual(packageJson.pi, expectedPackage.pi, 'package.json pi');
  if (!packageJson.keywords.includes('pi-package')) throw new Error('package.json is missing the pi-package keyword');
}

console.log(write ? 'Agent adapters synchronized' : 'Agent adapters are current');
