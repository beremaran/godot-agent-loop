// @test-kind: contract
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './helpers/manifest-sources.js';

const product = JSON.parse(readFileSync(join(repoRoot, 'product.json'), 'utf8')) as {
  name: string;
  tagline: string;
  category: string;
  version: string;
  repository: { url: string };
  npm: { package: string; binary: string };
  mcp: { registryName: string; serverName: string; title: string };
  agentBundle: { pluginName: string; serverKey: string };
  addon: {
    directory: string; name: string; category: string; minimumGodotVersion: string;
    primaryGodotVersion: string; version: string; protocolVersion: string; license: string;
    description: string; icon: string; previews: string[];
  };
  observability: { serverComponent: string; runtimeComponent: string; editorComponent: string };
  lineage: { originalRepository: string; inheritedRepository: string };
};
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  files: string[];
};

function source(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

describe('Godot Agent Loop product identity', () => {
  it('records the confirmed Option 1 identity in one product manifest', () => {
    expect(product).toMatchObject({
      name: 'Godot Agent Loop',
      tagline: 'Build it. Play it. Prove it.',
      category: 'An MCP automation loop for Godot 4',
      version: '1.1.0',
      repository: { url: 'https://github.com/beremaran/godot-agent-loop' },
      npm: { package: '@beremaran/godot-agent-loop', binary: 'godot-agent-loop' },
      mcp: {
        registryName: 'io.github.beremaran/godot-agent-loop',
        serverName: 'godot-agent-loop',
        title: 'Godot Agent Loop',
      },
      addon: {
        directory: 'addons/godot_agent_loop', name: 'Godot Agent Loop Bridge',
        category: 'Addons/Tools', minimumGodotVersion: '4.7', primaryGodotVersion: '4.7',
        version: '1.1.0', protocolVersion: '2', license: 'MIT',
      },
    });
    expect(packageJson.files).toContain('product.json');
  });

  it('keeps AssetLib identity, protocol, and media tied to the product manifest', () => {
    const config = source(`${product.addon.directory}/plugin.cfg`);
    expect(config).toContain(`name="${product.addon.name}"`);
    expect(config).toContain(`version="${product.addon.version}"`);
    expect(config).toContain(`protocol_version="${product.addon.protocolVersion}"`);
    expect(config).toContain(`minimum_godot_version="${product.addon.minimumGodotVersion}"`);
    const plugin = source(`${product.addon.directory}/plugin.gd`);
    expect(plugin).toContain(`const PROTOCOL_VERSION: String = "${product.addon.protocolVersion}"`);
    expect(plugin).toContain(`const ADDON_VERSION: String = "${product.addon.version}"`);
    expect(source(`${product.addon.directory}/LICENSE`)).toContain('MIT License');
    expect(source(`${product.addon.directory}/README.md`)).toContain(product.addon.name);
    expect(() => readFileSync(join(repoRoot, product.addon.icon))).not.toThrow();
    for (const preview of product.addon.previews) {
      expect(() => readFileSync(join(repoRoot, preview)), preview).not.toThrow();
    }
  });

  it('aligns the runtime schema, server implementation, and transient editor UI', () => {
    const schema = JSON.parse(source('docs/runtime-api.schema.json')) as {
      $id: string;
      title: string;
      'x-runtime-contract': { observability: { components: string[] } };
    };
    expect(schema.$id).toBe(`${product.repository.url}/runtime-api-1.0.schema.json`);
    expect(schema.title).toBe(`${product.name} Runtime API`);
    expect(schema['x-runtime-contract'].observability.components).toEqual([
      product.observability.serverComponent,
      product.observability.runtimeComponent,
      product.observability.editorComponent,
    ]);
    expect(source('src/index.ts')).toContain(`name: '${product.mcp.serverName}'`);
    expect(source('src/game-connection.ts')).toContain(`component: '${product.observability.serverComponent}'`);
    expect(source('src/scripts/mcp_interaction_server.gd')).toContain(`"component": "${product.observability.runtimeComponent}"`);
    expect(source('addons/godot_agent_loop/plugin.gd')).toContain(`_activity_dock.name = "${product.name}"`);
  });

  it('puts outcome, setup, proof, support boundary, and lineage on the README path', () => {
    const readme = source('README.md');
    const firstScreen = readme.split('\n').slice(0, 90).join('\n');
    for (const expected of [
      `# ${product.name}`,
      product.tagline,
      product.category,
      product.npm.package,
      'author → validate → run → observe → playtest → verify → refine',
      '171/171 tools',
      '365 public actions',
      '40 tools',
      'Support is deliberately bounded',
    ]) {
      expect(firstScreen).toContain(expected);
    }
    expect(readme).toContain('## Lineage');
    expect(readme).toContain(product.lineage.originalRepository);
    expect(readme).toContain(product.lineage.inheritedRepository);
    expect(readme).toMatch(/complete Git\s+history/);
  });

  it('contains no superseded public identifiers in release-facing artifacts', () => {
    const releaseFacing = [
      'package.json',
      'server.json',
      'README.md',
      'CONTRIBUTING.md',
      'docs/agent-plugin.md',
      'docs/runtime-api.schema.json',
      'agent-plugin/adapter-manifest.json',
      'agent-plugin/.mcp.json',
      'agent-plugin/.claude-plugin/plugin.json',
      'agent-plugin/.codex-plugin/plugin.json',
      '.claude-plugin/marketplace.json',
      '.agents/plugins/marketplace.json',
    ];
    for (const path of releaseFacing) {
      const content = source(path);
      expect(content, path).not.toContain('@beremaran/godot-mcp');
      expect(content, path).not.toContain('io.github.beremaran/godot-mcp');
      expect(content, path).not.toContain('github.com/beremaran/godot-mcp');
    }
  });
});
