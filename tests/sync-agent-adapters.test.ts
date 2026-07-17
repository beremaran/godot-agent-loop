// @test-kind: contract
import { describe, expect, it } from 'vitest';
import { assertGeneratedTextCurrent } from '../scripts/sync-agent-adapters.js';

describe('agent adapter synchronization', () => {
  it('accepts generated text with CRLF checkout line endings', () => {
    expect(() => {
      assertGeneratedTextCurrent('interface:\r\n  display_name: "Build"\r\n', 'interface:\n  display_name: "Build"\n', 'agents/openai.yaml');
    })
      .not.toThrow();
  });

  it('rejects generated text with real content drift', () => {
    expect(() => {
      assertGeneratedTextCurrent('interface:\r\n  display_name: "Build"\r\n', 'interface:\n  display_name: "Ship"\n', 'agents/openai.yaml');
    })
      .toThrow('agents/openai.yaml is out of sync with agent-plugin/adapter-manifest.json');
  });
});
