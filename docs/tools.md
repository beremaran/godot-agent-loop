# Tool catalog

Godot Agent Loop exposes 171 tools. The default MCP surface advertises a
compact core of 40 tools, including the `godot_tools` meta-tool, which searches,
describes, and dispatches everything below on demand. Set
`GODOT_MCP_TOOL_SURFACE=full` to advertise the complete static catalog
instead.

Per-tool verification status, action inventories, and test references are
published in the generated [coverage report](coverage/coverage-report.md).

## Meta & editor bridge (4 tools)

| Tool | Description |
| ------ | ------------- |
| `godot_tools` | Search, describe, and dispatch any tool in this catalog |
| `editor_session` | Idempotently discover/attach, inspect, or disconnect a project editor session |
| `editor_control` | Inspect editor state and apply reversible edits through the editor bridge |
| `editor_transaction` | Commit one validated compound scene edit as one editor undo step |

`editor_control` inspects the edited scene and selection, opens/saves/reloads
scenes, and applies reversible property or node-name edits through
`EditorUndoRedoManager`. `editor_session ensure` first discovers a normally
opened matching editor; `launch_editor` uses the same flow and spawns only when
needed. Its **Agent Activity** dock shows
each command's target, live outcome, and duration from the same correlated
lifecycle events used by server diagnostics, including bounded replay after a
late attach or reconnect. File-backed writes enter an acknowledged per-project
scan/import queue and reload the affected scene only when it has no unsaved
human changes. Results distinguish persisted, acknowledged, detached,
conflicted, timed-out, and failed synchronization. When an
operation identifies a scene node, the bridge selects and reveals it in the
editor so the human view follows the agent's current target. The dock's
**Pause Agent** button gives the human a cooperative editing lock: subsequent
mutating tools are refused before dispatch while inspection remains available;
**Resume Agent** returns control. The lock defaults to agent-driving and does
not affect unattended use when no editor is open. Setup, uninstall, security,
protocol migration, and all session states are documented in the
[interaction architecture](architecture/editor-interaction.md).

## Project Management (16 tools)

| Tool | Description |
| ------ | ------------- |
| `launch_editor` | Launch Godot editor for a project |
| `run_project` | Run a Godot project and capture output |
| `verify_project` | Run, assert bounded runtime evidence, optionally capture, and tear down |
| `game_wait_until` | Await one bounded runtime condition and return its last observed state |
| `game_scenario` | Run a bounded input/wait/assert/observe/screenshot/performance sequence |
| `run_project_tests` | Discover or run native, GUT, and GdUnit4 tests with structured cases and logs |
| `manage_import_pipeline` | Inspect/change importer settings, reimport, and query generated dependencies |
| `analyze_project_integrity` | Analyze resource graphs and preview non-mutating rename impact |
| `verify_export_readiness` | Validate export prerequisites and return artifact plus smoke-run evidence |
| `verify_dotnet_project` | Inspect, restore, build, and run against the matching Godot.NET.Sdk |
| `manage_addon` | Inspect/install/update/remove and toggle hash-pinned local EditorPlugins |
| `stop_project` | Stop the running project |
| `get_debug_output` | Get console output and errors |
| `get_godot_version` | Get installed Godot version |
| `list_projects` | Find Godot projects in a directory |
| `get_project_info` | Get project metadata (including an `isDotnet` field) |

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
as locally runnable. Export writes the requested artifact and companion files,
returns bounded process output and SHA-256 evidence, and classifies missing
templates, unsupported platforms, invalid output paths, timeouts, export errors,
missing artifacts, and smoke failures.

The managed workflow requires both a .NET-enabled Godot editor and a 64-bit
.NET SDK. It verifies that the versioned `Godot.NET.Sdk` in the unique or
selected `.csproj` matches the active engine, returns bounded structured MSBuild
diagnostics, and hashes the resulting assembly. Standard Godot builds return a
controlled `dotnet_editor_required` result and do not attempt restore or build.

Add-on installation is deliberately offline and provenance-first: `sourcePath`
must be an allowed local directory and `expectedSha256` must match its authored
tree before any write. Symlinks, oversized trees, malformed `plugin.cfg`,
non-`@tool` scripts, incompatible minimum Godot versions, and traversal are
rejected. Replacement is staged atomically, editor reload is mandatory, and a
parse/load failure restores the prior version and plugin configuration.

## Scene Management (7 tools)

