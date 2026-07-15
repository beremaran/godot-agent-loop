import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const product = JSON.parse(readFileSync(join(repositoryRoot, 'product.json'), 'utf8'));
const downloadCommit = process.argv[2];
if (!/^[0-9a-f]{40}$/.test(downloadCommit ?? '')) {
  throw new Error('Usage: node scripts/build-assetlib-submission.js <40-character-download-commit> [output.json]');
}
const outputPath = resolve(process.argv[3] ?? join(repositoryRoot, 'dist/assetlib-submission.json'));
const rawBase = `https://raw.githubusercontent.com/${product.repository.owner}/${product.repository.name}/${downloadCommit}`;
const payload = {
  status: 'prepared-not-submitted',
  assetName: product.addon.name,
  category: product.addon.category,
  godotVersion: product.addon.minimumGodotVersion,
  testedThroughGodotVersion: product.addon.primaryGodotVersion,
  version: product.addon.version,
  repositoryHost: 'GitHub',
  repositoryUrl: product.repository.url,
  issuesUrl: product.repository.issues,
  downloadCommit,
  license: product.addon.license,
  iconUrl: `${rawBase}/${product.addon.icon}`,
  description: product.addon.description,
  previews: product.addon.previews.map(path => ({
    type: 'image',
    imageUrl: `${rawBase}/${path}`,
    thumbnailUrl: `${rawBase}/${path}`,
  })),
  protocolVersion: product.addon.protocolVersion,
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(outputPath);
