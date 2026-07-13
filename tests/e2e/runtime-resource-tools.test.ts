// @test-kind: e2e
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTempProject,
  importProjectResources,
  startServer,
  writePngFixture,
  type E2EServer,
} from './helpers/harness.js';

let server: E2EServer | null = null;

afterEach(async () => {
  if (!server) return;
  const active = server;
  server = null;
  await active.close();
});

function payload(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

async function evalResult(game: E2EServer, code: string): Promise<unknown> {
  const result = await game.call('game_eval', { code });
  expect(result.isError, result.text).toBe(false);
  return payload(result.text).result;
}

describe('runtime resource tools through MCP', () => {
  it('game_resource covers preload/cache, typed text and binary saves, references, failures, and safe paths', async () => {
    const project = createTempProject({ name: 'resource fixtures' });
    const fixtures = join(project.projectPath, 'fixtures');
    mkdirSync(fixtures, { recursive: true });
    writePngFixture(project.projectPath, 'fixtures/pixel.png');
    writeFileSync(join(fixtures, 'external material.tres'), [
      '[gd_resource type="StandardMaterial3D" load_steps=2 format=3]',
      '',
      '[ext_resource type="Texture2D" path="res://fixtures/pixel.png" id="1_texture"]',
      '',
      '[resource]',
      'resource_name = "ExternalMaterial"',
      'metallic = 0.25',
      'albedo_texture = ExtResource("1_texture")',
      '',
    ].join('\n'));
    writeFileSync(join(fixtures, 'corrupt.tres'), 'this is not a Godot resource\n');
    await importProjectResources(project.projectPath);

    server = await startServer({ project, allowPrivileged: true });
    const started = await server.call('run_project', { projectPath: project.projectPath });
    expect(started.isError, started.text).toBe(false);
    await server.waitForGameConnection();

    const exists = await server.call('game_resource', {
      action: 'exists', path: 'res://fixtures/external material.tres',
    });
    expect(payload(exists.text)).toMatchObject({ exists: true });
    expect(payload((await server.call('game_resource', {
      action: 'exists', path: 'res://fixtures/missing.tres',
    })).text)).toMatchObject({ exists: false });

    const preloaded = await server.call('game_resource', {
      action: 'preload', path: 'res://fixtures/external material.tres',
    });
    expect(preloaded.isError, preloaded.text).toBe(false);
    expect(payload(preloaded.text)).toMatchObject({
      action: 'preload', type: 'StandardMaterial3D', resource_name: 'ExternalMaterial',
      cached_before: false, cached_after: true,
    });
    const loaded = await server.call('game_resource', {
      action: 'load', path: 'res://fixtures/external material.tres',
    });
    expect(payload(loaded.text)).toMatchObject({
      action: 'load', type: 'StandardMaterial3D', cached_before: true, cached_after: true,
    });
    expect(await evalResult(server, [
      'var material := ResourceLoader.load("res://fixtures/external material.tres") as StandardMaterial3D',
      'var nested := StandardMaterial3D.new()',
      'nested.resource_name = "NestedPass"',
      'nested.roughness = 0.75',
      'material.next_pass = nested',
      'get_tree().root.get_node("Main/VisualTarget").material_override = material',
      'return {"metallic": material.metallic, "texture": material.albedo_texture.resource_path, "nested": material.next_pass.resource_name}',
    ].join('\n'))).toEqual({ metallic: 0.25, texture: 'res://fixtures/pixel.png', nested: 'NestedPass' });

    const textPath = 'res://fixtures/saved material.tres';
    const binaryPath = 'res://fixtures/saved material.res';
    const saveArgs = { nodePath: '/root/Main/VisualTarget', property: 'material_override' };
    const savedText = await server.call('game_resource', { action: 'save', path: textPath, ...saveArgs });
    expect(savedText.isError, savedText.text).toBe(false);
    expect(payload(savedText.text)).toMatchObject({ action: 'save', type: 'StandardMaterial3D' });
    const textResource = readFileSync(join(fixtures, 'saved material.tres'), 'utf8');
    expect(textResource).toContain('res://fixtures/pixel.png');
    expect(textResource).toContain('[sub_resource type="StandardMaterial3D"');

    expect(await evalResult(server, [
      'var material := get_tree().root.get_node("Main/VisualTarget").material_override as StandardMaterial3D',
      'material.metallic = 0.625',
      'return material.metallic',
    ].join('\n'))).toBe(0.625);
    const overwritten = await server.call('game_resource', { action: 'save', path: textPath, ...saveArgs });
    expect(overwritten.isError, overwritten.text).toBe(false);
    const savedBinary = await server.call('game_resource', { action: 'save', path: binaryPath, ...saveArgs });
    expect(savedBinary.isError, savedBinary.text).toBe(false);
    expect(statSync(join(fixtures, 'saved material.res')).size).toBeGreaterThan(32);
    expect(payload((await server.call('game_resource', { action: 'load', path: binaryPath })).text))
      .toMatchObject({ type: 'StandardMaterial3D' });
    expect(await evalResult(server, [
      'var material := ResourceLoader.load("res://fixtures/saved material.res", "", ResourceLoader.CACHE_MODE_IGNORE) as StandardMaterial3D',
      'return {"metallic": material.metallic, "texture": material.albedo_texture.resource_path, "nested": material.next_pass.resource_name}',
    ].join('\n'))).toEqual({ metallic: 0.625, texture: 'res://fixtures/pixel.png', nested: 'NestedPass' });

    for (const path of ['res://fixtures/missing.tres', 'res://fixtures/corrupt.tres']) {
      const failed = await server.call('game_resource', { action: 'load', path });
      expect(failed.isError).toBe(true);
      expect(failed.text).toMatch(/Resource not found|Failed to load resource/i);
    }
    const missingProperty = await server.call('game_resource', {
      action: 'save', path: 'res://fixtures/nope.tres', nodePath: '/root/Main/VisualTarget', property: 'not_a_property',
    });
    expect(missingProperty.isError).toBe(true);
    expect(missingProperty.text).toMatch(/Property not found/i);
    for (const path of ['user://outside.tres', 'res://../outside.tres']) {
      const outside = await server.call('game_resource', { action: 'exists', path });
      expect(outside.isError).toBe(true);
      expect(outside.text).toMatch(/within the project/i);
    }
  });
});
