# Godot MCP Verification and Capability Audit

## Technical summary

Godot MCP has a substantial real-engine integration suite, but it cannot yet
support the claim that all 157 advertised tools work end to end. The current
tests prove four narrower things:

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

| Coverage class | Tools | Meaning |
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

- all 157 MCP tool definitions;
- all 108 runtime commands in `docs/runtime-api.schema.json` (the audit text
  originally said 96; the generated denominator from source is 108);
- all 16 operations exposed by `godot_operations.gd`;
- TypeScript validation, routing, service, process, and connection layers;
- Godot 4.4 compatibility-floor and 4.7 primary-target CI;
- GDScript, .NET, editor, runtime, import, export, debugging, profiling,
  networking, rendering, and platform concerns.

It does not claim to enumerate every API in the Godot class reference. New
capabilities must be justified by an agent workflow or a documented product
promise, rather than by pursuing one MCP wrapper per engine method.

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

- `src/tool-definitions.ts` is the denominator for the 157 MCP tools.
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

- [ ] **T** `launch_editor`
- [ ] **T** `run_project`
- [ ] **T** `get_debug_output`
- [ ] **T** `stop_project`
- [ ] **T** `get_godot_version`
- [ ] **T** `list_projects`
- [ ] **T** `get_project_info`

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

- [ ] **T** `read_project_settings`
- [ ] **T** `modify_project_settings`
- [ ] **T** `list_project_files`
- [ ] **T** `read_file`
- [ ] **T** `write_file`
- [ ] **T** `delete_file`
- [ ] **T** `create_directory`
- [ ] **T** `rename_file`
- [ ] **T** `validate_script`
- [ ] **T** `validate_scripts`
- [ ] **T** `create_script`
- [ ] **T** `manage_autoloads`
- [ ] **T** `manage_input_map`
- [ ] **T** `manage_export_presets`
- [ ] **T** `manage_layers`
- [ ] **T** `manage_plugins`
- [ ] **T** `manage_shader`
- [ ] **T** `set_main_scene`
- [ ] **T** `manage_translations`

Required E2E additions: validate resulting configuration by reopening it through
Godot, test import-triggering file changes, UID/reference preservation, encoding
and line endings, symlink and traversal rejection, read-only files, atomic
writes, plugin lifecycle, autoload order, real shader compilation, and
translation loading.

### Project creation, .NET, export, and delivery automation

- [ ] **T** `create_project`
- [ ] **T** `create_csharp_script`
- [ ] **T** `export_project`
- [ ] **T** `manage_ci_pipeline`
- [ ] **T** `manage_docker_export`

Required E2E additions: create both GDScript and .NET projects, import and run
them, compile generated C# with the matching Godot.NET.Sdk, validate diagnostics,
build real exports with installed templates, inspect artifacts, smoke-run a
supported exported target, and syntax/build-test generated CI and container
files.

### Runtime inspection, mutation, state, and lifecycle

- [ ] **T** `game_screenshot`
- [ ] **T** `game_get_ui`
- [ ] **G+** `game_get_scene_tree`
- [ ] **G+** `game_eval`
- [ ] **G+** `game_get_property`
- [ ] **G-** `game_set_property`
- [ ] **G-** `game_call_method`
- [ ] **T** `game_get_node_info`
- [ ] **G-** `game_instantiate_scene`
- [ ] **T** `game_remove_node`
- [ ] **G-** `game_change_scene`
- [ ] **T** `game_pause`
- [ ] **T** `game_performance`
- [ ] **G+** `game_wait`
- [ ] **T** `game_get_nodes_in_group`
- [ ] **T** `game_find_nodes_by_class`
- [ ] **T** `game_reparent_node`
- [ ] **T** `game_get_errors`
- [ ] **T** `game_get_logs`
- [ ] **T** `game_spawn_node`
- [ ] **T** `game_manage_group`
- [ ] **T** `game_create_timer`
- [ ] **T** `game_serialize_state`
- [ ] **G-** `game_script`
- [ ] **T** `game_time_scale`
- [ ] **G-** `game_process_mode`
- [ ] **T** `game_world_settings`
- [ ] **G+** `game_os_info`
- [ ] **T** `game_window`
- [ ] **T** `game_locale`

