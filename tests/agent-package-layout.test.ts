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

type PackResult = {
  filename: string;
  files: { path: string }[];
};

function extractJsonArray(text: string): string {
  let inString = false;
  let escaping = false;

  for (let open = 0; open < text.length; open += 1) {
    const opening = text[open];
    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (opening === '\\') {
        escaping = true;
        continue;
      }
      if (opening === '"') {
        inString = false;
      }
      continue;
    }
    if (opening === '"') {
      inString = true;
      continue;
    }
    if (opening !== '[') continue;

    let depth = 0;
    let stringInsideArray = false;
    let escapedInsideArray = false;
    for (let index = open; index < text.length; index += 1) {
      const char = text[index];
      if (stringInsideArray) {
        if (escapedInsideArray) {
          escapedInsideArray = false;
          continue;
        }
        if (char === '\\') {
          escapedInsideArray = true;
          continue;
        }
        if (char === '"') {
          stringInsideArray = false;
        }
        continue;
      }
      if (char === '"') {
        stringInsideArray = true;
        continue;
      }
      if (char === '[') depth += 1;
      else if (char === ']') {
        depth -= 1;
        if (depth === 0) {
          const candidate = text.slice(open, index + 1);
          if (tryParsePackMetadata(candidate)) return candidate;
          break;
        }
      }
    }
  }

  return '';
}

function tryParsePackMetadata(value: string): boolean {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed);
  } catch {
    return false;
  }
}

function parsePackMetadata(output: string) {
  const raw = output.trim();
  try {
    return JSON.parse(raw) as PackResult[];
  } catch {
    const extracted = extractJsonArray(output);
    if (!extracted) {
      throw new Error(
        `Unable to parse npm pack --json output as JSON array: ${output.slice(0, 300)}`,
      );
    }
    try {
      return JSON.parse(extracted) as PackResult[];
    } catch {
      throw new Error(
        `Unable to parse npm pack --json output as JSON array: ${output.slice(0, 300)}`,
      );
    }
  }
}

describe('packed public agent layout', () => {
  it('installs byte-identical skills and consistent client metadata from the npm archive', async () => {
    const output = mkdtempSync(join(repoRoot, '.godot-agent-loop-pack-'));
    temporary.push(output);
    const packed = parsePackMetadata(execFileSync('npm', [
      'pack',
      '--ignore-scripts',
      '--silent',
      '--json',
      '--pack-destination',
      output,
    ], { cwd: repoRoot, encoding: 'utf8' }))[0] as PackResult;
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

describe('npm pack JSON output parser', () => {
  it('parses plain --json output', () => {
    const payload = [{
      filename: 'agent.tgz',
      files: [{ path: 'package/package.json' }],
    }];
    const actual = parsePackMetadata(JSON.stringify(payload));
    expect(actual).toEqual(payload);
  });

  it('extracts packed metadata from noisy output', () => {
    const payload = JSON.stringify([{
      filename: 'agent.tgz',
      files: [{ path: 'package/package.json' }],
    }]);
    const noisy = `[notice]\nnpm pack\n${payload}\nDone\n`;
    expect(parsePackMetadata(noisy), 'agent.tgz').toEqual(JSON.parse(payload));
  });
});
