#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const policy = JSON.parse(readFileSync(join(repoRoot, 'evals', 'change-impact.json'), 'utf8'));
const allCases = ['cases.json', 'server-cases.json'].flatMap(name =>
  JSON.parse(readFileSync(join(repoRoot, 'evals', name), 'utf8')).cases.map(entry => entry.id));

function parseArgs(argv) {
  const options = { changedFiles: [] };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--changed-file') options.changedFiles.push(argv[++index]);
    else if (argv[index] === '--base') options.base = argv[++index];
    else if (argv[index] === '--head') options.head = argv[++index];
    else throw new Error(`Unknown option: ${argv[index]}`);
  }
  if (options.changedFiles.length === 0 && !options.base) {
    throw new Error('Provide --changed-file or --base [--head].');
  }
  return options;
}

function gitFiles(base, head = 'HEAD') {
  const result = spawnSync('git', ['diff', '--name-only', `${base}...${head}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr || 'git diff failed');
  return result.stdout.split(/\r?\n/u).filter(Boolean);
}

export function selectCases(changedFiles) {
  const selected = new Set();
  const matches = [];
  for (const file of [...new Set(changedFiles)].sort()) {
    for (const rule of policy.rules) {
      if (!new RegExp(rule.pathPattern, 'u').test(file)) continue;
      const ids = rule.suite === 'all' ? allCases : policy.suites[rule.suite];
      ids.forEach(id => selected.add(id));
      matches.push({ file, suite: rule.suite, reason: rule.reason });
    }
  }
  return {
    schemaVersion: 1,
    changedFiles: [...new Set(changedFiles)].sort(),
    selectedCases: [...selected].sort(),
    selectedCaseCount: selected.size,
    paidRunRequired: selected.size > 0,
    paidRunAutomatic: false,
    matches,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const files = options.changedFiles.length > 0
    ? options.changedFiles
    : gitFiles(options.base, options.head);
  console.log(JSON.stringify(selectCases(files), null, 2));
}
