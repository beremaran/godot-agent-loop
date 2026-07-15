# `/goal` prompt: deliver interactive, editor-native Godot Agent Loop

Use the following as the `/goal` prompt for the implementation conversation.

```text
/goal Implement every item in TODO.md that is required to deliver the documented
interactive editor experience, including production code, protocols, tests, agent
skills, generated metadata, and user documentation. Continue until the final
release gate in TODO.md is satisfied with real evidence, or until a genuine
external blocker makes further progress impossible.

Context and product intent

Six real Codex sessions successfully built and tested a Pong game with Godot
Agent Loop, but exposed a gap between engine automation and interactive editor
collaboration:

- The agent used the MCP extensively, yet authoring still leaned on scripts,
  text/file mutations, and runtime construction. At one point the main scene was
  effectively empty and the game hierarchy was generated in `_ready()`.
- When Godot was already open, the MCP did not attach to it. The Agent Activity
  dock became useful only after the user explicitly asked the agent to call
  `launch_editor`.
- External scene/resource changes did not reliably appear in the editor. The
  user had to switch focus away and back, then click Reload from disk.
- `launch_editor` currently installs a bridge, spawns Godot, and returns before
  proving the bridge is ready. A single fixed-port, fixed-secret
  `EditorConnection` cannot discover or route multiple existing editors.
- Filesystem notifications and trace forwarding currently swallow bridge
  failures, allowing disk success to be mistaken for editor success.
- Ordinary project runs currently use fixed-FPS deterministic timing. In the
  Pong session this distorted the observed behavior and prompted the agent to
  add `Engine.max_fps = 60` to game code. Interactive realtime runs and
  deterministic verification must be separate modes.
- Performance debugging bundled several effects into one A/B change and then
  claimed a cause too strongly. It did not independently isolate all plausible
  effects or prove rendered/GPU frame behavior, and cleanup diagnostics were
  omitted from the final summary.

The intended experience is simple: a user opens Godot normally; an installed
Godot Agent Loop addon publishes a secure per-editor discovery session; the MCP
finds the matching project editor and connects; the persistent dock shows live
and replayed activity; supported scene/resource mutations happen through the
editor with undo/redo and visible selection updates; and external fallbacks are
synchronized and acknowledged without focus switching or manual reload.

Execution requirements

1. Read AGENTS.md, CLAUDE.md, TODO.md, the six prompt-*.md transcripts, and all
   relevant implementation/tests/docs before changing code. Treat TODO.md as the
   source of truth and preserve its product principles and non-goals.
2. Create and maintain a dependency-ordered implementation plan. Work through
   TODO.md from contracts and session discovery through synchronization,
   editor-native transactions, trace replay, execution/evidence tooling, agent
   guidance, and release verification. Do not stop after an ADR, prototype, or
   partial vertical slice.
3. Update TODO.md checkboxes only after the corresponding behavior has production
   code, focused tests, real-engine evidence where applicable, and accurate
   documentation. Leave an item unchecked if only a mock or design exists.
4. Preserve headless authoring, CI workflows, runtime interaction, security
   defaults, the human Pause Agent control, and Godot 4.4 compatibility while
   targeting 4.7. Do not trade away unattended workflows to improve the editor.
5. Prefer a persistent addon for interactive projects and retain transient
   installation for disposable MCP-owned sessions. Never remove a user's
   persistent addon during cleanup.
6. Use a per-project editor session registry and authenticated discovery records
   under `.godot/godot_agent_loop/`. Bind only to loopback, generate fresh random
   credentials for each editor start, validate stale PID/start identity, redact
   secrets everywhere, and support multiple projects without cross-routing.
7. Make `editor_session ensure` idempotent. It must attach to an existing
   compatible editor before considering a spawn. Make `launch_editor` reuse the
   same flow, avoid duplicates, and wait for a confirmed bridge state rather
   than returning optimistically.
8. Make editor synchronization acknowledged and conflict-safe. Await filesystem
   scan/import completion, read back state, preserve editor context where public
   APIs allow it, and never reload over unsaved human changes. A disk write and
   an editor-visible update are separate outcomes.
9. Implement editor-native compound transactions through
   `EditorUndoRedoManager`. Validate before commit, preserve scene ownership and
   typed resources, make one transaction one undo step, save and independently
   reopen/read the scene, and disclose every file-backed fallback.
10. Instrument the complete MCP lifecycle with bounded, redacted, correlated
    per-project events. Buffer and replay events on late attach/reconnect and
    deduplicate them in the dock. Include authoring, editor sync, runtime,
    verification, pause/conflict, fallback, failure, and cleanup events.
11. Separate realtime interactive runs from deterministic test runs. Return the
    active timing policy, add bounded server-side waits/scenarios, and expand
    performance evidence without fabricating unavailable render/GPU metrics.
12. Update the bundled build/debug/verify/ship skills so agents prefer the
    attached editor when a user wants to watch, persist meaningful scene
    structure, isolate one performance variable at a time, distinguish objective
    checks from subjective review, and report every warning/leak/fallback.
13. Keep public contracts synchronized across tool definitions, validation,
    manifests, protocol/schema files, generated adapter/product metadata, docs,
    coverage records, and tests. Follow existing source and markdown style.
14. Use apply_patch for hand edits, preserve unrelated user changes, and do not
    commit, push, publish, or make unrelated product changes unless explicitly
    requested.

Required verification

- Add unit and contract tests for every state, validation path, redaction rule,
  reconnect path, fallback, conflict, transaction, timing mode, wait/scenario,
  and trace-replay behavior introduced.
- Add strict Godot-side tests for discovery lifecycle, authentication, dynamic
  ports, editor transactions, undo/redo, ownership, synchronization, and dock
  event handling.
- Add full MCP-to-real-Godot E2E tests for all new public actions and update the
  repository's enforced coverage traceability.
- Prove Godot-first, MCP-first, MCP-restart, two-project, stale-session,
  incompatible-addon, missing-addon, pause, unsaved-conflict, and clean-shutdown
  cases.
- Prove a watched scene updates with no focus change or manual reload. Include
  macOS evidence for the observed Cmd+Tab symptom before claiming macOS editor
  UI support; otherwise document it as a remaining manual gate.
- Run a new interactive golden-agent Pong scenario. It must connect to a normally
  opened editor, show complete activity, author a meaningful persisted scene via
  editor-native operations where supported, disclose fallbacks, play and verify
  both outcome paths, and require no launch/reload/scene-structure intervention.
- During development run focused tests. Before completion run `npm run build`,
  `npm test`, `npm run lint`, `npm run coverage:check`, relevant
  `npm run test:godot` suites, and `npm run test:e2e`. Resolve unexpected Godot
  warnings, errors, ObjectDB leaks, stale bridge files, sockets, and child
  processes rather than hiding them.

Definition of done

The work is complete only when every applicable checkbox and the final release
gate in TODO.md are checked with referenced evidence; the editor can be opened
before or after the MCP; no duplicate launch is needed; supported authoring is
visible immediately and undoable; fallbacks synchronize safely; the trace panel
contains the whole correlated session including replay; realtime and
deterministic timing no longer contaminate each other; detached/headless use is
unchanged; all enforced checks pass; and documentation states all remaining
platform or Godot API limitations precisely.

If blocked, exhaust safe in-scope alternatives and keep making progress on
independent items. Report a blocker only when it requires unavailable external
authority, hardware/platform access, or a user decision that materially changes
the contract. Do not mark blocked merely because the roadmap is large.
```
