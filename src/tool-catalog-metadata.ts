import {
  toolDefinitions,
  type ToolName,
  type ToolSchemaInvalidExample,
} from './tool-definitions.js';
import { toolManifest, type ToolBackend } from './tool-manifest.js';
import { isToolCallMutating } from './tool-mutation-policy.js';

export type ToolEffectScope =
  | 'read-only'
  | 'project-persistent'
  | 'runtime-ephemeral'
  | 'process'
  | 'external-open-world';
export type ToolRequiredState = 'none' | 'project' | 'editor' | 'runtime';
export type ToolMutation = 'read-only' | 'mutating' | 'mixed';
export type ToolPrivilege = 'none' | 'required';

export interface ToolCatalogMetadata {
  readonly title: string;
  readonly summary: string;
  readonly purpose: string;
  readonly aliases: readonly string[];
  readonly intentTags: readonly string[];
  readonly concepts: readonly string[];
  readonly whenToUse: string;
  readonly whenNotToUse: string;
  readonly effectScope: ToolEffectScope;
  readonly requiredState: ToolRequiredState;
  readonly mutation: ToolMutation;
  readonly privilege: ToolPrivilege;
  readonly conditionalPrivileges: readonly {
    readonly selector: string;
    readonly group: 'reflection' | 'code-execution';
  }[];
  readonly destructive: boolean;
  readonly idempotent: boolean;
  readonly actionRequirements: Readonly<Record<string, {
    readonly required: readonly string[];
    readonly forbidden: readonly string[];
  }>>;
  readonly positiveExamples: readonly unknown[];
  readonly invalidExamples: readonly ToolSchemaInvalidExample[];
  readonly outputSummary: string;
  readonly warnings: readonly string[];
  readonly fallbacks: readonly string[];
  readonly remediation: string;
  readonly preferredAlternatives: readonly ToolName[];
  readonly relatedTools: readonly ToolName[];
}

interface CuratedGuidance {
  aliases?: readonly string[];
  tags?: readonly string[];
  concepts?: readonly string[];
  whenToUse?: string;
  whenNotToUse?: string;
  outputSummary?: string;
  warnings?: readonly string[];
  fallbacks?: readonly string[];
  remediation?: string;
  preferredAlternatives?: readonly ToolName[];
  relatedTools?: readonly ToolName[];
  conditionalPrivileges?: ToolCatalogMetadata['conditionalPrivileges'];
}

type WorkflowGuidance = readonly [whenToUse: string, whenNotToUse: string];

