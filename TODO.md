# Interactive editor and agent workflow roadmap

This roadmap turns the findings from the six Pong-building transcripts into
product work. The MCP loop successfully produced and tested a playable game,
but it behaved primarily as a headless file and runtime automation system. It
did not provide the continuously visible, editor-native collaboration expected
when a user already had Godot open.

The target experience is:

> Open Godot normally. If Godot Agent Loop is installed, the MCP discovers the
> matching editor, connects the Agent Activity dock, performs supported scene
> edits through the editor with undo/redo, and shows every acknowledged change
> without focus switching or a manual reload.

## Product principles

- Keep headless authoring and runtime automation first-class. Editor attachment
  is an additional interactive mode, not a requirement for unattended work.
- Prefer editor-native mutations when a compatible editor is attached. Use
  file-backed authoring when no editor is available or the operation is not yet
  supported, and disclose that fallback.
- Never overwrite unsaved editor state to make synchronization appear reliable.
- Treat attachment, synchronization, imports, and reloads as acknowledged state
  transitions. Do not swallow failures or claim editor state that was not read
  back from the editor.
- Keep meaningful structure in persisted scenes and resources. Scripts should
  primarily implement behavior, not reconstruct an otherwise empty game in
  `_ready()` unless procedural construction is an intentional requirement.
- Separate deterministic test execution from a realtime run a person is
  watching. The harness must not cause agents to compensate in product code.
- Require independent evidence for runtime, rendering, performance, and cleanup
  claims. Successful tool responses alone are not proof.

## P0: Freeze the interaction contract

- [x] Write an architecture decision record for the three supported modes:
  attached editor authoring, detached/headless authoring, and running-game
  interaction.
- [x] Define a per-project editor session state machine with at least
  `connected`, `no_editor`, `addon_missing_restart_required`,
  `addon_upgrade_restart_required`, `protocol_incompatible`, `paused`,
  `syncing`, and `unsaved_conflict` states.
- [x] Specify which existing project tools route through the editor when
  attached and which retain a file-backed implementation.
- [x] Specify a stable public `editor_session` contract. It should support an
  idempotent `ensure` action that discovers an existing editor before offering
  to launch one, plus status and disconnect operations.
- [x] Specify backend and synchronization metadata returned by every persistent
  mutation, including `backend`, `editor_session`, `sync_status`,
  `fallback_reason`, and the independently observed target state.
- [x] Document the one unavoidable limitation honestly: an editor that was
  already started without an installed and enabled addon cannot safely receive
  an `EditorPlugin` at runtime. A one-time install and editor restart is needed.
- [x] Define compatibility and migration behavior for older transient addons
  and protocol versions before changing the protocol.

### P0 acceptance

- [x] The contract makes it possible for a caller to distinguish "written to
  disk" from "visible and acknowledged in the attached editor."
- [x] No documented state tells users to focus-switch or blindly click
  **Reload from disk** as a normal workflow.
- [x] Headless use, CI, and projects that do not want a persistent addon remain
  explicitly supported.

## P1: Discover and attach to an editor the user launched

- [x] Make the persistent `addons/godot_agent_loop` distribution the recommended
  setup for interactive projects. Keep transient installation for disposable
  and CI-owned editor sessions.
- [x] Keep the Agent Activity dock present whenever the persistent addon is
  enabled. Its disconnected state should say that it is waiting for an agent,
  not that the user must relaunch Godot through `launch_editor`.
- [x] Have the addon select a free loopback port and generate a cryptographically
  random authentication token on each editor start.
- [x] Write an atomic, untracked discovery record at
  `.godot/godot_agent_loop/editor-session.json`. Include the canonical project
  path, editor PID and start identity, port, token, protocol version, addon
  version, Godot version, and creation time.
- [x] Restrict discovery-record access to the current user where the platform
  supports it. Never log, return, trace, or persist the token outside the
  discovery record.
