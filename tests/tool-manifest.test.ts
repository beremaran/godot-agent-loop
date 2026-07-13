// @test-kind: contract
import { describe, expect, it } from 'vitest';
import { toolDefinitions, type ToolName } from '../src/tool-definitions.js';
import { toolManifest } from '../src/tool-manifest.js';
import { PRIVILEGED_RUNTIME_COMMANDS, RUNTIME_COMMANDS } from '../src/runtime-protocol.js';
import { GameToolHandlers } from '../src/tool-handlers/game-tool-handlers.js';
import { LifecycleToolHandlers } from '../src/tool-handlers/lifecycle-tool-handlers.js';
import { ProjectToolHandlers } from '../src/tool-handlers/project-tool-handlers.js';
import {
  extractGdscriptActions,
  extractTypescriptActions,
  gdscriptFunctionBody,
  handlerMethodBodies,
  headlessOperationOf,
  headlessOperationRegistry,
  readRepoFile,
  registryMappings,
  runtimeCommandOf,
  runtimeCommandRegistry,
} from './helpers/manifest-sources.js';

const manifestEntries = Object.entries(toolManifest) as [ToolName, (typeof toolManifest)[ToolName]][];
const handlerBodies = {
  lifecycle: handlerMethodBodies('src/tool-handlers/lifecycle-tool-handlers.ts'),
  project: handlerMethodBodies('src/tool-handlers/project-tool-handlers.ts'),
  game: handlerMethodBodies('src/tool-handlers/game-tool-handlers.ts'),
};

describe('tool manifest completeness', () => {
  it('contains exactly one entry per advertised tool', () => {
    // Record<ToolName, ...> already enforces this at compile time; the runtime
    // assertion is the generated denominator the coverage report builds on.
    expect(Object.keys(toolManifest).sort()).toEqual(toolDefinitions.map(tool => tool.name).sort());
  });

  it('matches the domain registry mapping for every tool', () => {
    const registry = registryMappings();
    expect(registry.size).toBe(toolDefinitions.length);
    for (const [name, entry] of manifestEntries) {
      const registered = registry.get(name);
      expect(registered, `${name} missing from domain-tool-registries.ts`).toBeDefined();
      expect(registered, name).toEqual({ domain: entry.domain, handler: entry.handler });
    }
  });

  it('names a real handler method on the owning handler class', () => {
    const prototypes = {
      lifecycle: LifecycleToolHandlers.prototype as unknown as Record<string, unknown>,
      project: ProjectToolHandlers.prototype as unknown as Record<string, unknown>,
      game: GameToolHandlers.prototype as unknown as Record<string, unknown>,
    };
    for (const [name, entry] of manifestEntries) {
      expect(typeof prototypes[entry.domain][entry.handler], `${name} -> ${entry.handler}`).toBe('function');
    }
  });
});

describe('tool manifest backend mapping', () => {
  it('maps every runtime command to exactly one tool and vice versa', () => {
    const commands = manifestEntries
      .filter(([, entry]) => entry.backend.kind === 'runtime')
      .map(([, entry]) => (entry.backend as { command: string }).command)
      .sort();
    expect(commands).toEqual([...RUNTIME_COMMANDS].sort());
  });

  it('sends the declared runtime command from each game handler', () => {
    for (const [name, entry] of manifestEntries) {
      if (entry.domain !== 'game') continue;
      const body = handlerBodies.game.get(entry.handler);
      expect(body, `${name} handler body`).toBeDefined();
      const sent = runtimeCommandOf(body!);
      if (entry.backend.kind === 'runtime') {
        expect(sent, name).toBe(entry.backend.command);
      } else {
        expect(sent, `${name} declares ${entry.backend.kind} but sends a command`).toBeNull();
      }
    }
  });

  it('maps every headless operation to exactly one tool and vice versa', () => {
    const registry = headlessOperationRegistry();
    const operations = manifestEntries
      .filter(([, entry]) => entry.backend.kind === 'headless')
      .map(([, entry]) => (entry.backend as { operation: string }).operation)
      .sort();
    expect(operations).toEqual([...registry.keys()].sort());
  });

  it('executes the declared headless operation from each project handler', () => {
    for (const [name, entry] of manifestEntries) {
      if (entry.domain !== 'project') continue;
      const body = handlerBodies.project.get(entry.handler);
      expect(body, `${name} handler body`).toBeDefined();
      const executed = headlessOperationOf(body!);
      if (entry.backend.kind === 'headless') {
        expect(executed, name).toBe(entry.backend.operation);
      } else {
        expect(executed, `${name} declares ${entry.backend.kind} but executes an operation`).toBeNull();
      }
    }
  });

  it('registers every runtime command in the GDScript server', () => {
    const registry = runtimeCommandRegistry();
    expect([...registry.keys()].sort()).toEqual([...RUNTIME_COMMANDS].sort());
  });

  it('flags exactly the privileged runtime commands as privileged', () => {
    for (const [name, entry] of manifestEntries) {
      const expectPrivileged = entry.backend.kind === 'runtime'
        && (PRIVILEGED_RUNTIME_COMMANDS as readonly string[]).includes(entry.backend.command);
      expect(entry.privileged, name).toBe(expectPrivileged);
    }
  });
});

