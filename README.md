
<img width="2752" height="1536" alt="godot_mcp_header" src="https://github.com/user-attachments/assets/ed7ac605-8fb5-4a5f-adf8-4b6912cbc18c" />

# Godot MCP - Engine Automation

[![MCP Server](https://badge.mcpx.dev?type=server 'MCP Server')](https://modelcontextprotocol.io/introduction)
[![Made with Godot](https://img.shields.io/badge/Made%20with-Godot-478CBF?style=flat&logo=godot%20engine&logoColor=white)](https://godotengine.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white 'TypeScript')](https://www.typescriptlang.org/)
[![MIT License](https://img.shields.io/badge/License-MIT-red.svg 'MIT License')](https://opensource.org/licenses/MIT)

A [Model Context Protocol](https://modelcontextprotocol.io/introduction) (MCP)
server for project-file authoring, headless engine operations,
and inspection or mutation of running Godot games. Every advertised tool and
public action has a full MCP-to-Godot test. Support remains intentionally
bounded by the environment matrix below; editor UI automation, debugger
control, and native extension builds are not claimed.

<!-- generated-coverage-badge:start -->
[![E2E tools: 166/166](https://img.shields.io/badge/E2E_tools-166%2F166-brightgreen)](docs/coverage/coverage-report.md)
<!-- generated-coverage-badge:end -->

## Acknowledgments

This project is built upon and extends [godot-mcp](https://github.com/Coding-Solo/godot-mcp) by [Solomon Elias (Coding-Solo)](https://github.com/Coding-Solo). The original project provided the foundational architecture including the TypeScript MCP server, headless GDScript operations system, and TCP-based runtime interaction server. Thank you for making this possible with your excellent open-source work!

## What's New (Improvements Over Original)

The original godot-mcp provided 20 tools for basic project management and scene
creation. This fork substantially extends that surface with the following major
additions:

### New in 3.0

- **.NET / C# support** - Scaffold C# projects and generate C# scripts (`create_project` with `dotnet: true`, `create_csharp_script`); the `.csproj` SDK version is matched to your installed Godot.
- **GDScript diagnostics** - Validate scripts for syntax and type errors without running the game (`validate_script`, and `validate_scripts` for all git-changed or project-wide files).
- **Correctness and robustness fixes** across the headless scene operations and the runtime interaction server (resource-typed properties now persist, reparenting works, runtime commands are correlated by request id, and the tools survive projects with warnings-as-errors). Godot **4.7** is recommended; Godot 4.4 remains the tested compatibility floor.

### Runtime Code Execution

- **`game_eval`** - Execute arbitrary GDScript code in the running game with return values
- Full `await` support for async GDScript code
- Works even when the game is paused (`PROCESS_MODE_ALWAYS`)

### Editor state and undo/redo

- **`editor_control`** - Inspect the edited scene and selection, open/save/reload
  scenes, and apply reversible property or node-name edits through
  `EditorUndoRedoManager`. `launch_editor` installs the authenticated bridge
  for the lifetime of the MCP-owned editor session.

### Runtime Node Inspection & Manipulation

- **`game_get_property`** / **`game_set_property`** - Read/write any property on any node by path
- **`game_call_method`** - Call any method on any node with arguments
- **`game_get_node_info`** - Full node introspection: properties, signals, methods, children
- **`game_instantiate_scene`** - Dynamically add scenes to the running game
- **`game_remove_node`** - Remove nodes at runtime
- **`game_change_scene`** - Switch scenes at runtime
- **`game_reparent_node`** - Move nodes between parents

### Signal System

- **`game_connect_signal`** - Wire up signal connections at runtime
- **`game_disconnect_signal`** - Remove signal connections
- **`game_emit_signal`** - Emit signals with arguments

### Animation & Tweening

- **`game_play_animation`** - Control AnimationPlayer (play, stop, pause, list)
- **`game_tween_property`** - Smooth property animation with configurable easing

### Game Control & Debugging

- **`game_pause`** - Pause/unpause the game
- **`game_performance`** - FPS, frame time, memory, object counts, draw calls,
  bounded profiler sessions, and live orphan-node diagnostics
- **`game_wait`** - Wait N frames (timing-sensitive operations)
- **`game_get_nodes_in_group`** - Query nodes by group
- **`game_find_nodes_by_class`** - Find all nodes of a specific class

### Headless Scene Operations (No Running Game Needed)

- **`read_scene`** - Parse any .tscn file and get full node tree with properties as JSON
- **`modify_scene_node`** - Change node properties in scene files
- **`remove_scene_node`** - Remove nodes from scene files
- **`attach_script`** - Attach GDScript files to nodes in scenes
- **`create_resource`** - Create .tres resource files (materials, themes, etc.)

### Project Management

- **`read_project_settings`** - Parse project.godot as structured JSON
- **`modify_project_settings`** - Change project settings programmatically
- **`list_project_files`** - Paginate project files with extension/subdirectory filters
- **`run_project_tests`** - Discover or run native, GUT, and GdUnit4 tests with structured results
- **`manage_import_pipeline`** - Inspect/change import metadata, synchronously reimport, and trace imported files
- **`analyze_project_integrity`** - Find dependency/integrity defects and preview rename impact without mutation
- **`verify_export_readiness`** - Validate templates/presets, export, inspect artifacts, and smoke-run supported builds
- **`verify_dotnet_project`** - Detect managed prerequisites, restore/build, report diagnostics, and run C# projects
- **`manage_addon`** - Install and manage hash-pinned local EditorPlugins with rollback and reload validation

### File I/O

- **`read_file`** / **`write_file`** / **`delete_file`** - Full file system access within Godot projects
- **`create_directory`** - Create directory structures for scripts, scenes, assets

### Error & Log Capture

- **`game_get_errors`** - Get new push_error/push_warning messages since last call
- **`game_get_logs`** - Get new print output from the running game since last call

### Enhanced Input

- **`game_key_hold`** / **`game_key_release`** - Hold keys down for movement testing (WASD etc.)
- **`game_scroll`** - Mouse scroll wheel events
- **`game_mouse_drag`** - Drag between two points over multiple frames
- **`game_gamepad`** - Gamepad button and axis input events

### Project Creation & Configuration

- **`create_project`** - Create a new Godot project from scratch (pass `dotnet: true` to scaffold a .NET/C# project)
- **`create_csharp_script`** - Create a C# script in a Godot .NET project
- **`manage_autoloads`** - Add, remove, or list autoloads
- **`manage_input_map`** - Add, remove, or list input actions and key bindings
- **`manage_export_presets`** - Create or modify export preset configuration

### .NET / C# Support

- **`create_project`** with `dotnet: true` - Scaffold a Godot .NET project (`.csproj` with `Godot.NET.Sdk` matched to your Godot version, plus the `"C#"` feature flag)
- **`create_csharp_script`** - Generate an idiomatic C# script (partial class, correct `_Ready`/`_Process` override signatures); the class name is kept in sync with the file name so Godot can attach it
- **`get_project_info`** reports an `isDotnet` field

### GDScript Diagnostics

- **`validate_script`** - Check a single GDScript file for syntax and type errors headlessly, returning `{ valid, errors: [{ message, file, line }] }`
- **`validate_scripts`** - Batch-validate all git-changed `.gd` files (or the whole project), so an agent can verify its edits before running the game

### Camera, Physics & Audio

- **`game_get_camera`** / **`game_set_camera`** - Query and control 2D/3D cameras
- **`game_raycast`** - Cast physics rays (auto-detects 2D vs 3D)
- **`game_get_audio`** - Get audio bus layout and playing streams
- **`game_spawn_node`** - Create any node type at runtime with properties
- **`game_set_shader_param`** - Set shader parameters on materials
- **`game_audio_play`** / **`game_audio_bus`** - Full audio playback and bus control
- **`game_navigate_path`** - Query navigation paths (2D/3D)
- **`game_tilemap`** - Get/set TileMapLayer cells
- **`game_add_collision`** - Add collision shapes to physics bodies
- **`game_environment`** - Configure post-processing (fog, glow, SSAO, tonemap, etc.)
- **`game_manage_group`** - Add/remove nodes from groups
- **`game_create_timer`** - Create timer nodes programmatically
- **`game_set_particles`** - Configure GPUParticles2D/3D properties and process materials
- **`game_create_animation`** - Create animations with value/method/bezier/audio tracks and keyframes
- **`export_project`** - Trigger headless project export builds (CI/CD ready)
- **`game_serialize_state`** - Save/load entire node tree state as JSON
- **`game_physics_body`** - Configure mass, velocity, damping, friction, bounce
- **`game_create_joint`** - Create physics joints (pin, spring, hinge, cone, slider)
- **`game_bone_pose`** - Get/set skeleton bone poses for character animation
- **`game_ui_theme`** - Apply color, constant, and font size theme overrides
- **`game_viewport`** - Create/configure SubViewport nodes
- **`game_debug_draw`** - Draw debug geometry (lines, spheres, boxes)

### Networking

- **`game_http_request`** - HTTP GET/POST/PUT/DELETE with headers and body
- **`game_websocket`** - WebSocket client connect/disconnect/send messages
- **`game_multiplayer`** - ENet multiplayer create server/client/disconnect
- **`game_rpc`** - Call or configure RPC methods on nodes

### System & Window Control

- **`game_script`** - Attach, detach, or get source of node scripts at runtime
- **`game_window`** - Get/set window size, fullscreen, title, position
- **`game_os_info`** - Get platform, locale, screen, adapter, memory info
- **`game_time_scale`** - Get/set Engine.time_scale and timing info
- **`game_process_mode`** - Set node process mode (pausable/always/disabled)
- **`game_world_settings`** - Get/set gravity, physics FPS, and world settings

### Advanced Signals & Input

- **`game_list_signals`** - List all signals on a node with connections
- **`game_await_signal`** - Await a signal with timeout and return args
- **`game_touch`** - Simulate touch press/release/drag and gestures
- **`game_input_state`** - Query pressed keys, mouse position, connected pads
- **`game_input_action`** - Manage runtime InputMap actions and strength

### 3D Rendering & Geometry

- **`game_csg`** - Create/configure CSG nodes with boolean operations
- **`game_multimesh`** - Create/configure MultiMeshInstance3D for instancing
- **`game_procedural_mesh`** - Generate meshes via ArrayMesh from vertex data
- **`game_light_3d`** - Create/configure 3D lights (directional/omni/spot)
- **`game_mesh_instance`** - Create MeshInstance3D with primitive meshes
- **`game_gridmap`** - GridMap set/get/clear cells and query used cells
- **`game_3d_effects`** - Create ReflectionProbe, Decal, or FogVolume
- **`game_gi`** - Create/configure VoxelGI or LightmapGI
- **`game_path_3d`** - Create Path3D/Curve3D and manage curve points
- **`game_sky`** - Create/configure Sky with procedural/physical sky
- **`game_camera_attributes`** - Configure DOF, exposure, auto-exposure on camera
- **`game_navigation_3d`** - Create/configure NavigationRegion3D and bake
- **`game_physics_3d`** - Area3D queries and point/shape intersection tests

### 2D Systems

- **`game_canvas`** - Create/configure CanvasLayer and CanvasModulate
- **`game_canvas_draw`** - 2D drawing: line/rect/circle/polygon/text/clear
- **`game_light_2d`** - Create/configure 2D lights and light occluders
- **`game_parallax`** - Create/configure ParallaxBackground and layers
- **`game_shape_2d`** - Line2D/Polygon2D point manipulation
- **`game_path_2d`** - Path2D/Curve2D management and AnimatedSprite2D
- **`game_physics_2d`** - Area2D queries and 2D point/shape intersections

### Advanced Animation

- **`game_animation_tree`** - AnimationTree state machine travel and params
- **`game_animation_control`** - AnimationPlayer seek/queue/speed/info control
- **`game_skeleton_ik`** - SkeletonIK3D start/stop/set target position

### Advanced Audio

- **`game_audio_effect`** - Add/remove/configure audio bus effects
- **`game_audio_bus_layout`** - Create/remove/reorder audio buses and routing
- **`game_audio_spatial`** - Configure AudioStreamPlayer3D spatial properties

### Editor & Project Tools

- **`rename_file`** - Rename or move a file within the project
- **`manage_resource`** - Read or modify .tres/.res resource files
- **`create_script`** - Create a GDScript file from a template
- **`validate_script`** - Check a GDScript file for syntax/type errors headlessly (no run needed)
- **`validate_scripts`** - Batch-check GDScript files: git-changed ones by default, or all
- **`manage_scene_signals`** - List/add/remove signal connections in .tscn files
- **`manage_layers`** - List/set named layer definitions in project
- **`manage_plugins`** - List/enable/disable editor plugins
- **`manage_shader`** - Create or read .gdshader files
- **`manage_theme_resource`** - Create/read/modify Theme .tres resources
- **`set_main_scene`** - Set the main scene in project.godot
- **`manage_scene_structure`** - Rename/duplicate/move nodes within .tscn scenes
- **`manage_translations`** - List/add/remove translation files in project
- **`game_locale`** - Set/get locale and translate strings at runtime

### UI Controls

- **`game_ui_control`** - Set focus, anchors, tooltip, mouse filter on Control
- **`game_ui_text`** - LineEdit/TextEdit/RichTextLabel text operations
- **`game_ui_popup`** - Show/hide/popup for Popup/Dialog/Window nodes
- **`game_ui_tree`** - Tree control: get/select/collapse/add/remove items
- **`game_ui_item_list`** - ItemList/OptionButton: get/select/add/remove items
- **`game_ui_tabs`** - TabContainer/TabBar: get/set current tab
- **`game_ui_menu`** - PopupMenu/MenuBar: add/remove/get menu items
- **`game_ui_range`** - ProgressBar/Slider/SpinBox/ColorPicker get/set

### Rendering & Resources

- **`game_render_settings`** - Get/set MSAA, FXAA, TAA, scaling mode/scale
- **`game_resource`** - Runtime resource load, save, or preload

### Robustness Improvements

- **Reentrancy guard** - Prevents concurrent command processing during async operations
- **Full type conversion** - Supports Vector2/3, Color, Quaternion, Basis, Transform2D/3D, AABB, Rect2, and all packed array types
- **Smart property type detection** - Uses node's `get_property_list()` for automatic type conversion
- **PackedArray serialization** - Proper JSON arrays instead of string fallback
- **Graceful error handling** - Scene read fallback to raw .tscn text on missing dependencies

## Tool inventory

### Project Management (14 tools)

| Tool | Description |
| ------ | ------------- |
| `launch_editor` | Launch Godot editor for a project |
| `run_project` | Run a Godot project and capture output |
| `verify_project` | Run, assert bounded runtime evidence, optionally capture, and tear down |
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
| `get_project_info` | Get project metadata |

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

### Scene Management (7 tools)

| Tool | Description |
| ------ | ------------- |
| `create_scene` | Create a new scene with a root node type |
| `add_node` | Add a node to an existing scene |
| `load_sprite` | Load a texture into a Sprite2D node |
| `export_mesh_library` | Export a scene as MeshLibrary |
| `save_scene` | Save a scene (with optional variant path) |
| `get_uid` | Get UID for a file (Godot 4.4+) |
| `update_project_uids` | Resave resources to update UIDs |

### Headless Scene Operations (5 tools)

| Tool | Description |
| ------ | ------------- |
| `read_scene` | Read full scene tree as JSON |
| `modify_scene_node` | Modify node properties in a scene file |
| `remove_scene_node` | Remove a node from a scene file |
| `attach_script` | Attach a GDScript to a scene node |
| `create_resource` | Create a .tres resource file |

### Project Settings (3 tools)

| Tool | Description |
| ------ | ------------- |
| `read_project_settings` | Parse project.godot as JSON |
| `modify_project_settings` | Change a project setting |
| `list_project_files` | Paginate/filter project files |

### Runtime Input (5 tools)

| Tool | Description |
| ------ | ------------- |
| `game_screenshot` | Capture a screenshot (base64 PNG) |
| `game_visual_regression` | Capture baselines or compare frames with masks, tolerances, and retained PNG diffs |
| `game_click` | Click at a position |
| `game_key_press` | Send key press or input action |
| `game_mouse_move` | Move the mouse |

### Runtime Inspection (3 tools)

| Tool | Description |
| ------ | ------------- |
| `game_get_ui` | Get all visible UI elements |
| `game_get_scene_tree` | Get full scene tree structure |
| `game_get_node_info` | Detailed node introspection |

### Runtime Code Execution (1 tool)

| Tool | Description |
| ------ | ------------- |
| `game_eval` | Execute arbitrary GDScript with return values |

### Runtime Node Manipulation (7 tools)

| Tool | Description |
| ------ | ------------- |
| `game_get_property` | Get any node property |
| `game_set_property` | Set any node property (auto type conversion) |
| `game_call_method` | Call any method on a node |
| `game_instantiate_scene` | Add a PackedScene to the running tree |
| `game_remove_node` | Remove a node from the tree |
| `game_change_scene` | Switch to a different scene |
| `game_reparent_node` | Move a node to a new parent |

### Runtime Signals (5 tools)

| Tool | Description |
| ------ | ------------- |
| `game_connect_signal` | Connect a signal to a method |
| `game_disconnect_signal` | Disconnect a signal |
| `game_emit_signal` | Emit a signal with arguments |
| `game_list_signals` | List all signals on a node with connections |
| `game_await_signal` | Await a signal with timeout and return args |

### Runtime Animation (2 tools)

| Tool | Description |
| ------ | ------------- |
| `game_play_animation` | Control AnimationPlayer |
| `game_tween_property` | Tween a property with easing |

### Runtime Utilities (5 tools)

| Tool | Description |
| ------ | ------------- |
| `game_pause` | Pause/unpause the game |
| `game_performance` | Get FPS, memory, draw calls |
| `game_wait` | Wait N frames |
| `game_get_nodes_in_group` | Query nodes by group |
| `game_find_nodes_by_class` | Find nodes by class type |

### File I/O (4 tools)

| Tool | Description |
| ------ | ------------- |
| `read_file` | Read a text file from a Godot project |
| `write_file` | Create or overwrite a text file |
| `delete_file` | Delete a file from a project |
| `create_directory` | Create a directory inside a project |

### Error & Log Capture (2 tools)

| Tool | Description |
| ------ | ------------- |
| `game_get_errors` | Get new errors/warnings since last call |
| `game_get_logs` | Get new print output since last call |

### Enhanced Input (8 tools)

| Tool | Description |
| ------ | ------------- |
| `game_key_hold` | Hold a key down (no auto-release) |
| `game_key_release` | Release a held key |
| `game_scroll` | Mouse scroll wheel event |
| `game_mouse_drag` | Drag between two points over N frames |
| `game_gamepad` | Gamepad button or axis input |
| `game_touch` | Simulate touch press/release/drag and gestures |
| `game_input_state` | Query pressed keys, mouse position, connected pads |
| `game_input_action` | Manage runtime InputMap actions and strength |

### Project Creation (5 tools)

| Tool | Description |
| ------ | ------------- |
| `create_project` | Create a new Godot project (supports `dotnet: true` for C#) |
| `create_csharp_script` | Create a C# script in a Godot .NET project |
| `manage_autoloads` | Add, remove, or list autoloads |
| `manage_input_map` | Add, remove, or list input actions |
| `manage_export_presets` | Create or modify export presets |

### Advanced Runtime (24 tools)

| Tool | Description |
| ------ | ------------- |
| `game_get_camera` | Get active camera position/rotation/zoom |
| `game_set_camera` | Move or rotate the active camera |
| `game_raycast` | Cast a ray and return collision results |
| `game_get_audio` | Get audio bus layout and playing streams |
| `game_spawn_node` | Create a new node of any type at runtime |
| `game_set_shader_param` | Set a shader parameter on a node's material |
| `game_audio_play` | Play, stop, or pause an AudioStreamPlayer node |
| `game_audio_bus` | Set volume, mute, or solo on an audio bus |
| `game_navigate_path` | Query a navigation path between two points |
| `game_tilemap` | Get or set cells in a TileMapLayer node |
| `game_add_collision` | Add a collision shape to a physics body node |
| `game_environment` | Get or set environment and post-processing settings |
| `game_manage_group` | Add or remove a node from a group, or list groups |
| `game_create_timer` | Create a Timer node with configuration |
| `game_set_particles` | Configure GPUParticles2D/3D node properties |
| `game_create_animation` | Create an animation with tracks and keyframes |
| `game_serialize_state` | Save or load node tree state as JSON |
| `game_physics_body` | Configure physics body properties (mass, velocity) |
| `game_create_joint` | Create a physics joint between two bodies |
| `game_bone_pose` | Get or set bone poses on a Skeleton3D node |
| `game_ui_theme` | Apply theme overrides to a Control node |
| `game_viewport` | Create or configure a SubViewport node |
| `game_debug_draw` | Draw debug lines, spheres, or boxes in 3D |

### Build & Export (1 tool)

| Tool | Description |
| ------ | ------------- |
| `export_project` | Export a Godot project using a preset |

### Networking (4 tools)

| Tool | Description |
| ------ | ------------- |
| `game_http_request` | HTTP GET/POST/PUT/DELETE with headers and body |
| `game_websocket` | WebSocket client connect/disconnect/send messages |
| `game_multiplayer` | ENet multiplayer create server/client/disconnect |
| `game_rpc` | Call or configure RPC methods on nodes |

### System & Window (6 tools)

| Tool | Description |
| ------ | ------------- |
| `game_script` | Attach, detach, or get source of node scripts |
| `game_window` | Get/set window size, fullscreen, title, position |
| `game_os_info` | Get platform, locale, screen, adapter, memory info |
| `game_time_scale` | Get/set Engine.time_scale and timing info |
| `game_process_mode` | Set node process mode (pausable/always/disabled) |
| `game_world_settings` | Get/set gravity, physics FPS, and world settings |

### 3D Rendering & Geometry (13 tools)

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

### 2D Systems (7 tools)

| Tool | Description |
| ------ | ------------- |
| `game_canvas` | Create/configure CanvasLayer and CanvasModulate |
| `game_canvas_draw` | 2D drawing: line/rect/circle/polygon/text/clear |
| `game_light_2d` | Create/configure 2D lights and light occluders |
| `game_parallax` | Create/configure ParallaxBackground and layers |
| `game_shape_2d` | Line2D/Polygon2D point manipulation |
| `game_path_2d` | Path2D/Curve2D management and AnimatedSprite2D |
| `game_physics_2d` | Area2D queries and 2D point/shape intersections |

### Advanced Animation (3 tools)

| Tool | Description |
| ------ | ------------- |
| `game_animation_tree` | AnimationTree state machine travel and params |
| `game_animation_control` | AnimationPlayer seek/queue/speed/info control |
| `game_skeleton_ik` | SkeletonIK3D start/stop/set target position |

### Advanced Audio (3 tools)

| Tool | Description |
| ------ | ------------- |
| `game_audio_effect` | Add/remove/configure audio bus effects |
| `game_audio_bus_layout` | Create/remove/reorder audio buses and routing |
| `game_audio_spatial` | Configure AudioStreamPlayer3D spatial properties |

### Editor & Project Tools (14 tools)

| Tool | Description |
| ------ | ------------- |
| `rename_file` | Rename or move a file within the project |
| `manage_resource` | Read or modify .tres/.res resource files |
| `create_script` | Create a GDScript file from a template |
| `validate_script` | Check a GDScript file for syntax/type errors (headless) |
| `validate_scripts` | Batch-check GDScript files (git-changed by default, or all) |
| `manage_scene_signals` | List/add/remove signal connections in .tscn files |
| `manage_layers` | List/set named layer definitions in project |
| `manage_plugins` | List/enable/disable editor plugins |
| `manage_shader` | Create or read .gdshader files |
| `manage_theme_resource` | Create/read/modify Theme .tres resources |
| `set_main_scene` | Set the main scene in project.godot |
| `manage_scene_structure` | Rename/duplicate/move nodes within .tscn scenes |
| `manage_translations` | List/add/remove translation files in project |
| `game_locale` | Set/get locale and translate strings at runtime |

### UI Controls (8 tools)

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

### Rendering & Resources (2 tools)

| Tool | Description |
| ------ | ------------- |
| `game_render_settings` | Get/set MSAA, FXAA, TAA, scaling mode/scale |
| `game_resource` | Runtime resource load, save, or preload |

## Requirements

- [Godot Engine](https://godotengine.org/download) 4.4 or later; the latest stable release, currently Godot **4.7**, is recommended
- (Optional) [.NET SDK](https://dotnet.microsoft.com/download) 8.0+ and the Godot .NET (C#) build, only if you use `create_project`'s `dotnet: true` flag or `create_csharp_script`
- [Node.js](https://nodejs.org/) >= 18.0.0
- An AI assistant that supports MCP (Claude Code, Cline, Cursor, etc.)

### Godot compatibility policy

Development targets the latest stable Godot release. The project also keeps a
tested compatibility floor while the same implementation remains cleanly
portable; currently, CI covers Godot 4.4 and 4.7. The floor may be raised when
it blocks useful features or creates meaningful maintenance cost. In that case,
the last compatible release remains available, and an older-version maintenance
branch will be created only when user demand justifies maintaining it. Such a
branch would receive critical fixes rather than new features.

### Verified support boundary

| Area | Status | Evidence or limitation |
| --- | --- | --- |
| Linux headless, Godot 4.4 and 4.7 | Verified in CI | Full MCP E2E, direct runtime, headless operations, and strict script parsing |
| GDScript project and running-game workflows | Verified for advertised tools | See the generated [coverage report](docs/coverage/coverage-report.md) |
| Privileged runtime commands | Opt-in only | Disabled by default; intended for trusted localhost development |
| Godot .NET/C# | Scaffold, compile, and editor-load verification | Godot .NET 4.4 and 4.7 with .NET SDK 8 |
| Linux exports | Release/debug template export and smoke-run verification | Godot 4.4 and 4.7 installed templates; other targets are not claimed |
| Rendering and screenshots | Headless limitations plus virtual-display pixel verification | Compatibility and Forward+ on Linux software rendering |
| Windows and macOS | Portable acceptance verified | Godot 4.7 process, Unicode path, runtime input, window query, and teardown workflows |
| Editor state and undo/redo bridge | Verified in MCP E2E | Headless editor bridge is authenticated and uses `EditorInterface` plus `EditorUndoRedoManager` |
| Full debugger control | Not claimed | Breakpoints, stack inspection, and frame-local evaluation remain outside the supported boundary |
| Profiler, leak, asset, localization, and accessibility audits | Verified in MCP E2E | `game_performance` and `analyze_project_integrity` return bounded live/static evidence; native extension builds remain unsupported |
| GDExtension builds | Not claimed | `analyze_project_integrity` inspects declarations and libraries without invoking arbitrary native toolchains |

## Installation

```bash
git clone https://github.com/beremaran/godot-mcp.git
cd godot-mcp
npm install
npm run build
```

## Configuration

### Claude Code

Add to your Claude Code MCP settings:

```json
{
  "mcpServers": {
    "godot": {
      "command": "node",
      "args": ["/absolute/path/to/godot-mcp/build/index.js"],
      "env": {
        "GODOT_PATH": "/path/to/godot",
        "DEBUG": "true"
      }
    }
  }
}
```

### Cline (VS Code)

Add to your Cline MCP settings (`cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "godot": {
      "command": "node",
      "args": ["/absolute/path/to/godot-mcp/build/index.js"],
      "disabled": false
    }
  }
}
```

### Cursor

Create `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "godot": {
      "command": "node",
      "args": ["/absolute/path/to/godot-mcp/build/index.js"]
    }
  }
}
```

## Runtime Tools Setup

To use the `game_*` runtime tools, your Godot project needs the MCP interaction server autoload. Copy `build/scripts/mcp_interaction_server.gd` to your project and register it as an autoload:

1. Copy `build/scripts/mcp_interaction_server.gd` to your project's scripts folder
2. In Godot: **Project > Project Settings > Autoload**
3. Add the script with the name `McpInteractionServer`

The server listens on `127.0.0.1:9090`. Each MCP server launch generates a
cryptographic runtime secret, passes it only to the Godot child process, and
authenticates it during capability negotiation before any runtime command is
accepted. A manually managed runtime should set the same
`GODOT_MCP_RUNTIME_SECRET` value in both processes; leaving it unset retains
legacy unauthenticated behavior and is suitable only for a trusted machine.

Commands that execute arbitrary GDScript, invoke arbitrary node properties or
methods, mutate scripts, call multiplayer peers, or make HTTP/WebSocket
connections remain disabled by default even after authentication. Grant only
the required group with `GODOT_MCP_PRIVILEGED_GROUPS`: `reflection` enables
arbitrary property/method access, `code-execution` enables eval/script control,
and `network` enables RPC, HTTP, and WebSocket. The legacy
`GODOT_MCP_ALLOW_PRIVILEGED_COMMANDS=true` grants all three groups. Use either
only for a trusted local developer workflow. Authentication and policy denials
never echo secrets, source, property values, URLs, headers, or engine errors.
Authentication success/failure emits a structured audit event containing only
the event name, runtime component, numeric session ID, and timestamp.

## Environment Variables

| Variable | Description |
| ---------- | ------------- |
| `GODOT_PATH` | Path to the Godot executable (overrides auto-detection) |
| `DEBUG` | Set to `"true"` for detailed server-side logging. This also runs the headless operations script with `--debug-godot`, which logs diagnostics and writes a temporary write-access probe file into the project (removed again on every branch). Parameter values are summarized by type and size in both logs, never printed. |
| `GODOT_MCP_ALLOWED_DIRS` | Optional. Restrict `run_project` to projects under these roots (`;`, `,`, or `:` separated). When unset, any project path is allowed. |
| `GODOT_MCP_RUNTIME_SECRET` | Optional explicit shared runtime secret. The MCP server generates a fresh 256-bit value when omitted and passes it only to Godot processes it launches. Set the same value manually only when connecting to a separately launched runtime. |
| `GODOT_MCP_PRIVILEGED_GROUPS` | Optional comma-separated least-privilege grants: `reflection`, `code-execution`, and/or `network`. All are denied by default. |
| `GODOT_MCP_ALLOW_PRIVILEGED_COMMANDS` | Optional, default `false`. Explicitly enable runtime `eval`, arbitrary property/method access, script control, RPC, HTTP, and WebSocket commands for a trusted localhost developer workflow. |

### Structured runtime evidence

With `DEBUG=true`, the MCP server emits JSON request lifecycle events to
stderr. The Godot runtime emits matching events to its captured stdout. Both
use an internal `mcp_<number>` correlation ID and controlled event fields;
parameters, response values, secrets, source, URLs, and malformed payloads are
never copied into logs. Runtime process output is capped at the latest 1,000
stdout and stderr lines. Stable JSON-RPC error codes remain the authoritative
machine-readable failure classification.

### Large-project response limits

Large responses are bounded rather than allowed to grow with project size.
`list_project_files` returns deterministic cursor pages of at most 1,000 files;
`game_get_scene_tree` returns deterministic pre-order trees of 1,000 nodes by
default (configurable up to 10,000) and reports truncation. `game_get_logs` and
`game_get_errors` return at most 1,000 unread lines per call with `hasMore` and
`remaining`, while retaining the latest 1,000 lines per stream. Runtime JSON
responses are capped at 8 MiB, screenshots additionally enforce pixel and
6 MiB PNG limits, and short-lived headless/import commands cap captured output
at 16 MiB. Limit failures are explicit; callers can narrow resource/import
queries instead of receiving partial unlabelled data.

## Architecture

The server uses two communication channels:

1. **Headless CLI** - For operations that don't need a running game (scene reading, modification, resource creation). Runs Godot with `--headless --script godot_operations.gd <operation> <json_params>`.

2. **TCP Socket** - For runtime interaction with a running game. The `mcp_interaction_server.gd` autoload listens on port 9090 and processes JSON commands sent by the TypeScript MCP server.

### Source layout

| Path | Description |
| ------ | ------------- |
| `src/index.ts` | MCP server, tool definitions, and all handlers |
| `src/utils.ts` | Pure utility functions (parameter mapping, validation, error helpers) |
| `src/scripts/godot_operations.gd` | Headless GDScript operations runner |
| `src/scripts/mcp_interaction_server.gd` | TCP interaction server autoload |
| `tests/` | Vitest test suite |

## Testing

The project uses Vitest plus direct Godot and full MCP-to-Godot suites. The
source-derived tool, action, command, and suite inventory is published in the
[coverage report](docs/coverage/coverage-report.md).

```bash
npm run check       # TypeScript tests, lint, build, and coverage drift
npm run test:e2e    # built MCP server through a real client and Godot
npm run test:godot  # strict parsing, headless operations, runtime protocol
npm run test:watch  # watch mode
```

## Example Prompts

```text
"Run my Godot project and check for errors"

"Eval this in my running game: return get_tree().current_scene.name"

"Get the player's position in the running game"

"Set the player's health to 100"

"Read the test_level.tscn scene and show me the node tree"

"Change the player's speed property in the player.tscn scene file"

"List all .gd files in my project"

"Connect the enemy's 'died' signal to the game manager's 'on_enemy_died' method"

"Tween the camera's position to (0, 10, -5) over 2 seconds with ease-out"

"Get performance metrics - what's my FPS and draw call count?"

"Pause the game and take a screenshot"

"Find all CharacterBody3D nodes in the scene"

"Create a new Godot project called 'MyGame' and write a player script"

"Create a new C# (.NET) Godot project and add a CharacterBody2D script"

"Validate player.gd for errors"

"Check all my changed GDScript files for syntax errors before I run the game"

"Hold down the W key for 2 seconds to test walking"

"Cast a ray from the player downward to check for ground"

"Get the camera position and move it to look at the player"

"Show me the latest error messages from the running game"
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Credits

- **Original project**: [godot-mcp](https://github.com/Coding-Solo/godot-mcp) by [Solomon Elias (Coding-Solo)](https://github.com/Coding-Solo) - provided the foundational MCP server architecture, headless operations system, and TCP interaction framework
- **Inherited from**: [Tugcan Topaloglu](https://github.com/tugcantopaloglu)'s repository, which extended the original project across networking, 3D/2D rendering, UI controls, audio,
  animation, file I/O, runtime code execution, project creation, and physics
- **Maintained and further extended by**: [Berke Arslan](https://github.com/beremaran)