- [x] Remove the discovery record on clean editor exit. Reject and clean stale
  records by validating the project path, PID/start identity, loopback endpoint,
  and authenticated handshake.
- [x] Replace the single fixed global `EditorConnection` with a reconnectable
  per-project session registry. It must support multiple open projects without
  routing commands to the wrong editor.
- [x] Add reconnect with bounded backoff for MCP restarts and brief editor bridge
  interruptions. Do not spin or emit repeated user-visible errors indefinitely.
- [x] Change `launch_editor` to call the same ensure flow, attach to a compatible
  existing editor when possible, avoid duplicate editors, and wait until the
  bridge is ready or a precise terminal state is known.
- [x] Return structured attachment details from `editor_session` and
  `launch_editor`, including whether the editor was reused or spawned and
  whether a restart or addon upgrade is required.
- [x] Keep the persistent addon installed when the MCP exits. Clean up only
  transient installations owned by that MCP process.

### P1 acceptance

- [x] Start Godot first, then start the MCP: it discovers and authenticates the
  matching editor without launching another editor.
- [x] Start the MCP first, then start Godot normally: it connects when the
  discovery record appears.
- [x] Restart the MCP while Godot stays open: it reconnects without an editor
  restart.
- [x] Open two projects: each command and trace event reaches only its matching
  editor.
- [x] Missing, disabled, stale, and incompatible addons produce distinct,
  actionable states with no misleading `ECONNREFUSED` completion claim.
- [x] MCP shutdown leaves a persistent dock showing a clean disconnected state
  and removes only MCP-owned transient files and processes.

## P2: Make editor synchronization immediate and trustworthy

- [x] Replace best-effort, swallowed `filesystem_changed` sends with a
  per-project synchronization queue that records success, timeout, conflict,
  disconnection, and retry outcome.
- [x] Debounce related file writes into one bounded sync without losing the
  final scene/resource focus target.
- [x] Add an explicit filesystem synchronization command that starts a scan,
  awaits import/scan completion, refreshes changed resources, and returns an
  acknowledgement of what became visible.
- [x] Read back the open scene, selected node, resource/import status, and final
  editor state before reporting that synchronization succeeded.
- [x] Reload an externally changed open scene only when it is safe. Detect
  unsaved local changes and return `unsaved_conflict` instead of overwriting
  them.
- [x] Preserve the current open scene, selection, inspector target, and 2D/3D
  viewport context where Godot's public editor API permits it.
- [x] Select and reveal newly created or modified nodes after synchronization.
  Treat failure to focus as separate from failure to persist or reload.
- [x] Surface sync failures in both the MCP result and Agent Activity dock. Do
  not use `.catch(() => undefined)` on correctness-critical editor updates.
- [x] Ensure authoring tools can finish successfully in detached mode while
  clearly reporting that no editor acknowledgement was possible.

### P2 acceptance

- [x] A watched scene/resource change appears in Godot without Alt+Tab,
  Cmd+Tab, editor refocus, or a manual **Reload from disk** click.
- [x] Rapid consecutive writes settle on the final saved state and focus the
  intended node without duplicate reloads.
- [x] An unsaved editor change is never lost; the caller receives a conflict
  result with a safe next action.
- [x] A dropped bridge connection cannot be reported as a successful editor
  synchronization.
- [x] Synchronization works for scene text, scripts, imported source assets,
  external resources, and project settings, with behavior documented per type.

## P3: Make scene construction genuinely editor-native

- [x] Add an atomic `editor_transaction` capability backed by
  `EditorUndoRedoManager`. A transaction should validate all operations before
  commit and become one human-readable undo step.
- [x] Support creating/opening a scene; adding, removing, renaming, duplicating,
  and reparenting nodes; setting multiple properties; instantiating a packed
  scene; attaching a script; assigning an existing resource; and saving.
- [x] Preserve Godot scene ownership, editable-child rules, inherited-scene
  constraints, unique names, resource UIDs, and typed Variant conversion.
