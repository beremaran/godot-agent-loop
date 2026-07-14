// @test-kind: contract
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { toolDefinitions } from '../src/tool-definitions.js';

interface PackageMetadata {
  name: string;
  version: string;
  description: string;
  homepage: string;
  bugs: { url: string };
  repository: { url: string };
  mcpName: string;
  bin: Record<string, string>;
}

interface ServerMetadata {
  name: string;
  title: string;
  description: string;
  version: string;
  websiteUrl: string;
  repository: { url: string };
  packages: { identifier: string; version: string }[];
}

const root = fileURLToPath(new URL('..', import.meta.url));
const product = JSON.parse(readFileSync(join(root, 'product.json'), 'utf8')) as {
  name: string;
  description: string;
  version: string;
  repository: { url: string; issues: string };
  npm: { package: string; binary: string };
  mcp: { registryName: string; title: string };
};
const packageMetadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageMetadata;
const serverMetadata = JSON.parse(readFileSync(join(root, 'server.json'), 'utf8')) as ServerMetadata;

function withoutGitSuffix(url: string): string {
  return url.replace(/\.git$/, '');
}

describe('release and MCP Registry metadata', () => {
  it('derives the advertised tool count from the callable manifest inventory', () => {
    const countClaim = new RegExp(`\\b${toolDefinitions.length}\\s+tested tools\\b`);
    expect(packageMetadata.description).toMatch(countClaim);
    expect(serverMetadata.description).toBe(packageMetadata.description);
  });

  it('keeps package and registry artifacts aligned with product.json', () => {
    expect(packageMetadata).toMatchObject({
      name: product.npm.package,
      version: product.version,
      description: product.description,
      homepage: product.repository.url,
      bugs: { url: product.repository.issues },
      mcpName: product.mcp.registryName,
      bin: { [product.npm.binary]: './build/index.js' },
    });
    expect(withoutGitSuffix(packageMetadata.repository.url)).toBe(product.repository.url);
    expect(serverMetadata).toMatchObject({
      name: product.mcp.registryName,
      title: product.mcp.title,
      description: product.description,
      version: product.version,
      websiteUrl: product.repository.url,
      repository: { url: product.repository.url },
    });
    expect(serverMetadata.packages).toEqual([
      expect.objectContaining({ identifier: product.npm.package, version: product.version }),
    ]);
  });
});
