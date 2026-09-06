/**
 * Parser-safe serialization and atomic writes for Godot INI-style config files.
 *
 * Scope: `project.godot`, `export_presets.cfg`, `override.cfg`, and `*.import`
 * files share one line-oriented grammar (`[section]` headers plus `key=value`
 * assignments whose values are Godot Variant text). Semantic surfaces
 * (autoloads, project settings, export presets) must build assignments through
 * this module instead of interpolating untrusted strings into config syntax or
 * into dynamically constructed regular expressions.
 *
 * Contract summary (full contract: `docs/project-config-mutations.md`):
 * - `serializeConfigValue` converts a supported value to Variant text and
 *   throws `ProjectConfigError(code: 'unsupported_value')` otherwise. Nothing
 *   is written when serialization throws.
 * - `validateConfigValueText` / `assertSafeConfigValueText` reject malformed
 *   Variant text (`'malformed_value_text'`) before any write occurs.
 * - `setIniSetting` / `removeIniSetting` are pure line transforms. Section and
 *   key lookups use exact string equality, never `new RegExp(untrusted)`, so
 *   regex metacharacters in names are inert. Unrelated lines are preserved.
 * - `writeConfigFileAtomic` / `updateIniFileAtomic` replace the target via a
 *   temporary file in the same directory plus `renameSync`. Validation runs
 *   before the replacement; write/rename failures remove the temporary file
 *   and leave the original bytes untouched.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type ConfigErrorCode =
  | 'invalid_section'
  | 'invalid_key'
  | 'unsupported_value'
  | 'malformed_value_text'
  | 'write_failed';

/** Structured failure surfaced before (validation) or during (write) mutation. */
export class ProjectConfigError extends Error {
  readonly code: ConfigErrorCode;
  readonly key?: string;

  constructor(code: ConfigErrorCode, message: string, key?: string) {
    super(message);
    this.name = 'ProjectConfigError';
    this.code = code;
    if (key !== undefined) this.key = key;
  }
}

export function isProjectConfigError(error: unknown): error is ProjectConfigError {
  return error instanceof ProjectConfigError;
}

/** Values this module can losslessly render as Godot Variant/config text. */
export type ConfigValue =
  | null
  | boolean
  | number
  | string
  | ConfigValue[]
  | { [key: string]: ConfigValue };

const SECTION_PATTERN = /^[A-Za-z0-9_.-]+$/;
const KEY_PATTERN = /^[A-Za-z0-9_./-]+$/;
const MAX_CONFIG_BYTES = 16 * 1024 * 1024;

export function assertValidSection(section: string): void {
  if (typeof section !== 'string' || section.length === 0 || section.length > 128 || !SECTION_PATTERN.test(section)) {
    throw new ProjectConfigError('invalid_section', `Invalid config section: ${JSON.stringify(section) ?? '?'}`);
  }
}

export function assertValidKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0 || key.length > 256 || !KEY_PATTERN.test(key)) {
    throw new ProjectConfigError('invalid_key', `Invalid config key: ${JSON.stringify(key) ?? '?'}`, typeof key === 'string' ? key : undefined);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Render a supported value as Godot Variant text. Strings use JSON-compatible
 * double-quote escaping (no raw newlines); numbers must be finite; arrays and
 * plain-object dictionaries recurse. Anything else throws `unsupported_value`.
 */
export function serializeConfigValue(value: unknown, ancestors: Set<object> = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ProjectConfigError('unsupported_value', `Unsupported numeric value: ${String(value)}`);
    }
    return String(value);
  }
  if (typeof value === 'string') {
    const rendered = JSON.stringify(value);
    if (typeof rendered !== 'string' || /[\r\n]/.test(rendered)) {
      throw new ProjectConfigError('unsupported_value', 'String value could not be quoted safely.');
    }
    return rendered;
  }
  if (typeof value === 'bigint' || typeof value === 'undefined'
    || typeof value === 'function' || typeof value === 'symbol') {
    throw new ProjectConfigError('unsupported_value', `Unsupported config value of type ${typeof value}.`);
  }
  if (typeof value === 'object') {
    if (ancestors.has(value)) {
      throw new ProjectConfigError('unsupported_value', 'Circular config value is not supported.');
    }
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        const items: string[] = [];
        for (let index = 0; index < value.length; index += 1) {
          if (!(index in value)) {
            throw new ProjectConfigError('unsupported_value', 'Sparse arrays are not supported.');
          }
          items.push(serializeConfigValue((value as unknown[])[index], ancestors));
        }
        return `[${items.join(', ')}]`;
      }
      if (!isPlainRecord(value)) {
        throw new ProjectConfigError('unsupported_value', 'Only plain objects serialize as config dictionaries.');
      }
      const entries: string[] = [];
      for (const [entryKey, entryValue] of Object.entries(value)) {
        if (entryKey === '__proto__' || entryKey === 'constructor' || entryKey === 'prototype') {
          throw new ProjectConfigError('unsupported_value', `Unsupported dictionary key: ${entryKey}`);
        }
        entries.push(`${JSON.stringify(entryKey)}: ${serializeConfigValue(entryValue, ancestors)}`);
      }
      return `{${entries.join(', ')}}`;
    } finally {
      ancestors.delete(value);
    }
  }
  throw new ProjectConfigError('unsupported_value', 'Unsupported config value.');
}

