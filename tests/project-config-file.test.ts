// @test-kind: unit
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ProjectConfigError,
  assertSafeConfigValueText,
  removeIniSetting,
  serializeConfigAssignment,
  serializeConfigValue,
  serializePackedStringArray,
  setIniSetting,
  setIniSettingAtomic,
  updateIniFileAtomic,
  validateConfigValueText,
  writeConfigFileAtomic,
} from '../src/project-config-file.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'safe-config-'));
}

describe('serializeConfigValue', () => {
  it('round-trips quotes, backslashes, and control characters without raw newlines', () => {
    const value = 'say "hi" \\ back\nnew line\rcarriage\ttab ☃';
    const text = serializeConfigValue(value);
    expect(text.startsWith('"')).toBe(true);
    expect(text).not.toMatch(/[\r\n]/);
    expect(assertSafeConfigValueText(text)).toBe(value);
  });

  it('serializes regex metacharacters as inert string content', () => {
    const value = '.*+?^${}()|[]\\ end';
    const text = serializeConfigValue(value);
    expect(validateConfigValueText(text).ok).toBe(true);
    expect(assertSafeConfigValueText(text)).toBe(value);
  });

  it('serializes nested arrays and dictionaries', () => {
    const text = serializeConfigValue({ a: [1, 'x', true, null], b: { nested: 2.5 } });
    const parsed = assertSafeConfigValueText(text) as Record<string, unknown>;
    expect(parsed).toEqual({ a: [1, 'x', true, null], b: { nested: 2.5 } });
  });

  it('rejects unsupported values', () => {
    for (const bad of [undefined, Number.NaN, Number.POSITIVE_INFINITY, () => 1, Symbol('s'), 10n]) {
      expect(() => serializeConfigValue(bad)).toThrow(ProjectConfigError);
    }
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => serializeConfigValue(circular)).toThrow(/Circular/);
    expect(() => serializeConfigValue(new Date())).toThrow(ProjectConfigError);
    expect(() => serializeConfigValue({ ['__proto__']: 1 })).toThrow(ProjectConfigError);
    const sparse: unknown[] = [1];
    sparse.length = 3;
    expect(() => serializeConfigValue(sparse)).toThrow(/Sparse/);
    expect(() => serializePackedStringArray([1, 2])).toThrow(ProjectConfigError);
  });

  it('rejects invalid section and key names instead of emitting config syntax', () => {
    expect(() => serializeConfigAssignment('a\nb', 'x')).toThrow(ProjectConfigError);
    expect(() => serializeConfigAssignment('a=b', 'x')).toThrow(ProjectConfigError);
    expect(() => serializeConfigAssignment('evil.*+?^${}()|[]\\', 'x')).toThrow(ProjectConfigError);
    expect(() => setIniSetting('[x]', 'bad section!', 'k', 1)).toThrow(ProjectConfigError);
  });
});

describe('validateConfigValueText', () => {
  it('rejects malformed Variant text', () => {
    for (const bad of [
      '"unterminated',
      "'single-quoted'",
      'bare_word',
      '[1, 2',
      '{"a": 1',
      '[1, 2,]',
      'true trailing garbage',
      'PackedStringArray("a", "b"',
      'SomeUnknown("x")',
      '"bad escape \\q"',
      '123abc',
    ]) {
      expect(validateConfigValueText(bad).ok, bad).toBe(false);
    }
    expect(() => assertSafeConfigValueText('"unterminated')).toThrow(ProjectConfigError);
  });

  it('rejects raw newlines inside strings and NUL bytes', () => {
    expect(validateConfigValueText('"line\nbreak"').ok).toBe(false);
    expect(validateConfigValueText('"\0"').ok).toBe(false);
  });

  it('accepts packed constructors produced by the serializer', () => {
    const text = serializePackedStringArray(['a"b', 'c']);
    expect(validateConfigValueText(text)).toMatchObject({ ok: true });
  });
});