Required E2E additions: successful privileged mutations, typed values across the
codec corpus, absolute and scene-relative paths, scene transitions, freed-node
races, pause/time-scale behavior, log/error cursors, state save/load fidelity,
window/display limitations in headless mode, and screenshots checked by decoded
dimensions plus deterministic pixel fixtures.

### Signals and input

- [ ] **G+** `game_connect_signal`
- [ ] **G+** `game_disconnect_signal`
- [ ] **G+** `game_emit_signal`
- [ ] **G+** `game_list_signals`
- [ ] **G-** `game_await_signal`
- [ ] **G+** `game_click`
- [ ] **G-** `game_key_press`
- [ ] **T** `game_mouse_move`
- [ ] **G+** `game_key_hold`
- [ ] **G+** `game_key_release`
- [ ] **G-** `game_scroll`
- [ ] **G+** `game_mouse_drag`
- [ ] **T** `game_gamepad`
- [ ] **G-** `game_touch`
- [ ] **G+** `game_input_state`
- [ ] **G+** `game_input_action`

Required E2E additions: successful await with arguments, one-shot and duplicate
connections, bound callables, node deletion while awaiting, physical key versus
InputMap semantics, modifiers, Unicode text input, mouse buttons and capture,
scroll direction, joypad axes/deadzones, multi-touch gestures, and guaranteed
release of all injected state on timeout, disconnect, stop, and crash.

### Camera, rendering, shaders, environment, and video

- [ ] **T** `game_get_camera`
- [ ] **T** `game_set_camera`
- [ ] **T** `game_set_shader_param`
- [ ] **G+** `game_environment`
- [ ] **T** `game_set_particles`
- [ ] **T** `game_viewport`
- [ ] **G+** `game_debug_draw`
- [ ] **T** `game_render_settings`
- [ ] **G+** `game_visual_shader`
- [ ] **T** `game_video`
- [ ] **T** `game_sky`
- [ ] **T** `game_gi`
- [ ] **T** `game_camera_attributes`

Required E2E additions: Compatibility and Forward+ renderers, headless limitations,
2D/3D active-camera selection, shader type conversion and compile failures,
material ownership, viewport textures, render-setting readback, deterministic
image comparisons with tolerances, particle lifecycle, supported video codecs,
and GI features that may be unavailable on CI hardware.

### Physics, navigation, and collision

- [ ] **G+** `game_raycast`
- [ ] **G+** `game_navigate_path`
- [ ] **G+** `game_add_collision`
- [ ] **G+** `game_physics_body`
- [ ] **G+** `game_create_joint`
- [ ] **G+** `game_navigation_3d`
- [ ] **G+** `game_physics_2d`
- [ ] **T** `game_physics_3d`

Required E2E additions: positive hit/query cases rather than only empty-space
misses, collision layers/masks and exclusions, every supported shape/joint type,
body-mode-specific fields, physics-frame synchronization, navigation map sync,
region baking, unreachable targets, 2D/3D parity, and resource cleanup.

### 2D scene systems

- [ ] **G+** `game_tilemap`
- [ ] **G+** `game_canvas`
- [ ] **G+** `game_canvas_draw`
- [ ] **G+** `game_light_2d`
- [ ] **G+** `game_parallax`
- [ ] **G+** `game_shape_2d`
- [ ] **G+** `game_path_2d`

Required E2E additions: every public action, TileMapLayer source/atlas/alternative
coordinates, terrain connections, texture-backed lights, occluders, polygon and
text drawing, curve edits/removals, AnimatedSprite2D behavior, visual persistence,
and cleanup after server removal.

### 3D scene systems

