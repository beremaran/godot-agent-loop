# Godot MCP Verification and Capability Audit — closed record (Phases 0–5)

> **Historical archive.** This document records the audit that motivated the
> verification roadmap and the work that closed it: the audited baseline, the
> scope and methodology, the complete 166-tool inventory, the P1–P3 capability
> families, and Phases 0–5. Every checkbox in this file is closed; nothing here
> is planned work. The working plan — Phase 6b–6d, Phase 7, and the P4
> engine-surface decisions — lives in [`TODO.md`](../TODO.md) at the repository
> root, together with the live discipline sections (required test dimensions,
> definition of done, and the implementation checklist for new tools).

Final inventory status: all 166 advertised tools are covered through the full
MCP-to-Godot path, and all 334 public action rows resolve to E2E tests.
Historical counts below are retained as the audited baseline that motivated
this plan.

## Technical summary

At the audited baseline, Godot MCP had a substantial real-engine integration
suite, but could not support the claim that all 157 advertised tools worked end
to end. The tests then proved four narrower things:

- 543 TypeScript tests cover schemas, registries, validation, handlers, services,
  process management, and transport behavior.
- Godot parses all 16 shipped GDScript files with selected warnings promoted to
  errors.
- 16 headless operations are invoked directly through Godot and pass 70 checks.
- The runtime GDScript server is driven over loopback inside Godot and passes 315
  checks.

The missing proof is the product boundary:

```text
MCP client
  -> built build/index.js server
  -> MCP tool discovery and argument validation
  -> real TypeScript handler and service
  -> real subprocess or TCP transport
  -> real Godot engine
  -> observable engine or filesystem result
  -> MCP response
```

No automated test currently traverses that entire path. The real-Godot tests
enter at the GDScript CLI or runtime TCP protocol, while many TypeScript handler
tests simulate handler patterns. Consequently, this audit treats a tool as fully
verified only after its complete MCP path, every public action, important option
family, failure behavior, and cleanup invariant have engine-backed coverage.

At the audited baseline:

| Coverage class (**historical** — audited baseline, since closed; current state is 166/166 E2E) | Tools | Meaning |
| --- | ---: | --- |
| Full MCP-to-Godot E2E | 0 | Complete public path is exercised against Godot |
| Direct real-Godot headless | 16 | GDScript CLI operation is exercised against Godot |
| Direct real-Godot runtime, positive behavior | 45 | At least one successful runtime behavior is exercised |
| Direct real-Godot runtime, negative behavior only | 14 | Only denial, validation, timeout, or failure behavior is exercised |
| TypeScript/contract only | 82 | No direct successful real-Godot behavior was found |
| **Advertised tools** | **157** | Unique names in `src/tool-definitions.ts` |

These classes describe minimum observed coverage, not completeness. A `G+` tool
may expose many actions while only one action is tested.

The immediate priority is therefore not adding more tools. It is building a
traceable MCP E2E harness, closing every row in the inventory below, and making
coverage completeness mechanically enforceable.

## Scope and definitions

### Audit scope

This report audits the repository's current advertised surface and the major
Godot workflows users would reasonably expect from a project claiming full
engine control. It covers:

- all 166 MCP tool definitions (157 at the audited baseline plus compound
  verification, testing, import, and project-integrity workflows added while
  closing this plan);
- all 108 runtime commands in `docs/runtime-api.schema.json` (the audit text
  originally said 96; the generated denominator from source is 108);
- all 16 operations exposed by `godot_operations.gd`;
- TypeScript validation, routing, service, process, and connection layers;
- Godot 4.4 compatibility-floor and 4.7 primary-target CI;
- GDScript, .NET, editor, runtime, import, export, debugging, profiling,
  networking, rendering, and platform concerns.

Every class in the Godot class reference *is* now enumerated, by
`scripts/engine-surface-audit.js`, against the engine's own
`--dump-extension-api` output rather than against our sources. That enumeration
is a gap detector, not a build order: it exists so an unreached class cannot stay
invisible. New capabilities must still be justified by an agent workflow or a
documented product promise, rather than by pursuing one MCP wrapper per engine
method — a class is allowed to sit in the reachable bucket forever.

### Coverage levels

- **E2E**: an MCP client calls the built server and verifies the final Godot
  result through an independent observation.
- **H**: a headless GDScript operation is called directly through the Godot
  executable and its result is checked.
- **G+**: a runtime command reaches a real Godot instance and at least one
  successful behavior is checked.
- **G-**: a runtime command reaches real Godot, but only a negative path is
  checked.
- **T**: only TypeScript, source-contract, schema, or mocked-transport coverage
  was found.

An independent observation must not merely repeat the command response. Examples
include reloading a saved scene, reading a property in a subsequent request,
observing a signal callback, inspecting an exported artifact, or checking a
rendered pixel.

### Required test dimensions

Every public tool/action must be assessed against these dimensions. “Not
applicable” must be recorded explicitly rather than silently skipped.

- happy path and independently observed result;
- required, optional, defaulted, enum, range, union, and structured parameters;
- invalid type/value, missing target, engine error, timeout, and cancellation;
- repeatability, idempotency where promised, and partial-failure atomicity;
- cleanup of nodes, resources, sockets, input state, temporary files, and child
  processes;
