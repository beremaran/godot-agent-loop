// @test-kind: contract
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { toolDefinitions } from '../src/tool-definitions.js';

interface PackageMetadata {
  name: string;
  version: string;
  description: string;
  homepage: string;
  repository: { url: string };
  mcpName: string;
}

interface ServerMetadata {
  name: string;
  description: string;
  version: string;
  websiteUrl: string;
  repository: { url: string };
  packages: { identifier: string; version: string }[];
}

const root = join(new URL('..', import.meta.url).pathname);
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

  it('keeps registry identity, version, package, and repository aligned with package.json', () => {
    expect(serverMetadata.name).toBe(packageMetadata.mcpName);
    expect(serverMetadata.version).toBe(packageMetadata.version);
    expect(serverMetadata.packages).toEqual([
      expect.objectContaining({ identifier: packageMetadata.name, version: packageMetadata.version }),
    ]);
    expect(serverMetadata.websiteUrl).toBe(packageMetadata.homepage);
    expect(serverMetadata.repository.url).toBe(withoutGitSuffix(packageMetadata.repository.url));
  });
});
