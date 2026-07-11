import { describe, expect, it } from 'vitest';
import { toolDefinitions } from '../src/tool-definitions.js';
import { parseToolArguments, ToolArgumentValidationError } from '../src/tool-argument-validation.js';

const tool = (name: string) => toolDefinitions.find(definition => definition.name === name)!;

describe('parseToolArguments', () => {
  it('accepts arguments that match the advertised schema', () => {
    expect(parseToolArguments(tool('game_click'), { x: 10, y: 20 })).toEqual({ x: 10, y: 20 });
  });

  it('rejects missing required fields before dispatch', () => {
    expect(() => parseToolArguments(tool('game_click'), { x: 10 })).toThrow(ToolArgumentValidationError);
    expect(() => parseToolArguments(tool('game_click'), { x: 10 })).toThrow('arguments.y is required');
  });

  it('rejects invalid primitive and array item types', () => {
    expect(() => parseToolArguments(tool('game_click'), { x: '10', y: 20 })).toThrow('arguments.x must be number');
    expect(() => parseToolArguments(tool('validate_scripts'), {
      projectPath: '/project', scriptPaths: ['good.gd', 3],
    })).toThrow('arguments.scriptPaths[1] must be string');
  });

  it('rejects unknown top-level fields but permits documented free-form objects', () => {
    expect(() => parseToolArguments(tool('game_click'), { x: 10, y: 20, unexpected: true }))
      .toThrow('arguments.unexpected is not allowed');
    expect(parseToolArguments(tool('add_node'), {
      projectPath: '/project', scenePath: 'main.tscn', nodeType: 'Node', nodeName: 'Child',
      properties: { customGodotProperty: { nested: true } },
    })).toBeDefined();
  });
});
