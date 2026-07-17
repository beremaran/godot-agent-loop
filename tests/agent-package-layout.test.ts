// @test-kind: contract
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { repoRoot } from './helpers/manifest-sources.js';

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

export function parseNpmPackJson(output: string): { filename: string; files: { path: string }[] } {
  const start = output.indexOf('[');
  const end = output.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`npm pack did not return JSON output: ${output}`);
  }
  return JSON.parse(output.slice(start, end + 1))[0] as {
    filename: string;
    files: { path: string }[];
  };
}

describe('packed public agent layout', () => {
  it('parses npm pack JSON when lifecycle output is printed first', () => {
    expect(parseNpmPackJson('Agent adapters are current\n[{"filename":"pkg.tgz","files":[]}]\n'))
      .toEqual({ filename: 'pkg.tgz', files: [] });
  });

  it('installs byte-identical skills and consistent client metadata from the npm archive', async () => {
    const output = mkdtempSync(join(repoRoot, '.godot-agent-loop-pack-'));
    temporary.push(output);
    const packed = parseNpmPackJson(execFileSync('npm', [
      'pack', '--ignore-scripts', '--json', '--pack-destination', output,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, npm_config_cache: join(output, '.npm-cache') },
    }));
    const archive = join(output, packed.filename);
    const paths = packed.files.map(file => file.path);
    const adapter = JSON.parse(readFileSync(join(repoRoot, 'agent-plugin/adapter-manifest.json'), 'utf8')) as {
      name: string; skills: { name: string; description: string; interface: { defaultPrompt: string } }[];
    };

    for (const skill of adapter.skills) {
      for (const relative of [
        `agent-plugin/skills/${skill.name}/SKILL.md`,
        `agent-plugin/skills/${skill.name}/agents/openai.yaml`,
      ]) {
        expect(paths, relative).toContain(relative);
        const archived = execFileSync('tar', ['-xOf', archive, `package/${relative}`]);
        expect(archived, relative).toEqual(readFileSync(join(repoRoot, relative)));
      }
    }

    for (const relative of [
      'agent-plugin/adapter-manifest.json',
      'agent-plugin/.mcp.json',
      'agent-plugin/.claude-plugin/plugin.json',
      'agent-plugin/.codex-plugin/plugin.json',
      'agent-plugin/pi/extension.ts',
    ]) {
      expect(paths, relative).toContain(relative);
      const archived = execFileSync('tar', ['-xOf', archive, `package/${relative}`]);
      expect(archived, relative).toEqual(readFileSync(join(repoRoot, relative)));
    }

    execFileSync('tar', ['-xf', archive, '-C', output]);
    const installedRoot = join(output, 'package');
    const installedPackage = JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8')) as {
      pi: { extensions: string[]; skills: string[] };
    };
    expect(installedPackage.pi).toEqual({
      extensions: ['./agent-plugin/pi/extension.ts'],
      skills: ['./agent-plugin/skills'],
    });
    expect(existsSync(join(installedRoot, 'build/opencode-setup.js'))).toBe(true);

    const target = join(output, 'opencode-install');
    mkdirSync(target);
    const packedSetup = await import(
      `${pathToFileURL(join(installedRoot, 'build/opencode-setup.js')).href}?package-layout=${Date.now()}`
    ) as { setupOpenCode(options: { cwd: string; write: boolean }): { changes: string[] } };
    expect(packedSetup.setupOpenCode({ cwd: target, write: true }).changes.length).toBeGreaterThan(0);
    const installedConfig = JSON.parse(readFileSync(join(target, 'opencode.json'), 'utf8')) as {
      mcp: Record<string, { environment: Record<string, string> }>;
    };
    expect(installedConfig.mcp[adapter.name].environment).toEqual({ GODOT_MCP_TOOL_SURFACE: 'core' });
    for (const declared of adapter.skills) {
      const installedSkillRoot = join(target, '.agents/skills', declared.name);
      expect(readFileSync(join(installedSkillRoot, 'SKILL.md')))
        .toEqual(readFileSync(join(repoRoot, 'agent-plugin/skills', declared.name, 'SKILL.md')));
      const installedInterface = readFileSync(join(installedSkillRoot, 'agents/openai.yaml'), 'utf8');
      expect(installedInterface).toContain(`default_prompt: ${JSON.stringify(declared.interface.defaultPrompt)}`);
    }
  });
});
