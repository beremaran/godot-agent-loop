import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';

interface OpenCodeSetupOptions {
  cwd?: string;
  home?: string;
  scope?: 'project' | 'user';
  configPath?: string;
  write?: boolean;
  uninstall?: boolean;
}

interface OwnershipRecord {
  version: 1;
  configPath: string;
  configEntry: unknown;
  skills: Record<string, string>;
}

export interface OpenCodeSetupResult {
  action: 'install' | 'uninstall';
  applied: boolean;
  configPath: string;
  skillsRoot: string;
  changes: string[];
  warnings: string[];
}

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = join(packageRoot, 'agent-plugin');

interface AdapterManifest {
  name: string;
  version: string;
  mcp: { command: string[]; environment: Record<string, string> };
  skills: { name: string }[];
}

function loadAdapter(): AdapterManifest {
  return JSON.parse(readFileSync(join(pluginRoot, 'adapter-manifest.json'), 'utf8')) as AdapterManifest;
}

function stable(value: unknown): string {
  return JSON.stringify(value);
}

function directoryHash(path: string): string {
  const hash = createHash('sha256');
  const visit = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const fullPath = join(dir, name);
      const info = statSync(fullPath);
      if (info.isDirectory()) visit(fullPath);
      else {
        hash.update(relative(path, fullPath));
        hash.update(readFileSync(fullPath));
      }
    }
  };
  visit(path);
  return hash.digest('hex');
}

function readOwnership(path: string): OwnershipRecord | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as OwnershipRecord;
}

function parseConfig(source: string, path: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value = parse(source, errors, { allowTrailingComma: true, disallowComments: false }) as Record<string, unknown>;
  if (errors.length > 0 || !value || Array.isArray(value)) {
    throw new Error(`Cannot safely update ${path}: invalid JSON/JSONC configuration`);
  }
  return value;
}

function configSource(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
}

function editConfig(source: string, name: string, value: unknown): string {
  const edits = modify(source, ['mcp', name], value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' },
  });
  return applyEdits(source, edits);
}

function defaultProjectConfig(cwd: string): string {
  const jsonc = join(cwd, 'opencode.jsonc');
  const json = join(cwd, 'opencode.json');
  return existsSync(jsonc) ? jsonc : json;
}

