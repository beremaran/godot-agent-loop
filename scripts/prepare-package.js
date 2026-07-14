import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Build source checkouts when development tools are installed, while allowing
 * production-only Git consumers (notably Pi) to install the adapter bundle.
 * Published npm tarballs already contain build/; a Git-installed Pi adapter
 * falls back to the manifest-pinned npm server until that package resolves.
 */
export function preparePackage(options = {}) {
  const root = options.root ?? repositoryRoot;
  const exists = options.exists ?? existsSync;
  const execute = options.execute ?? execFileSync;
  const log = options.log ?? console.log;
  const windows = options.platform === 'win32' || (options.platform === undefined && process.platform === 'win32');
  const executable = name => join(root, 'node_modules', '.bin', `${name}${windows ? '.cmd' : ''}`);

  if (!exists(executable('tsc'))) {
    log('Skipping source build: development dependencies are not installed.');
    return 'skipped-production-install';
  }

  execute(windows ? 'npm.cmd' : 'npm', ['run', 'build'], {
    cwd: root,
    stdio: 'inherit',
    shell: windows,
  });

  const husky = executable('husky');
  if (exists(husky)) {
    execute(husky, [], { cwd: root, stdio: 'inherit', shell: windows });
  }
  return 'built-source-checkout';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  preparePackage();
}
