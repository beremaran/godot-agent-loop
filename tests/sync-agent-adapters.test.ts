import { describe, expect, it } from 'vitest';
import { normalizeLineEndingsAndTrailingNewlines } from '../scripts/sync-agent-adapters.js';

describe('agent adapter text sync normalization', () => {
  it('ignores platform line ending and trailing newline differences', () => {
    const expected = [
      'interface:',
      '  display_name: "Build and test Godot games"',
      '  short_description: "Run Godot workflows from an agent"',
      '  default_prompt: "Use the build-godot-game skill and say \"go!\"."',
      '',
    ].join('\n');

    expect(normalizeLineEndingsAndTrailingNewlines(expected))
      .toBe(normalizeLineEndingsAndTrailingNewlines(expected.replace(/\n/g, '\r\n')));
  });

  it('normalizes trailing EOF whitespace and line endings', () => {
    expect(
      normalizeLineEndingsAndTrailingNewlines('line \n'),
    ).toBe('line');
    expect(
      normalizeLineEndingsAndTrailingNewlines('line\n\n'),
    ).toBe('line');
    expect(
      normalizeLineEndingsAndTrailingNewlines('line\r\n\r\n'),
    ).toBe('line');
    expect(
      normalizeLineEndingsAndTrailingNewlines('line \\n'),
    ).toBe('line \\n');
  });
});
