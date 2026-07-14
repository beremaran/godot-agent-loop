// @test-kind: e2e
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type E2EServer } from './helpers/harness.js';

let server: E2EServer | null = null;

afterEach(async () => {
  if (server) {
    const active = server;
    server = null;
    await active.close();
  }
});

function payload(text: string): unknown {
  return JSON.parse(text) as unknown;
}

async function startedGame(): Promise<E2EServer> {
  server = await startServer({ allowPrivileged: true });
  const started = await server.call('run_project', { projectPath: server.projectPath });
  expect(started.isError, started.text).toBe(false);
  await server.waitForGameConnection();
  return server;
}

async function evalResult(game: E2EServer, code: string): Promise<unknown> {
  const result = await game.call('game_eval', { code });
  expect(result.isError, result.text).toBe(false);
  return (payload(result.text) as { result: unknown }).result;
}

describe('runtime G+ 2D scene tools through MCP', () => {
  it('game_tilemap covers set/get/list/erase with source, atlas, and alternative IDs', async () => {
    const game = await startedGame();
    const sourceId = await evalResult(game, [
      'var layer := get_tree().root.get_node("Main/Tiles") as TileMapLayer',
      'var tile_set := TileSet.new()',
      'tile_set.tile_size = Vector2i(16, 16)',
      'var source := TileSetAtlasSource.new()',
      'var image := Image.create(16, 16, false, Image.FORMAT_RGBA8)',
      'image.fill(Color(0.2, 0.8, 0.3, 1.0))',
      'source.texture = ImageTexture.create_from_image(image)',
      'source.texture_region_size = Vector2i(16, 16)',
      'source.create_tile(Vector2i.ZERO)',
      'source.create_alternative_tile(Vector2i.ZERO, 1)',
      'var id := tile_set.add_source(source)',
      'layer.tile_set = tile_set',
      'return id',
    ].join('\n')) as number;

    const set = await game.call('game_tilemap', {
      nodePath: '/root/Main/Tiles',
      action: 'set_cells',
      cells: [
        { x: 2, y: 3, sourceId, atlasX: 0, atlasY: 0, altTile: 0 },
        { x: 4, y: 5, sourceId, atlasX: 0, atlasY: 0, altTile: 1 },
      ],
    });
    expect(set.isError, set.text).toBe(false);

    const first = await game.call('game_tilemap', {
      nodePath: '/root/Main/Tiles', action: 'get_cell', x: 2, y: 3,
    });
    const alternative = await game.call('game_tilemap', {
      nodePath: '/root/Main/Tiles', action: 'get_cell', x: 4, y: 5,
    });
    expect(payload(first.text)).toMatchObject({
      source_id: sourceId, atlas_coords: { x: 0, y: 0 }, alt_tile: 0,
    });
    expect(payload(alternative.text)).toMatchObject({
      source_id: sourceId, atlas_coords: { x: 0, y: 0 }, alt_tile: 1,
    });

    const used = await game.call('game_tilemap', {
      nodePath: '/root/Main/Tiles', action: 'get_used_cells', sourceId,
    });
    expect(used.isError, used.text).toBe(false);
    expect(payload(used.text)).toMatchObject({ count: 2 });
    expect(await evalResult(game, [
      'var layer := get_tree().root.get_node("Main/Tiles") as TileMapLayer',
      'return {"count": layer.get_used_cells().size(), "alternative": layer.get_cell_alternative_tile(Vector2i(4, 5))}',
    ].join('\n'))).toEqual({ count: 2, alternative: 1 });

    const erased = await game.call('game_tilemap', {
      nodePath: '/root/Main/Tiles', action: 'erase_cells', cells: [{ x: 2, y: 3 }, { x: 4, y: 5 }],
    });
    expect(erased.isError, erased.text).toBe(false);
    expect(await evalResult(game, 'return (get_tree().root.get_node("Main/Tiles") as TileMapLayer).get_used_cells().size()')).toBe(0);

    const missingCells = await game.call('game_tilemap', {
      nodePath: '/root/Main/Tiles', action: 'set_cells',
    });
    expect(missingCells.isError).toBe(true);
    expect(missingCells.text).toMatch(/cells is required/i);
  });

  it('game_canvas and all game_canvas_draw actions create, configure, accumulate, and clear state', async () => {
    const game = await startedGame();
    expect((await game.call('game_canvas', {
      action: 'create_layer', parentPath: '/root/Main', name: 'E2ELayer', layer: 3,
    })).isError).toBe(false);
    expect((await game.call('game_canvas', {
      action: 'create_modulate', parentPath: '/root/Main', name: 'E2EModulate', color: { r: 0.7, g: 0.6, b: 0.5, a: 1 },
    })).isError).toBe(false);
    expect((await game.call('game_canvas', {
      action: 'configure', nodePath: '/root/Main/E2ELayer', layer: 8, offset: { x: 12, y: 34 }, visible: false,
    })).isError).toBe(false);
    expect((await game.call('game_canvas', {
      action: 'configure', nodePath: '/root/Main/E2EModulate', color: { r: 0.1, g: 0.2, b: 0.3, a: 0.9 },
    })).isError).toBe(false);

    const canvasState = await evalResult(game, [
      'var layer := get_tree().root.get_node("Main/E2ELayer") as CanvasLayer',
      'var modulate := get_tree().root.get_node("Main/E2EModulate") as CanvasModulate',
      'return {"layer": layer.layer, "offset": layer.offset, "visible": layer.visible, "color": modulate.color}',
    ].join('\n')) as { layer: number; offset: { x: number; y: number }; visible: boolean; color: Record<string, number> };
    expect(canvasState).toMatchObject({ layer: 8, offset: { x: 12, y: 34 }, visible: false });
    expect(canvasState.color.r).toBeCloseTo(0.1);
    expect(canvasState.color.a).toBeCloseTo(0.9);

    const draws = [
      { action: 'line', parentPath: '/root/Main', from: { x: 1, y: 2 }, to: { x: 20, y: 2 }, width: 3, color: { r: 1, g: 0, b: 0, a: 1 } },
      { action: 'rect', rect: { x: 5, y: 5, w: 20, h: 10 }, filled: false, color: { r: 0, g: 1, b: 0, a: 1 } },
      { action: 'circle', center: { x: 30, y: 30 }, radius: 8, color: { r: 0, g: 0, b: 1, a: 1 } },
      { action: 'polygon', points: [{ x: 40, y: 5 }, { x: 55, y: 20 }, { x: 35, y: 20 }], color: { r: 1, g: 1, b: 0, a: 1 } },
      { action: 'text', position: { x: 5, y: 60 }, text: 'Godot Agent Loop', fontSize: 18, color: { r: 1, g: 1, b: 1, a: 1 } },
    ];
    for (const draw of draws) {
      const result = await game.call('game_canvas_draw', draw);
      expect(result.isError, `${draw.action}: ${result.text}`).toBe(false);
    }
    await game.call('game_wait', { frames: 2 });
    const drawState = await evalResult(game, [
      'var node := get_tree().root.get_node("Main/_McpCanvasDraw")',
      'var actions: Array = []',
      'for command in node.get("draw_commands"):',
      '\tactions.append(command.action)',
      'return {"class": node.get_class(), "actions": actions, "count": actions.size()}',
    ].join('\n'));
    expect(drawState).toEqual({ class: 'Node2D', actions: ['line', 'rect', 'circle', 'polygon', 'text'], count: 5 });

    const invalidPolygon = await game.call('game_canvas_draw', {
      action: 'polygon', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
    });
    expect(invalidPolygon.isError).toBe(true);
    expect(invalidPolygon.text).toMatch(/at least 3 points/i);

    expect((await game.call('game_canvas_draw', { action: 'clear' })).isError).toBe(false);
    expect(await evalResult(game, 'return get_tree().root.get_node("Main/_McpCanvasDraw").get("draw_commands").size()')).toBe(0);
  });

  it('game_light_2d and game_parallax cover every creation and configuration action', async () => {
    const game = await startedGame();
    expect((await game.call('game_light_2d', {
      action: 'create_point', parentPath: '/root/Main', name: 'Point', energy: 2.5, range: 1.5,
      color: { r: 0.8, g: 0.4, b: 0.2, a: 1 },
    })).isError).toBe(false);
    expect((await game.call('game_light_2d', {
      action: 'create_directional', parentPath: '/root/Main', name: 'Directional', energy: 1.75,
      color: { r: 0.2, g: 0.5, b: 0.9, a: 1 },
    })).isError).toBe(false);
    expect((await game.call('game_light_2d', {
      action: 'create_occluder', parentPath: '/root/Main', name: 'Occluder',
      points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }],
    })).isError).toBe(false);
    const lights = await evalResult(game, [
      'var point := get_tree().root.get_node("Main/Point") as PointLight2D',
      'var directional := get_tree().root.get_node("Main/Directional") as DirectionalLight2D',
      'var occluder := get_tree().root.get_node("Main/Occluder") as LightOccluder2D',
      'return {"point_energy": point.energy, "scale": point.texture_scale, "texture": point.texture.get_class(), "directional_energy": directional.energy, "points": occluder.occluder.polygon.size()}',
    ].join('\n'));
    expect(lights).toMatchObject({ point_energy: 2.5, scale: 1.5, texture: 'GradientTexture2D', directional_energy: 1.75, points: 4 });

    expect((await game.call('game_parallax', {
      action: 'create_background', parentPath: '/root/Main', name: 'Parallax',
    })).isError).toBe(false);
    expect((await game.call('game_parallax', {
      action: 'add_layer', parentPath: '/root/Main/Parallax', name: 'Layer',
      motionScale: { x: 0.5, y: 0.25 }, motionOffset: { x: 3, y: 4 }, mirroring: { x: 100, y: 50 },
    })).isError).toBe(false);
    expect((await game.call('game_parallax', {
      action: 'configure', nodePath: '/root/Main/Parallax', scrollOffset: { x: 12, y: 18 }, scrollBaseOffset: { x: 2, y: 3 },
    })).isError).toBe(false);
    expect((await game.call('game_parallax', {
      action: 'configure', nodePath: '/root/Main/Parallax/Layer', motionScale: { x: 0.75, y: 0.6 }, motionOffset: { x: 7, y: 8 }, mirroring: { x: 120, y: 80 },
    })).isError).toBe(false);
    const parallax = await evalResult(game, [
      'var bg := get_tree().root.get_node("Main/Parallax") as ParallaxBackground',
      'var layer := bg.get_node("Layer") as ParallaxLayer',
      'return {"scroll": bg.scroll_offset, "base": bg.scroll_base_offset, "scale": layer.motion_scale, "offset": layer.motion_offset, "mirroring": layer.motion_mirroring}',
    ].join('\n')) as Record<string, { x: number; y: number }>;
    expect(parallax).toMatchObject({
      scroll: { x: 12, y: 18 }, base: { x: 2, y: 3 }, scale: { x: 0.75 },
      offset: { x: 7, y: 8 }, mirroring: { x: 120, y: 80 },
    });
    expect(parallax.scale.y).toBeCloseTo(0.6);

    const shortOccluder = await game.call('game_light_2d', {
      action: 'create_occluder', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
    });
    expect(shortOccluder.isError).toBe(true);
    expect(shortOccluder.text).toMatch(/at least 3 points/i);
  });

  it('game_shape_2d and game_path_2d cover all mutations and readback', async () => {
    const game = await startedGame();
    expect((await game.call('game_shape_2d', {
      nodePath: '/root/Main/Line', action: 'set_points', points: [{ x: 0, y: 0 }, { x: 10, y: 5 }],
    })).isError).toBe(false);
    expect((await game.call('game_shape_2d', {
      nodePath: '/root/Main/Line', action: 'add_point', point: { x: 20, y: 0 },
    })).isError).toBe(false);
    const linePoints = await game.call('game_shape_2d', {
      nodePath: '/root/Main/Line', action: 'get_points',
    });
    expect(payload(linePoints.text)).toMatchObject({ points: [{ x: 0, y: 0 }, { x: 10, y: 5 }, { x: 20, y: 0 }] });

    expect((await game.call('game_shape_2d', {
      nodePath: '/root/Main/Polygon', action: 'set_points',
      points: [{ x: 1, y: 1 }, { x: 8, y: 1 }, { x: 4, y: 9 }],
    })).isError).toBe(false);
    expect((await game.call('game_shape_2d', {
      nodePath: '/root/Main/Polygon', action: 'add_point', point: { x: 0, y: 5 },
    })).isError).toBe(false);
    expect(await evalResult(game, [
      'var line := get_tree().root.get_node("Main/Line") as Line2D',
      'var polygon := get_tree().root.get_node("Main/Polygon") as Polygon2D',
      'return {"line": line.points.size(), "last": line.points[-1], "polygon": polygon.polygon.size()}',
    ].join('\n'))).toEqual({ line: 3, last: { x: 20, y: 0 }, polygon: 4 });

    expect((await game.call('game_shape_2d', { nodePath: '/root/Main/Line', action: 'clear' })).isError).toBe(false);
    expect((await game.call('game_shape_2d', { nodePath: '/root/Main/Polygon', action: 'clear' })).isError).toBe(false);
    expect(await evalResult(game, [
      'return (get_tree().root.get_node("Main/Line") as Line2D).points.is_empty() and (get_tree().root.get_node("Main/Polygon") as Polygon2D).polygon.is_empty()',
    ].join('\n'))).toBe(true);

    const created = await game.call('game_path_2d', {
      action: 'create', parentPath: '/root/Main', name: 'Route',
      points: [{ x: 0, y: 0 }, { x: 25, y: 10 }],
    });
    expect(created.isError, created.text).toBe(false);
    expect((await game.call('game_path_2d', {
      action: 'add_point', nodePath: '/root/Main/Route', point: { x: 50, y: 0 },
    })).isError).toBe(false);
    const pathPoints = await game.call('game_path_2d', { action: 'get_points', nodePath: '/root/Main/Route' });
    expect(payload(pathPoints.text)).toMatchObject({ points: [{ x: 0, y: 0 }, { x: 25, y: 10 }, { x: 50, y: 0 }] });
    expect(await evalResult(game, [
      'var path := get_tree().root.get_node("Main/Route") as Path2D',
      'return {"class": path.curve.get_class(), "count": path.curve.point_count, "baked_length": path.curve.get_baked_length()}',
    ].join('\n'))).toMatchObject({ class: 'Curve2D', count: 3, baked_length: expect.any(Number) });

    const missingPoint = await game.call('game_path_2d', { action: 'add_point', nodePath: '/root/Main/Route' });
    expect(missingPoint.isError).toBe(true);
    expect(missingPoint.text).toMatch(/point is required/i);
  });
});
