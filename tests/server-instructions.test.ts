// @test-kind: contract
import { describe, expect, it } from 'vitest';
import { SERVER_INSTRUCTIONS } from '../src/server-instructions.js';

describe('MCP server instructions', () => {
  it('teaches the durable agent loop and security boundary', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/author → run → observe → assert/);
    expect(SERVER_INSTRUCTIONS).toContain('verify_project');
    expect(SERVER_INSTRUCTIONS).toContain('run_project_tests');
    expect(SERVER_INSTRUCTIONS).toMatch(/injection and cleanup are automatic/i);
    expect(SERVER_INSTRUCTIONS).toContain('GODOT_MCP_PRIVILEGED_GROUPS');
    expect(SERVER_INSTRUCTIONS).toContain('GODOT_MCP_ALLOW_PRIVILEGED_COMMANDS');
  });

  it('stays within its always-loaded context budget', () => {
    expect(Buffer.byteLength(SERVER_INSTRUCTIONS, 'utf8')).toBeLessThanOrEqual(1_200);
    expect(SERVER_INSTRUCTIONS.trim().split(/\s+/).length).toBeLessThanOrEqual(120);
  });
});
