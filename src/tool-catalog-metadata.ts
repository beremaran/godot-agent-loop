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
    readonly group: 'reflection' | 'code-execution' | 'network';
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
  add_node: ['Add a node to a saved scene.', 'Use game_spawn_node for a temporary runtime-only node.'],
  analyze_project_integrity: ['Audit assets or preview a safe rename.', 'Do not use it to mutate or rename files directly.'],
  attach_script: ['Attach a saved script to a node in a scene.', 'Do not use it for runtime-only script attachment.'],
  create_project: ['Create a new Godot project directory.', 'Do not use it for an existing project.'],
  create_scene: ['Create a persistent scene resource.', 'Use runtime spawning for temporary scene-tree experiments.'],
  create_script: ['Create a persistent GDScript source file.', 'Use write_file when replacing arbitrary existing content.'],
  editor_control: ['Drive an attached editor selection, scene, property, or undo action.', 'Do not use it when no compatible editor is attached.'],
  editor_session: ['Inspect, attach, launch, or disconnect the persistent editor bridge.', 'Do not use it to start the game runtime.'],
  editor_transaction: ['Apply an undoable batch of editor scene mutations.', 'Use focused project tools for simple headless file authoring.'],
  export_project: ['Produce an export artifact from a configured preset.', 'Run readiness checks first when release confidence matters.'],
  game_call_method: ['Invoke a known runtime node method during playtesting.', 'Avoid arbitrary calls when a typed purpose-built tool exists.'],
  game_click: ['Click runtime UI or viewport coordinates.', 'Use key tools for keyboard or InputMap actions.'],
  game_eval: ['Evaluate a bounded diagnostic runtime expression.', 'Do not use it for persistent authoring or untrusted code.'],
  game_get_errors: ['Read bounded new runtime errors.', 'Use get_debug_output for raw process output.'],
  game_get_logs: ['Read bounded new runtime log messages.', 'Use game_get_errors when only failures matter.'],
  game_get_node_info: ['Inspect one runtime node and selected properties.', 'Use scene-tree reads to discover an unknown node path first.'],
  game_get_property: ['Read one known runtime property.', 'Use game_get_node_info for a broader node inspection.'],
  game_get_scene_tree: ['Discover the live runtime scene tree.', 'Use read_scene for saved authored structure.'],
  game_get_ui: ['Inspect concise runtime UI controls and text.', 'Use the full scene tree for non-UI nodes.'],
  game_key_hold: ['Hold one key or InputMap action across frames; in a scenario, use step.arguments and a bounded wait for duration.', 'Do not pass a duration field; use game_key_release after the wait.'],
  game_key_press: ['Tap a key, action, or text once.', 'Use hold/release for continuous movement.'],
  game_key_release: ['Release input previously held by the agent.', 'Do not use it as a one-frame key tap.'],
  game_scenario: ['Run a bounded sequence of safe input, wait, observation, and assertions; put input fields inside each step.arguments object and conditions directly on wait/assert steps.', 'Do not use it to dispatch arbitrary hidden or persistent tools.'],
  game_screenshot: ['Capture visual evidence from the running game.', 'Do not treat a screenshot alone as behavioral verification.'],
  game_wait_until: ['Wait for a bounded runtime condition.', 'Do not replace deterministic immediate reads with polling.'],
  get_debug_output: ['Read bounded runtime stdout and stderr.', 'Use structured logs/errors when their typed data is sufficient.'],
  get_godot_version: ['Inspect the selected Godot executable version.', 'Do not use it as a project compatibility proof.'],
  get_project_info: ['Inspect project metadata and main-scene configuration.', 'Use read_project_settings for individual settings.'],
  godot_call: ['Execute a specifically discovered hidden tool.', 'Use godot_catalog first when the exact tool is unknown.'],
  godot_catalog: ['Search or describe the full tool catalog without mutation.', 'Do not use discovery as permission to execute a result.'],
  launch_editor: ['Open a project in the Godot editor.', 'Use editor_session ensure when a watched attached workflow is required.'],
  list_project_files: ['List bounded project-relative files.', 'Use read_file only after choosing a specific file.'],
  manage_addon: ['Inspect or manage an editor add-on with integrity checks.', 'Do not install untrusted or unhashed add-on sources.'],
  manage_export_presets: ['Inspect or edit persistent export presets.', 'Use verify_export_readiness before release export.'],
  manage_import_pipeline: ['Inspect dependencies, change importer settings, or reimport assets.', 'Do not edit generated .import metadata with generic file writes.'],
  manage_input_map: ['Inspect or persist InputMap actions.', 'Use runtime input tools to exercise an existing action.'],
  manage_resource: ['Read or modify a saved Godot resource.', 'Use runtime resource tools for loaded ephemeral state.'],
  modify_project_settings: ['Change one persistent project setting.', 'Use read_project_settings before changing an unfamiliar key.'],
  modify_scene_node: ['Change properties on a node in a saved scene.', 'Use runtime property tools for temporary playtest changes.'],
  read_file: ['Read one bounded project-relative text file.', 'Use specialized scene/settings readers when structure matters.'],
  read_project_settings: ['Read persistent project settings.', 'Do not use it for live runtime state.'],
  read_scene: ['Inspect bounded authored scene structure.', 'Use game_get_scene_tree for the live instantiated tree.'],
  remove_scene_node: ['Remove a node from a saved scene.', 'Use runtime removal for a temporary instantiated node.'],
  run_project: ['Start the game and wait for the runtime bridge.', 'Do not launch a duplicate runtime when one is already connected.'],
  run_project_tests: ['Discover or run project test suites.', 'Use verify_project for broader static and configuration checks.'],
  save_scene: ['Persist an authored scene resource.', 'Do not use it as proof the running game reloaded the change.'],
  set_main_scene: ['Set the project main scene persistently.', 'Do not use it to change only the current runtime scene.'],
  stop_project: ['Safely stop the connected game runtime.', 'Do not disconnect the editor when only the game should stop.'],
  validate_script: ['Validate one GDScript file.', 'Use validate_scripts for a bounded project batch.'],
  validate_scripts: ['Validate changed, all, or explicit GDScript files.', 'Use validate_script for a single known path.'],
  verify_dotnet_project: ['Inspect, restore, build, or run the project .NET workflow.', 'Do not use it for a GDScript-only project.'],
  verify_export_readiness: ['Inspect or smoke-test an export preset.', 'Do not substitute it for testing the exported artifact.'],
  verify_project: ['Run bounded project-wide static verification.', 'Use runtime observations for gameplay behavior.'],
  write_file: ['Create or replace a bounded project-relative text file.', 'Prefer structured scene, setting, and resource tools when available.'],
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
  game_light_2d: {
    aliases: ['add 2d lighting', 'change 2d lighting', 'create 2d light'],
    tags: ['lighting', 'illumination', '2d'],
    concepts: ['Light2D', 'PointLight2D', 'DirectionalLight2D'],
  },
  game_light_3d: {
    aliases: ['add 3d lighting', 'change 3d lighting', 'create 3d light'],
    tags: ['lighting', 'illumination', '3d'],
    concepts: ['Light3D', 'OmniLight3D', 'SpotLight3D', 'DirectionalLight3D'],
  },
  game_audio_play: {
    aliases: ['play audio', 'play a sound', 'control audio playback'],
    tags: ['audio', 'sound', 'playback'],
    concepts: ['AudioStreamPlayer', 'AudioStreamPlayer2D', 'AudioStreamPlayer3D'],
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
  game_terrain: {
    aliases: ['create terrain', 'make a heightmap terrain', 'paint terrain'],
    tags: ['terrain', 'heightmap', 'mesh', 'paint'],
    concepts: ['ArrayMesh', 'HeightMapShape3D'],
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
  create_scene: {
    aliases: ['create a persistent scene', 'create saved scene', 'author a scene'],
    tags: ['persistent', 'authoring', 'saved', 'scene', 'project'],
    concepts: ['PackedScene'],
  },
  add_node: {
    aliases: ['add a persistent node', 'author node in saved scene'],
    tags: ['persistent', 'authoring', 'saved', 'node', 'scene'],
    concepts: ['Node', 'PackedScene'],
  },
  game_spawn_node: {
    aliases: ['spawn a runtime-only node', 'create temporary node', 'runtime node spawn'],
    tags: ['runtime', 'ephemeral', 'temporary', 'spawn', 'node'],
    concepts: ['Node', 'SceneTree'],
  },
};

const EXTERNAL_TOOLS = new Set<ToolName>([
  'game_http_request', 'game_websocket', 'game_multiplayer', 'game_rpc',
]);
const EDITOR_TOOLS = new Set<ToolName>(['editor_control', 'editor_transaction']);
const RUNTIME_STATE_TOOLS = new Set<ToolName>(['get_debug_output', 'stop_project']);
const NO_STATE_TOOLS = new Set<ToolName>(['godot_catalog', 'godot_call', 'godot_tools', 'get_godot_version', 'list_projects']);
const POTENTIALLY_DESTRUCTIVE_TOOLS = new Set<ToolName>([
  'godot_call', 'godot_tools', 'editor_control', 'editor_transaction', 'write_file',
  'delete_file', 'rename_file', 'remove_scene_node', 'manage_addon', 'manage_autoloads',
  'manage_input_map', 'manage_export_presets', 'manage_plugins', 'manage_scene_structure',
  'manage_scene_signals', 'manage_translations', 'game_remove_node', 'game_change_scene',
]);

const PREFERRED_ALTERNATIVES: Partial<Record<ToolName, readonly ToolName[]>> = {
  add_node: ['game_spawn_node'],
  create_scene: ['game_spawn_node'],
  game_spawn_node: ['add_node', 'create_scene'],
  modify_scene_node: ['game_set_property'],
  game_set_property: ['modify_scene_node'],
  read_scene: ['game_get_scene_tree'],
  game_get_scene_tree: ['read_scene'],
  game_key_press: ['game_key_hold', 'game_key_release'],
  game_key_hold: ['game_key_press', 'game_key_release'],
  game_key_release: ['game_key_press', 'game_key_hold'],
  get_debug_output: ['game_get_logs', 'game_get_errors'],
  game_get_logs: ['game_get_errors', 'get_debug_output'],
  game_get_errors: ['game_get_logs', 'get_debug_output'],
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
  if (name === 'godot_call' || name === 'godot_tools') return 'external-open-world';
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
