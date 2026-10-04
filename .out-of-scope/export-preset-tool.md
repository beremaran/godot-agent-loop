# Export Preset Mutation Tool

This project does not ship a tool that creates, updates, or removes entries in `export_presets.cfg`.

## Why this is out of scope

The August 2026 lean-surface reduction deleted `manage_export_presets` along with the other project-settings wrappers (`manage_autoloads`, `manage_input_map`, `modify_project_settings`, and similar). Coding agents already have file tools, and `export_presets.cfg` is a plain text file they edit directly. A wrapper adds tool-surface size and a second parser to maintain, and it does the job no better than a file edit.

What the server keeps is the part file edits cannot do: `verify_export_readiness` reads a preset, checks templates, runs the export, inspects the artifact, and smoke-runs it.

The safe-config module (`src/project-config-file.ts`) was built to back these wrappers. With the wrappers gone it has no caller outside its own test.

## Prior requests

- #60: "Make export preset mutations parser-safe and atomic"
- #84: "Implement a parser-safe and atomic export-preset mutation engine"
- #85: "Expose safe export-preset mutations through the project tool surface"
- #86: "Add adversarial export-preset and Godot reload regression coverage"

Related: #58 (autoload mutations) was deferred for the same reason.