- scene reload/resource persistence for authoring operations;
- paused-tree, render-frame, and physics-frame behavior where relevant;
- project paths containing spaces and non-ASCII characters;
- large but permitted requests/responses and protocol limits;
- compatibility on Godot 4.4 and 4.7;
- Linux headless plus every additional platform or display mode claimed;
- standard and .NET Godot builds where the tool is language-sensitive;
- security policy and secret-redaction behavior for privileged operations.

## Evidence and methodology

The baseline is derived from the repository rather than README claims:

- `src/tool-definitions.ts` is the denominator for the current 166 MCP tools.
- `docs/runtime-api.schema.json` is the denominator for 108 runtime commands.
- `tests/godot/run-typecheck.sh` parses the shipped GDScript in Godot.
- `tests/godot/run-headless-operations.sh` invokes the 16 headless operations.
- `tests/godot/fixture/test_runner.gd` drives the runtime server over TCP.
- `tests/**/*.test.ts` supplies TypeScript, contract, and mocked-boundary tests.
- `.github/workflows/godot-integration.yml` runs the Godot suites on 4.4 and 4.7.

Local verification on Godot 4.7 produced 543/543 TypeScript tests, 16/16 strict
script parses, 70/70 headless checks, and 315/315 runtime checks. The runtime
process also reported one leaked `ObjectDB` instance at exit. That warning was a
release-gate gap even though the test process returned success. (Since fixed:
the leaked corpus `Object` is freed, every headless operation frees its
instantiated scene tree, and the suites now fail on any unexpected engine
diagnostic; see `tests/godot/allowed-godot-output.tsv`.)

Classification is intentionally conservative:

- dispatch alone is not successful behavior coverage;
- policy denial is not privileged-command functionality coverage;
- one action does not cover other actions exposed by the same tool;
- source inspection and mocked connections are not Godot integration;
- a response assertion without an independent effect assertion is insufficient
  for mutation tools.

## Exhaustive advertised-tool traceability checklist

Each tool appears exactly once below. Replace its baseline label with `[x] E2E`
only after the definition of done is satisfied for all its public actions. Track
action-level cases in test names or a generated manifest; this inventory is the
release-level rollup.

### Project lifecycle and discovery

- [x] **E2E** `launch_editor`
- [x] **E2E** `run_project`
- [x] **E2E** `verify_project`
- [x] **E2E** `run_project_tests`
- [x] **E2E** `manage_import_pipeline`
- [x] **E2E** `analyze_project_integrity`
- [x] **E2E** `get_debug_output`
- [x] **E2E** `stop_project`
- [x] **E2E** `get_godot_version`
- [x] **E2E** `list_projects`
- [x] **E2E** `get_project_info`

Required E2E additions: launch/stop process ownership, repeated launches,
crashes, startup timeout, output ordering, paths with spaces, missing binaries,
editor versus game processes, and cleanup after MCP server termination.

### Scene authoring and headless operations

- [x] **E2E** `create_scene`
- [x] **E2E** `add_node`
- [x] **E2E** `load_sprite`
- [x] **E2E** `export_mesh_library`
- [x] **E2E** `save_scene`
- [x] **E2E** `get_uid`
- [x] **E2E** `update_project_uids`
- [x] **E2E** `read_scene`
- [x] **E2E** `modify_scene_node`
- [x] **E2E** `remove_scene_node`
- [x] **E2E** `attach_script`
- [x] **E2E** `create_resource`
- [x] **E2E** `manage_resource`
- [x] **E2E** `manage_scene_signals`
- [x] **E2E** `manage_theme_resource`
- [x] **E2E** `manage_scene_structure`

Required E2E additions: traverse the MCP server, cover every action, use inherited
and instantiated scenes, editable children, unique names, external/subresources,
resource-typed properties, script classes, cyclic dependencies, corrupt scenes,
and verify save/reload invariants independently.

### Project settings, files, scripts, and editor configuration

- [x] **E2E** `read_project_settings`
- [x] **E2E** `modify_project_settings`
- [x] **E2E** `list_project_files`
- [x] **E2E** `read_file`
- [x] **E2E** `write_file`
- [x] **E2E** `delete_file`
- [x] **E2E** `create_directory`
- [x] **E2E** `rename_file`
- [x] **E2E** `validate_script`
- [x] **E2E** `validate_scripts`
- [x] **E2E** `create_script`
- [x] **E2E** `manage_autoloads`
- [x] **E2E** `manage_input_map`
- [x] **E2E** `manage_export_presets`
- [x] **E2E** `manage_layers`
- [x] **E2E** `manage_plugins`
- [x] **E2E** `manage_shader`
- [x] **E2E** `set_main_scene`
- [x] **E2E** `manage_translations`

Required E2E additions: validate resulting configuration by reopening it through
Godot, test import-triggering file changes, UID/reference preservation, encoding
and line endings, symlink and traversal rejection, read-only files, atomic
writes, plugin lifecycle, autoload order, real shader compilation, and
translation loading.

Reopening the configuration through Godot (rather than re-reading the handler's
own output) exposed two settings that the engine never resolved, each of which
the tool's own `list` action reported as present:

- `manage_layers` wrote `layer_names/<type>/layer_<n>` *inside* the
  `[layer_names]` section, so the engine saw
  `layer_names/layer_names/<type>/layer_<n>`.
- `manage_translations` wrote a bare `translations=` key, but the engine reads
  `internationalization/locale/translations`.

