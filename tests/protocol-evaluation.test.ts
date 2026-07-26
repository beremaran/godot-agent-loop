// @test-kind: contract
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import packageDocument from '../package.json';
import { repoRoot } from './helpers/manifest-sources.js';

const protocol = JSON.parse(readFileSync(
  join(repoRoot, 'evals/protocol/conformance-scenarios.json'),
  'utf8',
)) as {
  package: { name: string; version: string };
  applicable: string[];
  notApplicable: { id: string; reason: string }[];
};

describe('MCP protocol evaluation lane', () => {
  it('classifies every pinned active conformance scenario without claiming exclusions as passes', () => {
    expect(protocol.package).toEqual({
      name: '@modelcontextprotocol/conformance',
      version: packageDocument.devDependencies['@modelcontextprotocol/conformance'],
    });
    const classified = [
      ...protocol.applicable,
      ...protocol.notApplicable.map(entry => entry.id),
    ];
    expect(classified).toHaveLength(30);
    expect(new Set(classified).size).toBe(classified.length);
    expect(protocol.applicable).toEqual(expect.arrayContaining([
      'server-initialize',
      'ping',
      'tools-list',
      'server-sse-multiple-streams',
      'dns-rebinding-protection',
    ]));
    expect(protocol.notApplicable.every(entry => entry.reason.length > 20)).toBe(true);
  });

  it('pins both protocol tools and exposes reproducible package commands', () => {
    expect(packageDocument.devDependencies['@modelcontextprotocol/conformance']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(packageDocument.devDependencies['@modelcontextprotocol/inspector-cli']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(packageDocument.scripts['eval:protocol'])
      .toBe('npm run build && node scripts/run-protocol-evaluation.mjs');
    expect(packageDocument.scripts.inspector).not.toContain('npx');
  });

  it('keeps the HTTP transport evaluation-only and loopback constrained', () => {
    const launcher = readFileSync(join(repoRoot, 'scripts/evaluation-http-server.mjs'), 'utf8');
    expect(launcher).toContain("const host = '127.0.0.1'");
    expect(launcher).toContain('loopback authority or origin rejected');
    expect(launcher).toContain("url.pathname !== '/mcp'");
    expect(launcher).toContain('manageProcessLifecycle: false');
    expect(launcher).not.toContain('0.0.0.0');
    const runner = readFileSync(join(repoRoot, 'scripts/run-protocol-evaluation.mjs'), 'utf8');
    expect(runner).toContain("scripts/run-inspector-cli.mjs");
    expect(runner).toContain("'tools/list'");
    expect(runner).toContain("'tools/call'");
    expect(runner).toContain('invalidCallStructuredError');
    expect(runner).toContain("'invalid_arguments'");
    expect(runner).toContain("transport: 'production-stdio'");
    const inspectorWrapper = readFileSync(join(repoRoot, 'scripts/run-inspector-cli.mjs'), 'utf8');
    expect(inspectorWrapper).toContain('@modelcontextprotocol');
    expect(inspectorWrapper).toContain('inspector-cli');
  });
});