| Tool | Description |
| ------ | ------------- |
| `create_scene` | Create a new scene with a root node type |
| `add_node` | Add a node to an existing scene |
| `load_sprite` | Load a texture into a Sprite2D node |
| `export_mesh_library` | Export a scene as MeshLibrary |
| `save_scene` | Save a scene (with optional variant path) |
| `get_uid` | Get UID for a file (Godot 4.4+) |
| `update_project_uids` | Resave resources to update UIDs |

## Scene Authoring Operations (5 tools)

These operate directly on `.tscn`/`.tres` files — no running game needed.

| Tool | Description |
| ------ | ------------- |
| `read_scene` | Read full scene tree as JSON (falls back to raw `.tscn` text on missing dependencies) |
| `modify_scene_node` | Modify node properties in a scene file |
| `remove_scene_node` | Remove a node from a scene file |
| `attach_script` | Attach a GDScript to a scene node |
| `create_resource` | Create a .tres resource file (materials, themes, etc.) |

## Project Settings (3 tools)

| Tool | Description |
| ------ | ------------- |
| `read_project_settings` | Parse project.godot as JSON |
| `modify_project_settings` | Change a project setting |
| `list_project_files` | Paginate/filter project files |

## Runtime Input (5 tools)

| Tool | Description |
| ------ | ------------- |
| `game_screenshot` | Capture a screenshot (base64 PNG) |
| `game_visual_regression` | Capture baselines or compare frames with masks, tolerances, and retained PNG diffs |
| `game_click` | Click at a position |
| `game_key_press` | Send key press or input action |
| `game_mouse_move` | Move the mouse |

## Runtime Inspection (3 tools)

| Tool | Description |
| ------ | ------------- |
| `game_get_ui` | Get all visible UI elements |
| `game_get_scene_tree` | Get full scene tree structure |
| `game_get_node_info` | Detailed node introspection: properties, signals, methods, children |

## Runtime Code Execution (1 tool)

| Tool | Description |
| ------ | ------------- |
| `game_eval` | Execute arbitrary GDScript with return values |

