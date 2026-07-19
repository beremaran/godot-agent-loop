// @test-kind: unit
import { describe, expect, it } from 'vitest';
import { toolDefinitions } from '../src/tool-definitions.js';
import { parseToolArguments, ToolArgumentValidationError } from '../src/tool-argument-validation.js';
import { convertCamelToSnakeCase, normalizeParameters } from '../src/utils.js';

const tool = (name: string) => toolDefinitions.find(definition => definition.name === name)!;

describe('parseToolArguments', () => {
  it('uses JSON Schema 2020-12 and closes every declared object', () => {
    for (const definition of toolDefinitions) {
      expect(definition.inputSchema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(definition.inputSchema.additionalProperties, definition.name).toBe(false);
    }
    const transaction = tool('editor_transaction');
    expect(transaction.inputSchema.properties?.operations?.items?.additionalProperties).toBe(false);
    expect(tool('add_node').inputSchema.properties?.properties?.additionalProperties).toBe(true);
    expect(tool('add_node').inputSchema.properties?.properties?.description).toContain('Intentionally open');
  });

  it('encodes conditional input, wait, scenario, and editor requirements', () => {
    expect(() => parseToolArguments(tool('game_key_press'), {})).toThrow('must match exactly one');
    expect(() => parseToolArguments(tool('game_key_press'), { key: 'A', action: 'jump' }))
      .toThrow('must match exactly one');
    expect(parseToolArguments(tool('game_key_press'), { text: 'Ω', shift: true })).toBeDefined();
    expect(() => parseToolArguments(tool('game_wait_until'), { condition: 'property', nodePath: '/root' }))
      .toThrow('arguments.value is required');
    expect(() => parseToolArguments(tool('editor_control'), {
      projectPath: '/project', action: 'set_property', nodePath: 'Player', property: 'visible',
    })).toThrow('arguments.value is required');
    expect(() => parseToolArguments(tool('game_scenario'), {
      name: 'invalid', steps: [{ type: 'input', tool: 'game_key_hold' }],
    })).toThrow('arguments.steps[0].arguments is required');
    expect(() => parseToolArguments(tool('editor_transaction'), {
      projectPath: '/project', scenePath: 'main.tscn', name: 'invalid',
      operations: [{ op: 'add_node', nodeName: 'MissingType' }],
    })).toThrow('arguments.operations[0].nodeType is required');
    expect(() => parseToolArguments(tool('game_scenario'), {
      name: 'unsafe', steps: [{ type: 'observe', tool: 'game_set_property' }],
    })).toThrow('arguments.steps[0].tool must be one of:');
    expect(() => parseToolArguments(tool('game_scenario'), {
      name: 'missing-condition-field',
      steps: [{ type: 'wait', condition: { condition: 'property', nodePath: '/root/Main' } }],
    })).toThrow('arguments.steps[0].condition.property is required');
    expect(() => parseToolArguments(tool('game_scenario'), {
      name: 'forbidden-step-field',
      steps: [{ type: 'screenshot', arguments: {} }],
    })).toThrow('arguments.steps[0].arguments is forbidden by this action shape');
    expect(() => parseToolArguments(tool('editor_transaction'), {
      projectPath: '/project', scenePath: 'main.tscn', name: 'irrelevant-field',
      operations: [{ op: 'save', nodePath: 'Player' }],
    })).toThrow('arguments.operations[0].nodePath is forbidden by this action shape');
    expect(() => parseToolArguments(tool('editor_control'), {
      projectPath: '/project', action: 'inspect', scenePath: 'main.tscn',
    })).toThrow('arguments.scenePath is forbidden by this action shape');
  });

  it('marks property waits and scenario conditions as reflection-dependent', () => {
    const wait = tool('game_wait_until');
    expect(wait.description).toMatch(/property waits need reflection/i);
    expect(wait.inputSchema.oneOf?.find(branch => branch.properties?.condition?.const === 'property'))
      .toMatchObject({ 'x-privilege-group': 'reflection' });

    const scenario = tool('game_scenario');
    const condition = scenario.inputSchema.properties?.steps?.items?.properties?.condition;
    expect(scenario.description).toMatch(/property waits need reflection/i);
    expect(condition?.oneOf?.find(branch => branch.properties?.condition?.const === 'property'))
      .toMatchObject({ 'x-privilege-group': 'reflection' });
  });

  it('accepts arguments that match the advertised schema', () => {
    expect(parseToolArguments(tool('game_click'), { x: 10, y: 20 })).toEqual({ x: 10, y: 20 });
    expect(parseToolArguments(tool('read_scene'), {
      project_path: '/project', scene_path: 'main.tscn', response_limit: 4096,
    })).toEqual({ projectPath: '/project', scenePath: 'main.tscn', responseLimit: 4096 });
  });

  it('rejects missing required fields before dispatch', () => {
    expect(() => parseToolArguments(tool('game_click'), { x: 10 })).toThrow(ToolArgumentValidationError);
    expect(() => parseToolArguments(tool('game_click'), { x: 10 })).toThrow('arguments.y is required');
  });

  it('reports the selected action branch instead of unrelated oneOf errors', () => {
    try {
      parseToolArguments(tool('manage_autoloads'), { projectPath: '/project', action: 'add' });
      throw new Error('Expected add validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ToolArgumentValidationError);
      const validation = error as ToolArgumentValidationError;
      expect(validation.details[0]).toMatchObject({ path: 'arguments.name', keyword: 'required' });
      expect(validation.details.map(issue => issue.path)).not.toContain('arguments.action');
    }

    try {
      parseToolArguments(tool('manage_autoloads'), { projectPath: '/project', action: 'explode' });
      throw new Error('Expected action validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ToolArgumentValidationError);
      expect((error as ToolArgumentValidationError).details[0]).toMatchObject({
        path: 'arguments.action', keyword: 'enum',
      });
    }
  });

  it('rejects malformed top-level argument values before dispatch', () => {
    expect(() => parseToolArguments(tool('game_click'), null)).toThrow('arguments.x is required');
    expect(() => parseToolArguments(tool('game_click'), 'not-an-object')).toThrow('arguments must be object');
    expect(() => parseToolArguments(tool('game_click'), [])).toThrow('arguments must be object');
  });

  it('rejects invalid primitive and array item types', () => {
    expect(() => parseToolArguments(tool('game_click'), { x: '10', y: 20 })).toThrow('arguments.x must be number');
    expect(() => parseToolArguments(tool('validate_scripts'), {
      projectPath: '/project', scriptPaths: ['good.gd', 3],
    })).toThrow('arguments.scriptPaths[1] must be string');
  });

  it('enforces advertised oneOf unions', () => {
    expect(parseToolArguments(tool('game_ui_control'), {
      nodePath: '/root/Main/Button', action: 'configure', anchorPreset: 'center',
    })).toBeDefined();
    expect(parseToolArguments(tool('game_ui_control'), {
      nodePath: '/root/Main/Button', action: 'configure', anchorPreset: 8,
    })).toBeDefined();
    expect(() => parseToolArguments(tool('game_ui_control'), {
      nodePath: '/root/Main/Button', action: 'configure', anchorPreset: true,
    })).toThrow('arguments.anchorPreset must match exactly one allowed schema');
  });

  it('enforces advertised numeric and array bounds', () => {
    expect(() => parseToolArguments(tool('game_websocket'), {
      action: 'receive', timeout: -1,
    })).toThrow('arguments.timeout must be at least 0');
    expect(() => parseToolArguments(tool('game_input_state'), {
      keys: Array.from({ length: 129 }, () => 'A'),
    })).toThrow('arguments.keys must contain at most 128 items');
    expect(() => parseToolArguments(tool('game_input_state'), {
      mouseButtons: [10],
    })).toThrow('arguments.mouseButtons[0] must be at most 9');
    expect(() => parseToolArguments(tool('list_project_files'), {
      projectPath: '/project', limit: 1001,
    })).toThrow('arguments.limit must be at most 1000');
    expect(() => parseToolArguments(tool('list_project_files'), {
      projectPath: '/project', cursor: -1,
    })).toThrow('arguments.cursor must be at least 0');
    expect(() => parseToolArguments(tool('game_get_scene_tree'), {
      maxNodes: 10001,
    })).toThrow('arguments.maxNodes must be at most 10000');
    expect(() => parseToolArguments(tool('game_get_logs'), {
      maxItems: 0,
    })).toThrow('arguments.maxItems must be at least 1');
    expect(() => parseToolArguments(tool('game_get_errors'), {
      maxItems: 1001,
    })).toThrow('arguments.maxItems must be at most 1000');
  });

  it('enforces advertised string bounds', () => {
    expect(() => parseToolArguments(tool('game_http_request'), { url: '' }))
      .toThrow('arguments.url must contain at least 1 characters');
    expect(() => parseToolArguments(tool('game_http_request'), {
      url: 'http://localhost', body: 'x'.repeat(1_048_577),
    })).toThrow('arguments.body must contain at most 1048576 characters');
  });

  it('preserves free-form HTTP headers and RPC argument object keys', () => {
    const value = {
      headers: { 'X-E2E_Header': 'value' },
      args: [{ snake_case_payload: true }],
    };
    expect(normalizeParameters(value)).toEqual({
      headers: { 'X-E2E_Header': 'value' },
      args: [{ snake_case_payload: true }],
    });
    expect(convertCamelToSnakeCase(value)).toEqual({
      headers: { 'X-E2E_Header': 'value' },
      args: [{ snake_case_payload: true }],
    });
  });

  it('rejects unknown top-level fields but permits documented free-form objects', () => {
    expect(() => parseToolArguments(tool('game_click'), { x: 10, y: 20, unexpected: true }))
      .toThrow('arguments.unexpected is not allowed');
    expect(parseToolArguments(tool('add_node'), {
      projectPath: '/project', scenePath: 'main.tscn', nodeType: 'Node', nodeName: 'Child',
      properties: { customGodotProperty: { nested: true } },
    })).toBeDefined();
  });

  it('rejects historical array and incomplete component shapes before runtime dispatch', () => {
    expect(() => parseToolArguments(tool('game_environment'), {
      action: 'set', backgroundColor: [1, 0.5, 0.25, 1],
    })).toThrow('arguments.backgroundColor must be object');
    expect(() => parseToolArguments(tool('game_environment'), {
      action: 'set', backgroundColor: { r: 1, g: 0.5 },
    })).toThrow('arguments.backgroundColor.b is required');
    expect(parseToolArguments(tool('game_environment'), {
      action: 'set', backgroundColor: { r: 1, g: 0.5, b: 0.25, a: 1 },
    })).toBeDefined();
  });

  it('rejects unsafe CI and Docker generator values before dispatch', () => {
    expect(() => parseToolArguments(tool('manage_ci_pipeline'), {
      projectPath: '/project', action: 'create', platforms: ['linux', 'linux; rm -rf /'],
    })).toThrow('arguments.platforms[1] must be one of: windows, linux, macos, web');
    expect(() => parseToolArguments(tool('manage_docker_export'), {
      projectPath: '/project', action: 'create', baseImage: 'ubuntu:22.04\nRUN malicious',
    })).toThrow('arguments.baseImage must be one of: ubuntu:22.04, ubuntu:24.04');
    expect(() => parseToolArguments(tool('manage_ci_pipeline'), {
      projectPath: '/project', action: 'create', godotVersion: '4.7-stable\nrun: malicious',
    })).toThrow('arguments.godotVersion must match:');
    expect(() => parseToolArguments(tool('manage_docker_export'), {
      projectPath: '/project', action: 'create', godotVersion: '4.6-stable',
    })).toThrow('arguments.godotVersion must match:');
    expect(() => parseToolArguments(tool('manage_docker_export'), {
      projectPath: '/project', action: 'create', exportPreset: 'Linux/X11\nRUN malicious',
    })).toThrow('arguments.exportPreset must match:');
  });
});