- [ ] **G-** `game_csg`
- [ ] **T** `game_multimesh`
- [ ] **T** `game_procedural_mesh`
- [ ] **T** `game_light_3d`
- [ ] **G+** `game_mesh_instance`
- [ ] **T** `game_gridmap`
- [ ] **T** `game_3d_effects`
- [ ] **G+** `game_path_3d`
- [ ] **G+** `game_terrain`

Required E2E additions: successful CSG operations, all primitive types, mesh
surface validation, normals/UVs/indices, MultiMesh transforms/colors/custom data,
GridMap mesh libraries and orientations, light types and shadows, decals/probes/
fog volumes, curve actions, terrain mutation/readback, and rendered or geometry-
level independent assertions.

### Animation, skeletons, and tweening

- [ ] **T** `game_play_animation`
- [ ] **T** `game_tween_property`
- [ ] **T** `game_create_animation`
- [ ] **T** `game_bone_pose`
- [ ] **T** `game_animation_tree`
- [ ] **G+** `game_animation_control`
- [ ] **T** `game_skeleton_ik`

Required E2E additions: create/play/seek/queue/stop flows, each track type,
keyframe interpolation, AnimationTree parameters and state transitions, tween
completion/cancellation, bone local/global pose round trips, IK lifecycle, frame
advancement, and invalid animation/resource cases.

### Audio

- [ ] **T** `game_get_audio`
- [ ] **T** `game_audio_play`
- [ ] **T** `game_audio_bus`
- [ ] **T** `game_audio_effect`
- [ ] **G+** `game_audio_bus_layout`
- [ ] **T** `game_audio_spatial`

Required E2E additions: real imported audio fixtures, playback state across
frames, stream completion, bus add/remove/reorder/send, every supported effect
type and parameter, spatial attenuation, listener behavior, missing audio-device
behavior, and cleanup. Signal/state assertions should supplement—not depend on—
audible output in CI.

### UI controls and themes

- [ ] **G+** `game_ui_theme`
- [ ] **G+** `game_ui_control`
- [ ] **G+** `game_ui_text`
- [ ] **T** `game_ui_popup`
- [ ] **T** `game_ui_tree`
- [ ] **G+** `game_ui_item_list`
- [ ] **T** `game_ui_tabs`
- [ ] **G-** `game_ui_menu`
- [ ] **G+** `game_ui_range`

Required E2E additions: each supported Control subclass and action, anchors and
offsets, focus traversal, mouse filters, text selection/editing, RichTextLabel
markup, popup/window behavior, recursive Tree operations, menus and shortcuts,
tab switching, ranges and ColorPicker values, theme inheritance, and screenshot
or layout assertions at multiple viewport sizes.

### Runtime resources

- [ ] **G+** `game_resource`

Required E2E additions: load/preload/save actions, cache behavior, typed resource
round trips, subresources, binary and text formats, missing/corrupt resources,
external-reference preservation, and safe project-bound paths.

### Networking and remote I/O

- [ ] **G-** `game_http_request`
- [ ] **G+** `game_websocket`
- [ ] **G+** `game_multiplayer`
- [ ] **G-** `game_rpc`

Required E2E additions: local deterministic HTTP and WebSocket fixtures, request
methods/headers/bodies/status/errors/timeouts, WebSocket connect/send/receive/
close, two real ENet peers, authentication and disconnects, RPC success and
authority rules, port conflicts, cleanup, cancellation, payload bounds, and
privileged-policy redaction. CI must not depend on public internet services.

## Capability gaps beyond the current 157 tools

The following catalogue is exhaustive at the workflow-family level for the
current product claim. Individual Godot APIs should be added only when they
enable one of these workflows.

### P1: capabilities required for trustworthy agent-driven development

- [ ] **Editor state and control:** expose open scenes, current edited scene,
  selection, Inspector values, filesystem dock state, editor errors, play state,
  scene tabs, save/reload, and editor restart through an EditorPlugin using
  `EditorInterface`.
- [ ] **Undo/redo-aware authoring:** editor mutations must participate in
  `EditorUndoRedoManager`, preserve scene ownership, mark resources edited, and
  be reversible from the editor.
