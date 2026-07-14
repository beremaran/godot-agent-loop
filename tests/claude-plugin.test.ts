// @test-kind: contract
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './helpers/manifest-sources.js';

const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const pluginRoot = join(repoRoot, 'claude-plugin');
const plugin = JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin/plugin.json'), 'utf8'));
const mcp = JSON.parse(readFileSync(join(pluginRoot, '.mcp.json'), 'utf8'));
const marketplace = JSON.parse(readFileSync(join(repoRoot, '.claude-plugin/marketplace.json'), 'utf8'));
const expectedSkills = ['build-godot-game', 'debug-godot-game', 'verify-godot-change'];

function skill(name: string): string {
  return readFileSync(join(pluginRoot, 'skills', name, 'SKILL.md'), 'utf8');
}

describe('Claude Code plugin package', () => {
  it('keeps manifest, marketplace, MCP command, and npm release aligned', () => {
    expect(plugin).toMatchObject({ name: 'godot-mcp', version: packageJson.version });
    expect(marketplace).toMatchObject({
      name: 'godot-mcp',
      plugins: [expect.objectContaining({ name: 'godot-mcp', source: './claude-plugin' })],
    });
    expect(mcp.mcpServers['godot-mcp']).toEqual({
      command: 'npx', args: ['-y', `@beremaran/godot-mcp@${packageJson.version}`],
    });
    expect(packageJson.files).toContain('claude-plugin');
  });

  it('ships exactly the three end-goal skills with valid trigger metadata', () => {
    expect(readdirSync(join(pluginRoot, 'skills')).sort()).toEqual(expectedSkills);
    for (const name of expectedSkills) {
      const source = skill(name);
      expect(source).toMatch(new RegExp(`^---\\nname: ${name}\\ndescription: .+\\n---`));
      expect(source).not.toContain('[TODO:');
      expect(source.split('\n').length, name).toBeLessThan(100);
    }
  });

  it('gives each workflow explicit tool order and independent evidence', () => {
    const build = skill('build-godot-game');
    expect(build.indexOf('1. Inspect before writing.')).toBeLessThan(build.indexOf('2. Author the smallest complete game.'));
    expect(build.indexOf('2. Author the smallest complete game.')).toBeLessThan(build.indexOf('3. Validate static artifacts.'));
    expect(build.indexOf('3. Validate static artifacts.')).toBeLessThan(build.indexOf('4. Run and exercise the game.'));
    expect(build).toContain('`create_project`');
    expect(build).toContain('`create_scene`');
    expect(build).toContain('`validate_scripts`');
    expect(build).toContain('`run_project`');
    expect(build).toContain('`verify_project`');
    expect(build).toContain('`run_project_tests`');

    const verify = skill('verify-godot-change');
    expect(verify.indexOf('`validate_script`')).toBeLessThan(verify.indexOf('`verify_project`'));
    expect(verify).toContain('`game_get_scene_tree`');
    expect(verify).toMatch(/successful mutation response is not evidence/i);

    const debug = skill('debug-godot-game');
    expect(debug.indexOf('`run_project`')).toBeLessThan(debug.indexOf('`get_debug_output`'));
    expect(debug.indexOf('`get_debug_output`')).toBeLessThan(debug.indexOf('Stop the project before editing'));
    expect(debug).toContain('`verify_project`');
    expect(debug).toMatch(/independent passing evidence/i);
  });
});
