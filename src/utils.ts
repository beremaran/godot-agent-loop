/**
 * Shared utilities for the Godot MCP server.
 * Pure functions extracted for testability.
 */

export interface OperationParams {
  [key: string]: any;
}

export const PARAMETER_MAPPINGS: Record<string, string> = {
  'project_path': 'projectPath',
  'scene_path': 'scenePath',
  'root_node_type': 'rootNodeType',
  'parent_node_path': 'parentNodePath',
  'node_type': 'nodeType',
  'node_name': 'nodeName',
  'texture_path': 'texturePath',
  'node_path': 'nodePath',
  'output_path': 'outputPath',
  'mesh_item_names': 'meshItemNames',
  'new_path': 'newPath',
  'file_path': 'filePath',
  'directory': 'directory',
  'recursive': 'recursive',
  'scene': 'scene',
  'type_hint': 'typeHint',
  'parent_path': 'parentPath',
  'signal_name': 'signalName',
  'target_path': 'targetPath',
  'class_name': 'className',
  'root_path': 'rootPath',
  'new_parent_path': 'newParentPath',
  'keep_global_transform': 'keepGlobalTransform',
  'script_path': 'scriptPath',
  'resource_type': 'resourceType',
  'resource_path': 'resourcePath',
  'final_value': 'finalValue',
  'trans_type': 'transType',
  'ease_type': 'easeType',
  'directory_path': 'directoryPath',
  'from_x': 'fromX',
  'from_y': 'fromY',
  'to_x': 'toX',
  'to_y': 'toY',
  'project_name': 'projectName',
  'action_name': 'actionName',
  'param_name': 'paramName',
  'shape_type': 'shapeType',
  'shape_params': 'shapeParams',
  'bus_name': 'busName',
  'from_position': 'fromPosition',
  'collision_layer': 'collisionLayer',
  'collision_mask': 'collisionMask',
  'source_id': 'sourceId',
  'atlas_x': 'atlasX',
  'atlas_y': 'atlasY',
  'alt_tile': 'altTile',
  'background_mode': 'backgroundMode',
  'background_color': 'backgroundColor',
  'ambient_light_color': 'ambientLightColor',
  'ambient_light_energy': 'ambientLightEnergy',
  'fog_enabled': 'fogEnabled',
  'fog_density': 'fogDensity',
  'fog_light_color': 'fogLightColor',
  'glow_enabled': 'glowEnabled',
  'glow_intensity': 'glowIntensity',
  'glow_bloom': 'glowBloom',
  'tonemap_mode': 'tonemapMode',
  'ssao_enabled': 'ssaoEnabled',
  'ssao_radius': 'ssaoRadius',
  'ssao_intensity': 'ssaoIntensity',
  'ssr_enabled': 'ssrEnabled',
  'wait_time': 'waitTime',
  'one_shot': 'oneShot',
  'speed_scale': 'speedScale',
  'process_material': 'processMaterial',
  'initial_velocity_min': 'initialVelocityMin',
  'initial_velocity_max': 'initialVelocityMax',
  'scale_min': 'scaleMin',
  'scale_max': 'scaleMax',
  'animation_name': 'animationName',
  'loop_mode': 'loopMode',
  'max_depth': 'maxDepth',
  'gravity_scale': 'gravityScale',
  'linear_velocity': 'linearVelocity',
  'angular_velocity': 'angularVelocity',
  'linear_damp': 'linearDamp',
  'angular_damp': 'angularDamp',
  'joint_type': 'jointType',
  'node_a_path': 'nodeAPath',
  'node_b_path': 'nodeBPath',
  'rest_length': 'restLength',
  'initial_offset': 'initialOffset',
  'bone_index': 'boneIndex',
  'bone_name': 'boneName',
  'font_sizes': 'fontSizes',
  'transparent_bg': 'transparentBg',
  'render_target_update_mode': 'renderTargetUpdateMode',
  'preset_name': 'presetName',
  // Batch 1-5 new parameter mappings
  'max_clients': 'maxClients',
  'mouse_mode': 'mouseMode',
  'time_scale': 'timeScale',
  'gravity_direction': 'gravityDirection',
  'physics_fps': 'physicsFps',
  'csg_type': 'csgType',
  'mesh_type': 'meshType',
  'light_type': 'lightType',
  'spot_angle': 'spotAngle',
  'effect_type': 'effectType',
  'gi_type': 'giType',
  'sky_type': 'skyType',
  'top_color': 'topColor',
  'bottom_color': 'bottomColor',
  'sun_energy': 'sunEnergy',
  'ground_color': 'groundColor',
  'dof_blur_far': 'dofBlurFar',
  'dof_blur_near': 'dofBlurNear',
  'dof_blur_amount': 'dofBlurAmount',
  'exposure_multiplier': 'exposureMultiplier',
  'auto_exposure': 'autoExposure',
  'auto_exposure_scale': 'autoExposureScale',
  'cell_size': 'cellSize',
  'agent_radius': 'agentRadius',
  'agent_height': 'agentHeight',
  'motion_scale': 'motionScale',
  'motion_offset': 'motionOffset',
  'state_name': 'stateName',
  'param_value': 'paramValue',
  'send_to': 'sendTo',
  'max_distance': 'maxDistance',
  'unit_size': 'unitSize',
  'max_db': 'maxDb',
  'attenuation_model': 'attenuationModel',
  'layer_type': 'layerType',
  'plugin_name': 'pluginName',
  'shader_path': 'shaderPath',
  'shader_type': 'shaderType',
  'translation_path': 'translationPath',
  'anchor_preset': 'anchorPreset',
  'mouse_filter': 'mouseFilter',
  'min_size': 'minSize',
  'caret_position': 'caretPosition',
  'selection_from': 'selectionFrom',
  'selection_to': 'selectionTo',
  'item_path': 'itemPath',
  'min_value': 'minValue',
  'max_value': 'maxValue',
  'msaa_2d': 'msaa2d',
  'msaa_3d': 'msaa3d',
  'scaling_mode': 'scalingMode',
  'scaling_scale': 'scalingScale',
  'source_path': 'sourcePath',
  'new_name': 'newName',
};