- [ ] **Debugger control:** set/remove breakpoints, pause/continue, step in/over/
  out, enumerate stack frames, inspect locals/members, and evaluate in the
  selected paused frame.
- [ ] **Test orchestration:** discover and run project-native tests, initially
  Godot scripts plus optional GUT/GdUnit4 adapters, returning structured cases,
  failures, logs, durations, and artifacts.
- [ ] **Verification workflows:** provide compound tools for run -> interact ->
  assert -> capture -> teardown so agents can prove a change without manually
  composing fragile low-level calls.
- [ ] **Import pipeline:** inspect/change import settings, force reimport, await
  completion, return importer warnings/errors, and query source/imported-file
  dependencies.
- [ ] **Dependency and integrity analysis:** resource dependency graph, broken
  references, UID conflicts, cyclic dependencies, orphan resources/nodes, and
  safe rename/move impact previews.
- [ ] **Real .NET workflow:** detect the .NET editor build and SDK, restore,
  compile, surface C# diagnostics, run generated projects, and test the supported
  Godot.NET.Sdk matrix.
- [ ] **Export readiness:** detect templates, validate preset requirements,
  perform exports, classify engine/export errors, inspect artifacts, and smoke-
  run locally executable outputs.

### P2: capabilities needed for broad engine workflow coverage

- [ ] **Profiler sessions:** start/stop CPU, script, rendering, memory, physics,
  and network profiling; return time-series and per-function/resource breakdowns.
- [ ] **Leak and orphan diagnostics:** expose orphan nodes, ObjectDB/resource
  leaks, retained RIDs, unfreed sockets, and teardown deltas as structured data.
- [ ] **Render capture and visual regression:** deterministic viewport capture,
  renderer metadata, image diff with tolerances, masks, baselines, and artifact
  retention.
- [ ] **Physics/navigation debugging:** collision-shape inspection, contact data,
  navigation map status, avoidance agents, bake progress, and debug captures.
- [ ] **Asset workflows:** first-class model, texture, animation, audio, font,
  sprite-sheet, atlas, and TileSet import/configuration with provenance.
- [ ] **Add-on management:** install/update/remove pinned add-ons, inspect plugin
  metadata and compatibility, enable safely, and validate project reload.
- [ ] **GDExtension workflow:** scaffold, configure, build, load, diagnose, and
  test native extensions without pretending arbitrary toolchains are portable.
- [ ] **Localization workflow:** import CSV/PO, inspect keys and locale coverage,
  detect missing/unused translations, pseudo-localize, and run layout checks.
- [ ] **Accessibility and UI validation:** keyboard traversal, focus visibility,
  minimum target size, contrast metadata, localization overflow, and responsive
  layout checks.

### P3: portability, scale, and operational hardening

- [ ] **Cross-platform runners:** add Windows and macOS coverage for process,
  path, editor, input, window, and export behavior; document truly Linux-only
  capabilities.
- [ ] **Display/render matrix:** cover headless, virtual display, Compatibility,
  Forward+, and supported GPU-dependent feature gates.
- [ ] **Engine-version policy automation:** test every claimed floor/target,
  detect API drift, and require an explicit compatibility decision for new APIs.
- [ ] **Large-project behavior:** bounded scene trees, file lists, logs,
  screenshots, resources, imports, and responses; pagination or streaming where
  necessary.
- [ ] **Session recovery:** reconnect after game/editor restart, re-install or
  update the runtime server safely, restore capabilities, and clearly invalidate
  stale node/resource handles.
- [ ] **Multi-project isolation:** simultaneous projects, unique runtime ports,
  explicit target identity, no cross-project commands, and deterministic process
  ownership.
- [ ] **Authentication and authorization:** retain loopback binding but add a
  per-session secret, capability negotiation, least-privilege command groups,
  audit events, and secret-safe errors.
- [ ] **Observability:** structured MCP/server/Godot logs with request correlation,
  bounded retention, redaction, lifecycle events, and actionable error classes.

