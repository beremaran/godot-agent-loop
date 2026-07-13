// @test-kind: unit
import { describe, it, expect } from 'vitest';
import { parseGodotScriptDiagnostics, collectGdPaths } from '../src/utils.js';

describe('parseGodotScriptDiagnostics', () => {
  it('returns no diagnostics for empty/clean output', () => {
    expect(parseGodotScriptDiagnostics('')).toEqual([]);
    expect(parseGodotScriptDiagnostics('Godot Engine v4.7.stable\n')).toEqual([]);
  });

  it('parses a parse error with file and line (real 4.x format)', () => {
    const out = [
      'SCRIPT ERROR: Parse Error: Expected ":" after "if" condition.',
      '   at: GDScript::reload (res://broken.gd:6)',
      'ERROR: Failed to load script "res://broken.gd" with error "Parse error".',
    ].join('\n');
    const d = parseGodotScriptDiagnostics(out);
    expect(d).toHaveLength(1);
    expect(d[0]).toEqual({ message: 'Expected ":" after "if" condition.', file: 'res://broken.gd', line: 6 });
  });

  it('strips the "Parse Error:" prefix from the message', () => {
    const out = 'SCRIPT ERROR: Parse Error: Cannot assign a value of type "String" as "int".\n   at: GDScript::reload (res://typeerr.gd:3)';
    const d = parseGodotScriptDiagnostics(out);
    expect(d[0].message).toBe('Cannot assign a value of type "String" as "int".');
    expect(d[0].line).toBe(3);
  });

  it('parses multiple independent errors', () => {
    const out = [
      'SCRIPT ERROR: Parse Error: First problem.',
      '   at: GDScript::reload (res://a.gd:3)',
      'SCRIPT ERROR: Parse Error: Second problem.',
      '   at: GDScript::reload (res://a.gd:5)',
    ].join('\n');
    const d = parseGodotScriptDiagnostics(out);
    expect(d).toHaveLength(2);
    expect(d.map(e => e.line)).toEqual([3, 5]);
  });

  it('keeps a diagnostic even when no location line follows', () => {
    const d = parseGodotScriptDiagnostics('SCRIPT ERROR: Parse Error: Something went wrong.');
    expect(d).toHaveLength(1);
    expect(d[0].message).toBe('Something went wrong.');
    expect(d[0].line).toBeUndefined();
  });

  it('ignores non-SCRIPT ERROR noise', () => {
    const out = 'WARNING: something\nERROR: Failed to load script "res://x.gd".\n';
    expect(parseGodotScriptDiagnostics(out)).toEqual([]);
  });

  it('handles a res:// path containing parentheses', () => {
    const out = 'SCRIPT ERROR: Parse Error: Bad.\n   at: GDScript::reload (res://player (old).gd:6)';
    const d = parseGodotScriptDiagnostics(out);
    expect(d[0].file).toBe('res://player (old).gd');
    expect(d[0].line).toBe(6);
  });

  it('prefers the at: location over a location inside the message', () => {
    const out = 'SCRIPT ERROR: Parse Error: see (res://other.gd:99) for context.\n   at: GDScript::reload (res://real.gd:4)';
    const d = parseGodotScriptDiagnostics(out);
    expect(d[0].file).toBe('res://real.gd');
    expect(d[0].line).toBe(4);
  });
});

describe('collectGdPaths', () => {
  it('collects .gd paths across multiple git outputs and dedupes', () => {
    const unstaged = 'scripts/a.gd\nscripts/readme.md\n';
    const staged = 'scripts/b.gd\n';
    const untracked = 'scripts/c.gd\nscripts/a.gd\n';
    expect(collectGdPaths([unstaged, staged, untracked]))
      .toEqual(['scripts/a.gd', 'scripts/b.gd', 'scripts/c.gd']);
  });

  it('excludes non-.gd files', () => {
    expect(collectGdPaths(['a.tscn\nb.cs\nc.md\n'])).toEqual([]);
  });

  it('normalizes backslashes and trims blank lines', () => {
    expect(collectGdPaths(['scripts\\player.gd\n\n  ui/menu.gd  \n'])).toEqual(['scripts/player.gd', 'ui/menu.gd']);
  });

  it('returns empty for empty output', () => {
    expect(collectGdPaths(['', '\n'])).toEqual([]);
  });
});
