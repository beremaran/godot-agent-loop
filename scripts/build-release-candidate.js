import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const product = JSON.parse(readFileSync(join(repositoryRoot, 'product.json'), 'utf8'));
const expectedCommit = process.argv[2];
if (!/^[0-9a-f]{40}$/.test(expectedCommit ?? '')) {
  throw new Error('Usage: node scripts/build-release-candidate.js <40-character-tested-commit> [output-directory]');
}
const head = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repositoryRoot, encoding: 'utf8',
}).trim();
if (head !== expectedCommit) {
  throw new Error(`Release candidate commit mismatch: expected ${expectedCommit}, checked out ${head}`);
}
const status = execFileSync('git', ['status', '--porcelain'], {
  cwd: repositoryRoot, encoding: 'utf8',
}).trim();
if (status) throw new Error('Release candidate requires a clean working tree');

const outputRoot = resolve(process.argv[3] ?? join(repositoryRoot, 'dist/release'));
rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });

execFileSync('npm', ['pack', '--silent', '--pack-destination', outputRoot], {
  cwd: repositoryRoot, stdio: 'inherit',
});
const npmArchive = readdirSync(outputRoot).find(name => name.endsWith('.tgz'));
if (!npmArchive) throw new Error('npm pack did not produce a tarball');

const assetLibName = `${product.repository.name}-${product.version}.zip`;
execFileSync(process.execPath, [
  join(repositoryRoot, 'scripts/build-assetlib-archive.js'), join(outputRoot, assetLibName),
], { cwd: repositoryRoot, stdio: 'inherit' });

const copies = [
  ['assets/demo/godot-agent-loop-launch.mp4', 'godot-agent-loop-launch.mp4'],
  ['assets/demo/godot-agent-loop-launch-poster.png', 'godot-agent-loop-launch-poster.png'],
  ['docs/releases/1.0.1.md', 'RELEASE_NOTES.md'],
  ['server.json', 'server.json'],
];
for (const [source, destination] of copies) {
  copyFileSync(join(repositoryRoot, source), join(outputRoot, destination));
}

const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const names = readdirSync(outputRoot).sort();
const files = Object.fromEntries(names.map(name => [name, sha256(join(outputRoot, name))]));
const manifest = {
  schemaVersion: 1,
  product: product.name,
  version: product.version,
  commit: expectedCommit,
  files,
};
writeFileSync(join(outputRoot, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const checksumNames = [...names, 'release-manifest.json'].sort();
writeFileSync(join(outputRoot, 'SHA256SUMS'), `${checksumNames.map(name => (
  `${sha256(join(outputRoot, name))}  ${basename(name)}`
)).join('\n')}\n`);

console.log(JSON.stringify({ output: outputRoot, ...manifest }, null, 2));