/** Render a string list as `PackedStringArray(...)`; every element must be a string. */
export function serializePackedStringArray(values: unknown): string {
  if (!Array.isArray(values)) {
    throw new ProjectConfigError('unsupported_value', 'PackedStringArray requires an array of strings.');
  }
  for (const item of values) {
    if (typeof item !== 'string') {
      throw new ProjectConfigError('unsupported_value', 'PackedStringArray elements must be strings.');
    }
  }
  return `PackedStringArray(${(values as string[]).map(item => serializeConfigValue(item)).join(', ')})`;
}

/** Build one `key=value` assignment line without caller-side string interpolation. */
export function serializeConfigAssignment(key: string, value: unknown): string {
  assertValidKey(key);
  return `${key}=${serializeConfigValue(value)}`;
}

// ---------------------------------------------------------------------------
// Variant-text validation (reject raw/malformed text before any write)
// ---------------------------------------------------------------------------

export interface ConfigValueValidation {
  ok: boolean;
  value?: unknown;
  error?: { code: Extract<ConfigErrorCode, 'malformed_value_text'>; message: string };
}

class VariantCursor {
  position = 0;
  constructor(readonly text: string) {}
  get done(): boolean { return this.position >= this.text.length; }
  peek(): string { return this.text[this.position] ?? ''; }
  skipWhitespace(): void {
    while (!this.done && /[ \t]/.test(this.peek())) this.position += 1;
  }
}

function parseVariantValue(cursor: VariantCursor, depth: number): unknown {
  if (depth > 64) throw new Error('Config value is nested too deeply.');
  cursor.skipWhitespace();
  if (cursor.done) throw new Error('Unexpected end of config value.');
  const rest = cursor.text.slice(cursor.position);
  if (rest.startsWith('true') && !/[A-Za-z0-9_]/.test(rest[4] ?? '')) {
    cursor.position += 4; return true;
  }
  if (rest.startsWith('false') && !/[A-Za-z0-9_]/.test(rest[5] ?? '')) {
    cursor.position += 5; return false;
  }
  if (rest.startsWith('null') && !/[A-Za-z0-9_]/.test(rest[4] ?? '')) {
    cursor.position += 4; return null;
  }
  const char = cursor.peek();
  if (char === '"') return parseVariantString(cursor);
  if (char === '[') return parseVariantArray(cursor, depth);
  if (char === '{') return parseVariantDictionary(cursor, depth);
  if (char === '-' || char === '+' || (char >= '0' && char <= '9') || char === '.') {
    return parseVariantNumber(cursor);
  }
  if (/[A-Za-z_]/.test(char)) return parseVariantConstructor(cursor, depth);
  throw new Error(`Unexpected character ${JSON.stringify(char)} in config value.`);
}