/** Explicitly reviewed guidance for every compact or shipped-skill tool. */
const REVIEWED_WORKFLOW_GUIDANCE: Partial<Record<ToolName, WorkflowGuidance>> = {
  analyze_project_integrity: ['Audit assets or preview a safe rename.', 'Do not use it to mutate or rename files directly.'],
  editor_control: ['Inspect editor state, select nodes, open scenes, and undo/redo through the attached editor bridge.', 'Do not use it for scene mutation; route persistent edits through editor_transaction.'],
  editor_session: ['Inspect, attach, launch, or disconnect the persistent editor bridge.', 'Do not use it to start the game runtime.'],
  editor_transaction: ['Apply an undoable batch of editor scene mutations.', 'Do not use it when no attached editor is available.'],
  game_call_method: ['Invoke a known runtime node method during playtesting.', 'Avoid arbitrary calls when a typed purpose-built tool exists.'],
  game_click: ['Click runtime UI or viewport coordinates.', 'Use key tools for keyboard or InputMap actions.'],
  game_eval: ['Evaluate a bounded diagnostic runtime expression.', 'Do not use it for persistent authoring or untrusted code.'],
  game_get_errors: ['Read bounded new runtime errors.', 'Use game_get_logs for raw process output.'],
  game_get_logs: ['Read bounded new runtime log messages.', 'Use game_get_errors when only failures matter; use a fresh log condition for a transition wait.'],
  game_get_node_info: ['Inspect one runtime node, its properties, and signal connections.', 'Use scene-tree reads to discover an unknown node path first.'],
  game_get_property: ['Read one known runtime property.', 'Use game_get_node_info for a broader node inspection.'],
  game_get_scene_tree: ['Discover the live runtime scene tree.', 'Inspect a single node with game_get_node_info once its path is known.'],
  game_get_ui: ['Inspect concise runtime UI controls and text.', 'Use the full scene tree for non-UI nodes.'],
  game_key_hold: ['Hold one key or InputMap action across frames; in a scenario, use step.arguments and a short engine-side wait or observation.', 'Do not pass a duration field or rely on a long hold to steer through a grid route; use game_key_release after the wait.'],
  game_key_press: ['Tap a key, action, or text once.', 'Use hold/release for continuous movement.'],
  game_key_release: ['Release input previously held by the agent.', 'Do not use it as a one-frame key tap.'],
  game_pause: ['Pause or resume the running game tree to freeze gameplay while inspecting state.', 'Resume with paused=false before ending the session; do not use it for persistent project state.'],
  game_scenario: ['Run a bounded sequence of safe input, wait, observation, and assertions; put input fields inside each step.arguments object and conditions directly on wait/assert steps.', 'Do not use it to dispatch arbitrary hidden or persistent tools; set fresh=true on log conditions that must prove a new event.'],
  game_screenshot: ['Capture visual evidence from the running game.', 'Do not treat a screenshot alone as behavioral verification.'],
  game_wait_until: ['Wait for a bounded runtime condition; set fresh=true on a log condition when it must match output emitted after the wait starts.', 'Do not replace deterministic immediate reads with polling or use an old log line as transition proof.'],
  godot_call: ['Execute a specifically discovered hidden tool.', 'Use godot_catalog first when the exact tool is unknown.'],
  godot_catalog: ['Search or describe the full tool catalog without mutation.', 'Do not use discovery as permission to execute a result.'],
  manage_addon: ['Inspect or manage an editor add-on with integrity checks.', 'Do not install untrusted or unhashed add-on sources.'],
  manage_import_pipeline: ['Inspect dependencies, change importer settings, or reimport assets.', 'Do not edit generated .import metadata with generic file writes.'],
  run_project: ['Start the game and wait for the runtime bridge.', 'Do not launch a duplicate runtime when one is already connected.'],
  run_project_tests: ['Discover or run project test suites. action=discover accepts framework and testPaths; action=run also accepts artifactPaths, timeoutSeconds, and failFast.', 'Do not pass run-only fields to action=discover; use verify_project for broader static and configuration checks.'],
  stop_project: ['Safely stop the connected game runtime with no arguments; it is process-global.', 'Do not pass projectPath or disconnect the editor when only the game should stop.'],
  verify_dotnet_project: ['Inspect, restore, build, or run the project .NET workflow.', 'Do not use it for a GDScript-only project.'],
  verify_export_readiness: ['Inspect or smoke-test an export preset.', 'Do not substitute it for testing the exported artifact.'],
  verify_project: ['Run bounded project-wide static verification.', 'Use runtime observations for gameplay behavior.'],
};

