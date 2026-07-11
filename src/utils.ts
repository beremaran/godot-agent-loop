/**
 * Shared utilities for the Godot MCP server.
 * Pure functions extracted for testability.
 */

export type OperationParams = Record<string, any>;

export const PARAMETER_MAPPINGS: Record<string, string> = {
  'msaa_2d': 'msaa2d',
  'msaa_3d': 'msaa3d',
  // Runtime mouse handlers historically consume these wire names directly.
  'relative_x': 'relative_x',
  'relative_y': 'relative_y',
};

const OPAQUE_PARAMETER_OBJECTS = new Set(['properties', 'shapeParams', 'overrides']);

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
      const normalizedKey = PARAMETER_MAPPINGS[key] || key.replace(/_([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());
      const value = params[key];
      result[normalizedKey] = OPAQUE_PARAMETER_OBJECTS.has(normalizedKey) ? value : Array.isArray(value)
        ? value.map(item => item && typeof item === 'object' ? normalizeParameters(item) : item)
        : value && typeof value === 'object' ? normalizeParameters(value) : value;
    }
  }

  return result;
}

export function convertCamelToSnakeCase(params: OperationParams): OperationParams {
  const result: OperationParams = {};

  for (const key in params) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      const snakeKey = REVERSE_PARAMETER_MAPPINGS[key] || key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);

      const value = params[key];
      result[snakeKey] = Array.isArray(value)
        ? value.map(item => item && typeof item === 'object' ? convertCamelToSnakeCase(item) : item)
        : value && typeof value === 'object' ? convertCamelToSnakeCase(value) : value;
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
  const match = /^(\d+)\.(\d+)/.exec(version);
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
    const m = /SCRIPT ERROR:\s*(.+?)\s*$/.exec(lines[i]);
    if (!m) continue;
    const message = m[1].replace(/^Parse Error:\s*/, '');
    let file: string | undefined;
    let line: number | undefined;
    for (const j of [i + 1, i]) {
      if (j >= lines.length) continue;
      const loc = locRe.exec(lines[j]);
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

export function collectGdPaths(outputs: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const out of outputs) {
    for (const rawLine of (out || '').split(/\r?\n/)) {
      const filePath = rawLine.trim().replace(/\\/g, '/');
      if (!/\.gd$/i.test(filePath)) continue;
      if (!seen.has(filePath)) {
        seen.add(filePath);
        result.push(filePath);
      }
    }
  }
  return result;
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

export function generateGodotProjectFeatures(isDotnet: boolean, version = '4.4'): string {
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
  const baseClass = (opts.baseClass?.trim()) || 'Node';
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
  const body = methodBlocks.length > 0 ? methodBlocks.join('\n\n') : indent;

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