describe('tool manifest action declarations', () => {
  const runtimeRegistry = runtimeCommandRegistry();
  const headlessRegistry = headlessOperationRegistry();
  const headlessSource = readRepoFile('src/scripts/godot_operations.gd');

  it('declares actions for every tool that exposes an action parameter', () => {
    for (const tool of toolDefinitions) {
      const entry = toolManifest[tool.name];
      const actionProperty = tool.inputSchema.properties?.action;
      if (!actionProperty) {
        expect(entry.actions, `${tool.name} has no action parameter`).toBeNull();
        expect(entry.actionParamIsData, tool.name).toBeUndefined();
        continue;
      }
      if (entry.actionParamIsData) {
        expect(entry.actions, `${tool.name} treats action as data`).toBeNull();
        continue;
      }
      expect(entry.actions, `${tool.name} exposes an action parameter but declares none`).not.toBeNull();
      expect(entry.actions!.length, tool.name).toBeGreaterThan(0);
      expect(new Set(entry.actions).size, `${tool.name} duplicate actions`).toBe(entry.actions!.length);
    }
  });

  it('matches schema action enums exactly', () => {
    for (const tool of toolDefinitions) {
      const enumValues = tool.inputSchema.properties?.action?.enum;
      if (!enumValues) continue;
      const declared = toolManifest[tool.name].actions ?? [];
      expect([...declared].sort(), tool.name).toEqual([...enumValues].sort());
    }
  });

  it('matches the actions implemented by each runtime command', () => {
    for (const [name, entry] of manifestEntries) {
      if (entry.backend.kind !== 'runtime') continue;
      const registered = runtimeRegistry.get(entry.backend.command)!;
      const body = gdscriptFunctionBody(readRepoFile(registered.file), registered.handler);
      expect(body, `${name} -> ${registered.handler}`).not.toBeNull();
      assertActionsMatch(name, entry, extractGdscriptActions(body!), body!);
    }
  });

  it('matches the actions implemented by each headless operation', () => {
    for (const [name, entry] of manifestEntries) {
      if (entry.backend.kind !== 'headless') continue;
      const implementation = headlessRegistry.get(entry.backend.operation)!;
      const body = gdscriptFunctionBody(headlessSource, implementation);
      expect(body, `${name} -> ${implementation}`).not.toBeNull();
      assertActionsMatch(name, entry, extractGdscriptActions(body!), body!);
    }
  });

  it('matches the actions dispatched by TypeScript-implemented tools', () => {
    for (const [name, entry] of manifestEntries) {
      if (entry.backend.kind === 'runtime' || entry.backend.kind === 'headless') continue;
      if (!entry.actions) continue;
      const body = handlerBodies[entry.domain].get(entry.handler)!;
      assertActionsMatch(name, entry, extractTypescriptActions(body), body, "'");
    }
  });
});

/**
 * Exactly-extracted action lists must equal the declaration; partially
 * extracted lists must be a subset of it, and every declared action must at
 * least appear as a quoted literal in the implementation.
 */
function assertActionsMatch(
  name: string,
  entry: (typeof toolManifest)[ToolName],
  extracted: { confidence: 'exact' | 'partial'; actions: string[] } | null,
  body: string,
  quote = '"',
): void {
  if (entry.actionParamIsData) return;
  if (!entry.actions) {
    expect(extracted, `${name} implements actions but declares none`).toBeNull();
    return;
  }
  const declared = [...entry.actions].sort();
  if (extracted?.confidence === 'exact') {
    expect([...new Set(extracted.actions)].sort(), `${name} action drift`).toEqual(declared);
    return;
  }
  if (extracted) {
    for (const action of extracted.actions) {
      expect(declared, `${name} implements undeclared action "${action}"`).toContain(action);
    }
  }
  for (const action of declared) {
    expect(body.includes(`${quote}${action}${quote}`), `${name} declares unimplemented action "${action}"`).toBe(true);
  }
}
