import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function listFiles(root) {
  const files = [];
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === '.godot' || entry.name === 'build') continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(relative(root, absolute).replaceAll('\\', '/'));
      }
    }
  };
  if (existsSync(root)) walk(root);
  return files.sort();
}

export function normalizedFixtureSnapshot(projectPath) {
  const snapshot = {};
  const projectPathBytes = Buffer.from(projectPath);
  for (const file of listFiles(projectPath)) {
    if (file.startsWith('addons/godot_agent_loop/') || file === 'fixtures/local-template.x86_64') {
      continue;
    }
    const absolute = join(projectPath, file);
    if (lstatSync(absolute).isSymbolicLink()) {
      const target = readlinkSync(absolute);
      snapshot[file] = `symlink:${relative(
        projectPath,
        resolve(dirname(absolute), target),
      ).replaceAll('\\', '/')}`;
      continue;
    }
    const contents = readFileSync(absolute);
    snapshot[file] = contents.includes(projectPathBytes)
      ? sha256(Buffer.from(contents.toString('utf8').replaceAll(projectPath, '$PROJECT')))
      : sha256(contents);
  }
  return snapshot;
}