/** High-value user language that cannot be inferred reliably from tool names. */
const CURATED_GUIDANCE: Partial<Record<ToolName, CuratedGuidance>> = {
  godot_catalog: {
    aliases: ['search tools', 'inspect tool catalog', 'describe hidden tool'],
    tags: ['catalog', 'discovery', 'search', 'describe', 'read-only'],
    concepts: ['MCP tool catalog'],
  },
  godot_call: {
    aliases: ['call hidden tool', 'execute discovered tool'],
    tags: ['dispatch', 'execute', 'hidden tool'],
    concepts: ['MCP tool call'],
  },
  game_key_hold: {
    aliases: ['hold input while moving', 'hold key', 'press and hold', 'continuous movement'],
    tags: ['input', 'held', 'movement', 'continuous'],
    concepts: ['Input action', 'InputEventKey'],
  },
  game_key_press: {
    aliases: ['tap a key once', 'tap key once', 'one-frame key tap', 'type text'],
    tags: ['input', 'tap', 'single frame', 'keyboard'],
    concepts: ['Input action', 'InputEventKey'],
  },
  game_key_release: {
    aliases: ['release held input', 'release held key', 'stop continuous movement'],
    tags: ['input', 'release', 'cleanup', 'held'],
    concepts: ['Input action', 'InputEventKey'],
  },
  game_get_audio: {
    aliases: ['inspect audio state', 'check audio playback status', 'audio player state'],
    tags: ['audio', 'sound', 'inspect', 'status'],
    concepts: ['AudioStreamPlayer'],
  },
  verify_export_readiness: {
    aliases: ['export game readiness', 'inspect export readiness', 'release export check'],
    tags: ['export', 'release', 'readiness', 'templates', 'artifact'],
    concepts: ['EditorExportPreset'],
  },
  analyze_project_integrity: {
    aliases: ['rename an asset safely', 'safe asset rename preview', 'inspect project integrity'],
    tags: ['integrity', 'dependencies', 'rename', 'asset', 'safe'],
    concepts: ['ResourceUID', 'project integrity'],
  },
  manage_import_pipeline: {
    aliases: ['inspect resource dependencies', 'inspect imports', 'import pipeline', 'asset dependencies'],
    tags: ['import', 'dependency', 'asset', 'reimport'],
    concepts: ['EditorImportPlugin', 'ResourceLoader'],
  },
  game_wait_until: {
    aliases: ['wait until a label changes', 'wait until a property changes', 'bounded condition wait'],
    tags: ['wait', 'condition', 'label', 'property', 'signal', 'bounded'],
    concepts: ['Signal', 'Node property'],
    warnings: ['The property condition requires the reflection privilege group and fails before polling when it is disabled.'],
    fallbacks: ['Use a log condition for an emitted state marker, or use game_get_ui for bounded control text without reflection.'],
    remediation: 'Enable reflection with GODOT_MCP_PRIVILEGED_GROUPS=reflection and restart the runtime, or choose a log/UI fallback.',
    conditionalPrivileges: [{ selector: 'condition=property', group: 'reflection' }],
  },
  game_scenario: {
    warnings: ['Property wait and assert steps require the reflection privilege group and fail before polling when it is disabled.'],
    fallbacks: ['Use a log condition step for an emitted state marker, or observe with game_get_ui without reflection.'],
    remediation: 'Enable reflection with GODOT_MCP_PRIVILEGED_GROUPS=reflection and restart the runtime, or choose a log/UI fallback.',
    conditionalPrivileges: [{ selector: 'steps[].condition.condition=property', group: 'reflection' }],
  },
  game_visual_regression: {
    aliases: ['compare a screenshot', 'screenshot comparison', 'visual regression'],
    tags: ['screenshot', 'compare', 'image', 'diff', 'baseline'],
    concepts: ['Viewport texture', 'PNG'],
  },
  manage_addon: {
    aliases: ['inspect addons', 'inspect editor plugins', 'manage addon'],
    tags: ['addon', 'plugin', 'editor', 'install'],
    concepts: ['EditorPlugin', 'plugin.cfg'],
  },
  verify_dotnet_project: {
    aliases: ['inspect dotnet status', 'check c sharp build', '.net project status'],
    tags: ['dotnet', 'csharp', 'c#', 'build', 'sdk'],
    concepts: ['Godot.NET.Sdk', 'CSharpScript'],
  },
  game_spawn_node: {
    aliases: ['spawn a runtime-only node', 'create temporary node', 'runtime node spawn'],
    tags: ['runtime', 'ephemeral', 'temporary', 'spawn', 'node'],
    concepts: ['Node', 'SceneTree'],
  },
};

const EXTERNAL_TOOLS = new Set<ToolName>([]);
const EDITOR_TOOLS = new Set<ToolName>(['editor_control', 'editor_transaction']);
const RUNTIME_STATE_TOOLS = new Set<ToolName>(['stop_project']);
const NO_STATE_TOOLS = new Set<ToolName>(['godot_catalog', 'godot_call']);
const POTENTIALLY_DESTRUCTIVE_TOOLS = new Set<ToolName>([
  'godot_call', 'editor_transaction', 'manage_addon',
  'game_remove_node', 'game_change_scene',
]);

const PREFERRED_ALTERNATIVES: Partial<Record<ToolName, readonly ToolName[]>> = {
  game_key_press: ['game_key_hold', 'game_key_release'],
  game_key_hold: ['game_key_press', 'game_key_release'],
  game_key_release: ['game_key_press', 'game_key_hold'],
  game_get_logs: ['game_get_errors'],
  game_get_errors: ['game_get_logs'],
};

export const reviewedToolGuidanceNames: ReadonlySet<ToolName> = new Set(
  Object.keys(REVIEWED_WORKFLOW_GUIDANCE) as ToolName[],
);

