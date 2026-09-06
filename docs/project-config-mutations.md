# Project configuration mutations

Shared foundation for semantic writers of Godot INI-style config files
(`project.godot`, `export_presets.cfg`, `override.cfg`, `*.import`).
Implemented in `src/project-config-file.ts`.

## Why this module exists

Config writers used to interpolate values into raw text and into dynamically
built regular expressions. A name or value containing quotes, newlines, or
regex metacharacters could then break parsing, match an unrelated line, or
persist malformed Variant text. This module is the only place that renders
`key=value` lines, matches sections/keys, and replaces files, so surface
handlers (autoloads, project settings, export presets) reuse one reviewed
implementation instead of copying escaping logic.

## Supported values

`serializeConfigValue` accepts:

- `null`, booleans, finite numbers (rejects `NaN`/`Infinity`).
- Strings of any content; output is double-quoted with escapes and never
  contains a raw newline.
- Arrays of supported values, rendered as `[a, b]`.
- Plain-object dictionaries with string keys, rendered as `{"k": v}`.
  `__proto__`, `constructor`, and `prototype` keys are rejected, as are class
  instances, sparse arrays, and circular structures.

`serializePackedStringArray` accepts only string arrays and renders
`PackedStringArray("a", "b")`.

Anything else throws `ProjectConfigError` with `code: 'unsupported_value'`
and nothing is written.

Section names must match `^[A-Za-z0-9_.-]+$`; keys must match
`^[A-Za-z0-9_./-]+$`. Anything else throws `invalid_section` / `invalid_key`.
In particular, regex metacharacters outside those classes (for example
`*+?^${}()|[]\`) are rejected, and matching itself uses exact string
equality, never `new RegExp(name)`.

## Raw-text validation

`validateConfigValueText` / `assertSafeConfigValueText` parse candidate
Variant text with a strict grammar before it may reach a file:

- Accepted: `true`/`false`/`null`, finite numbers, double-quoted strings with
  valid escapes, `[...]` arrays, `{...}` dictionaries with quoted keys, and
  `PackedStringArray(...)` / `PackedInt32Array(...)` /
  `PackedFloat32Array(...)` / `PackedByteArray(...)` / `Array(...)`.
- Rejected as `malformed_value_text`: bare words, single-quoted strings,
  unterminated quotes, raw newlines inside strings, bad escapes, unbalanced
  brackets, trailing commas, trailing garbage, NUL bytes, and unknown
  constructors.

## Line-preserving edits

`setIniSetting(content, section, key, value)` and
`removeIniSetting(content, section, key)` are pure string transforms:

- The section header and the assignment line are located by parsing each line
  and comparing names with `===`; untrusted input never becomes a pattern.
- Comments, blank lines, ordering, and unrelated sections/keys pass through
  byte-for-byte; a missing section or key is appended.
- Serialization runs first, so an unsupported value throws before any text
  is produced.

## Atomic writes

`writeConfigFileAtomic(targetPath, content, options?)` and
`updateIniFileAtomic(targetPath, mutate, options?)`:

1. Validate the full replacement text (NUL/size checks plus an optional
   caller `validate` hook).
2. Write a uniquely named temporary sibling file and `fsync` it.
3. `rename` the temporary file over the target.
4. Remove the temporary file on any failure; the original bytes are untouched
   when validation, staging, or replacement fails.

`setIniSettingAtomic(targetPath, section, key, value, options?)` combines
read, `setIniSetting`, validation, and the atomic replacement, and reports
`{ changed, before, after }`. A no-op (identical bytes) skips the write.

`AtomicWriteOptions` accepts injectable `writeTemp` / `replace` hooks so
tests can simulate interrupted writes without touching disk permissions.

## Error contract

All failures throw `ProjectConfigError` with a stable `code`:

| Code | Meaning | File touched? |
| --- | --- | --- |
| `invalid_section` | Section name outside the allowed class | No |
| `invalid_key` | Key name outside the allowed class | No |
| `unsupported_value` | Value cannot serialize (type, circular, prototype key, non-finite) | No |
| `malformed_value_text` | Raw Variant text or full replacement failed validation | No |
| `write_failed` | Read, staging, or replacement failed (message chains the cause) | Original preserved; temp removed |

Surface handlers should catch `ProjectConfigError` and translate `code`
into their tool-level categories (for example `invalid_arguments` for the
first four, `io_error` for `write_failed`) without re-implementing quoting
or file replacement.

## Example

```ts
import {
  ProjectConfigError,
  setIniSettingAtomic,
  validateConfigValueText,
} from './project-config-file.js';

try {
  setIniSettingAtomic(projectGodot, 'autoload', 'MySingleton', '*res://my_singleton.gd');
} catch (error) {
  if (error instanceof ProjectConfigError) return toolError(error.code, error.message);
  throw error;
}

const raw = '"*res://my_singleton.gd"';
const checked = validateConfigValueText(raw);
if (!checked.ok) return toolError(checked.error.code, checked.error.message);
```

Do not build `key=value` lines with template strings, do not pass names into
`new RegExp`, and do not call `writeFileSync` on config targets directly;
route every mutation through this module.