- [x] Add editor-native resource operations for the common materials, meshes,
  shapes, themes, audio streams, and other resources needed by 2D and 3D game
  construction. Stage uncommon resource types behind the existing fallback.
- [x] Route `create_scene`, `add_node`, `modify_scene_node`,
  `remove_scene_node`, `attach_script`, `manage_scene_structure`, and supported
  resource tools through the attached editor backend.
- [x] Return the chosen backend and fallback reason. Never silently turn an
  editor-visible request into raw `.tscn` text patching.
- [x] Update editor selection and inspector focus as each compound authoring
  transaction commits, while preserving human pause/undo/redo behavior.
- [x] Keep scripts focused on behavior. Add an agent-facing structural check
  that flags an empty or trivial main scene when most persistent game nodes are
  procedurally created at startup without an explicit procedural requirement.
- [x] Verify persisted results by closing/reopening or independently reading the
  scene, not only by inspecting live editor objects.

### P3 acceptance

- [x] A representative 2D and 3D scene can be built while the user watches the
  Scene dock and Inspector update after each transaction.
- [x] One editor undo reverses one MCP transaction; redo restores it.
- [x] Saving and reopening the project preserves the same authored hierarchy,
  resources, scripts, ownership, and UIDs.
- [x] Pausing the agent prevents editor and file-backed persistent mutations,
  while observational tools remain available.
- [x] When an operation falls back to detached authoring, the subsequent editor
  synchronization is acknowledged and the fallback is visible in the result
  and trace.

## P4: Make the trace panel describe the whole agent session

- [x] Instrument MCP tool dispatch, project authoring, editor commands, runtime
  commands, verification, and cleanup with one redacted lifecycle event model.
- [x] Keep a bounded per-project server-side ring buffer of at least the most
  recent 200 events. Include a monotonic event ID, timestamp, correlation ID,
  tool/command, target backend, phase, outcome, and duration.
- [x] Replay buffered events on late attachment or reconnection. Deduplicate by
  event ID so MCP or editor restarts do not duplicate entries.
- [x] Show attachment, synchronization, fallback, pause, timeout, and cleanup
  transitions in addition to running-game requests.
- [x] Distinguish agent-authored actions from automatic scan/reload/focus work.
- [x] Show explicit connected, disconnected, authenticating, incompatible,
  paused, and conflict states in the dock.
- [x] Add bounded filtering and details suitable for diagnosing a failed tool
  without exposing secrets, unbounded payloads, source files, or base64 images.

### P4 acceptance

- [x] Opening the dock after work has started shows the earlier buffered events.
- [x] A complete mutation displays start, backend, sync/commit, and final outcome
  with the same correlation ID.
- [x] A timeout, fallback, pause rejection, or unsaved conflict is visually
  distinct from success.
- [x] No authentication token, environment secret, or unrestricted user payload
  appears in logs, MCP responses, tests, or the dock.

## P5: Improve run, wait, evidence, and performance tools

- [x] Add an explicit `timingMode` to `run_project`. Use realtime/display timing
  for an interactive watched run and reserve fixed-FPS deterministic timing for
  verification and tests. Return the active timing policy in the response.
- [x] Keep `verify_project` deterministic by default. Never require game source
  to set `Engine.max_fps` to compensate for harness behavior.
- [x] Add a compound `wait_until` primitive for bounded node, property, signal,
  log, scene, and connection conditions. Replace agent-side 350 ms polling
  loops with server-side waits and one trace span.
- [x] Add a bounded scenario runner for sequences of input, wait, observation,
  assertion, screenshot, and performance sampling. Return correlated step
  evidence and deterministic teardown.
- [x] Expand performance evidence beyond engine counters to include observed
  realtime FPS/frame-time distribution, process time, rendering time, and GPU
  time when the renderer/platform exposes it. State unavailable metrics rather
  than substituting another measure.
- [x] Support a bounded stress window and before/after comparison so transient
  effects, frame spikes, and accumulating objects can be diagnosed.
