// @test-kind: contract
import { describe, expect, it } from 'vitest';
import { readRepoFile } from './helpers/manifest-sources.js';

const COMPATIBILITY_FLOOR = '4.7';
const PRIMARY_TARGET = '4.7';
const packageJson = JSON.parse(readRepoFile('package.json')) as { version: string };

describe('Godot support policy', () => {
  it('keeps the workflow matrix aligned with the documented primary target', () => {
    const workflow = readRepoFile('.github/workflows/godot-integration.yml');
    const versions = /godot-version:\s*\[([^\]]+)\]/.exec(workflow)?.[1]
      .match(/\d+\.\d+-stable/g) ?? [];
    expect(versions).toEqual([`${PRIMARY_TARGET}-stable`]);

    const readme = readRepoFile('README.md');
    const product = JSON.parse(readRepoFile('product.json')) as {
      addon: { minimumGodotVersion: string; primaryGodotVersion: string };
    };
    expect(readme).toContain(`CI covers that exact release`);
    expect(readme).toContain(`Godot ${COMPATIBILITY_FLOOR} is both the compatibility floor`);
    expect(product.addon).toMatchObject({
      minimumGodotVersion: COMPATIBILITY_FLOOR,
      primaryGodotVersion: PRIMARY_TARGET,
    });
    expect(readme).toContain(`Linux headed (desktop or Xvfb), Godot ${PRIMARY_TARGET}`);
    expect(readme).not.toContain('| Linux headless');

    const lifecycle = readRepoFile('src/tool-handlers/lifecycle-tool-handlers.ts');
    const harness = readRepoFile('tests/e2e/helpers/harness.ts');
    expect(lifecycle).not.toContain('GODOT_MCP_RUN_HEADLESS');
    expect(harness).not.toContain('GODOT_MCP_E2E_HEADLESS');
    expect(workflow.slice(workflow.indexOf('  godot:'), workflow.indexOf('  godot-dotnet:')))
      .toContain('xvfb-run -a npm run test:e2e');
  });

  it('requires every public change to declare version applicability', () => {
    const template = readRepoFile('.github/pull_request_template.md');
    expect(template).toMatch(/Version, platform, renderer, build-flavor, and export applicability/);
    expect(template).toMatch(/tested limitation when a case is not supported/);
  });

  it('uses Node 24 workflow actions without forced-runtime deprecation warnings', () => {
    const workflow = readRepoFile('.github/workflows/godot-integration.yml');
    expect(workflow).toContain('actions/checkout@v6');
    expect(workflow).toContain('actions/setup-node@v6');
    expect(workflow).toContain('actions/setup-dotnet@v5');
    expect(workflow).toContain('actions/upload-artifact@v7');
    expect(workflow).toContain('node-version: 24');
    expect(workflow).not.toMatch(/actions\/(?:checkout|setup-node|setup-dotnet|upload-artifact)@v4/);
    expect(workflow).not.toContain('node-version: 20');
  });

  it('checks new stable Godot releases against the last known-good release', () => {
    const workflow = readRepoFile('.github/workflows/godot-latest-compatibility.yml');
    expect(workflow).toContain('cron: "23 3 * * 1-6"');
    expect(workflow).toContain('cron: "23 3 * * 0"');
    expect(workflow).toContain(`LAST_KNOWN_GOOD_GODOT: ${PRIMARY_TARGET}-stable`);
    expect(workflow).toContain("grep -E '^4\\.[0-9]+(\\.[0-9]+)?-stable$'");
    expect(workflow).toContain('xvfb-run -a npm run test:godot');
    expect(workflow).toContain('xvfb-run -a npm run test:e2e');
    expect(workflow).toContain('tests-outcome: ${{ steps.tests.outcome }}');
    expect(workflow).toContain("needs.test-latest.outputs.tests-outcome == 'failure'");
    expect(workflow).toContain("needs.test-known-good.result == 'success'");
    expect(workflow).toContain('issues: write');
    expect(workflow).toContain('actions/github-script@v8');
    expect(workflow).toContain('issue.title === title');
  });

  it('keeps npm publication manual and verifies the registered SSH signing key', () => {
    const workflow = readRepoFile('.github/workflows/publish-npm.yml');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain(`publish-@beremaran/godot-agent-loop@${packageJson.version}`);
    expect(workflow).toContain('gpg.ssh.allowedSignersFile="$ALLOWED_SIGNERS"');
    expect(workflow).toContain('berke@beremaran.com');
    expect(workflow).toContain('AAAAC3NzaC1lZDI1NTE5AAAAILjYS4yppZ4WvM2fzE4jMkMd9kn+psrlErcOR19rK5DZ');
    expect(workflow).toContain('test "$(git rev-parse "$RELEASE_TAG^{}")" = "$(git rev-parse HEAD)"');
    expect(workflow).toContain('Godot_v4.7-stable_linux.x86_64.zip');
    expect(workflow).toContain('GODOT_ARCHIVE_SHA256: 0b1a6c54c2c619c12e169fe9241edda4b81080b519451cec2984bf0d2c6cb73c');
    expect(workflow).toContain('echo "GODOT_BIN=$GODOT_BIN" >> "$GITHUB_ENV"');
    expect(workflow).toContain('sha256sum --check --strict');
    expect(workflow).toContain('mkdir -p dist');
    expect(workflow).toContain('npm pack --pack-destination dist');
    expect(workflow).toContain(`npm publish ./dist/beremaran-godot-agent-loop-${packageJson.version}.tgz --access public --provenance`);
    expect(workflow).not.toContain(`npm publish dist/beremaran-godot-agent-loop-${packageJson.version}.tgz`);
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('runs-on: ubuntu-latest');
    expect(workflow).not.toContain('NODE_AUTH_TOKEN');
    expect(workflow).not.toContain('secrets.NPM_TOKEN');
  });

  it('keeps generated engine API caches outside the npm package tree', () => {
    const audit = readRepoFile('scripts/engine-surface-audit.js');
    expect(audit).toContain("const cacheDir = join(root, '.cache/engine-api');");
    expect(audit).not.toContain("const cacheDir = join(root, 'build/engine-api');");
  });

  it('keeps generated E2E fixtures compatible with the declared floor', () => {
    const harness = readRepoFile('tests/e2e/helpers/harness.ts');
    expect(harness).toContain(`config/features=PackedStringArray("${COMPATIBILITY_FLOOR}")`);
  });

  it('keeps the .NET build-flavor job aligned with the engine target and documentation', () => {
    const workflow = readRepoFile('.github/workflows/godot-integration.yml');
    const dotnetJob = workflow.slice(workflow.indexOf('  godot-dotnet:'));
    expect(dotnetJob).toContain(`godot-version: ["${PRIMARY_TARGET}-stable"]`);
    expect(dotnetJob).toContain('actions/setup-dotnet@v5');
    expect(dotnetJob).toContain('GODOT_MCP_DOTNET_TEST: "1"');

    const readme = readRepoFile('README.md');
    expect(readme).toContain('Godot .NET 4.7 with .NET SDK 8');
  });

  it('keeps the bounded Linux export matrix aligned with support claims', () => {
    const workflow = readRepoFile('.github/workflows/godot-integration.yml');
    const exportJob = workflow.slice(workflow.indexOf('  godot-export:'));
    expect(exportJob).toContain(`godot-version: "${PRIMARY_TARGET}-stable"`);
    expect(exportJob).toContain(`template-version: "${PRIMARY_TARGET}.stable"`);
    expect(exportJob).toContain('GODOT_MCP_EXPORT_TEMPLATE_TEST: "1"');
    expect(exportJob).toContain('GODOT_MCP_EXPORT_XDG_DATA_HOME=$HOME/.local/share');

    const readme = readRepoFile('README.md');
    expect(readme).toContain('Linux exports | Release/debug template export and smoke-run verification');
    expect(readme).toContain('other targets are not claimed');
  });

  it('keeps virtual-display renderer jobs aligned with screenshot support claims', () => {
    const workflow = readRepoFile('.github/workflows/godot-integration.yml');
    const rendererJob = workflow.slice(workflow.indexOf('  renderer:'));
    expect(rendererJob).toContain('renderer: gl_compatibility');
    expect(rendererJob).toContain('renderer: forward_plus');
    expect(rendererJob).toContain('xvfb-run -a npm run test:e2e');
    expect(rendererJob).toContain('GODOT_MCP_RENDER_TEST: "1"');

    const readme = readRepoFile('README.md');
    expect(readme).toContain('Compatibility and Forward+ on Linux software rendering');
    expect(readme).toContain('A headed rendering context is required');

    const runtimeSystem = readRepoFile('tests/e2e/runtime-system-tools.test.ts');
    const observers = readRepoFile('tests/e2e/observers.test.ts');
    expect(runtimeSystem).not.toContain('structured headless limitation');
    expect(observers).not.toContain('structured headless limitation');
  });

  it('keeps native platform acceptance jobs aligned with their bounded claim', () => {
    const workflow = readRepoFile('.github/workflows/godot-integration.yml');
    const platformJob = workflow.slice(workflow.indexOf('  platform:'));
    expect(platformJob).toContain('os: [windows-latest, macos-latest]');
    expect(platformJob).toContain('Godot_v4.7-stable_win64.exe.zip');
    expect(platformJob).toContain('Godot_v4.7-stable_macos.universal.zip');
    expect(platformJob).toContain('tests/e2e/cross-platform-smoke.test.ts');

    const readme = readRepoFile('README.md');
    expect(readme).toContain('Godot 4.7 process, Unicode path, runtime input, window query, and teardown workflows');
    expect(readme).toContain('Windows editor UI remains outside the claimed boundary');
    expect(readme).toContain('macOS | Portable acceptance and attached-editor workflow verified');
    expect(readme).toContain('interactive-golden-agent-run.json');
  });
});