export const REVERSE_PARAMETER_MAPPINGS: Record<string, string> = Object.fromEntries(
  Object.entries(PARAMETER_MAPPINGS).map(([snake, camel]) => [camel, snake])
);

export function normalizeParameters(params: OperationParams): OperationParams {
  if (!params || typeof params !== 'object') {
    return params;
  }

  const result: OperationParams = {};

  for (const key in params) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      let normalizedKey = key;

      if (key.includes('_') && PARAMETER_MAPPINGS[key]) {
        normalizedKey = PARAMETER_MAPPINGS[key];
      }

      if (typeof params[key] === 'object' && params[key] !== null && !Array.isArray(params[key])) {
        result[normalizedKey] = normalizeParameters(params[key] as OperationParams);
      } else {
        result[normalizedKey] = params[key];
      }
    }
  }

  return result;
}

export function convertCamelToSnakeCase(params: OperationParams): OperationParams {
  const result: OperationParams = {};

  for (const key in params) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      const snakeKey = REVERSE_PARAMETER_MAPPINGS[key] || key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);

      if (typeof params[key] === 'object' && params[key] !== null && !Array.isArray(params[key])) {
        result[snakeKey] = convertCamelToSnakeCase(params[key] as OperationParams);
      } else {
        result[snakeKey] = params[key];
      }
    }
  }

  return result;
}

export function validatePath(path: string): boolean {
  if (!path || path.includes('..')) {
    return false;
  }
  return true;
}

export function createErrorResponse(message: string): any {
  console.error(`[SERVER] Error response: ${message}`);

  return {
    content: [
      {
        type: 'text',
        text: message,
      },
    ],
    isError: true,
  };
}

export function isGodot44OrLater(version: string): boolean {
  const match = version.match(/^(\d+)\.(\d+)/);
  if (match) {
    const major = parseInt(match[1], 10);
    const minor = parseInt(match[2], 10);
    return major > 4 || (major === 4 && minor >= 4);
  }
  return false;
}

export interface ScriptDiagnostic {
  message: string;
  file?: string;
  line?: number;
}

