// @test-kind: unit
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'jsonc-parser';
import { setupOpenCode } from '../src/opencode-setup.js';

const temporary: string[] = [];

function fixture(): string {
  const path = mkdtempSync(join(tmpdir(), 'godot-agent-loop-opencode-'));
  temporary.push(path);
  return path;
}

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('OpenCode setup', () => {
  it('previews without mutation, then preserves JSONC comments while applying idempotently', () => {
    const cwd = fixture();
    const configPath = join(cwd, 'opencode.jsonc');
    writeFileSync(configPath, '{\n  // keep this comment\n  "theme": "system"\n}\n');

    const preview = setupOpenCode({ cwd });
    expect(preview.applied).toBe(false);
    expect(preview.changes).toHaveLength(5);
    expect(readFileSync(configPath, 'utf8')).not.toContain('godot-agent-loop');

    setupOpenCode({ cwd, write: true });
    const source = readFileSync(configPath, 'utf8');
    expect(source).toContain('// keep this comment');
    const parsed = parse(source);
    expect(parsed.theme).toBe('system');
    expect(parsed.mcp['godot-agent-loop']).toEqual({
      type: 'local',
      command: ['npx', '-y', '@beremaran/godot-agent-loop@1.1.3'],
      enabled: true,
      environment: { GODOT_MCP_TOOL_SURFACE: 'core', GODOT_MCP_LEGACY_JSON_TEXT: 'false' },
    });
    expect(setupOpenCode({ cwd, write: true }).changes).toEqual([]);
    expect(existsSync(join(cwd, '.agents/skills/ship-godot-game/SKILL.md'))).toBe(true);
  });

  it('uninstalls only owned configuration and skills', () => {
    const cwd = fixture();
    setupOpenCode({ cwd, write: true });
    const changed = join(cwd, '.agents/skills/build-godot-game/SKILL.md');
    writeFileSync(changed, `${readFileSync(changed, 'utf8')}\nuser note\n`);

    const result = setupOpenCode({ cwd, write: true, uninstall: true });
    expect(result.warnings).toContain(`preserve modified or unowned skill ${join(cwd, '.agents/skills/build-godot-game')}`);
    expect(existsSync(changed)).toBe(true);
    expect(existsSync(join(cwd, '.agents/skills/ship-godot-game'))).toBe(false);
    expect(parse(readFileSync(join(cwd, 'opencode.json'), 'utf8')).mcp?.['godot-agent-loop']).toBeUndefined();
    expect(existsSync(join(cwd, '.agents/.godot-agent-loop-setup.json'))).toBe(false);
  });

  it('refuses to overwrite unowned MCP entries or skills', () => {
    const cwd = fixture();
    writeFileSync(join(cwd, 'opencode.json'), '{"mcp":{"godot-agent-loop":{"type":"remote","url":"https://example.com"}}}\n');
    expect(() => setupOpenCode({ cwd, write: true })).toThrow(/Refusing to overwrite existing OpenCode MCP entry/);

    const clean = fixture();
    mkdirSync(join(clean, '.agents/skills/debug-godot-game'), { recursive: true });
    writeFileSync(join(clean, '.agents/skills/debug-godot-game/SKILL.md'), 'user-owned\n');
    expect(() => setupOpenCode({ cwd: clean, write: true })).toThrow(/Refusing to overwrite modified or unowned skill/);
    expect(existsSync(join(clean, '.agents/skills/build-godot-game'))).toBe(false);
    expect(existsSync(join(clean, 'opencode.json'))).toBe(false);
  });

  it('supports isolated user-scope installation', () => {
    const root = fixture();
    const result = setupOpenCode({ cwd: join(root, 'project'), home: join(root, 'home'), scope: 'user', write: true });
    expect(result.configPath).toBe(join(root, 'home/.config/opencode/opencode.json'));
    expect(existsSync(join(root, 'home/.agents/skills/verify-godot-change/SKILL.md'))).toBe(true);
  });
});
