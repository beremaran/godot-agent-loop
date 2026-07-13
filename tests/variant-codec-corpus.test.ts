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
  negative: NegativeCase[];
}

function readCorpus(): VariantCodecCorpus {
  return JSON.parse(readFileSync(corpusPath, 'utf8')) as VariantCodecCorpus;
}

describe('Variant codec corpus', () => {
  it('covers the published type hints and every supported wire category', () => {
    const corpus = readCorpus();
    const schema = JSON.parse(readFileSync(join(root, 'docs/runtime-api.schema.json'), 'utf8')) as {
      'x-runtime-contract': { variantCodec: { typeHints: string[] } };
    };
    const expectedCases = [
      'null', 'bool', 'int', 'float', 'string',
      'vector2', 'vector2i', 'vector3', 'vector3i', 'color', 'quaternion',
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
      ['depth_exceeded', 'codec_depth_exceeded'],
      ['collection_exceeded', 'codec_collection_exceeded'],
    ];

    expect(corpus.negative.map(testCase => [testCase.name, testCase.reason])).toEqual(expectedFailures);

    const runner = readFileSync(join(root, 'tests/godot/fixture/test_runner.gd'), 'utf8');
    const script = readFileSync(join(root, 'tests/godot/run-integration-tests.sh'), 'utf8');
    expect(runner).toContain('res://variant-codec-corpus.json');
    expect(script).toContain('tests/variant-codec-corpus.json');
    expect(script).toContain('variant-codec-corpus.json');
  });
});