## Roadmap

### Phase 0: make the audit enforceable

- [x] Create a machine-readable manifest containing every MCP tool, mapped
  TypeScript handler, downstream operation/runtime command, public actions,
  privilege class, applicable dimensions, and test IDs.
  (`src/tool-manifest.ts` + `docs/coverage/tool-coverage.json`, validated by
  `tests/tool-manifest.test.ts` and `tests/tool-coverage.test.ts`.)
- [x] Generate the 157-tool and 108-command denominators from source; fail CI on
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

### Phase 2: close the current 157-tool inventory

- [x] Convert all 16 `H` tools to E2E while retaining their focused Godot tests.
  (`tests/e2e/headless-tools.test.ts`: every action, defaults, structured and
  resource-typed properties, failure classes, exotic paths, repeatability, and
  independent reload verification; the focused shell suite still runs.)
- [ ] Convert all 45 `G+` tools to E2E and expand them to every public action.
- [ ] Add successful engine behavior for all 14 `G-` tools, then convert to E2E.
- [ ] Add direct engine behavior and E2E coverage for all 82 `T` tools.
- [ ] Cover every declared parameter family and required failure class.
- [ ] Add persistent-effect and cleanup assertions appropriate to each tool.
- [ ] Run the completed suite on Godot 4.4 and 4.7.

Exit criteria: 157/157 tools and every declared action meet the tool definition
of done; no result depends solely on a mock, schema assertion, or response echo.

### Phase 3: cover real environments

- [ ] Add a Godot .NET CI job and compile/run generated C# projects.
- [ ] Add export-template jobs for a bounded supported target set.
- [ ] Add deterministic local HTTP, WebSocket, and two-peer ENet fixtures.
- [ ] Add virtual-display rendering and screenshot comparisons.
- [ ] Add Windows and macOS jobs for platform-sensitive capabilities.
- [ ] Add Compatibility/Forward+ coverage and explicit GPU feature skips.
- [ ] Add paths with spaces, Unicode paths, read-only paths, and large-project
  fixtures.

Exit criteria: every environment claimed in README has a passing job or an
explicitly documented and tested limitation.

### Phase 4: fill workflow capability gaps

- [ ] Implement editor integration and undo/redo-aware authoring.
- [ ] Implement debugger and structured test-runner workflows.
- [ ] Implement import/dependency/integrity analysis.
- [ ] Implement profiler, leak, and visual-regression workflows.
- [ ] Complete .NET, export, add-on, and GDExtension workflows.
- [ ] Add cross-platform recovery, isolation, authorization, and observability.

Exit criteria: each capability is documented, threat-modeled where relevant,
represented in the manifest, and covered by its own full-path acceptance suite.

### Phase 5: make and maintain a defensible product claim

- [ ] Replace “full control” with a bounded capability statement until Phases
  0-3 are complete.
- [ ] Generate README tool counts and coverage badges from the manifest.
- [ ] Require capability documentation, E2E tests, failure tests, cleanup tests,
  and compatibility declarations in the PR template for every public addition.
- [ ] Schedule periodic latest-stable and compatibility-floor verification.
- [ ] Track flaky tests, duration, quarantines, and allowed warnings; a quarantine
  must have an owner, issue, and expiry.

Exit criteria: published claims match generated evidence and cannot drift when
tools, actions, or supported environments change.

## Definition of done

### Per tool

A tool may be marked `[x] E2E` only when all applicable items pass:

- [ ] The tool is discoverable through MCP with the expected schema.
- [ ] A real MCP client calls the built server.
- [ ] The real handler and downstream service execute without monkeypatching.
- [ ] The expected Godot process/server receives the operation.
- [ ] Every public action has a successful real-engine case.
- [ ] Every parameter family has boundary and default coverage.
- [ ] The final effect is verified independently of the response.
- [ ] Expected engine, validation, permission, timeout, and cancellation failures
  return stable structured errors.
