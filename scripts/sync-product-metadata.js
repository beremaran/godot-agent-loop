#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const write = process.argv.includes('--write');
const product = readJson('product.json');

const expectedPackageFields = {
  name: product.npm.package,
  version: product.version,
  description: product.description,
  homepage: product.repository.url,
  bugs: { url: product.repository.issues },
  repository: { type: 'git', url: `${product.repository.url}.git` },
  mcpName: product.mcp.registryName,
  bin: { [product.npm.binary]: './build/index.js' },
};

const expectedServerFields = {
  name: product.mcp.registryName,
  title: product.mcp.title,
  description: product.description,
  repository: { url: product.repository.url, source: 'github' },
  version: product.version,
  websiteUrl: product.repository.url,
  packages: [{
    registryType: 'npm',
    identifier: product.npm.package,
    version: product.version,
    transport: { type: 'stdio' },
  }],
};

syncSelectedFields('package.json', expectedPackageFields);
syncSelectedFields('server.json', expectedServerFields);

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(root, relativePath), 'utf8'));
}

function syncSelectedFields(relativePath, expected) {
  const path = join(root, relativePath);
  const actual = readJson(relativePath);
  const projected = Object.fromEntries(Object.keys(expected).map(key => [key, actual[key]]));
  if (JSON.stringify(projected) === JSON.stringify(expected)) return;

  if (!write) {
    throw new Error(`${relativePath} product metadata is stale; run npm run product:sync`);
  }

  const updated = { ...actual, ...expected };
  writeFileSync(path, `${JSON.stringify(updated, null, 2)}\n`);
  process.stdout.write(`updated ${relativePath}\n`);
}