export function setupOpenCode(options: OpenCodeSetupOptions = {}): OpenCodeSetupResult {
  const adapter = loadAdapter();
  const cwd = resolve(options.cwd ?? process.cwd());
  const home = resolve(options.home ?? homedir());
  const scope = options.scope ?? 'project';
  const configPath = resolve(options.configPath ?? (
    scope === 'user' ? join(home, '.config', 'opencode', 'opencode.json') : defaultProjectConfig(cwd)
  ));
  const agentsRoot = scope === 'user' ? join(home, '.agents') : join(cwd, '.agents');
  const skillsRoot = join(agentsRoot, 'skills');
  const ownershipPath = join(agentsRoot, '.godot-agent-loop-setup.json');
  const ownership = readOwnership(ownershipPath);
  const expectedEntry = {
    type: 'local',
    command: adapter.mcp.command,
    enabled: true,
    environment: adapter.mcp.environment,
  };
  const source = configSource(configPath);
  const config = parseConfig(source, configPath);
  const currentEntry = (config.mcp as Record<string, unknown> | undefined)?.[adapter.name];
  const changes: string[] = [];
  const warnings: string[] = [];
  const skillOperations: { action: 'install' | 'update' | 'remove'; source?: string; target: string }[] = [];
  let nextConfig = source;

  if (options.uninstall) {
    const ownedEntry = ownership?.configEntry ?? expectedEntry;
    if (currentEntry !== undefined && stable(currentEntry) === stable(ownedEntry)) {
      nextConfig = editConfig(source, adapter.name, undefined);
      changes.push(`remove MCP entry ${adapter.name} from ${configPath}`);
    } else if (currentEntry !== undefined) {
      warnings.push(`preserve modified MCP entry ${adapter.name} in ${configPath}`);
    }
  } else if (currentEntry === undefined) {
    nextConfig = editConfig(source, adapter.name, expectedEntry);
    changes.push(`add MCP entry ${adapter.name} to ${configPath}`);
  } else if (stable(currentEntry) !== stable(expectedEntry)) {
    const previouslyOwned = ownership && stable(currentEntry) === stable(ownership.configEntry);
    if (!previouslyOwned) throw new Error(`Refusing to overwrite existing OpenCode MCP entry: ${adapter.name}`);
    nextConfig = editConfig(source, adapter.name, expectedEntry);
    changes.push(`update MCP entry ${adapter.name} in ${configPath}`);
  }

  const nextSkills: Record<string, string> = {};
  for (const declared of adapter.skills) {
    const sourceSkill = join(pluginRoot, 'skills', declared.name);
    const targetSkill = join(skillsRoot, declared.name);
    const sourceHash = directoryHash(sourceSkill);
    nextSkills[declared.name] = sourceHash;
    if (options.uninstall) {
      if (!existsSync(targetSkill)) continue;
      const installedHash = directoryHash(targetSkill);
      if (ownership?.skills[declared.name] === installedHash) {
        changes.push(`remove owned skill ${targetSkill}`);
        skillOperations.push({ action: 'remove', target: targetSkill });
      } else {
        warnings.push(`preserve modified or unowned skill ${targetSkill}`);
      }
      continue;
    }
    if (!existsSync(targetSkill)) {
      changes.push(`install skill ${targetSkill}`);
      skillOperations.push({ action: 'install', source: sourceSkill, target: targetSkill });
      continue;
    }
    const installedHash = directoryHash(targetSkill);
    if (installedHash === sourceHash) continue;
    if (ownership?.skills[declared.name] !== installedHash) {
      throw new Error(`Refusing to overwrite modified or unowned skill: ${targetSkill}`);
    }
    changes.push(`update owned skill ${targetSkill}`);
    skillOperations.push({ action: 'update', source: sourceSkill, target: targetSkill });
  }

  if (options.write) {
    for (const operation of skillOperations) {
      if (operation.action === 'remove' || operation.action === 'update') {
        rmSync(operation.target, { recursive: true });
      }
      if (operation.source) {
        mkdirSync(dirname(operation.target), { recursive: true });
        cpSync(operation.source, operation.target, { recursive: true });
      }
    }
    if (nextConfig !== source) {
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, nextConfig);
    }
    if (options.uninstall) {
      if (existsSync(ownershipPath)) rmSync(ownershipPath);
    } else {
      mkdirSync(dirname(ownershipPath), { recursive: true });
      const record: OwnershipRecord = {
        version: 1,
        configPath,
        configEntry: expectedEntry,
        skills: nextSkills,
      };
      writeFileSync(ownershipPath, `${JSON.stringify(record, null, 2)}\n`);
    }
  }

  return {
    action: options.uninstall ? 'uninstall' : 'install',
    applied: options.write === true,
    configPath,
    skillsRoot,
    changes,
    warnings,
  };
}

export async function runOpenCodeSetup(args: string[]): Promise<void> {
  const value = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const scope = value('--scope');
  if (scope !== undefined && scope !== 'project' && scope !== 'user') {
    throw new Error('--scope must be project or user');
  }
  const result = setupOpenCode({
    scope,
    configPath: value('--config'),
    write: args.includes('--write') || args.includes('--yes'),
    uninstall: args.includes('uninstall') || args.includes('--uninstall'),
  });
  const mode = result.applied ? 'Applied' : 'Preview';
  console.log(`${mode}: OpenCode ${result.action}`);
  console.log(`Config: ${result.configPath}`);
  console.log(`Skills: ${result.skillsRoot}`);
  for (const change of result.changes) console.log(`  - ${change}`);
  for (const warning of result.warnings) console.log(`  ! ${warning}`);
  if (!result.applied) console.log('Run again with --write to apply this preview.');
}
