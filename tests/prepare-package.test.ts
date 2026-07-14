// @test-kind: unit
import { describe, expect, it, vi } from 'vitest';
import { preparePackage } from '../scripts/prepare-package.js';

describe('package prepare lifecycle', () => {
  it('does not require omitted development tools during production Git installs', () => {
    const execute = vi.fn();
    const log = vi.fn();

    expect(preparePackage({
      root: '/production/git-package',
      exists: () => false,
      execute,
      log,
      platform: 'linux',
    })).toBe('skipped-production-install');
    expect(execute).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('Skipping source build: development dependencies are not installed.');
  });

  it('builds source checkouts and installs hooks when development tools exist', () => {
    const execute = vi.fn();

    expect(preparePackage({
      root: '/development/checkout',
      exists: () => true,
      execute,
      log: vi.fn(),
      platform: 'linux',
    })).toBe('built-source-checkout');
    expect(execute).toHaveBeenNthCalledWith(1, 'npm', ['run', 'build'], {
      cwd: '/development/checkout', stdio: 'inherit', shell: false,
    });
    expect(execute).toHaveBeenNthCalledWith(2, '/development/checkout/node_modules/.bin/husky', [], {
      cwd: '/development/checkout', stdio: 'inherit', shell: false,
    });
  });
});