export function parseGodotScriptDiagnostics(output: string): ScriptDiagnostic[] {
  const lines = (output || '').split(/\r?\n/);
  const diagnostics: ScriptDiagnostic[] = [];
  const locRe = /\((res:\/\/.+):(\d+)\)/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/SCRIPT ERROR:\s*(.+?)\s*$/);
    if (!m) continue;
    const message = m[1].replace(/^Parse Error:\s*/, '');
    let file: string | undefined;
    let line: number | undefined;
    for (const j of [i + 1, i]) {
      if (j >= lines.length) continue;
      const loc = lines[j].match(locRe);
      if (loc) {
        file = loc[1];
        line = parseInt(loc[2], 10);
        break;
      }
    }
    diagnostics.push({ message, ...(file ? { file } : {}), ...(line !== undefined ? { line } : {}) });
  }
  return diagnostics;
}

export const DEFAULT_GODOT_NET_SDK_VERSION = '4.4.0';
export const DEFAULT_DOTNET_TARGET_FRAMEWORK = 'net8.0';

export function toDotnetIdentifier(name: string): string {
  const cleaned = (name || '').replace(/[^A-Za-z0-9_]/g, '_');
  if (cleaned.length === 0) return 'Game';
  return /^[0-9]/.test(cleaned) ? '_' + cleaned : cleaned;
}

export function toDotnetNamespace(name: string): string {
  return (name || '')
    .split('.')
    .map(seg => toDotnetIdentifier(seg))
    .join('.');
}

export function isValidCsharpIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

export function generateGodotProjectFeatures(isDotnet: boolean, version: string = '4.4'): string {
  return isDotnet
    ? `PackedStringArray("${version}", "C#")`
    : `PackedStringArray("${version}")`;
}

export function generateCsprojContent(
  projectName: string,
  sdkVersion: string = DEFAULT_GODOT_NET_SDK_VERSION,
  targetFramework: string = DEFAULT_DOTNET_TARGET_FRAMEWORK
): string {
  const rootNamespace = toDotnetIdentifier(projectName);
  return `<Project Sdk="Godot.NET.Sdk/${sdkVersion}">
  <PropertyGroup>
    <TargetFramework>${targetFramework}</TargetFramework>
    <EnableDynamicLoading>true</EnableDynamicLoading>
    <Nullable>enable</Nullable>
    <RootNamespace>${rootNamespace}</RootNamespace>
  </PropertyGroup>
</Project>
`;
}

export interface CsharpScriptOptions {
  className: string;
  baseClass?: string;
  namespaceName?: string;
  methods?: string[];
}

const CSHARP_GODOT_OVERRIDES: Record<string, string> = {
  _Ready: 'public override void _Ready()',
  _Process: 'public override void _Process(double delta)',
  _PhysicsProcess: 'public override void _PhysicsProcess(double delta)',
  _Input: 'public override void _Input(InputEvent @event)',
  _UnhandledInput: 'public override void _UnhandledInput(InputEvent @event)',
  _EnterTree: 'public override void _EnterTree()',
  _ExitTree: 'public override void _ExitTree()',
};

export function generateCsharpScriptSource(opts: CsharpScriptOptions): string {
  const className = toDotnetIdentifier(opts.className);
  const baseClass = (opts.baseClass && opts.baseClass.trim()) || 'Node';
  const indent = opts.namespaceName ? '\t\t' : '\t';
  const bodyIndent = indent + '\t';

  const methodBlocks: string[] = [];
  const seenMethods = new Set<string>();
  for (const raw of opts.methods || []) {
    const name = String(raw).trim();
    if (!name || seenMethods.has(name)) continue;
    seenMethods.add(name);
    const signature = CSHARP_GODOT_OVERRIDES[name] || `public void ${toDotnetIdentifier(name)}()`;
    methodBlocks.push(`${indent}${signature}\n${indent}{\n${bodyIndent}\n${indent}}`);
  }
  const body = methodBlocks.length > 0 ? methodBlocks.join('\n\n') : `${indent}`;

  const classIndent = opts.namespaceName ? '\t' : '';
  const classBlock =
    `${classIndent}public partial class ${className} : ${baseClass}\n` +
    `${classIndent}{\n` +
    `${body}\n` +
    `${classIndent}}`;

  const lines = ['using Godot;', ''];
  if (opts.namespaceName) {
    lines.push(`namespace ${toDotnetNamespace(opts.namespaceName)};`, '');
  }
  lines.push(classBlock, '');
  return lines.join('\n');
}