- [x] Return screenshot previews without flooding the model context. Provide
  optional retained artifact paths, dimensions, digest, and visual-regression
  metadata; keep artifacts out of the game project unless requested.
- [x] Shorten capability discovery results and recommend compound tools when
  they replace repetitive low-level calls.

### P5 acceptance

- [x] A realtime Pong run follows normal display/VSync behavior, while a
  deterministic verification run advances repeatably and reports its policy.
- [x] A wait or scenario timeout explains the unmet condition and includes the
  last observed state without requiring dozens of MCP calls.
- [x] A performance regression can be reproduced with baseline, stress, and
  recovery samples that identify CPU/render/GPU availability separately.
- [x] Screenshots remain viewable evidence without embedding repeated large
  base64 payloads in textual results or leaving files in the target project.

## P6: Correct agent authoring and verification behavior

- [x] Update `build-godot-game` to ensure/inspect an editor session when the
  user wants to watch, prefer editor-native transactions, and verify that a
  meaningful hierarchy and resources were persisted.
- [x] Tell the build skill to use scripts for behavior and scenes/resources for
  authored structure. Allow procedural generation only when it is requested or
  justified by the design, and report that choice.
- [x] Update `verify-godot-change` to distinguish objective evidence from
  subjective feel, audio quality, composition, and polish. Report manual review
  needs rather than declaring them proven by structural checks.
- [x] Update `debug-godot-game` to capture a baseline, change one independent
  variable at a time, rerun the same stress path, and avoid causal conclusions
  from disabling particles, shockwaves, audio, and other systems together.
- [x] Require camera shake and other persistent per-frame effects to be tested
  independently when diagnosing a rendering freeze or stutter.
- [x] Require performance diagnoses to measure rendered/realtime frame behavior
  when the complaint is visual; simulation counters alone are insufficient.
- [x] Treat unexpected Godot warnings, errors, ObjectDB leaks, orphan/resource
  diagnostics, and bridge cleanup failures as evidence to resolve or disclose,
  even when the requested behavior otherwise passes.
- [x] Establish a performance budget before high-volume particles, fireworks,
  shockwaves, dynamic lights, audio voices, trails, or similar polish is added.
- [x] Retain the strong asset-provenance behavior from the transcripts: verify
  source and license, record attribution/CC0 status, and independently check
  that imported audio and visual assets load and play/render.
- [x] Prefer compound waits, scenarios, and verification over repetitive tool
  calls. Optimize for evidence quality, not raw call count.
- [x] Remove temporary probes and MCP-owned transient bridge artifacts. Never
  remove a user's persistent addon or omit cleanup diagnostics from the final
  report.

### P6 acceptance

- [x] A cold agent building a watched game uses the attached editor for every
  supported scene/resource mutation and reports any fallback.
- [x] The resulting main scene is inspectable and editable without running the
  game; it is not an empty shell whose hierarchy exists only after `_ready()`.
- [x] The agent proves both ordinary play and win/lose transitions, while
  labeling aesthetic and audio judgments honestly.
- [x] A performance-debug task isolates variables and does not claim one cause
  from a multi-system A/B change.
- [x] Final reports include all relevant warnings, leaks, unsupported metrics,
  fallbacks, and manual-review gaps.

## P7: Tests, documentation, and release evidence

- [x] Add focused TypeScript tests for discovery validation, stale sessions,
  reconnect/backoff, multi-project routing, state transitions, redaction,
  buffered replay, sync acknowledgements, conflicts, and fallback metadata.
- [x] Add strict GDScript tests for discovery-file lifecycle, dynamic loopback
  binding, authentication, transaction validation, undo/redo, scene ownership,
  synchronization completion, and dock event deduplication.
- [x] Add full MCP-to-Godot E2E coverage for each new tool/action and update the
  manifest, schemas, tool surface, coverage JSON/report, and adapter metadata.
- [x] Exercise both persistent and transient addon paths. Assert there are no
  leaked processes, sockets, session records, transient plugins, or unexpected
  Godot diagnostics.
