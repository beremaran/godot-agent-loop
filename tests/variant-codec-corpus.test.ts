// @test-kind: contract
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(fileURLToPath(new URL('..', import.meta.url)));
const corpusPath = join(root, 'tests/variant-codec-corpus.json');

interface CorpusCase {
  name: string;
  typeHint?: string;
  wire: unknown;
  dynamicKeys?: string[];
}

interface NegativeCase {
  name: string;
  reason: string;
}

interface VariantCodecCorpus {
  version: number;
  typeHints: string[];
  cases: CorpusCase[];
  typedWrappers: CorpusCase[];
  negative: NegativeCase[];
}

function readCorpus(): VariantCodecCorpus {
  return JSON.parse(readFileSync(corpusPath, 'utf8')) as VariantCodecCorpus;
}

describe('Variant codec corpus', () => {
  it('publishes canonical authoring shapes including explicit unsupported RID behavior', () => {
    const shapes = JSON.parse(readFileSync(join(root, 'docs/godot-variant-shapes.json'), 'utf8')) as {
      typedWrapper: { properties: { type: { enum: string[] } } };
      examples: Record<string, unknown[]>;
      rid: { mutationSupported: boolean };
      negativeExamples: { targetType: string; code: string }[];
    };
    for (const type of [
      'Vector2', 'Vector2i', 'Vector3', 'Vector3i', 'Vector4', 'Vector4i',
      'Color', 'Rect2', 'Transform2D', 'Transform3D', 'Basis', 'Quaternion',
      'NodePath', 'StringName', 'Resource',
    ]) {
      expect(shapes.typedWrapper.properties.type.enum).toContain(type);
      expect(shapes.examples[type]).not.toHaveLength(0);
    }
    expect(shapes.typedWrapper.properties.type.enum).toContain('RID');
    expect(shapes.examples).toMatchObject({ Array: expect.any(Array), Dictionary: expect.any(Array) });
    expect(shapes.rid.mutationSupported).toBe(false);
    expect(shapes.negativeExamples).toContainEqual({
      targetType: 'RID', value: { id: 42 }, code: 'unsupported_variant',
    });
  });

  it('covers the published type hints and every supported wire category', () => {
    const corpus = readCorpus();
    const schema = JSON.parse(readFileSync(join(root, 'docs/runtime-api.schema.json'), 'utf8')) as {
      'x-runtime-contract': { variantCodec: { typeHints: string[] } };
    };
    const expectedCases = [
      'null', 'bool', 'int', 'float', 'string',
      'vector2', 'vector2i', 'vector3', 'vector3i', 'vector4', 'vector4i', 'color', 'quaternion',
      'rect2', 'aabb', 'basis', 'transform3d', 'transform2d',
      'node_path', 'string_name',
      'packed_byte_array', 'packed_int32_array', 'packed_int64_array',
      'packed_float32_array', 'packed_float64_array', 'packed_string_array',
      'packed_vector2_array', 'packed_vector3_array', 'packed_color_array',
      'nested_collections', 'resource', 'node', 'object',
    ];

    expect(corpus.version).toBe(1);
    expect(corpus.typeHints).toEqual(schema['x-runtime-contract'].variantCodec.typeHints);
    expect(corpus.cases.map(testCase => testCase.name)).toEqual(expectedCases);
    expect(new Set(corpus.cases.map(testCase => testCase.name)).size).toBe(expectedCases.length);

    for (const testCase of corpus.cases) {
      expect(corpus.typeHints).toContain(testCase.typeHint ?? '');
      expect(JSON.parse(JSON.stringify(testCase.wire))).toEqual(testCase.wire);
      for (const dynamicKey of testCase.dynamicKeys ?? []) {
        expect(testCase.wire).toEqual(expect.objectContaining({ _type: expect.any(String) }));
        expect(dynamicKey).toEqual(expect.any(String));
      }
    }
    expect(corpus.typedWrappers.map(testCase => testCase.name)).toEqual([
      'wrapped_vector2i', 'wrapped_quaternion', 'wrapped_basis', 'wrapped_transform2d',
      'wrapped_node_path', 'wrapped_string_name', 'wrapped_resource',
    ]);
    for (const wrapper of corpus.typedWrappers) {
      expect(wrapper.wire).toMatchObject({ type: wrapper.typeHint, value: expect.anything() });
    }
  });

  it('publishes all codec failure fixtures and keeps the Godot runner on the same corpus', () => {
    const corpus = readCorpus();
    const expectedFailures = [
      ['array_cycle', 'codec_cycle'],
      ['dictionary_cycle', 'codec_cycle'],
      ['callable', 'unsupported_variant'],
      ['signal', 'unsupported_variant'],
      ['rid', 'unsupported_variant'],
      ['invalid_type_hint', 'invalid_type_hint'],
      ['invalid_variant_shape', 'invalid_variant_shape'],
      ['depth_exceeded', 'codec_depth_exceeded'],
      ['collection_exceeded', 'codec_collection_exceeded'],
      ['rid_wrapper', 'unsupported_variant'],
      ['integer_wrapper_fraction', 'invalid_variant_shape'],
      ['resource_wrapper_outside_project', 'invalid_variant_shape'],
      ['wrapper_target_mismatch', 'invalid_variant_shape'],
    ];

    expect(corpus.negative.map(testCase => [testCase.name, testCase.reason])).toEqual(expectedFailures);

    const runner = readFileSync(join(root, 'tests/godot/fixture/test_runner.gd'), 'utf8');
    const script = readFileSync(join(root, 'tests/godot/run-integration-tests.sh'), 'utf8');
    expect(runner).toContain('res://variant-codec-corpus.json');
    expect(script).toContain('tests/variant-codec-corpus.json');
    expect(script).toContain('variant-codec-corpus.json');
  });
});