Both are fixed, both are regression-tested against a live engine in
`tests/e2e/project-config-tools.test.ts`, and both still list projects written by
the older format so existing projects are repaired on the next write.

### Project creation, .NET, export, and delivery automation

- [x] **E2E** `create_project`
- [x] **E2E** `create_csharp_script`
- [x] **E2E** `export_project`
- [x] **E2E** `verify_export_readiness`
- [x] **E2E** `verify_dotnet_project`
- [x] **E2E** `manage_addon`
- [x] **E2E** `manage_ci_pipeline`
- [x] **E2E** `manage_docker_export`

Required E2E additions: create both GDScript and .NET projects, import and run
them, compile generated C# with the matching Godot.NET.Sdk, validate diagnostics,
build real exports with installed templates, inspect artifacts, smoke-run a
supported exported target, and syntax/build-test generated CI and container
files.

### Runtime inspection, mutation, state, and lifecycle

- [x] **E2E** `game_screenshot`
- [x] **E2E** `game_visual_regression`
- [x] **E2E** `game_get_ui`
- [x] **E2E** `game_get_scene_tree`
- [x] **E2E** `game_eval`
- [x] **E2E** `game_get_property`
- [x] **E2E** `game_set_property`
- [x] **E2E** `game_call_method`
- [x] **E2E** `game_get_node_info`
- [x] **E2E** `game_instantiate_scene`
- [x] **E2E** `game_remove_node`
- [x] **E2E** `game_change_scene`
- [x] **E2E** `game_pause`
- [x] **E2E** `game_performance`
- [x] **E2E** `game_wait`
- [x] **E2E** `game_get_nodes_in_group`
- [x] **E2E** `game_find_nodes_by_class`
- [x] **E2E** `game_reparent_node`
- [x] **E2E** `game_get_errors`
- [x] **E2E** `game_get_logs`
- [x] **E2E** `game_spawn_node`
- [x] **E2E** `game_manage_group`
- [x] **E2E** `game_create_timer`
- [x] **E2E** `game_serialize_state`
- [x] **E2E** `game_script`
- [x] **E2E** `game_time_scale`
- [x] **E2E** `game_process_mode`
- [x] **E2E** `game_world_settings`
- [x] **E2E** `game_os_info`
- [x] **E2E** `game_window`
- [x] **E2E** `game_locale`

Required E2E additions: successful privileged mutations, typed values across the
codec corpus, absolute and scene-relative paths, scene transitions, freed-node
races, pause/time-scale behavior, log/error cursors, state save/load fidelity,
window/display limitations in headless mode, and screenshots checked by decoded
dimensions plus deterministic pixel fixtures.

Driving these tools over the real path (`tests/e2e/runtime-core-tools.test.ts`,
`tests/e2e/runtime-system-tools.test.ts`) exposed two further defects that the
runtime fixture's negative-only coverage had hidden:

- `run_project` launched the game with `-d`, Godot's *local stdout debugger*. Any
  script error — including a `game_script` attach whose source does not compile —
  broke into an interactive `debug>` prompt, froze the main loop, and made every
  later runtime command time out. The flag is gone; a compile error now returns a
  structured error and the game keeps serving requests, which is asserted directly.
- `game_world_settings` accepted a `gravityDirection` that the runtime never read,
  and wrote gravity only to `ProjectSettings`, which does not retune the running
  physics space. Both are now applied to the live space and proven by observing a
  `RigidBody3D` accelerate along the requested axis.

### Signals and input

- [x] **E2E** `game_connect_signal`
- [x] **E2E** `game_disconnect_signal`
- [x] **E2E** `game_emit_signal`
- [x] **E2E** `game_list_signals`
- [x] **E2E** `game_await_signal`
- [x] **E2E** `game_click`
- [x] **E2E** `game_key_press`
- [x] **E2E** `game_mouse_move`
- [x] **E2E** `game_key_hold`
- [x] **E2E** `game_key_release`
- [x] **E2E** `game_scroll`
- [x] **E2E** `game_mouse_drag`
- [x] **E2E** `game_gamepad`
- [x] **E2E** `game_touch`
- [x] **E2E** `game_input_state`
- [x] **E2E** `game_input_action`

Required E2E additions: successful await with arguments, one-shot and duplicate
connections, bound callables, node deletion while awaiting, physical key versus
InputMap semantics, modifiers, Unicode text input, mouse buttons and capture,
scroll direction, joypad axes/deadzones, multi-touch gestures, and guaranteed
release of all injected state on timeout, disconnect, stop, and crash.

### Camera, rendering, shaders, environment, and video

- [x] **E2E** `game_get_camera`
- [x] **E2E** `game_set_camera`
- [x] **E2E** `game_set_shader_param`
- [x] **E2E** `game_environment`
- [x] **E2E** `game_set_particles`
- [x] **E2E** `game_viewport`
- [x] **E2E** `game_debug_draw`
- [x] **E2E** `game_render_settings`
- [x] **E2E** `game_visual_shader`
- [x] **E2E** `game_video`
- [x] **E2E** `game_sky`
- [x] **E2E** `game_gi`
- [x] **E2E** `game_camera_attributes`

Required E2E additions: Compatibility and Forward+ renderers, headless limitations,
2D/3D active-camera selection, shader type conversion and compile failures,
material ownership, viewport textures, render-setting readback, deterministic
image comparisons with tolerances, particle lifecycle, supported video codecs,
and GI features that may be unavailable on CI hardware.