describe('setIniSetting', () => {
  it('treats keys literally and preserves unrelated content', () => {
    const before = [
      '; comment with .*+? metachars',
      '[autoload]',
      'Foo="*res://foo.gd"',
      'Foobar="*res://foobar.gd"',
      '',
      '[rendering]',
      'quality=2',
      '',
    ].join('\n');
    const after = setIniSetting(before, 'autoload', 'Foo', '*res://foo2.gd');
    expect(after).toContain('Foo="*res://foo2.gd"');
    expect(after).toContain('Foobar="*res://foobar.gd"');
    expect(after).toContain('; comment with .*+? metachars');
    expect(after).toContain('quality=2');
  });

  it('does not confuse similar keys when a regex-meta key is rejected or absent', () => {
    const before = '[params]\nname="a"\nname_extra="b"\n';
    const after = setIniSetting(before, 'params', 'name', 'c');
    expect(after).toContain('name="c"');
    expect(after).toContain('name_extra="b"');
  });

  it('appends missing sections and keys without touching other lines', () => {
    const before = '[display]\nwidth=64\n';
    const after = setIniSetting(before, 'autoload', 'Hero', '*res://hero.gd');
    expect(after).toContain('[display]\nwidth=64');
    expect(after).toContain('[autoload]');
    expect(after).toContain('Hero="*res://hero.gd"');
  });

  it('removes exactly one key by exact match', () => {
    const before = '[autoload]\nFoo="*res://foo.gd"\nFoobar="*res://foobar.gd"\n';
    const after = removeIniSetting(before, 'autoload', 'Foo');
    expect(after).not.toContain('Foo="*res://foo.gd"');
    expect(after).toContain('Foobar="*res://foobar.gd"');
  });

  it('serializes newline-bearing values without emitting raw newlines', () => {
    const after = setIniSetting('[section]\n', 'section', 'key', 'a\nb');
    const line = after.split('\n').find(entry => entry.startsWith('key='));
    expect(line).toBe('key="a\\nb"');
    expect(validateConfigValueText(line?.slice('key='.length) ?? '').ok).toBe(true);
  });
});

describe('atomic writes', () => {
  it('replaces the target and leaves no staging file behind', () => {
    const dir = tempDir();
    try {
      const target = join(dir, 'project.godot');
      writeFileSync(target, '[a]\nx=1\n', 'utf8');
      const result = setIniSettingAtomic(target, 'a', 'x', 2);
      expect(result.changed).toBe(true);
      expect(readFileSync(target, 'utf8')).toContain('x=2');
      expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves the original untouched when serialization fails', () => {
    const dir = tempDir();
    try {
      const target = join(dir, 'project.godot');
      const before = '[a]\nx=1\n';
      writeFileSync(target, before, 'utf8');
      expect(() => setIniSettingAtomic(target, 'a', 'x', Number.NaN)).toThrow(ProjectConfigError);
      expect(readFileSync(target, 'utf8')).toBe(before);
      expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves the original untouched when replacement validation fails', () => {
    const dir = tempDir();
    try {
      const target = join(dir, 'project.godot');
      const before = '[a]\nx=1\n';
      writeFileSync(target, before, 'utf8');
      expect(() => updateIniFileAtomic(target, () => 'has NUL \0 byte')).toThrow(ProjectConfigError);
      expect(() => updateIniFileAtomic(target, () => 'ok', { validate: () => { throw new ProjectConfigError('malformed_value_text', 'nope'); } }))
        .toThrow(ProjectConfigError);
      expect(readFileSync(target, 'utf8')).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cleans up staging files when staging or replacement is interrupted', () => {
    const dir = tempDir();
    try {
      const target = join(dir, 'project.godot');
      const before = '[a]\nx=1\n';
      writeFileSync(target, before, 'utf8');
      expect(() => { writeConfigFileAtomic(target, '[a]\nx=2\n', {
        writeTemp(_tmp: string, _content: string): void { throw new Error('disk full during staging'); },
      }); }).toThrow(ProjectConfigError);
      expect(() => { writeConfigFileAtomic(target, '[a]\nx=2\n', {
        replace(_tmp: string, _final: string): void { throw new Error('crash before rename'); },
      }); }).toThrow(ProjectConfigError);
      expect(readFileSync(target, 'utf8')).toBe(before);
      expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([]);
      expect(existsSync(target)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips the write when content is unchanged', () => {
    const dir = tempDir();
    try {
      const target = join(dir, 'project.godot');
      writeFileSync(target, '[a]\nx=1\n', 'utf8');
      let replaced = false;
      const result = updateIniFileAtomic(target, content => content, {
        replace: (tmp, final) => { replaced = true; writeFileSync(final, readFileSync(tmp, 'utf8'), 'utf8'); },
      });
      expect(result.changed).toBe(false);
      expect(replaced).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
