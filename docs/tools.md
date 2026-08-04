# Tool catalog

Godot Agent Loop advertises a reviewed `core` surface of 16 tools within the
generated [surface budget](coverage/tool-surface.json). The remaining 40 tools
stay callable through read-only `godot_catalog` search and inspection followed
by `godot_call` execution. Set `GODOT_MCP_TOOL_SURFACE=full` to advertise the
complete 56-tool catalog statically. The former `compact` surface name aliases
`core` during migration.

A tool earns its place only if it does something file editing plus shell
cannot. The product is the feedback loop: **author files → validate → run →
observe → interact → assert**. Coding agents are expected to author
`.gd`/`.tscn`/`.tres`/`project.godot` with their own file tools, validate
GDScript through `run_project_tests` or headless checks before launching, use
`editor_transaction` for undoable scene edits when an editor is attached, and
reserve the MCP surface for the parts that need a live engine.

## Calling contract

Every advertised tool has a human title, closed input schema where applicable,
output schema, conservative effect annotations, and structured success/error
content. Equivalent serialized JSON text remains for older clients. A structured
argument error is a tool result with a field path and remediation; protocol
errors remain reserved for malformed MCP messages and unknown tools.

Effect scopes distinguish `read-only`, `project-persistent`,
`runtime-ephemeral`, `process`, and `external-open-world` behavior. An annotation
is a UI hint, not authorization: project roots, Pause Agent, privilege,
authentication, and mutation policy are enforced by the server.

Clients that advertise MCP roots constrain project access further; configured
allowed directories still apply. Long operations report progress only when the
request includes a progress token and honor MCP cancellation where safe. Clients
without these optional capabilities retain the bounded compatibility path.

## Advertised core (16)

These tools cover the whole loop without any hidden lookup:

| Tool | Purpose |
| ------ | ------------- |
| `godot_catalog` | Read-only ranked search and summary/schema/full description for any catalog tool |
| `godot_call` | Execute one inspected hidden tool with its effective scope, privilege group, and trace identity |
| `run_project` | Run the Godot project and capture output, then report when the authenticated runtime bridge is usable |
| `stop_project` | Stop the currently running project |
| `editor_session` | Discover, attach, inspect, or disconnect a per-project editor session |
| `editor_transaction` | Apply one validated compound scene edit as one editor undo step |
| `game_screenshot` | Capture a PNG preview with dimensions, digest, and optional retained artifact |
| `game_get_scene_tree` | Get the running game's scene tree as a bounded deterministic pre-order |
| `game_get_ui` | Get a bounded list of visible UI elements from the running game |
| `game_get_node_info` | Compact or full node introspection: properties, signals (with connection callables), methods, children |
| `game_get_errors` | Get new `push_error`/`push_warning` messages since the last call |
| `game_get_logs` | Get new `print` output since the last call (cursor read) |
| `game_scenario` | Run a bounded input/wait/assert/observe/screenshot/performance sequence |
| `game_wait_until` | Wait once for a bounded runtime condition and return the last observation |
| `run_project_tests` | Discover or run native, GUT, and GdUnit4 tests with structured results |
| `verify_project` | Run bounded assertions, capture evidence, and tear down deterministically |

`run_project` succeeds only after the authenticated runtime bridge is usable by
the next runtime tool; on failure it returns an actionable error and cleans
owned state. `game_scenario` composes input, wait, assert, observe, screenshot,
and performance steps into one bounded trace, so interactive verification does
not require many primitive calls. `verify_project` runs bounded assertions
(`node_exists`, `group_count`, `log_contains`) and can capture a screenshot and
stop the project in one call.

## Hidden surface (40 tools)

Every tool below is callable, but only through `godot_catalog search` +
`godot_catalog describe` + `godot_call`. Advertise them all up front only with
`GODOT_MCP_TOOL_SURFACE=full`. Privileged tools are denied by default and
require the named `GODOT_MCP_PRIVILEGED_GROUPS` grant.

### Input primitives

Reach these via the catalog when you need synthetic player input beyond
`game_scenario`'s composed steps.

| Tool | Purpose |
| ------ | ------------- |
| `game_click` | Click at a position in the running game window |
| `game_key_press` | Tap a key or input action for one frame (auto-release) |
| `game_key_hold` | Hold exactly one key or input action until `game_key_release` |
| `game_key_release` | Release exactly one previously held key or input action |
| `game_mouse_move` | Move the mouse (absolute or relative) in the running game |
| `game_mouse_drag` | Drag between two points over N frames |
| `game_scroll` | Send a mouse scroll wheel event at a position |
| `game_gamepad` | Send a gamepad button or axis input event |
| `game_touch` | Simulate touch press/release/drag and gestures |
| `game_input_action` | Manage runtime InputMap actions and strength |
| `game_input_state` | Query key, action, mouse, and joypad state or configure the mouse |

