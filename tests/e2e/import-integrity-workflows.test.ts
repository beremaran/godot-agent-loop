// @test-kind: e2e
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type E2EServer } from './helpers/harness.js';

let server: E2EServer | null = null;

afterEach(async () => {
  if (!server) return;
  const active = server;
  server = null;
  await active.close();
});

function json(text: string): Record<string, any> {
  return JSON.parse(text) as Record<string, any>;
}

describe('import pipeline and project integrity workflows through MCP', () => {
  it('reimports, inspects, changes, and traces a real SVG import', async () => {
    server = await startServer();
    mkdirSync(join(server.projectPath, 'assets'));
    writeFileSync(join(server.projectPath, 'assets', 'icon.svg'), [
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8">',
      '<rect width="8" height="8" fill="#ff00ff"/></svg>',
    ].join(''));

    const imported = await server.call('manage_import_pipeline', {
      projectPath: server.projectPath, action: 'reimport', timeoutSeconds: 30,
    });
    expect(imported.isError, imported.text).toBe(false);
    const importResult = json(imported.text);
    expect(importResult.imported).toBe(true);
    expect(importResult.diagnostics).toEqual(expect.any(Array));
    for (const diagnostic of importResult.diagnostics as string[]) {
      expect(diagnostic).toMatch(/progress dialog|tasks\.has\(p_task\)/i);
    }

    const inspected = await server.call('manage_import_pipeline', {
      projectPath: server.projectPath, action: 'inspect', sourcePath: 'assets/icon.svg',
    });
    expect(inspected.isError, inspected.text).toBe(false);
    expect(json(inspected.text)).toMatchObject({
      source_path: 'assets/icon.svg', importer: 'texture', resource_type: 'CompressedTexture2D',
    });

    const changed = await server.call('manage_import_pipeline', {
      projectPath: server.projectPath, action: 'change', sourcePath: 'assets/icon.svg',
      settings: { 'process/fix_alpha_border': false, 'svg/scale': 2.0 },
    });
    expect(changed.isError, changed.text).toBe(false);
    expect(json(changed.text).settings).toMatchObject({
      'process/fix_alpha_border': false, 'svg/scale': 2,
    });

    const dependencies = await server.call('manage_import_pipeline', {
      projectPath: server.projectPath, action: 'dependencies', sourcePath: 'assets/icon.svg',
    });
    expect(dependencies.isError, dependencies.text).toBe(false);
    expect(json(dependencies.text).dependencies).toMatchObject({
      source_file: 'res://assets/icon.svg',
    });
    expect(json(dependencies.text).dependencies.destination_files.length).toBeGreaterThan(0);
  });

  it('reports dependency, UID, cycle, orphan, and rename-impact evidence', async () => {
    server = await startServer();
    mkdirSync(join(server.projectPath, 'resources'));
    writeFileSync(join(server.projectPath, 'resources', 'a.tres'), [
      '[gd_resource type="Resource" load_steps=2 format=3 uid="uid://duplicate"]',
      '[ext_resource type="Resource" path="res://resources/b.tres" id="1"]',
      '[resource]', 'metadata/peer = ExtResource("1")', '',
    ].join('\n'));
    writeFileSync(join(server.projectPath, 'resources', 'b.tres'), [
      '[gd_resource type="Resource" load_steps=2 format=3 uid="uid://duplicate"]',
      '[ext_resource type="Resource" path="res://resources/a.tres" id="1"]',
      '[resource]', 'metadata/peer = ExtResource("1")', '',
    ].join('\n'));
    writeFileSync(join(server.projectPath, 'resources', 'broken.tres'), [
      '[gd_resource type="Resource" load_steps=2 format=3]',
      '[ext_resource type="Resource" path="res://resources/missing.tres" id="1"]',
      '[resource]', '',
    ].join('\n'));
    writeFileSync(join(server.projectPath, 'orphan_scene.tscn'), [
      '[gd_scene format=3]', '', '[node name="Root" type="Node"]',
      '[node name="Lost" type="Node" parent="Missing"]', '',
    ].join('\n'));

    const analyzed = await server.call('analyze_project_integrity', {
      projectPath: server.projectPath, action: 'analyze', maxFiles: 100,
    });
    expect(analyzed.isError, analyzed.text).toBe(false);
    const report = json(analyzed.text);
    expect(report.broken_references).toContainEqual({
      source: 'resources/broken.tres', target: 'resources/missing.tres',
    });
    expect(report.duplicate_uids).toContainEqual({
      uid: 'uid://duplicate', files: ['resources/a.tres', 'resources/b.tres'],
    });
    expect(report.cycles).toContainEqual([
      'resources/a.tres', 'resources/b.tres', 'resources/a.tres',
    ]);
    expect(report.orphan_nodes).toContainEqual({
      scene: 'orphan_scene.tscn', node: 'Lost', parent: 'Missing',
    });
    expect(report.orphan_resources).toContain('resources/broken.tres');

    const preview = await server.call('analyze_project_integrity', {
      projectPath: server.projectPath, action: 'preview_rename',
      sourcePath: 'resources/a.tres', destinationPath: 'resources/renamed.tres', maxFiles: 100,
    });
    expect(preview.isError, preview.text).toBe(false);
    expect(json(preview.text)).toMatchObject({
      source_exists: true, destination_exists: false,
      referencing_files: ['resources/b.tres'], changes_applied: false,
    });
  });

  it('bounds scans and rejects missing metadata and unsafe paths', async () => {
    server = await startServer();
    const missing = await server.call('manage_import_pipeline', {
      projectPath: server.projectPath, action: 'inspect', sourcePath: 'main.gd',
    });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/Import metadata does not exist/i);

    const unsafe = await server.call('analyze_project_integrity', {
      projectPath: server.projectPath, action: 'preview_rename',
      sourcePath: '../outside.tres', destinationPath: 'safe.tres',
    });
    expect(unsafe.isError).toBe(true);

    const bounded = await server.call('analyze_project_integrity', {
      projectPath: server.projectPath, action: 'analyze', maxFiles: 1,
    });
    expect(bounded.isError).toBe(true);
    expect(bounded.text).toMatch(/exceeds maxFiles/i);
  });
});