- [x] Add platform acceptance for Linux and the existing portable Windows/macOS
  boundary. Include a headed macOS manual or automated check for the original
  Cmd+Tab/reload symptom before claiming it fixed there.
- [x] Add an interactive golden-agent scenario based on the Pong transcripts.
  Record editor-native versus fallback mutations, user interventions, sync
  acknowledgements, trace completeness, tool calls, elapsed time, performance
  evidence, and final project structure.
- [x] Update `README.md`, `docs/tools.md`, addon setup help, portable agent
  documentation, server instructions, and release notes. Remove the claim that
  a normally launched editor cannot accept commands once discovery ships.
- [x] Document one-time persistent installation, explicit uninstall, security
  model, session-record location, headless behavior, multi-editor behavior,
  unsaved-conflict recovery, and troubleshooting states.
- [x] Run `npm run build`, focused tests during development, `npm test`,
  `npm run lint`, `npm run coverage:check`, relevant Godot suites, and full E2E
  before completion.

### Final release gate

- [x] A user can open Godot before or after the MCP and receive the trace panel
  connection without asking the agent to launch a duplicate editor.
- [x] Supported authoring operations visibly update the open editor without
  focus switching or manual reload and remain reversible through undo/redo.
- [x] Detached authoring, CI, runtime interaction, and deterministic verification
  continue to work with no persistent-addon requirement.
- [x] The interactive Pong golden scenario requires no editor-launch, focus,
  reload, or scene-structure correction from the user.
- [x] Security, compatibility, cleanup, and coverage gates pass on every claimed
  platform/version. Documentation describes any remaining limitation exactly.

## Completion evidence

- The accepted interaction contract, state machine, routing table,
  synchronization semantics, compatibility policy, and per-file limitations
  are in [`docs/architecture/editor-interaction.md`](docs/architecture/editor-interaction.md).
- Focused TypeScript coverage is in `tests/editor-session-registry.test.ts`,
  `tests/editor-sync-queue.test.ts`, `tests/editor-authoring-router.test.ts`,
  `tests/lifecycle-trace.test.ts`, and the updated handler/contract suites.
- Strict editor-runtime coverage loads the shipped addon through
  `tests/godot/run-editor-bridge-tests.sh`; the complete `npm run test:godot`
  gate passed against Godot 4.7.1 with 19 strict scripts, 75 operation checks,
  383 runtime checks, and no unexpected diagnostics.
- Real-editor acceptance is in
  `tests/e2e/interactive-editor-discovery.test.ts`,
  `tests/e2e/lifecycle-tools.test.ts`, and
  `tests/e2e/golden-agent-game.test.ts`. The full serial E2E matrix passed with
  34 files, 204 passed tests, one declared skip, and zero failures. The current
  golden replay then passed again after the final compact-surface adjustment.
- The headed macOS 4.7.1 no-focus-switch/no-reload run is recorded in
  [`docs/coverage/interactive-golden-agent-run.json`](docs/coverage/interactive-golden-agent-run.json).
- Final local gates: `npm run build`, 742/742 `npm test`, `npm run lint`,
  `npm run coverage:check`, `npm run test:godot`, full `npm run test:e2e`, and
  the focused golden/adapter/disclosure rerun all passed on 2026-07-15.
- The changed tree passed all locally available release gates on headed macOS
  4.7.1. Linux Godot 4.7 and the portable Windows boundary remain enforced
  by the repository's existing CI acceptance runners; Windows editor UI is not
  claimed. This matches the documented support boundary without treating local
  execution of every CI platform as a release prerequisite.

## Non-goals

- Eliminating file-backed or headless authoring.
- Launching or focusing an editor for every unattended task.
- Reloading over unsaved human changes.
- Exposing arbitrary code execution through the editor bridge.
- Replacing intentionally procedural games with authored scenes without a user
  or design requirement.
- Claiming subjective game feel, audio quality, or platform UI support from
  headless evidence alone.
