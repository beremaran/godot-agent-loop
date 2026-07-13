import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Source-derived views of the tool surface, used to cross-check the
 * hand-maintained src/tool-manifest.ts against what the code actually does.
 * Extraction is deliberately conservative: where a pattern cannot be parsed
 * with confidence the caller falls back to weaker subset assertions.
 */

export const repoRoot = join(fileURLToPath(new URL('../..', import.meta.url)));

export function readRepoFile(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

/** Tool name -> { domain, handler } parsed from the domain registry source. */
export function registryMappings(): Map<string, { domain: string; handler: string }> {
  const source = readRepoFile('src/domain-tool-registries.ts');
  const domains: Record<string, string> = {
    createLifecycleToolRegistry: 'lifecycle',
    createProjectToolRegistry: 'project',
    createGameToolRegistry: 'game',
  };
  const mappings = new Map<string, { domain: string; handler: string }>();
  for (const [factory, domain] of Object.entries(domains)) {
    const block = new RegExp(`export function ${factory}[\\s\\S]*?\\n}`).exec(source);
    if (!block) throw new Error(`Registry factory not found: ${factory}`);
    for (const match of block[0].matchAll(/'([a-z0-9_]+)':\s*(?:args\s*=>|\(\)\s*=>)\s*handlers\.(\w+)\(/g)) {
      if (mappings.has(match[1])) throw new Error(`Tool registered twice: ${match[1]}`);
      mappings.set(match[1], { domain, handler: match[2] });
    }
  }
  return mappings;
}

/** Handler method name -> body text for one handler class source file. */
export function handlerMethodBodies(relativePath: string): Map<string, string> {
  const source = readRepoFile(relativePath);
  const starts: { name: string; index: number }[] = [];
  for (const match of source.matchAll(/public async (handle\w+)\(/g)) {
    starts.push({ name: match[1], index: match.index });
  }
  const bodies = new Map<string, string>();
  starts.forEach((start, i) => {
    bodies.set(start.name, source.slice(start.index, starts[i + 1]?.index ?? source.length));
  });
  return bodies;
}

/** The single runtime command a game handler method sends, if extractable. */
export function runtimeCommandOf(body: string): string | null {
  const matches = [...body.matchAll(/(?:gameCommand|commands\.execute|commands\.send|context\.execute)\('([a-z0-9_]+)'/g)];
  const unique = [...new Set(matches.map(match => match[1]))];
  if (unique.length > 1) throw new Error(`Handler sends multiple runtime commands: ${unique.join(', ')}`);
  return unique[0] ?? null;
}

/** The single headless operation a project handler method executes, if any. */
export function headlessOperationOf(body: string): string | null {
  const matches = [...body.matchAll(/(?:executeOperation|headlessOp|sceneOperations\.run)\(\s*'([a-z0-9_]+)'/g)];
  const unique = [...new Set(matches.map(match => match[1]))];
  if (unique.length > 1) throw new Error(`Handler executes multiple operations: ${unique.join(', ')}`);
  return unique[0] ?? null;
}

/** Operation name -> implementing function, from godot_operations.gd's registry. */
export function headlessOperationRegistry(): Map<string, string> {
  const source = readRepoFile('src/scripts/godot_operations.gd');
  const block = /func _register_operations\(\) -> void:\n\s*_operations = \{([\s\S]*?)\}/.exec(source);
  if (!block) throw new Error('godot_operations.gd operation registry not found');
  const registry = new Map<string, string>();
  for (const match of block[1].matchAll(/"([a-z0-9_]+)":\s*(\w+),/g)) {
    registry.set(match[1], match[2]);
  }
  return registry;
}

/** Every runtime GDScript source that can register or implement commands. */
export function runtimeGdscriptSources(): string[] {
  const runtimeDir = join(repoRoot, 'src/scripts/mcp_runtime');
  const domains = readdirSync(runtimeDir)
    .filter(file => file.endsWith('.gd'))
    .map(file => `src/scripts/mcp_runtime/${file}`);
  return ['src/scripts/mcp_interaction_server.gd', ...domains];
}

/** Runtime command -> { file, handler } from register_command sites. */
export function runtimeCommandRegistry(): Map<string, { file: string; handler: string }> {
  const registry = new Map<string, { file: string; handler: string }>();
  for (const file of runtimeGdscriptSources()) {
    for (const match of readRepoFile(file).matchAll(/register_command\("([^"]+)",\s*(\w+)/g)) {
      if (registry.has(match[1])) throw new Error(`Runtime command registered twice: ${match[1]}`);
      registry.set(match[1], { file, handler: match[2] });
    }
  }
  return registry;
}

/** The body of one top-level GDScript function, bounded by the next declaration. */
export function gdscriptFunctionBody(source: string, name: string): string | null {
  const lines = source.split('\n');
  const start = lines.findIndex(line => line.startsWith(`func ${name}(`));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^(func |static func |class )/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

export interface ExtractedActions {
  /** 'exact' lists can be compared with set equality; 'partial' only supports subset checks. */
  confidence: 'exact' | 'partial';
  actions: string[];
}

/**
 * Actions a GDScript command/operation function accepts. Recognizes, in order
 * of confidence: reader.required_enum/optional_enum("action", ...) declarations,
 * `match action:` arms, and `action ==/!= "..."` comparison chains.
 */
export function extractGdscriptActions(body: string): ExtractedActions | null {
  const enumDeclaration = /_enum\(\s*"action"\s*,\s*(?:"[^"]*"\s*,\s*)?\[([^\]]*)\]/.exec(body);
  if (enumDeclaration) {
    return { confidence: 'exact', actions: quotedStrings(enumDeclaration[1]) };
  }
  if (!body.includes('"action"')) return null;

  const lines = body.split('\n');
  const matchIndex = lines.findIndex(line => /^\s*match action:/.test(line));
  if (matchIndex >= 0) {
    const indent = /^\s*/.exec(lines[matchIndex])![0];
    const actions: string[] = [];
    for (let i = matchIndex + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '') continue;
      const lineIndent = /^\s*/.exec(line)![0];
      if (lineIndent.length <= indent.length) break;
      const arm = /^\s*((?:"[^"]+"(?:\s*,\s*)?)+):/.exec(line);
      if (arm && lineIndent.length === indent.length + 1) actions.push(...quotedStrings(arm[1]));
    }
    if (actions.length > 0) return { confidence: 'exact', actions };
  }

  const comparisons = [...body.matchAll(/action [!=]= "([^"]+)"/g)].map(match => match[1]);
  if (comparisons.length > 0) return { confidence: 'partial', actions: [...new Set(comparisons)] };
  return null;
}

/** Actions dispatched by a TypeScript handler body through args.action comparisons. */
export function extractTypescriptActions(body: string): ExtractedActions | null {
  const comparisons = [...body.matchAll(/args\.action\s*[!=]==\s*'([^']+)'/g)].map(match => match[1]);
  if (comparisons.length === 0) return null;
  return { confidence: 'partial', actions: [...new Set(comparisons)] };
}

function quotedStrings(text: string): string[] {
  return [...text.matchAll(/"([^"]+)"/g)].map(match => match[1]);
}