function parseVariantString(cursor: VariantCursor): string {
  // Opening quote already peeked.
  cursor.position += 1;
  let result = '';
  while (!cursor.done) {
    const char = cursor.text[cursor.position] ?? '';
    if (char === '\n' || char === '\r') throw new Error('Unterminated string: raw newline in config value.');
    if (char === '"') { cursor.position += 1; return result; }
    if (char === '\\') {
      const next = cursor.text[cursor.position + 1];
      if (next === undefined) throw new Error('Unterminated escape in config value.');
      if (next === '\n' || next === '\r') throw new Error('Unterminated escape in config value.');
      const escapes: Record<string, string> = {
        '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
      };
      if (next in escapes) {
        result += escapes[next];
        cursor.position += 2;
        continue;
      }
      if (next === 'u') {
        const hex = cursor.text.slice(cursor.position + 2, cursor.position + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('Invalid unicode escape in config value.');
        result += String.fromCharCode(parseInt(hex, 16));
        cursor.position += 6;
        continue;
      }
      throw new Error(`Invalid escape ${JSON.stringify(`\\${next}`)} in config value.`);
    }
    result += char;
    cursor.position += 1;
  }
  throw new Error('Unterminated string in config value.');
}

function parseVariantArray(cursor: VariantCursor, depth: number): unknown[] {
  cursor.position += 1; // '['
  const items: unknown[] = [];
  cursor.skipWhitespace();
  if (cursor.peek() === ']') { cursor.position += 1; return items; }
  for (;;) {
    items.push(parseVariantValue(cursor, depth + 1));
    cursor.skipWhitespace();
    const char = cursor.peek();
    if (char === ',') { cursor.position += 1; cursor.skipWhitespace(); if (cursor.peek() === ']') throw new Error('Trailing comma in config array.'); continue; }
    if (char === ']') { cursor.position += 1; return items; }
    if (cursor.done) throw new Error('Unterminated array in config value.');
    throw new Error(`Unexpected character ${JSON.stringify(char)} in config array.`);
  }
}

function parseVariantDictionary(cursor: VariantCursor, depth: number): Record<string, unknown> {
  cursor.position += 1; // '{'
  const result: Record<string, unknown> = {};
  cursor.skipWhitespace();
  if (cursor.peek() === '}') { cursor.position += 1; return result; }
  for (;;) {
    cursor.skipWhitespace();
    if (cursor.peek() !== '"') throw new Error('Dictionary keys must be double-quoted strings.');
    const key = parseVariantString(cursor);
    cursor.skipWhitespace();
    if (cursor.peek() !== ':') throw new Error('Dictionary entries require a ":" separator.');
    cursor.position += 1;
    result[key] = parseVariantValue(cursor, depth + 1);
    cursor.skipWhitespace();
    const char = cursor.peek();
    if (char === ',') { cursor.position += 1; continue; }
    if (char === '}') { cursor.position += 1; return result; }
    if (cursor.done) throw new Error('Unterminated dictionary in config value.');
    throw new Error(`Unexpected character ${JSON.stringify(char)} in config dictionary.`);
  }
}

function parseVariantNumber(cursor: VariantCursor): number {
  const match = /^[+-]?(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/.exec(cursor.text.slice(cursor.position));
  if (!match) throw new Error('Invalid number in config value.');
  cursor.position += match[0].length;
  const value = Number(match[0]);
  if (!Number.isFinite(value)) throw new Error('Non-finite number in config value.');
  return value;
}

const PACKED_ARRAY_NAMES = new Set([
  'PackedStringArray', 'PackedInt32Array', 'PackedFloat32Array', 'PackedByteArray', 'Array',
]);

function parseVariantConstructor(cursor: VariantCursor, depth: number): unknown[] | Record<string, unknown> {
  const nameMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(cursor.text.slice(cursor.position));
  const name = nameMatch?.[0] ?? '';
  if (!PACKED_ARRAY_NAMES.has(name)) {
    throw new Error(`Unsupported config value ${JSON.stringify(name || cursor.peek())}.`);
  }
  cursor.position += name.length;
  cursor.skipWhitespace();
  if (cursor.peek() !== '(') throw new Error(`Expected "(" after ${name}.`);
  cursor.position += 1;
  const items: unknown[] = [];
  cursor.skipWhitespace();
  if (cursor.peek() === ')') { cursor.position += 1; return items; }
  for (;;) {
    items.push(parseVariantValue(cursor, depth + 1));
    cursor.skipWhitespace();
    const char = cursor.peek();
    if (char === ',') { cursor.position += 1; continue; }
    if (char === ')') { cursor.position += 1; return items; }
    if (cursor.done) throw new Error(`Unterminated ${name} in config value.`);
    throw new Error(`Unexpected character ${JSON.stringify(char)} in ${name}.`);
  }
}

/**
 * Validate raw Variant text without writing it. Accepts the values
 * `serializeConfigValue` produces (plus equivalent packed-array constructors)
 * and rejects bare words, single-quoted strings, raw newlines inside strings,
 * unbalanced brackets, trailing garbage, and unsupported constructors.
 */
export function validateConfigValueText(text: string): ConfigValueValidation {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_CONFIG_BYTES) {
    return { ok: false, error: { code: 'malformed_value_text', message: 'Config value text must be a non-empty string.' } };
  }
  if (text.includes('\0')) {
    return { ok: false, error: { code: 'malformed_value_text', message: 'Config value text must not contain NUL bytes.' } };
  }
  try {
    const cursor = new VariantCursor(text);
    const value = parseVariantValue(cursor, 0);
    cursor.skipWhitespace();
    if (!cursor.done) {
      return { ok: false, error: { code: 'malformed_value_text', message: `Trailing text after config value: ${JSON.stringify(text.slice(cursor.position, cursor.position + 24))}` } };
    }
    return { ok: true, value };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid config value text.';
    return { ok: false, error: { code: 'malformed_value_text', message } };
  }
}

/** Throw `ProjectConfigError('malformed_value_text')` when raw text is not safe. */
export function assertSafeConfigValueText(text: string): unknown {
  const result = validateConfigValueText(text);
  if (!result.ok) {
    throw new ProjectConfigError('malformed_value_text', result.error?.message ?? 'Malformed config value text.');
  }
  return result.value;
}

// ---------------------------------------------------------------------------
// Line-preserving INI transforms (no untrusted regex interpolation)
// ---------------------------------------------------------------------------

function splitSectionHeader(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.length < 2 || !trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  return trimmed.slice(1, -1);
}

function splitAssignment(line: string): { key: string; value: string } | null {
  const index = line.indexOf('=');
  if (index < 0) return null;
  return { key: line.slice(0, index).trim(), value: line.slice(index + 1) };
}

/**
 * Return `content` with `key` in `section` set to `value`. Matching uses exact
 * string equality on parsed section/key names, so names containing regex
 * metacharacters (`.*+?^${}()|[]\\`) can never alter an unrelated line. All
 * other lines (comments, blank lines, other sections/keys, ordering) are
 * preserved byte-for-byte. Appends a missing section or key.
 */
export function setIniSetting(content: string, section: string, key: string, value: unknown): string {
  assertValidSection(section);
  assertValidKey(key);
  const assignment = serializeConfigAssignment(key, value);
  const hasTrailingNewline = content.endsWith('\n');
  const lines = content.split('\n');
  let headerIndex = -1;
  let sectionEnd = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const header = splitSectionHeader(lines[index] ?? '');
    if (header === null) continue;
    if (headerIndex >= 0) { sectionEnd = index; break; }
    if (header === section) headerIndex = index;
  }
  if (headerIndex < 0) {
    const prefix = content === '' ? '' : hasTrailingNewline ? '' : '\n';
    const gap = content === '' ? '' : '\n';
    return `${content}${prefix}${gap}[${section}]\n\n${assignment}\n`;
  }
  const end = sectionEnd < 0 ? lines.length : sectionEnd;
  for (let index = headerIndex + 1; index < end; index += 1) {
    const parsed = splitAssignment(lines[index] ?? '');
    if (parsed !== null && parsed.key === key) {
      const next = [...lines];
      next[index] = assignment;
      return next.join('\n');
    }
  }
  const next = [...lines];
  const insertAt = end;
  const anchor = (next[insertAt - 1] ?? '') === '' ? insertAt - 1 : insertAt;
  next.splice(anchor, 0, assignment);
  return next.join('\n');
}

