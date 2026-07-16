// @test-kind: contract
import { describe, expect, it } from 'vitest';
import { reviewedToolGuidanceNames, toolCatalogMetadata } from '../src/tool-catalog-metadata.js';
import { toolDefinitions } from '../src/tool-definitions.js';
import { toolManifest } from '../src/tool-manifest.js';
import { CORE_TOOL_NAMES } from '../src/tool-surface.js';

describe('tool catalog metadata', () => {
  it('provides complete non-empty discovery and policy metadata for every tool', () => {
    expect(Object.keys(toolCatalogMetadata).sort()).toEqual(toolDefinitions.map(tool => tool.name).sort());
    for (const definition of toolDefinitions) {
      const metadata = toolCatalogMetadata[definition.name];
      expect(metadata.title.trim(), `${definition.name}.title`).not.toBe('');
      expect(metadata.summary.trim(), `${definition.name}.summary`).not.toBe('');
      expect(metadata.purpose.trim(), `${definition.name}.purpose`).not.toBe('');
      expect(metadata.aliases.length, `${definition.name}.aliases`).toBeGreaterThan(0);
      expect(metadata.intentTags.length, `${definition.name}.intentTags`).toBeGreaterThan(0);
      expect(metadata.concepts.length, `${definition.name}.concepts`).toBeGreaterThan(0);
      expect(metadata.whenToUse.trim(), `${definition.name}.whenToUse`).not.toBe('');
      expect(metadata.whenNotToUse.trim(), `${definition.name}.whenNotToUse`).not.toBe('');
      expect(['read-only', 'project-persistent', 'runtime-ephemeral', 'process', 'external-open-world'])
        .toContain(metadata.effectScope);
      expect(['none', 'project', 'editor', 'runtime']).toContain(metadata.requiredState);
      expect(['read-only', 'mutating', 'mixed']).toContain(metadata.mutation);
      expect(metadata.privilege).toBe(toolManifest[definition.name].privileged ? 'required' : 'none');
      expect(metadata.destructive).toEqual(expect.any(Boolean));
      expect(metadata.idempotent).toEqual(expect.any(Boolean));
      expect(Object.keys(metadata.actionRequirements).sort()).toEqual(
        [...(toolManifest[definition.name].actions ?? [])].sort(),
      );
      expect(metadata.positiveExamples.length, `${definition.name}.positiveExamples`).toBeGreaterThan(0);
      expect(metadata.invalidExamples.length, `${definition.name}.invalidExamples`).toBeGreaterThan(0);
      expect(metadata.outputSummary.trim(), `${definition.name}.outputSummary`).not.toBe('');
      expect(metadata.remediation.trim(), `${definition.name}.remediation`).not.toBe('');
      expect(metadata.warnings).toEqual(expect.any(Array));
      expect(metadata.fallbacks).toEqual(expect.any(Array));
      expect(metadata.preferredAlternatives).toEqual(expect.any(Array));
      expect(metadata.relatedTools).toEqual(expect.any(Array));
    }
  });

  it('uses reviewed workflow guidance for every compact and shipped-skill tool', () => {
    for (const name of CORE_TOOL_NAMES) expect(reviewedToolGuidanceNames.has(name), name).toBe(true);
    for (const name of [
      'analyze_project_integrity', 'export_project', 'game_call_method', 'game_eval',
      'game_get_property', 'list_project_files', 'manage_addon', 'manage_export_presets',
      'manage_import_pipeline', 'manage_resource', 'verify_dotnet_project', 'verify_export_readiness',
    ] as const) expect(reviewedToolGuidanceNames.has(name), name).toBe(true);
  });

  it('distinguishes persistent authoring, ephemeral runtime work, and observation', () => {
    expect(toolCatalogMetadata.godot_catalog).toMatchObject({
      effectScope: 'read-only', requiredState: 'none', mutation: 'read-only',
    });
    expect(toolCatalogMetadata.godot_call).toMatchObject({
      effectScope: 'external-open-world', requiredState: 'none', mutation: 'mutating',
    });
    expect(toolCatalogMetadata.godot_tools).toMatchObject({
      effectScope: 'external-open-world', requiredState: 'none', mutation: 'mixed',
    });
    expect(toolCatalogMetadata.create_scene).toMatchObject({
      effectScope: 'project-persistent', requiredState: 'project', mutation: 'mutating',
    });
    expect(toolCatalogMetadata.game_spawn_node).toMatchObject({
      effectScope: 'runtime-ephemeral', requiredState: 'runtime', mutation: 'mutating',
    });
    expect(toolCatalogMetadata.game_get_audio).toMatchObject({
      effectScope: 'read-only', requiredState: 'runtime', mutation: 'read-only',
    });
  });
});
