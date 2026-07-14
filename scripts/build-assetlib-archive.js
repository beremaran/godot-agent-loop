import { createWriteStream, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZipFile } from 'yazl';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const product = JSON.parse(readFileSync(join(repositoryRoot, 'product.json'), 'utf8'));
const addonRoot = join(repositoryRoot, product.addon.directory);
const outputPath = resolve(process.argv[2] ?? join(
  repositoryRoot,
  'dist',
  `${product.repository.name}-${product.version}.zip`,
));
// ZIP's mandatory DOS timestamp has no timezone. Construct the same local wall
// time in every release environment and omit yazl's UTC timestamp extension so
// the archive bytes do not depend on the machine timezone.
const archiveMtime = new Date(2000, 0, 1, 0, 0, 0);

function collectFiles(directory) {
  const files = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`AssetLib archive refuses symbolic links: ${path}`);
    if (stat.isDirectory()) files.push(...collectFiles(path));
    else if (stat.isFile()) files.push(path);
    else throw new Error(`AssetLib archive refuses non-regular files: ${path}`);
  }
  return files;
}

const files = collectFiles(addonRoot);
const required = ['LICENSE', 'README.md', 'plugin.cfg', 'plugin.gd'];
for (const name of required) {
  if (!files.some(path => relative(addonRoot, path) === name)) {
    throw new Error(`AssetLib addon is missing required file: ${name}`);
  }
}

mkdirSync(dirname(outputPath), { recursive: true });
rmSync(outputPath, { force: true });
const archive = new ZipFile();
const output = createWriteStream(outputPath, { mode: 0o644 });
const completion = new Promise((resolvePromise, reject) => {
  output.on('close', resolvePromise);
  output.on('error', reject);
  archive.outputStream.on('error', reject);
});
archive.outputStream.pipe(output);
for (const path of files) {
  const addonRelativePath = relative(addonRoot, path).split(sep).join('/');
  archive.addFile(path, `${product.addon.directory}/${addonRelativePath}`, {
    mtime: archiveMtime,
    mode: 0o100644,
    forceDosTimestamp: true,
  });
}
archive.end({ comment: `${product.addon.name} ${product.version}` });
await completion;

console.log(JSON.stringify({
  archive: outputPath,
  addon: product.addon.directory,
  version: product.version,
  files: files.length,
}, null, 2));