/** Remove `key` from `section` by exact name match; unrelated lines are preserved. */
export function removeIniSetting(content: string, section: string, key: string): string {
  assertValidSection(section);
  assertValidKey(key);
  const lines = content.split('\n');
  let headerIndex = -1;
  let sectionEnd = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const header = splitSectionHeader(lines[index] ?? '');
    if (header === null) continue;
    if (headerIndex >= 0) { sectionEnd = index; break; }
    if (header === section) headerIndex = index;
  }
  if (headerIndex < 0) return content;
  const end = sectionEnd < 0 ? lines.length : sectionEnd;
  const next = [...lines];
  for (let index = end - 1; index > headerIndex; index -= 1) {
    const parsed = splitAssignment(next[index] ?? '');
    if (parsed !== null && parsed.key === key) next.splice(index, 1);
  }
  return next.join('\n');
}

// ---------------------------------------------------------------------------
// Atomic file replacement
// ---------------------------------------------------------------------------

export interface AtomicWriteHooks {
  writeTemp?: (temporaryPath: string, content: string) => void;
  replace?: (temporaryPath: string, targetPath: string) => void;
}

export interface AtomicWriteOptions extends AtomicWriteHooks {
  /** Extra gate run after the built-in NUL/size checks, before replacement. */
  validate?: (content: string) => void;
}