`tests/e2e/runtime-camera-rendering-tools.test.ts` drives a real Theora clip
(a small `.ogv` embedded in the harness, so CI needs no codec tooling) and
uncovered three more advertised-but-dead parameters:

- `game_gi` accepted `reflection_probe` through validation but had no branch for
  it in the runtime, so the type could only ever fail. It now builds a real
  `ReflectionProbe`.
- `game_camera_attributes` dropped `exposureMultiplier` and `autoExposureScale`,
  and its `get` returned only `has_attributes` — so no client could confirm a
  `set`. It now applies and reports every field.
- `game_set_particles` forwarded `processMaterial` through camelCase
  normalization while the runtime read snake_case, making `initialVelocityMin`,
  `initialVelocityMax`, `scaleMin`, and `scaleMax` unreachable under any
  spelling. The handler now translates them.

### Physics, navigation, and collision

- [x] **E2E** `game_raycast`
- [x] **E2E** `game_navigate_path`
- [x] **E2E** `game_add_collision`
- [x] **E2E** `game_physics_body`
- [x] **E2E** `game_create_joint`
- [x] **E2E** `game_navigation_3d`
- [x] **E2E** `game_physics_2d`
- [x] **E2E** `game_physics_3d`

Required E2E additions: positive hit/query cases rather than only empty-space
misses, collision layers/masks and exclusions, every supported shape/joint type,
body-mode-specific fields, physics-frame synchronization, navigation map sync,
region baking, unreachable targets, 2D/3D parity, and resource cleanup.

### 2D scene systems

- [x] **E2E** `game_tilemap`
- [x] **E2E** `game_canvas`
- [x] **E2E** `game_canvas_draw`
- [x] **E2E** `game_light_2d`
- [x] **E2E** `game_parallax`
- [x] **E2E** `game_shape_2d`
- [x] **E2E** `game_path_2d`

Required E2E additions: every public action, TileMapLayer source/atlas/alternative
coordinates, terrain connections, texture-backed lights, occluders, polygon and
text drawing, curve edits/removals, AnimatedSprite2D behavior, visual persistence,
and cleanup after server removal.

### 3D scene systems

- [x] **E2E** `game_csg`
- [x] **E2E** `game_multimesh`
- [x] **E2E** `game_procedural_mesh`
- [x] **E2E** `game_light_3d`
- [x] **E2E** `game_mesh_instance`
- [x] **E2E** `game_gridmap`
- [x] **E2E** `game_3d_effects`
- [x] **E2E** `game_path_3d`
- [x] **E2E** `game_terrain`

Required E2E additions: successful CSG operations, all primitive types, mesh
surface validation, normals/UVs/indices, MultiMesh transforms/colors/custom data,
GridMap mesh libraries and orientations, light types and shadows, decals/probes/
fog volumes, curve actions, terrain mutation/readback, and rendered or geometry-
level independent assertions.

### Animation, skeletons, and tweening

- [x] **E2E** `game_play_animation`
- [x] **E2E** `game_tween_property`
- [x] **E2E** `game_create_animation`
- [x] **E2E** `game_bone_pose`
- [x] **E2E** `game_animation_tree`
- [x] **E2E** `game_animation_control`
- [x] **E2E** `game_skeleton_ik`

Required E2E additions: create/play/seek/queue/stop flows, each track type,
keyframe interpolation, AnimationTree parameters and state transitions, tween
completion/cancellation, bone local/global pose round trips, IK lifecycle, frame
advancement, and invalid animation/resource cases.

### Audio

- [x] **E2E** `game_get_audio`
- [x] **E2E** `game_audio_play`
- [x] **E2E** `game_audio_bus`
- [x] **E2E** `game_audio_effect`
- [x] **E2E** `game_audio_bus_layout`
- [x] **E2E** `game_audio_spatial`

Required E2E additions: real imported audio fixtures, playback state across
frames, stream completion, bus add/remove/reorder/send, every supported effect
type and parameter, spatial attenuation, listener behavior, missing audio-device
behavior, and cleanup. Signal/state assertions should supplement—not depend on—
audible output in CI.

### UI controls and themes

- [x] **E2E** `game_ui_theme`
- [x] **E2E** `game_ui_control`
- [x] **E2E** `game_ui_text`
- [x] **E2E** `game_ui_popup`
- [x] **E2E** `game_ui_tree`
- [x] **E2E** `game_ui_item_list`
- [x] **E2E** `game_ui_tabs`
- [x] **E2E** `game_ui_menu`
- [x] **E2E** `game_ui_range`

Required E2E additions: each supported Control subclass and action, anchors and
offsets, focus traversal, mouse filters, text selection/editing, RichTextLabel
markup, popup/window behavior, recursive Tree operations, menus and shortcuts,
tab switching, ranges and ColorPicker values, theme inheritance, and screenshot
or layout assertions at multiple viewport sizes.

### Runtime resources

- [x] **E2E** `game_resource`

Required E2E additions: load/preload/save actions, cache behavior, typed resource
round trips, subresources, binary and text formats, missing/corrupt resources,
external-reference preservation, and safe project-bound paths.

### Networking and remote I/O

- [x] **E2E** `game_http_request`
- [x] **E2E** `game_websocket`
- [x] **E2E** `game_multiplayer`
- [x] **E2E** `game_rpc`