`game_eval` supports `await` for async GDScript and works even when the game
is paused (`PROCESS_MODE_ALWAYS`). It belongs to the `code-execution`
privileged group and is denied by default; see the security notes in the
[README](../README.md#runtime-tools-setup).

## Runtime Node Manipulation (7 tools)

| Tool | Description |
| ------ | ------------- |
| `game_get_property` | Get any node property |
| `game_set_property` | Set any node property (auto type conversion) |
| `game_call_method` | Call any method on a node |
| `game_instantiate_scene` | Add a PackedScene to the running tree |
| `game_remove_node` | Remove a node from the tree |
| `game_change_scene` | Switch to a different scene |
| `game_reparent_node` | Move a node to a new parent |

Property access uses the node's `get_property_list()` for automatic type
conversion, supporting Vector2/3, Color, Quaternion, Basis, Transform2D/3D,
AABB, Rect2, and all packed array types (serialized as proper JSON arrays).

## Runtime Signals (5 tools)

| Tool | Description |
| ------ | ------------- |
| `game_connect_signal` | Connect a signal to a method |
| `game_disconnect_signal` | Disconnect a signal |
| `game_emit_signal` | Emit a signal with arguments |
| `game_list_signals` | List all signals on a node with connections |
| `game_await_signal` | Await a signal with timeout and return args |

## Runtime Animation (2 tools)

| Tool | Description |
| ------ | ------------- |
| `game_play_animation` | Control AnimationPlayer (play, stop, pause, list) |
| `game_tween_property` | Tween a property with configurable easing |

## Runtime Utilities (5 tools)

| Tool | Description |
| ------ | ------------- |
| `game_pause` | Pause/unpause the game |
| `game_performance` | FPS, frame time, memory, object counts, draw calls, bounded profiler sessions, and live orphan-node diagnostics |
| `game_wait` | Wait N frames (timing-sensitive operations) |
| `game_get_nodes_in_group` | Query nodes by group |
| `game_find_nodes_by_class` | Find nodes by class type |

## File I/O (4 tools)

| Tool | Description |
| ------ | ------------- |
| `read_file` | Read a text file from a Godot project |
| `write_file` | Create or overwrite a text file |
| `delete_file` | Delete a file from a project |
| `create_directory` | Create a directory inside a project |

## Error & Log Capture (2 tools)

| Tool | Description |
| ------ | ------------- |
| `game_get_errors` | Get new push_error/push_warning messages since last call |
| `game_get_logs` | Get new print output since last call |

## Enhanced Input (8 tools)

| Tool | Description |
| ------ | ------------- |
| `game_key_hold` | Hold a key down (no auto-release), e.g. WASD movement testing |
| `game_key_release` | Release a held key |
| `game_scroll` | Mouse scroll wheel event |
| `game_mouse_drag` | Drag between two points over N frames |
| `game_gamepad` | Gamepad button or axis input |
| `game_touch` | Simulate touch press/release/drag and gestures |
| `game_input_state` | Query pressed keys, mouse position, connected pads |
| `game_input_action` | Manage runtime InputMap actions and strength |

## Project Creation (5 tools)

| Tool | Description |
| ------ | ------------- |
| `create_project` | Create a new Godot project (pass `dotnet: true` to scaffold a .NET/C# project with a `.csproj` whose `Godot.NET.Sdk` version matches your installed Godot) |
| `create_csharp_script` | Create an idiomatic C# script (partial class, correct `_Ready`/`_Process` override signatures, class name kept in sync with the file name) |
| `manage_autoloads` | Add, remove, or list autoloads |
| `manage_input_map` | Add, remove, or list input actions and key bindings |
| `manage_export_presets` | Create or modify export presets |

## Advanced Runtime (23 tools)

| Tool | Description |
| ------ | ------------- |
| `game_get_camera` | Get active camera position/rotation/zoom |
| `game_set_camera` | Move or rotate the active camera |
| `game_raycast` | Cast a ray and return collision results (auto-detects 2D vs 3D) |
| `game_get_audio` | Get audio bus layout and playing streams |
| `game_spawn_node` | Create a new node of any type at runtime with properties |
| `game_set_shader_param` | Set a shader parameter on a node's material |
| `game_audio_play` | Play, stop, or pause an AudioStreamPlayer node |
| `game_audio_bus` | Set volume, mute, or solo on an audio bus |
| `game_navigate_path` | Query a navigation path between two points (2D/3D) |
| `game_tilemap` | Get or set cells in a TileMapLayer node |
| `game_add_collision` | Add a collision shape to a physics body node |
| `game_environment` | Get or set environment and post-processing settings (fog, glow, SSAO, tonemap, etc.) |
| `game_manage_group` | Add or remove a node from a group, or list groups |
| `game_create_timer` | Create a Timer node with configuration |
| `game_set_particles` | Configure GPUParticles2D/3D properties and process materials |
| `game_create_animation` | Create animations with value/method/bezier/audio tracks and keyframes |
| `game_serialize_state` | Save or load entire node tree state as JSON |
| `game_physics_body` | Configure physics body properties (mass, velocity, damping, friction, bounce) |
| `game_create_joint` | Create physics joints (pin, spring, hinge, cone, slider) |
| `game_bone_pose` | Get or set skeleton bone poses for character animation |
| `game_ui_theme` | Apply color, constant, and font size theme overrides to a Control node |
| `game_viewport` | Create or configure a SubViewport node |
| `game_debug_draw` | Draw debug geometry (lines, spheres, boxes) in 3D |

## Build & Export (3 tools)

| Tool | Description |
| ------ | ------------- |
| `export_project` | Export a Godot project using a preset (CI/CD ready) |
| `manage_ci_pipeline` | Create/read GitHub Actions workflow for automated Godot exports |
| `manage_docker_export` | Create Dockerfile for headless Godot export |

## Networking (4 tools)

| Tool | Description |
| ------ | ------------- |
| `game_http_request` | HTTP GET/POST/PUT/DELETE with headers and body |
| `game_websocket` | WebSocket client connect/disconnect/send messages |
| `game_multiplayer` | ENet multiplayer create server/client/disconnect |
| `game_rpc` | Call or configure RPC methods on nodes |

Networking tools belong to the `network` privileged group and are denied by
default.

## System & Window (6 tools)

| Tool | Description |
| ------ | ------------- |
| `game_script` | Attach, detach, or get source of node scripts at runtime |
| `game_window` | Get/set window size, fullscreen, title, position |
| `game_os_info` | Get platform, locale, screen, adapter, memory info |
| `game_time_scale` | Get/set Engine.time_scale and timing info |
| `game_process_mode` | Set node process mode (pausable/always/disabled) |
| `game_world_settings` | Get/set gravity, physics FPS, and world settings |

## 3D Rendering & Geometry (14 tools)

| Tool | Description |
| ------ | ------------- |
| `game_csg` | Create/configure CSG nodes with boolean operations |
| `game_multimesh` | Create/configure MultiMeshInstance3D for instancing |
| `game_procedural_mesh` | Generate meshes via ArrayMesh from vertex data |
| `game_light_3d` | Create/configure 3D lights (directional/omni/spot) |
| `game_mesh_instance` | Create MeshInstance3D with primitive meshes |
| `game_gridmap` | GridMap set/get/clear cells and query used cells |
| `game_3d_effects` | Create ReflectionProbe, Decal, or FogVolume |
| `game_gi` | Create/configure VoxelGI or LightmapGI |
| `game_path_3d` | Create Path3D/Curve3D and manage curve points |
| `game_sky` | Create/configure Sky with procedural/physical sky |
| `game_camera_attributes` | Configure DOF, exposure, auto-exposure on camera |
| `game_navigation_3d` | Create/configure NavigationRegion3D and bake |
| `game_physics_3d` | Area3D queries and point/shape intersection tests |
| `game_terrain` | Create/modify terrain meshes from heightmap data |

## 2D Systems (7 tools)

| Tool | Description |
| ------ | ------------- |
| `game_canvas` | Create/configure CanvasLayer and CanvasModulate |
| `game_canvas_draw` | 2D drawing: line/rect/circle/polygon/text/clear |
| `game_light_2d` | Create/configure 2D lights and light occluders |
| `game_parallax` | Create/configure ParallaxBackground and layers |
| `game_shape_2d` | Line2D/Polygon2D point manipulation |
| `game_path_2d` | Path2D/Curve2D management and AnimatedSprite2D |
| `game_physics_2d` | Area2D queries and 2D point/shape intersections |

## Advanced Animation (3 tools)

| Tool | Description |
| ------ | ------------- |
| `game_animation_tree` | AnimationTree state machine travel and params |
| `game_animation_control` | AnimationPlayer seek/queue/speed/info control |
| `game_skeleton_ik` | SkeletonIK3D start/stop/set target position |

## Advanced Audio (3 tools)

| Tool | Description |
| ------ | ------------- |
| `game_audio_effect` | Add/remove/configure audio bus effects |
| `game_audio_bus_layout` | Create/remove/reorder audio buses and routing |
| `game_audio_spatial` | Configure AudioStreamPlayer3D spatial properties |

## Editor & Project Tools (14 tools)

| Tool | Description |
| ------ | ------------- |
| `rename_file` | Rename or move a file within the project |
| `manage_resource` | Read or modify .tres/.res resource files |
| `create_script` | Create a GDScript file from a template |
| `validate_script` | Check a GDScript file for syntax/type errors headlessly, returning `{ valid, errors: [{ message, file, line }] }` |
| `validate_scripts` | Batch-check GDScript files (git-changed by default, or the whole project) |
| `manage_scene_signals` | List/add/remove signal connections in .tscn files |
| `manage_layers` | List/set named layer definitions in project |
| `manage_plugins` | List/enable/disable editor plugins |
| `manage_shader` | Create or read .gdshader files |
| `manage_theme_resource` | Create/read/modify Theme .tres resources |
| `set_main_scene` | Set the main scene in project.godot |
| `manage_scene_structure` | Rename/duplicate/move nodes within .tscn scenes |
| `manage_translations` | List/add/remove translation files in project |
| `game_locale` | Set/get locale and translate strings at runtime |

## UI Controls (8 tools)

| Tool | Description |
| ------ | ------------- |
| `game_ui_control` | Set focus, anchors, tooltip, mouse filter on Control |
| `game_ui_text` | LineEdit/TextEdit/RichTextLabel text operations |
| `game_ui_popup` | Show/hide/popup for Popup/Dialog/Window nodes |
| `game_ui_tree` | Tree control: get/select/collapse/add/remove items |
| `game_ui_item_list` | ItemList/OptionButton: get/select/add/remove items |
| `game_ui_tabs` | TabContainer/TabBar: get/set current tab |
| `game_ui_menu` | PopupMenu/MenuBar: add/remove/get menu items |
| `game_ui_range` | ProgressBar/Slider/SpinBox/ColorPicker get/set |

## Rendering & Resources (4 tools)

| Tool | Description |
| ------ | ------------- |
| `game_render_settings` | Get/set MSAA, FXAA, TAA, scaling mode/scale |
| `game_resource` | Runtime resource load, save, or preload |
| `game_visual_shader` | Create and edit VisualShader graphs: add/connect/disconnect nodes |
| `game_video` | Video playback control: play, pause, stop, seek on VideoStreamPlayer |
