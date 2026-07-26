#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(scriptPath));

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--output') options.output = resolve(argv[++index]);
    else throw new Error(`Unknown option: ${argv[index]}`);
  }
  return options;
}

export function prepareBaseline(options = {}) {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'evals', 'baselines', 'v1.1.4', 'manifest.json'), 'utf8'));
  const output = options.output ?? join(repoRoot, 'evals', 'cache', `baseline-${manifest.package.version}`);
  const packageRoot = join(output, 'package');
  const serverPath = join(packageRoot, 'build', 'index.js');
  const preparedManifest = join(output, 'prepared-baseline.json');
  if (existsSync(preparedManifest) && existsSync(serverPath)) {
    return JSON.parse(readFileSync(preparedManifest, 'utf8'));
  }
  if (existsSync(output)) {
    throw new Error(`Refusing to overwrite incomplete baseline directory: ${output}`);
  }
  mkdirSync(output, { recursive: true });
  const pack = JSON.parse(run('npm', [
    'pack',
    `@beremaran/godot-agent-loop@${manifest.package.version}`,
    '--json',
    '--pack-destination',
    output,
  ], repoRoot));
  const tarball = join(output, pack[0].filename);
  const observedSha256 = sha256(tarball);
  if (observedSha256 !== manifest.package.sha256) {
    throw new Error(`Published tarball SHA-256 mismatch: ${observedSha256}`);
  }
  run('tar', ['-xzf', tarball, '-C', output], repoRoot);
  run('npm', ['install', '--omit=dev', '--ignore-scripts'], packageRoot);
  if (!existsSync(serverPath)) throw new Error(`Released package has no built server: ${serverPath}`);
  const result = {
    schemaVersion: 1,
    baselineId: manifest.baselineId,
    packageVersion: manifest.package.version,
    packageSha256: observedSha256,
    packageRoot,
    serverPath,
    preparedAt: new Date().toISOString(),
  };
  writeFileSync(preparedManifest, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  console.log(JSON.stringify(prepareBaseline(parseArgs(process.argv.slice(2))), null, 2));
}