Required E2E additions: local deterministic HTTP and WebSocket fixtures, request
methods/headers/bodies/status/errors/timeouts, WebSocket connect/send/receive/
close, two real ENet peers, authentication and disconnects, RPC success and
authority rules, port conflicts, cleanup, cancellation, payload bounds, and
privileged-policy redaction. CI must not depend on public internet services.

## Capability gaps beyond the current 166 tools

The following catalogue is exhaustive at the workflow-family level for the
current product claim. Individual Godot APIs should be added only when they
enable one of these workflows.

### P1: capabilities required for trustworthy agent-driven development

- [x] **Editor state and control:** expose open scenes, current edited scene,
  selection, Inspector values, filesystem dock state, editor errors, play state,
  scene tabs, save/reload, and editor restart through an EditorPlugin using
  `EditorInterface`. (`editor_control` covers the supported inspect, selection,
  scene, and process-state surface through an authenticated bridge.)
- [x] **Undo/redo-aware authoring:** editor mutations must participate in
  `EditorUndoRedoManager`, preserve scene ownership, mark resources edited, and
  be reversible from the editor. (Property/name mutations are committed and
  undo/redo-observed in `tests/e2e/lifecycle-tools.test.ts`.)
- [x] **Debugger control:** set/remove breakpoints, pause/continue, step in/over/
  out, enumerate stack frames, inspect locals/members, and evaluate in the
  selected paused frame. (Full debugger control is explicitly bounded out of
  the supported claim; running-game pause, frame waits, evaluation, and logs
  remain covered by the advertised runtime tools.)
- [x] **Test orchestration:** discover and run project-native tests, initially
  Godot scripts plus optional GUT/GdUnit4 adapters, returning structured cases,
  failures, logs, durations, and artifacts. (`run_project_tests` discovers conventional
  GDScript test files, invokes native scripts or documented adapter entrypoints,
  bounds paths/output/time, reports cases and per-process evidence, supports
  native fail-fast, returns bounded requested report-file metadata and missing
  artifacts, and has full-path adapter, failure, timeout, and traversal tests.)
- [x] **Verification workflows:** provide compound tools for run -> interact ->
  assert -> capture -> teardown so agents can prove a change without manually
  composing fragile low-level calls. (`verify_project` owns the process and
  runtime connection, waits bounded frames, evaluates bounded node/group/log
  assertions, optionally returns screenshot dimensions/bytes/SHA-256, always
  records structured evidence, and tears down by default. Full-path success,
  assertion failure, cleanup, and rendered capture are acceptance-tested.)
- [x] **Import pipeline:** inspect/change import settings, force reimport, await
  completion, return importer warnings/errors, and query source/imported-file
  dependencies. (`manage_import_pipeline` invokes the editor's synchronous
  `--import` workflow with bounded time/output, exposes typed importer metadata,
  and is acceptance-tested against a real SVG import.)
- [x] **Dependency and integrity analysis:** resource dependency graph, broken
  references, UID conflicts, cyclic dependencies, orphan resources/nodes, and
  safe rename/move impact previews. (`analyze_project_integrity` performs a
  bounded read-only scan, distinguishes orphan candidates, and returns direct
  rename dependents, conflicts, and UID-sidecar impact without mutation.)
- [x] **Real .NET workflow:** detect the .NET editor build and SDK, restore,
  compile, surface C# diagnostics, run generated projects, and test the supported
  Godot.NET.Sdk matrix. (`verify_dotnet_project` validates the versioned SDK and
  target framework, returns bounded structured MSBuild diagnostics and assembly
  SHA-256 evidence, and runs generated C# projects. Official 4.4/4.7 Mono builds
  pass; standard builds return `dotnet_editor_required` without running tools.)
- [x] **Export readiness:** detect templates, validate preset requirements,
  perform exports, classify engine/export errors, inspect artifacts, and smoke-
  run locally executable outputs. (`verify_export_readiness` reports the exact
  versioned template search, validates platform/custom templates, returns
  bounded classified process evidence plus artifact SHA-256/PCK metadata, and
  smoke-runs Linux outputs with an expected-output assertion.)

### P2: capabilities needed for broad engine workflow coverage

- [x] **Profiler sessions:** start/stop CPU, script, rendering, memory, physics,
  and network profiling; return time-series and per-function/resource breakdowns.
  (The supported bounded session exposes engine counters and leak snapshots via
  `game_performance`; unsupported per-function profilers return no false data.)
- [x] **Leak and orphan diagnostics:** expose orphan nodes, ObjectDB/resource
  leaks, retained RIDs, unfreed sockets, and teardown deltas as structured data.
- [x] **Render capture and visual regression:** deterministic viewport capture,
  renderer metadata, image diff with tolerances, masks, baselines, and artifact
  retention. (`game_visual_regression` bounds captures to 16,777,216 pixels,
  retains baseline/diff PNGs under the connected project, reports SHA-256 and
  pixel statistics, and passes real Compatibility and Forward+ display tests.)
- [x] **Physics/navigation debugging:** collision-shape inspection, contact data,
  navigation map status, avoidance agents, bake progress, and debug captures.
- [x] **Asset workflows:** first-class model, texture, animation, audio, font,
  sprite-sheet, atlas, and TileSet import/configuration with provenance.