function defaultWriteTemp(temporaryPath: string, content: string): void {
  const fd = openSync(temporaryPath, 'w', 0o644);
  try {
    writeSync(fd, content, null, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function validateFullContent(content: string): void {
  if (typeof content !== 'string') {
    throw new ProjectConfigError('malformed_value_text', 'Config content must be a string.');
  }
  if (content.includes('\0')) {
    throw new ProjectConfigError('malformed_value_text', 'Config content must not contain NUL bytes.');
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_CONFIG_BYTES) {
    throw new ProjectConfigError('malformed_value_text', 'Config content exceeds the size limit.');
  }
}

/**
 * Replace `targetPath` with `content` atomically: write a temporary sibling
 * file, fsync it, then rename over the target. On any failure the temporary
 * file is removed and the original is left untouched. Throws
 * `ProjectConfigError(code: 'write_failed' | 'malformed_value_text')`.
 */
export function writeConfigFileAtomic(targetPath: string, content: string, options: AtomicWriteOptions = {}): void {
  validateFullContent(content);
  options.validate?.(content);
  const temporaryPath = join(dirname(targetPath), `.${randomUUID()}.tmp`);
  const writeTemp = options.writeTemp ?? defaultWriteTemp;
  const replace = options.replace ?? renameSync;
  try {
    writeTemp(temporaryPath, content);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    if (isProjectConfigError(error)) throw error;
    throw new ProjectConfigError('write_failed', `Failed to stage config write: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  try {
    replace(temporaryPath, targetPath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    if (isProjectConfigError(error)) throw error;
    throw new ProjectConfigError('write_failed', `Failed to replace config file: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  if (existsSync(temporaryPath)) {
    // A custom `replace` hook may copy instead of renaming; never leave the
    // staging file behind.
    rmSync(temporaryPath, { force: true });
  }
}

export interface IniMutationResult {
  changed: boolean;
  before: string;
  after: string;
}

/**
 * Read `targetPath`, apply `mutate` to its text, then atomically replace it.
 * Serialization/validation errors throw before any write, so malformed or
 * unsupported values never touch the target file. Returns whether bytes changed.
 */
export function updateIniFileAtomic(
  targetPath: string,
  mutate: (content: string) => string,
  options: AtomicWriteOptions = {},
): IniMutationResult {
  let before: string;
  try {
    before = readFileSync(targetPath, 'utf8');
  } catch (error) {
    throw new ProjectConfigError('write_failed', `Failed to read config file: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  const after = mutate(before);
  validateFullContent(after);
  options.validate?.(after);
  if (after === before) return { changed: false, before, after };
  writeConfigFileAtomic(targetPath, after, options);
  return { changed: true, before, after };
}

/** Convenience wrapper: set one `section/key` to `value` with an atomic write. */
export function setIniSettingAtomic(
  targetPath: string,
  section: string,
  key: string,
  value: unknown,
  options: AtomicWriteOptions = {},
): IniMutationResult {
  return updateIniFileAtomic(targetPath, content => setIniSetting(content, section, key, value), options);
}