### Privileged generics (denied by default)

These are the generic reflection/code-execution tools. Grant
`GODOT_MCP_PRIVILEGED_GROUPS=reflection` and/or `code-execution` for a trusted
localhost workflow; they cover the ground that the deleted subsystem wrappers
used to expose.

| Tool | Privilege | Purpose |
| ------ | ------------- | ------------- |
| `game_eval` | `code-execution` | Execute arbitrary GDScript in the running game; `return` yields values |
| `game_get_property` | `reflection` | Get a property value from any node by path |
| `game_set_property` | `reflection` | Set a property on a node (auto type conversion) |
| `game_call_method` | `reflection` | Call a method on any node with optional arguments |
| `game_script` | `code-execution` | Attach, detach, or get the source of node scripts |

### Node generics

Generic live scene-tree manipulation that does not persist back to `.tscn`
files.

| Tool | Purpose |
| ------ | ------------- |
| `game_spawn_node` | Create a new node of any type at runtime with properties |
| `game_remove_node` | Remove and free a node from the running scene tree |
| `game_change_scene` | Switch to a different scene file in the running game |
| `game_instantiate_scene` | Load a PackedScene and add it as a child of a node |
| `game_reparent_node` | Move a node to a new parent, optionally keeping the global transform |
| `game_connect_signal` | Connect a signal from one node to a method on another |
| `game_disconnect_signal` | Disconnect a signal connection |
| `game_emit_signal` | Emit a signal on a node, optionally with arguments |
| `game_get_nodes_in_group` | Get all nodes belonging to a specific group |
| `game_find_nodes_by_class` | Find all nodes of a class type under a root |
| `game_await_signal` | Await a signal with a timeout and return its arguments |
| `game_manage_group` | Add/remove a node from a group, or list groups |

Signal inspection is folded into `game_get_node_info` (core): `detail=full`
returns each signal name together with its connected callables and flags, so
`game_list_signals` no longer needs a separate identity.

### Runtime state

| Tool | Purpose |
| ------ | ------------- |
| `game_pause` | Pause or unpause the running game tree |

### Observation extras

Additional bounded evidence beyond the core observation tools.

| Tool | Purpose |
| ------ | ------------- |
| `game_performance` | Sample live metrics or run a bounded profiler session (sample, start, stop, report, stress, leaks) |
| `game_visual_regression` | Capture a baseline or compare rendered PNGs with tolerances, masks, and retained diffs |
| `game_wait` | Wait N render or physics frames |
| `game_get_camera` | Get the active camera position, rotation, and size |
| `game_get_audio` | Get the audio bus layout and playing streams |

### Editor

Editor attachment beyond the core session/transaction pair.

| Tool | Purpose |
| ------ | ------------- |
| `editor_control` | Inspect editor state, select nodes, and save/reload/open scenes or undo/redo through the editor bridge |

`editor_session ensure` first discovers a normally opened matching editor and
spawns only when needed; `launch_editor` no longer exists as a separate
identity. `editor_control` inspects the edited scene and selection, opens,
saves, and reloads scenes, selects nodes, and walks the editor undo stack.
Scene mutations (add/remove/rename/property edits) go through
`editor_transaction`, which records one undo action and persists the scene.

### Ship and validation

Project-level tooling for validation, imports, integrity, .NET, add-ons, and
exports.

| Tool | Purpose |
| ------ | ------------- |
| `manage_import_pipeline` | Inspect/change importer settings, reimport, and query generated dependencies |
| `analyze_project_integrity` | Analyze resource graphs, run static audits, and preview a safe resource rename |
| `verify_export_readiness` | Validate presets/templates, export, inspect artifacts, and smoke-run builds |
| `verify_dotnet_project` | Inspect, restore, build, and run against the matching `Godot.NET.Sdk` |
| `manage_addon` | Inspect/install/update/remove and toggle hash-pinned local EditorPlugins |

Import changes require an editor-capable Godot binary. `reimport` runs Godot's
bounded `--import` workflow and returns diagnostics; it may rewrite `.import`
metadata and `.godot/imported` cache files. Integrity analysis is read-only,
skips generated/vendor directories, defaults to 10,000 resource files, and
labels unreferenced resources as candidates because dynamic loads cannot be
proven statically. Use `preview_rename` before moving a resource; it reports
direct textual dependents, destination conflicts, and UID sidecars but never
changes files.

Export readiness recognizes the bounded Linux, Windows, macOS, and Web template
filenames for the active Godot version. Local smoke execution is intentionally
limited to Linux exports on Linux; other targets are inspected but not claimed
as locally runnable. Add-on installation is deliberately offline and
provenance-first: `sourcePath` must be an allowed local directory and
`expectedSha256` must match its authored tree before any write.