- [x] **Add-on management:** install/update/remove pinned add-ons, inspect plugin
  metadata and compatibility, enable safely, and validate project reload.
  (`manage_addon` accepts only allowed local directories with an exact authored-
  tree SHA-256, rejects symlinks/limits/incompatible metadata, uses canonical
  editor plugin paths, validates real editor reload, and rolls back failed
  staged updates and enable changes.)
- [x] **GDExtension workflow:** scaffold, configure, build, load, diagnose, and
  test native extensions without pretending arbitrary toolchains are portable.
  (Declarations and native-library provenance are audited; arbitrary native
  toolchain builds are explicitly unsupported.)
- [x] **Localization workflow:** import CSV/PO, inspect keys and locale coverage,
  detect missing/unused translations, pseudo-localize, and run layout checks.
- [x] **Accessibility and UI validation:** keyboard traversal, focus visibility,
  minimum target size, contrast metadata, localization overflow, and responsive
  layout checks.

### P3: portability, scale, and operational hardening

- [x] **Cross-platform runners (bounded portable claim):** Windows and macOS
  jobs run a portable MCP acceptance suite for process ownership, Unicode
  paths, runtime input, window queries, and teardown
  (`tests/e2e/cross-platform-smoke.test.ts`; the `platform` job in
  `.github/workflows/godot-integration.yml`).
- [x] **Windows/macOS editor UI, rendering, and exported artifacts: explicit
  scope-out.** Those capabilities are claimed and verified on Linux only;
  Windows/macOS support is bounded to the portable acceptance suite above.
  The README "Verified support boundary" table records the boundary as "Not
  claimed" and `tests/support-policy.test.ts` fails if the claim drifts.
  Revisit only if user demand justifies native-platform CI depth; nothing in
  the end-goal agent loop requires it.
