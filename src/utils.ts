import * as fs from 'fs';
import { isAbsolute, relative, resolve } from 'path';

/**
 * Shared utilities for the Godot Agent Loop server.
 * Pure functions extracted for testability.
 */

export type OperationParams = Record<string, unknown>;
/** Parsed tool arguments. Untrusted MCP input must be parsed before this type is used. */
export type ToolArguments = Record<string, any>;
export interface ToolResponse {
  content: { type: string; [key: string]: unknown }[];
  [key: string]: unknown;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

export const PARAMETER_MAPPINGS: Record<string, string> = {
  'msaa_2d': 'msaa2d',
  'msaa_3d': 'msaa3d',
  // Runtime mouse handlers historically consume these wire names directly.
  'relative_x': 'relative_x',
  'relative_y': 'relative_y',
};

const OPAQUE_PARAMETER_OBJECTS = new Set(['properties', 'shapeParams', 'overrides', 'headers', 'args']);

export const REVERSE_PARAMETER_MAPPINGS: Record<string, string> = Object.fromEntries(
  Object.entries(PARAMETER_MAPPINGS).map(([snake, camel]) => [camel, snake])
);

export function normalizeParameters(params: OperationParams): OperationParams;
export function normalizeParameters(params: null): null;
export function normalizeParameters(params: undefined): undefined;
export function normalizeParameters(params: OperationParams | null | undefined): OperationParams | null | undefined {
  if (!params || typeof params !== 'object') {
    return params;
  }

  const result: OperationParams = {};

  for (const key in params) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      const normalizedKey = PARAMETER_MAPPINGS[key] || key.replace(/_([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());
      const value = params[key];
      result[normalizedKey] = OPAQUE_PARAMETER_OBJECTS.has(normalizedKey) ? value : normalizeValue(value);
    }
  }

  return result;
}

/**
 * Normalize a value of any shape. Arrays must stay arrays at every depth: a
 * nested array is still `typeof "object"`, so treating it as a record turned
 * mesh buffers like `[[x, y, z], ...]` into `[{"0": x, "1": y, "2": z}, ...]`
 * and the engine read them as empty.
 */
function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === 'object') return normalizeParameters(value as OperationParams);
  return value;
}

export function convertCamelToSnakeCase(params: OperationParams): OperationParams {
  const result: OperationParams = {};

  for (const key in params) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      const snakeKey = REVERSE_PARAMETER_MAPPINGS[key] || key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);

      const value = params[key];
      result[snakeKey] = OPAQUE_PARAMETER_OBJECTS.has(key) || OPAQUE_PARAMETER_OBJECTS.has(snakeKey)
        ? value
        : snakeCaseValue(value);
    }
  }

  return result;
}

/** Mirrors normalizeValue: nested arrays stay arrays, so mesh buffers survive. */
function snakeCaseValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeCaseValue);
  if (value && typeof value === 'object') return convertCamelToSnakeCase(value as OperationParams);
  return value;
}

export function validatePath(path: string): boolean {
  if (!path || path.includes('..')) {
    return false;
  }
  return true;
}

/** Centralized filesystem policy for project and project-relative paths. */
export class PathSecurity {
  private readonly configuredRoots: string[];
  private clientRoots: string[] | null = null;
  private readonly supportsRealpath = Object.keys(fs).includes('realpathSync');

  constructor(
    allowedRoots?: string[],
    private readonly realpathResolver?: (target: string) => string,
  ) {
    const configured = allowedRoots ?? (process.env.GODOT_MCP_ALLOWED_DIRS || '')
      .split(process.platform === 'win32' ? /[;,]/ : /[:,]/)
      .map(value => value.trim())
      .filter(Boolean);
    this.configuredRoots = configured.map(root => this.realpathWithFallback(root));
  }

  /** Refresh the MCP client's roots. An empty advertised list intentionally denies all paths. */
  setClientRoots(roots: readonly string[] | null): void {
    this.clientRoots = roots === null ? null : roots.map(root => this.realpathWithFallback(root));
  }

