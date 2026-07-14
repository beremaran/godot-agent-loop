// @test-kind: contract
import { describe, expect, it } from 'vitest';
import { toolDefinitions } from '../src/tool-definitions.js';
import {
  CORE_TOOL_NAMES,
  TOOL_SURFACE_BUDGETS,
  advertisedToolDefinitions,
  compactToolSurfaceBytes,
  estimatedToolSurfaceTokens,
  resolveToolSurfaceMode,
} from '../src/tool-surface.js';

describe('progressive tool surface', () => {
  it('defaults to a stable core while retaining an explicit full mode', () => {
    expect(resolveToolSurfaceMode(undefined)).toBe('core');
    expect(resolveToolSurfaceMode('invalid')).toBe('core');
    expect(resolveToolSurfaceMode('full')).toBe('full');
    expect(advertisedToolDefinitions('full')).toBe(toolDefinitions);
    expect(advertisedToolDefinitions('core').map(tool => tool.name))
      .toEqual(toolDefinitions.filter(tool => CORE_TOOL_NAMES.has(tool.name)).map(tool => tool.name));
  });

  it('keeps the complete build-game loop directly visible', () => {
    const names = CORE_TOOL_NAMES;
    for (const required of [
      'godot_tools', 'create_project', 'create_scene', 'create_script', 'attach_script',
      'manage_input_map', 'set_main_scene', 'run_project', 'game_get_scene_tree',
      'game_get_ui', 'game_screenshot', 'verify_project', 'run_project_tests',
    ] as const) expect(names.has(required), required).toBe(true);
  });

  it('enforces count, byte, estimated-token, and reduction budgets', () => {
    const core = advertisedToolDefinitions('core');
    const fullBytes = compactToolSurfaceBytes(toolDefinitions);
    const coreBytes = compactToolSurfaceBytes(core);
    expect(toolDefinitions.length).toBeGreaterThan(core.length);
    expect(core.length).toBeLessThanOrEqual(TOOL_SURFACE_BUDGETS.coreToolCountMax);
    expect(fullBytes).toBeLessThanOrEqual(TOOL_SURFACE_BUDGETS.fullBytesMax);
    expect(coreBytes).toBeLessThanOrEqual(TOOL_SURFACE_BUDGETS.coreBytesMax);
    expect(estimatedToolSurfaceTokens(core)).toBeLessThanOrEqual(TOOL_SURFACE_BUDGETS.coreEstimatedTokensMax);
    expect((1 - coreBytes / fullBytes) * 100).toBeGreaterThanOrEqual(TOOL_SURFACE_BUDGETS.coreReductionPercentMin);
  });
});
