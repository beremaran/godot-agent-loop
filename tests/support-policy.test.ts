// @test-kind: contract
import { describe, expect, it } from 'vitest';
import { readRepoFile } from './helpers/manifest-sources.js';

const COMPATIBILITY_FLOOR = '4.4';
const PRIMARY_TARGET = '4.7';

describe('Godot support policy', () => {
  it('keeps the workflow matrix aligned with the documented floor and target', () => {
    const workflow = readRepoFile('.github/workflows/godot-integration.yml');
    const versions = /godot-version:\s*\[([^\]]+)\]/.exec(workflow)?.[1]
      .match(/\d+\.\d+-stable/g) ?? [];
    expect(versions).toEqual([
      `${COMPATIBILITY_FLOOR}-stable`, `${PRIMARY_TARGET}-stable`,
    ]);

    const readme = readRepoFile('README.md');
    expect(readme).toContain(`CI covers Godot ${COMPATIBILITY_FLOOR} and ${PRIMARY_TARGET}`);
    expect(readme).toContain(`Linux headed (desktop or Xvfb), Godot ${COMPATIBILITY_FLOOR} and ${PRIMARY_TARGET}`);
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
    expect(workflow).toContain('actions/upload-artifact@v6');
    expect(workflow).toContain('node-version: 24');
    expect(workflow).not.toMatch(/actions\/(?:checkout|setup-node|setup-dotnet|upload-artifact)@v4/);
    expect(workflow).not.toContain('node-version: 20');
  });

  it('keeps npm publication manual and verifies the registered SSH signing key', () => {
    const workflow = readRepoFile('.github/workflows/publish-npm.yml');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('publish-@beremaran/godot-agent-loop@1.0.0');
    expect(workflow).toContain('gpg.ssh.allowedSignersFile="$ALLOWED_SIGNERS"');
    expect(workflow).toContain('berke@beremaran.com');
    expect(workflow).toContain('AAAAC3NzaC1lZDI1NTE5AAAAIIsZdWjkdesADYJ5uI4zJwW1jtlGBXLc01aZoz3TTdvt');
    expect(workflow).toContain('test "$(git rev-parse "$RELEASE_TAG^{}")" = "$(git rev-parse HEAD)"');
    expect(workflow).toContain('Godot_v4.7-stable_linux.x86_64.zip');
    expect(workflow).toContain('GODOT_ARCHIVE_SHA256: 0b1a6c54c2c619c12e169fe9241edda4b81080b519451cec2984bf0d2c6cb73c');
    expect(workflow).toContain('echo "GODOT_BIN=$GODOT_BIN" >> "$GITHUB_ENV"');
    expect(workflow).toContain('sha256sum --check --strict');
  });

  it('keeps generated E2E fixtures compatible with the declared floor', () => {
    const harness = readRepoFile('tests/e2e/helpers/harness.ts');
    expect(harness).toContain(`config/features=PackedStringArray("${COMPATIBILITY_FLOOR}")`);
  });

  it('keeps the .NET build-flavor matrix aligned with the engine matrix and documentation', () => {
    const workflow = readRepoFile('.github/workflows/godot-integration.yml');
    const dotnetJob = workflow.slice(workflow.indexOf('  godot-dotnet:'));
    expect(dotnetJob).toContain(`godot-version: ["${COMPATIBILITY_FLOOR}-stable", "${PRIMARY_TARGET}-stable"]`);
    expect(dotnetJob).toContain('actions/setup-dotnet@v5');
    expect(dotnetJob).toContain('GODOT_MCP_DOTNET_TEST: "1"');

    const readme = readRepoFile('README.md');
    expect(readme).toContain('Godot .NET 4.4 and 4.7 with .NET SDK 8');
  });

  it('keeps the bounded Linux export matrix aligned with support claims', () => {
    const workflow = readRepoFile('.github/workflows/godot-integration.yml');
    const exportJob = workflow.slice(workflow.indexOf('  godot-export:'));
    for (const version of [COMPATIBILITY_FLOOR, PRIMARY_TARGET]) {
      expect(exportJob).toContain(`godot-version: "${version}-stable"`);
      expect(exportJob).toContain(`template-version: "${version}.stable"`);
    }
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
    expect(readme).toContain('Windows/macOS editor UI, rendering, and exports | Not claimed');
  });
});
