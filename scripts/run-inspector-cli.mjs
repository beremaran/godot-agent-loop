#!/usr/bin/env node

import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const inspectorBuild = join(
  repoRoot,
  'node_modules',
  '@modelcontextprotocol',
  'inspector-cli',
  'build',
);
const inspectorEntry = join(inspectorBuild, 'index.js');

if ((process.argv[2] === 'node' || process.argv[2] === process.execPath)
  && process.argv[3]
  && !isAbsolute(process.argv[3])) {
  process.argv[3] = resolve(repoRoot, process.argv[3]);
}

/*
 * Inspector CLI 1.0.0 resolves its own package.json relative to the process
 * working directory before importing it relative to the module. Running from
 * the package build directory selects its documented standalone-package path.
 * All target paths supplied by this repository are absolute, so changing cwd
 * does not change which MCP server is evaluated.
 */
process.chdir(inspectorBuild);
process.argv[1] = inspectorEntry;
await import(pathToFileURL(inspectorEntry).href);