function humanTitle(name: string): string {
  return name.split('_').map(token => token.length <= 3 && /^(?:ui|os|rpc|http|gi|ci)$/.test(token)
    ? token.toUpperCase()
    : `${token.charAt(0).toUpperCase()}${token.slice(1)}`).join(' ');
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function mutationFor(name: ToolName): ToolMutation {
  const manifest = toolManifest[name];
  if (manifest.actions && !manifest.actionParamIsData) {
    const mutations = manifest.actions.map(action => isToolCallMutating(name, { action }));
    if (mutations.every(Boolean)) return 'mutating';
    if (mutations.every(value => !value)) return 'read-only';
    return 'mixed';
  }
  return isToolCallMutating(name, {}) ? 'mutating' : 'read-only';
}

function effectScopeFor(name: ToolName, backend: ToolBackend, mutation: ToolMutation): ToolEffectScope {
  if (name === 'godot_catalog') return 'read-only';
  if (name === 'godot_call') return 'external-open-world';
  if (EXTERNAL_TOOLS.has(name)) return 'external-open-world';
  if (mutation === 'read-only') return 'read-only';
  if (backend.kind === 'runtime' || backend.kind === 'runtime-buffer') return 'runtime-ephemeral';
  if (backend.kind === 'process' || backend.kind === 'godot-cli') return 'process';
  if (toolManifest[name].domain === 'project') return 'project-persistent';
  return 'process';
}

function requiredStateFor(name: ToolName, backend: ToolBackend): ToolRequiredState {
  if (NO_STATE_TOOLS.has(name)) return 'none';
  if (EDITOR_TOOLS.has(name)) return 'editor';
  if (RUNTIME_STATE_TOOLS.has(name) || backend.kind === 'runtime' || backend.kind === 'runtime-buffer') {
    return 'runtime';
  }
  return 'project';
}

function actionRequirementsFor(name: ToolName): ToolCatalogMetadata['actionRequirements'] {
  const definition = toolDefinitions.find(candidate => candidate.name === name)!;
  const actions = toolManifest[name].actions ?? [];
  return Object.fromEntries(actions.map(action => {
    const branch = definition.inputSchema.oneOf?.find(candidate => candidate.properties?.action?.const === action);
    const required = unique((branch?.required ?? []).filter(field => field !== 'action'));
    const forbidden = Object.entries(branch?.properties ?? {})
      .filter(([field, property]) => field !== 'action' && property.not !== undefined
        && Object.keys(property.not).length === 0)
      .map(([field]) => field);
    return [action, { required, forbidden }];
  }));
}

function relatedToolsFor(name: ToolName): ToolName[] {
  const manifest = toolManifest[name];
  const stem = name.split('_').slice(0, 2).join('_');
  return toolDefinitions
    .map(definition => definition.name)
    .filter(candidate => candidate !== name
      && (candidate.startsWith(`${stem}_`) || toolManifest[candidate].domain === manifest.domain))
    .slice(0, 6);
}

function metadataFor(name: ToolName): ToolCatalogMetadata {
  const definition = toolDefinitions.find(candidate => candidate.name === name)!;
  const manifest = toolManifest[name];
  const curated = CURATED_GUIDANCE[name] ?? {};
  const reviewed = REVIEWED_WORKFLOW_GUIDANCE[name];
  const nameWords = name.split('_');
  const actions = manifest.actions ?? [];
  const mutation = mutationFor(name);
  return {
    title: definition.title ?? humanTitle(name),
    summary: definition.description,
    purpose: `${definition.description}. Use it for ${nameWords.join(' ')} workflows.`,
    aliases: unique([nameWords.join(' '), ...(curated.aliases ?? [])]),
    intentTags: unique([manifest.domain, manifest.backend.kind, ...nameWords, ...actions, ...(curated.tags ?? [])]),
    concepts: unique([humanTitle(name), ...nameWords, ...actions, ...(curated.concepts ?? [])]),
    whenToUse: curated.whenToUse ?? reviewed?.[0]
      ?? `Use when the task specifically requires ${nameWords.join(' ')} in the ${manifest.domain} domain.`,
    whenNotToUse: curated.whenNotToUse ?? reviewed?.[1]
      ?? `Do not use when a narrower read-only tool or a different ${manifest.domain} workflow matches the task.`,
    effectScope: effectScopeFor(name, manifest.backend, mutation),
    requiredState: requiredStateFor(name, manifest.backend),
    mutation,
    privilege: manifest.privileged ? 'required' : 'none',
    conditionalPrivileges: curated.conditionalPrivileges ?? [],
    destructive: POTENTIALLY_DESTRUCTIVE_TOOLS.has(name),
    idempotent: mutation === 'read-only',
    actionRequirements: actionRequirementsFor(name),
    positiveExamples: definition.inputSchema.examples ?? [],
    invalidExamples: definition.inputSchema['x-invalidExamples'] ?? [],
    outputSummary: curated.outputSummary
      ?? `Returns the common structured result envelope with ${nameWords.join(' ')} data on success.`,
    warnings: curated.warnings
      ?? (mutation === 'read-only' ? [] : [`May cause ${effectScopeFor(name, manifest.backend, mutation)} effects.`]),
    fallbacks: curated.fallbacks ?? [],
    remediation: curated.remediation
      ?? `Correct the reported field or precondition, inspect ${name} details, and retry only when the error is retryable.`,
    preferredAlternatives: curated.preferredAlternatives ?? PREFERRED_ALTERNATIVES[name] ?? [],
    relatedTools: curated.relatedTools ?? relatedToolsFor(name),
  };
}

export const toolCatalogMetadata: Record<ToolName, ToolCatalogMetadata> = Object.fromEntries(
  toolDefinitions.map(definition => [definition.name, metadataFor(definition.name)]),
) as Record<ToolName, ToolCatalogMetadata>;