- [ ] Partial failures do not corrupt scenes, resources, settings, or files.
- [ ] Repetition and concurrency behave according to the documented contract.
- [ ] Teardown leaves no process, socket, held input, node, temporary artifact,
  ObjectDB instance, resource, or RID leak.
- [ ] Applicable Godot versions, build flavors, renderers, and platforms pass.
- [ ] Documentation states prerequisites, privilege level, side effects,
  limitations, and recovery behavior.

### Per capability family

- [ ] The user workflow and non-goals are documented.
- [ ] The minimal tool composition is usable without arbitrary `game_eval`.
- [ ] The trust boundary and destructive effects are explicit.
- [ ] At least one realistic fixture completes the entire workflow.
- [ ] Failure recovery is tested at each external boundary.
- [ ] Performance and response sizes are bounded on a representative large case.
- [ ] Platform/version limitations are detected and returned, not silently
  ignored.
- [ ] The workflow emits sufficient structured evidence for an agent to decide
  whether its intended result actually occurred.

### Release gate

- [ ] Build, lint, TypeScript tests, and all Godot suites pass.
- [ ] The generated manifest has no coverage or routing drift.
- [ ] No unexpected engine warning, error, crash, sanitizer finding, or leak is
  present.
- [ ] No required E2E test is skipped or quarantined.
- [ ] Compatibility floor and primary target pass.
- [ ] Required .NET, renderer, export, and platform jobs pass for the release's
  stated support matrix.
- [ ] Security-sensitive tests confirm default denial, explicit opt-in,
  authorization, bounds, and redaction.
- [ ] README counts, support statements, and limitations are generated or checked
  against the same manifest.

## Implementation checklist for every new tool or action

- [ ] Add or update the public tool schema.
- [ ] Add strict runtime/headless parameter declarations.
- [ ] Map the MCP tool to exactly one downstream operation or command.
- [ ] Declare privilege, cancellation, timeout, mutation, and cleanup semantics.
- [ ] Add unit tests for pure transformations and validation.
- [ ] Add protocol/contract tests for routing and serialization.
- [ ] Add focused direct-Godot behavior tests.
- [ ] Add full MCP-to-Godot E2E happy-path and failure tests.
- [ ] Add an independent effect assertion.
- [ ] Add teardown/leak assertions.
- [ ] Add version/platform/build-flavor cases or explicit non-applicability.
- [ ] Update the traceability manifest and generated report.
- [ ] Document examples, prerequisites, side effects, and limitations.

## Limitations and robustness notes

- Counts are at tool/command granularity. Several commands expose many actions,
  node classes, resource types, and mutually exclusive modes; the Phase 0
  manifest must establish the larger action-level denominator.
- A passing headless test does not establish editor behavior, rendering fidelity,
  OS input behavior, audio output, or export portability.
- CI currently spans Godot versions but not operating systems, renderers, .NET
  builds, export templates, or GPU capabilities.
- Some advanced engine features are intrinsically hardware-, platform-, codec-,
  or template-dependent. Tests should report capability-based skips only when
  the product also detects and explains that limitation to users.
- Visual and audio tests require deterministic state/assertion strategies; exact
  pixels or samples are inappropriate where renderer/device variance is expected.
- Security verification must assume another local process may connect. Loopback
  binding alone is not authentication.

## Further questions to resolve before Phase 3

- Which operating systems are product-supported versus best effort?
- Which renderers and GPU-dependent features are promised in CI?
- Is Godot .NET a first-class supported build or an optional scaffold generator?
- Which export targets and templates are supported and smoke-runnable?
- Is editor automation a core product direction, or is the supported boundary
  intentionally project files plus running games?
- Which third-party test frameworks, add-on sources, and native toolchains may be
  integrated without expanding the trust boundary unexpectedly?
- What latency and project-size budgets define acceptable behavior for tree,
  file, log, screenshot, import, and resource operations?
- Should privileged runtime access remain an environment-wide switch, or move to
  authenticated per-session capabilities?

Until those decisions are made, documentation should distinguish verified
support, experimental support, and intentionally unsupported workflows.