  get hasConfiguredRoots(): boolean { return this.configuredRoots.length > 0; }
  get hasClientRootPolicy(): boolean { return this.clientRoots !== null; }
  get unrestrictedLegacyMode(): boolean { return !this.hasConfiguredRoots && this.clientRoots === null; }

  isProjectPathAllowed(projectPath: string, allowMissing = false): boolean {
    if (!validatePath(projectPath)) return false;
    if (this.unrestrictedLegacyMode) return true;
    if (!allowMissing && !fs.existsSync(projectPath)) return false;
    if (this.isExactAllowedRoot(resolve(projectPath))) return true;
    return this.isWithinAllowedRoots(this.realpathWithFallback(projectPath));
  }

  resolveProjectPath(projectPath: string, relativePath: string): string | null {
    const projectRelativePath = relativePath.startsWith('res://') ? relativePath.slice('res://'.length) : relativePath;
    if (!this.hasRealpath() && this.isExactAllowedRoot(resolve(projectPath)) && validatePath(projectRelativePath)) {
      return resolve(projectPath, projectRelativePath);
    }
    if (!this.supportsRealpath && validatePath(projectPath) && validateRelativePath(relativePath)) {
      return resolve(projectPath, projectRelativePath);
    }
    if (!this.isProjectPathAllowed(projectPath) || !validateRelativePath(relativePath)) return null;
    const projectRoot = this.realpathWithFallback(projectPath);
    const candidate = resolve(projectRoot, projectRelativePath);
    return this.isWithin(candidate, projectRoot) && this.isWithin(this.realpathWithFallback(candidate), projectRoot)
      ? candidate
      : null;
  }

  /** Return the allowed project's real path for relative-path calculations. */
  canonicalProjectPath(projectPath: string): string | null {
    if (!validatePath(projectPath) || !fs.existsSync(projectPath)) return null;
    const canonical = this.realpathWithFallback(projectPath);
    return this.isWithinAllowedRoots(canonical) ? canonical : null;
  }

  isRelativePathAllowed(projectPath: string, relativePath: string): boolean {
    return this.resolveProjectPath(projectPath, relativePath) !== null;
  }

  private isWithinAllowedRoots(target: string): boolean {
    const configuredAllowed = this.configuredRoots.length === 0
      || this.configuredRoots.some(root => this.isWithin(target, root));
    const clientAllowed = this.clientRoots === null
      || this.clientRoots.some(root => this.isWithin(target, root));
    return configuredAllowed && clientAllowed;
  }

  private isExactAllowedRoot(target: string): boolean {
    const configuredAllowed = this.configuredRoots.length === 0 || this.configuredRoots.includes(target);
    const clientAllowed = this.clientRoots === null || this.clientRoots.includes(target);
    return configuredAllowed && clientAllowed;
  }

  private isWithin(target: string, root: string): boolean {
    const rel = relative(root, target);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  }

  private realpathWithFallback(target: string): string {
    const absolute = resolve(target);
    if (fs.existsSync(absolute)) {
      if (this.realpathResolver) return this.realpathResolver(absolute);
      const mockedRealpath = (Object.keys(fs).includes('realpathSync'))
        ? fs.realpathSync as typeof fs.realpathSync & { native?: typeof fs.realpathSync }
        : undefined;
      const realpath = mockedRealpath?.native ?? mockedRealpath;
      return realpath ? realpath(absolute) : absolute;
    }
    const parent = resolve(absolute, '..');
    return parent === absolute ? absolute : resolve(this.realpathWithFallback(parent), absolute.slice(parent.length + 1));
  }

  private hasRealpath(): boolean {
    try {
      return typeof fs.realpathSync === 'function';
    } catch {
      return false;
    }
  }
}

function validateRelativePath(path: string): boolean {
  return Boolean(path) && !isAbsolute(path) && validatePath(path);
}

export function createErrorResponse(message: string): ToolResponse {
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

export const DEFAULT_GODOT_NET_SDK_VERSION = '4.7.0';
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

export function generateGodotProjectFeatures(isDotnet: boolean, version = '4.7'): string {
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