## Removed in the lean surface reduction

The August 2026 reduction deleted 109 tools whose work file editing plus shell
already did better. They are gone from the catalog and return an unknown-tool
error; do not call them.

- **File CRUD and project listing** — `read_file`, `write_file`, `delete_file`,
  `create_directory`, `rename_file`, `list_project_files`, `list_projects`.
- **Project and script creation** — `create_project`, `create_script`,
  `create_csharp_script`, `manage_shader`.
- **Scene-authoring primitives** — `create_scene`, `add_node`, `read_scene`,
  `modify_scene_node`, `remove_scene_node`, `attach_script`, `save_scene`,
  `create_resource`, `manage_resource`, `manage_scene_signals`,
  `manage_scene_structure`, `manage_theme_resource`, `load_sprite`,
  `export_mesh_library`, `get_uid`, `update_project_uids`.
- **Project-settings wrappers** — `read_project_settings`,
  `modify_project_settings`, `manage_input_map`, `set_main_scene`,
  `manage_autoloads`, `manage_export_presets`, `manage_layers`, `manage_plugins`,
  `manage_translations`.
- **CI/export scaffolds** — `manage_ci_pipeline`, `manage_docker_export`.
- **Deprecated dispatcher** — `godot_tools` (migrate to `godot_catalog` +
  `godot_call`).
- **Subsystem runtime wrappers (~70)** — 3D rendering and geometry
  (`game_csg`, `game_multimesh`, `game_procedural_mesh`, `game_light_3d`,
  `game_mesh_instance`, `game_gridmap`, `game_3d_effects`, `game_gi`,
  `game_path_3d`, `game_sky`, `game_camera_attributes`, `game_navigation_3d`,
  `game_physics_3d`, `game_terrain`); 2D systems (`game_canvas`,
  `game_canvas_draw`, `game_light_2d`, `game_parallax`, `game_shape_2d`,
  `game_path_2d`, `game_physics_2d`); animation (`game_play_animation`,
  `game_tween_property`, `game_create_animation`, `game_bone_pose`,
  `game_animation_tree`, `game_animation_control`, `game_skeleton_ik`); audio
  (`game_audio_play`, `game_audio_bus`, `game_audio_effect`,
  `game_audio_bus_layout`, `game_audio_spatial`); UI controls
  (`game_ui_theme`, `game_ui_control`, `game_ui_text`, `game_ui_popup`,
  `game_ui_tree`, `game_ui_item_list`, `game_ui_tabs`, `game_ui_menu`,
  `game_ui_range`); physics and collision (`game_physics_body`,
  `game_create_joint`, `game_add_collision`, `game_raycast`,
  `game_navigate_path`); runtime state and config (`game_time_scale`,
  `game_process_mode`, `game_world_settings`, `game_window`,
  `game_render_settings`, `game_environment`, `game_set_shader_param`,
  `game_set_particles`, `game_viewport`, `game_debug_draw`,
  `game_create_timer`, `game_serialize_state`, `game_tilemap`, `game_locale`,
  `game_set_camera`); networking (`game_http_request`, `game_websocket`,
  `game_multiplayer`, `game_rpc`); and resources/video (`game_resource`,
  `game_visual_shader`, `game_video`).

## Removed after the lean surface reduction

A follow-up pass deleted three redundant identities: `launch_editor` (the
`editor_session ensure` flow covers launching with `launchIfNeeded`),
`validate_script` (superseded by `run_project_tests` and headless checks), and
`get_debug_output` (superseded by the cursor reads `game_get_logs` and
`game_get_errors`, which page the same process output). They return an
unknown-tool error; do not call them.

## Removed in the current surface reduction

A further pass removed six more identities that duplicated remaining tools or
runtime observation:

- `get_godot_version` — the engine version is reported by `run_project` and the
  catalog; do not call it.
- `get_project_info` — use `analyze_project_integrity`, `run_project_tests`, or
  host file reads of `project.godot` instead.
- `validate_scripts` — use `run_project_tests` (native/GUT/GdUnit4 discovery and
  runs) or headless checks instead.
- `game_os_info` — runtime platform details are observed through the remaining
  runtime reads (`game_get_audio`, `game_performance`, `game_get_camera`).
- `game_list_signals` — merged into `game_get_node_info`; `detail=full` now
  returns signal names with their connection callables and flags.
- `export_project` — `verify_export_readiness` owns preset validation, the
  export itself, artifact inspection, and smoke runs; use it instead.

They return an unknown-tool error; do not call them. `editor_control` also lost
its `set_property` and `rename_node` actions — route scene mutations through
`editor_transaction` so they remain one undo step. A new hidden
`game_pause` tool exposes the runtime pause command.