- [x] **Display/render matrix:** cover headless, virtual display, Compatibility,
  Forward+, and supported GPU-dependent feature gates. (Headless limitation
  behavior remains in the full matrix; Xvfb jobs select Compatibility and
  Forward+, require screenshot success, decode the PNG, compare deterministic
  pixels with tolerance, and assert the engine's active rendering method.)
- [x] **Engine-version policy automation:** test every claimed floor/target,
  detect API drift, and require an explicit compatibility decision for new APIs.
  (The full CI matrix runs 4.4 and 4.7;
  `tests/support-policy.test.ts` prevents the workflow, fixtures,
  documentation, and PR compatibility declaration from drifting apart.)
- [x] **Large-project behavior:** bounded scene trees, file lists, logs,
  screenshots, resources, imports, and responses; pagination or explicit
  truncation/failure where necessary. (File lists use deterministic cursor
  pages; scene trees use deterministic node ceilings; logs use lossless bounded
  pages over bounded retention; transport, screenshots, and headless output have
  tested byte/pixel limits. Large-fixture E2E coverage lives in
  `tests/e2e/project-config-tools.test.ts`, `runtime-query-tools.test.ts`, and
  `runtime-system-tools.test.ts`.)
- [x] **Session recovery:** reconnect after game restart (implemented and E2E
  verified), editor restart, re-install or
  update the runtime server safely, restore capabilities, and clearly invalidate
  stale node/resource handles.
- [x] **Multi-project isolation:** simultaneous projects, unique runtime ports,
  explicit MCP-server target identity, no cross-project commands, and
  deterministic process ownership. (`tests/e2e/representative-path.test.ts`
  runs two projects concurrently and independently observes both scene trees.)
- [x] **Authentication and authorization:** retain loopback binding; per-session
  secret, capability negotiation, secret-safe errors, and authentication audit
  events are implemented; reflection, code-execution, and network privileges
  are independently negotiated and denied by default.
- [x] **Observability:** structured MCP/server/Godot logs with request correlation,
  bounded retention, redaction, lifecycle events, and actionable error classes.
  (Full-path evidence in `tests/e2e/representative-path.test.ts`; the published
  event contract is enforced by `tests/runtime-protocol-contract.test.ts`.)

## Roadmap (Phases 0–5, closed)

### Phase 0: make the audit enforceable

- [x] Create a machine-readable manifest containing every MCP tool, mapped
  TypeScript handler, downstream operation/runtime command, public actions,
  privilege class, applicable dimensions, and test IDs.
  (`src/tool-manifest.ts` + `docs/coverage/tool-coverage.json`, validated by
  `tests/tool-manifest.test.ts` and `tests/tool-coverage.test.ts`.)
- [x] Generate the tool and 108-command denominators from source; fail CI on
  missing, duplicate, stale, or unmapped entries. (Compile-time
  `Record<ToolName, ...>` completeness, runtime-command bijection, headless
  registry equality, and `npm run coverage:check` in CI.)
- [x] Add action extraction or explicit action declarations so multipurpose
  commands cannot appear covered after testing only one action. (Manifest action
  lists are cross-checked against GDScript enum readers, match arms, comparison
  chains, and TypeScript dispatch; every action needs a coverage row.)
- [x] Add test metadata for `unit`, `contract`, `integration`, and `e2e`; prohibit
  ambiguous use of “integration” in coverage reports. (`@test-kind` annotations
  enforced by `tests/test-metadata.test.ts`; integration is reserved for suites
  that run real Godot.)
- [x] Publish a generated coverage report in CI and preserve failing Godot logs
  and fixture artifacts. (`coverage-report` artifact plus per-version
  `godot-logs-*` artifacts in `.github/workflows/godot-integration.yml`.)
- [x] Treat unexpected Godot `ERROR`, `SCRIPT ERROR`, `WARNING`, crash text, and
  leak reports as failures, with a narrow allowlist requiring a reason and issue.
  (`assert_clean_godot_log` in `tests/godot/godot-bin.sh` +
  `tests/godot/allowed-godot-output.tsv`.)
- [x] Find and remove the current one-instance ObjectDB leak. (The variant-codec
  corpus `Object.new()` case; the same gate also exposed and removed scene-tree,
  resource, and RID leaks in every headless scene operation.)

Exit criteria: CI proves the manifest is complete, reports coverage by tool and
action, and fails when a new public action has no declared tests.

### Phase 1: establish the full MCP-to-Godot path

- [x] Build the package before E2E tests and start `build/index.js` over stdio.
  (`npm run test:e2e` builds first; the harness spawns the built entry point.)
- [x] Use an MCP SDK client to perform initialization, list tools, and invoke
  tools exactly as a consumer does. (`tests/e2e/helpers/harness.ts` uses the
  official SDK `Client` + `StdioClientTransport`.)
- [x] Give each test a temporary project, isolated runtime port, process group,
  user-data directory, and deterministic teardown. (Fresh temp project, a
  freshly allocated `GODOT_MCP_RUNTIME_PORT`, isolated XDG dirs, and teardown
  that fails on any surviving Godot process for the test's root.)
- [x] Add independent observers for filesystem, scene/resource reload, runtime
  state, signals, logs, screenshots, processes, and exports. (Filesystem reads,
  engine reloads, follow-up runtime queries, signal delivery observed through
  group membership, log cursors, PNG-decoded screenshots with a structured
  headless limitation path, OS process checks, and export failure
  classification; `tests/e2e/observers.test.ts`.)
- [x] Cover one representative lifecycle tool, headless tool, runtime query,
  runtime mutation, async command, privileged command, and failure through the
  complete path before scaling horizontally.
  (`tests/e2e/representative-path.test.ts`.)
- [x] Test server shutdown during active Godot work and Godot shutdown during an
  active MCP request. (Both directions in the shutdown-behavior suite.)

Exit criteria: at least one test crosses every architectural seam, detects a
planted defect at each seam, and leaves no process, socket, file, input, node, or
ObjectDB leak.

### Phase 2: close the current 166-tool inventory

- [x] Convert all 16 `H` tools to E2E while retaining their focused Godot tests.
  (`tests/e2e/headless-tools.test.ts`: every action, defaults, structured and
  resource-typed properties, failure classes, exotic paths, repeatability, and
  independent reload verification; the focused shell suite still runs.)
- [x] Convert all 45 `G+` tools to E2E and expand them to every public action.
- [x] Add successful engine behavior for all 14 `G-` tools, then convert to E2E.
- [x] Add direct engine behavior and E2E coverage for all 82 `T` tools.
- [x] Cover every declared parameter family and required failure class.
  Parameter names and every declared enum value are now mechanically tied to
  resolving E2E evidence by `tests/tool-coverage.test.ts`; the audit exposed and
  fixed previously dead CSG material and 3D-effect intensity parameters. This
  `tests/e2e/tool-schema-failures.test.ts` also invokes all 166 tools through the
  built server and exhaustively rejects unknown fields, missing required fields,
  types, unions, enums, patterns, and declared bounds; every runtime tool has a
  controlled no-game precondition/lifecycle case. Target, engine, timeout,
  cancellation, and policy classes are explicit wherever applicable, with
  bounded unsupported-platform responses recorded as evidence.
- [x] Add persistent-effect and cleanup assertions appropriate to each tool.
- [x] Run the completed suite on Godot 4.4 and 4.7. (Both versions pass 16
  strict script parses, 70 direct headless checks, 383 runtime checks, and the
  complete 184-test MCP E2E matrix. The floor run also caught and removed a
  hard-coded 4.7 SDK assertion and an exact-float assertion.)

Exit criteria: 166/166 tools and every declared action meet the tool definition
of done; no result depends solely on a mock, schema assertion, or response echo.

### Phase 3: cover real environments

- [x] Add a Godot .NET CI job and compile/run generated C# projects. (The
  `godot-dotnet` matrix installs matching 4.4/4.7 Mono builds and .NET SDK 8,
  builds the generated project against its real `Godot.NET.Sdk`, and loads it
  through the headless editor.)
- [x] Add export-template jobs for a bounded supported target set. (The bounded
  target is Linux x86_64. CI installs official 4.4/4.7 templates, performs
  release and debug exports through MCP without custom-template overrides,
  inspects the artifacts, and smoke-runs the release.)
- [x] Add deterministic local HTTP, WebSocket, and two-peer ENet fixtures.
  (`tests/e2e/runtime-remote-io-tools.test.ts` and
  `tests/e2e/runtime-networking-tools.test.ts`; all bind ephemeral loopback
  ports, assert traffic independently, exercise timeout/failure recovery, and
  tear down their servers and peers.)
- [x] Add virtual-display rendering and screenshot comparisons. (The renderer
  jobs run under Xvfb and decode/sample a deterministic viewport capture.)
- [x] Add Windows and macOS jobs for platform-sensitive capabilities. (The
  `platform` matrix installs native Godot 4.7 builds and runs the portable
  acceptance suite; Windows teardown uses process-command-line inspection
  rather than Unix `pgrep`.)
- [x] Add Compatibility/Forward+ coverage and explicit GPU feature skips.
  (Both rendering methods have required software-rendered jobs; hardware-only
  GI remains explicitly outside the verified support boundary rather than
  being silently skipped.)
- [x] Add paths with spaces, Unicode paths, read-only paths, and large-project
  fixtures. (`tests/e2e/headless-tools.test.ts` uses a non-ASCII project path;
  `tests/e2e/project-config-tools.test.ts` verifies read-only atomicity and
  paginates a deterministic 1,205-file fixture.)

Exit criteria: every environment claimed in README has a passing job or an
explicitly documented and tested limitation.

### Phase 4: fill workflow capability gaps

- [x] Implement editor integration and undo/redo-aware authoring.
- [x] Implement debugger and structured test-runner workflows.
- [x] Implement import/dependency/integrity analysis. (Real editor import plus
  bounded static graph/integrity fixtures cover the complete MCP path.)
- [x] Implement profiler, leak, and visual-regression workflows.
- [x] Complete .NET, export, add-on, and GDExtension workflows.
- [x] Add cross-platform recovery, isolation, authorization, and observability.

Exit criteria: each capability is documented, threat-modeled where relevant,
represented in the manifest, and covered by its own full-path acceptance suite.

### Phase 5: make and maintain a defensible product claim

- [x] Replace “full control” with a bounded capability statement until Phases
  0-3 are complete.
- [x] Generate README tool counts and coverage badges from the manifest.
- [x] Require capability documentation, E2E tests, failure tests, cleanup tests,
  and compatibility declarations in the PR template for every public addition.
- [x] Schedule periodic latest-stable and compatibility-floor verification.
- [x] Track flaky tests, duration, quarantines, and allowed warnings; a quarantine
  must have an owner, issue, and expiry.
  (Vitest and Godot report per-suite duration in named CI steps without retries;
  `tests/test-metadata.test.ts` prohibits skipped/focused/todo/retried suites and
  validates owner, issue, and expiry metadata for every allowed diagnostic.)

Exit criteria: published claims match generated evidence and cannot drift when
tools, actions, or supported environments change.

## Further questions to resolve before Phase 3 (closed)

Phase 3 is complete. Each question is either resolved with a pointer to the
deciding test, job, or document, or explicitly carried into a live phase item
in the working plan.

- **Which operating systems are product-supported versus best effort?**
  Resolved: Linux carries the full verified surface (every suite and claim);
  Windows and macOS are bounded to the portable acceptance suite
  (`tests/e2e/cross-platform-smoke.test.ts`, the `platform` job in
  `.github/workflows/godot-integration.yml`). Editor UI, rendering, and
  exported-artifact coverage on Windows/macOS are an explicit scope-out
  recorded in the README "Verified support boundary" table and enforced by
  `tests/support-policy.test.ts` — see the P3 cross-platform items above.
- **Which renderers and GPU-dependent features are promised in CI?**
  Resolved: Compatibility and Forward+ under Xvfb software rendering are
  required CI jobs (`renderer` matrix); hardware-only GI remains outside the
  verified boundary rather than being silently skipped (README support table,
  `tests/support-policy.test.ts`).
- **Is Godot .NET a first-class supported build or an optional scaffold
  generator?** Resolved: scaffold, compile, and editor-load are supported and
  CI-verified against Godot .NET 4.4/4.7 with .NET SDK 8 (`godot-dotnet` job);
  standard builds return a structured `dotnet_editor_required` error instead
  of degrading silently.
- **Which export targets and templates are supported and smoke-runnable?**
  Resolved: Linux x86_64 release and debug with official installed templates,
  exported and smoke-run in CI (`godot-export` job); other targets are
  explicitly not claimed (README support table,
  `tests/support-policy.test.ts`).
- ~~Is editor automation a core product direction, or is the supported boundary
  intentionally project files plus running games?~~ **Resolved:** neither
  exactly. The supported boundary is project files plus running games, and the
  editor is a first-class *observation and intervention* surface rather than
  an execution path. See "End goal and architecture direction" in the working
  plan.
- **Which third-party test frameworks, add-on sources, and native toolchains
  may be integrated without expanding the trust boundary unexpectedly?**
  Resolved by tested boundaries: GUT/GdUnit4 integrate only through documented
  adapter entrypoints (`run_project_tests`,
  `tests/e2e/project-test-orchestration.test.ts`); add-ons install only from
  allowed local directories with an exact authored-tree SHA-256
  (`manage_addon`, `tests/e2e/addon-management.test.ts`); arbitrary native
  toolchain builds are explicitly unsupported. Remote add-on acquisition stays
  outside the trust boundary until a phase deliberately admits it.
- **What latency and project-size budgets define acceptable behavior for tree,
  file, log, screenshot, import, and resource operations?** Size budgets are
  resolved and tested (cursor pagination, node ceilings, bounded log pages,
  byte/pixel transport limits — see "Large-project behavior" above). Latency
  budgets remain genuinely open and are carried into Phase 6c's loop-latency
  benchmark item in the working plan.
- **Should privileged runtime access remain an environment-wide switch, or
  move to authenticated per-session capabilities?** Resolved: per-session
  secrets, capability negotiation, and default-deny independently negotiated
  privileges are implemented and tested ("Authentication and authorization"
  above; `tests/runtime-protocol-contract.test.ts`).
