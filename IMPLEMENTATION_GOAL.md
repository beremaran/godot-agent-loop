Complete every open item in TODO.md, end to end.

TODO.md at the repo root is the authoritative plan; read it fully first. All
work through Phase 6a is done and verified — do not redo it. The open work is:
Phase 6b (override.cfg injection, stale-installation reaper, SIGKILL
byte-identity test), Phase 6c (persistent session), Phase 6d (editor
observation dock), Phase 7a-7d (instructions, tool-surface budget, skills,
golden agent acceptance test), the P4 engine-surface decisions (45 unresolved
classes), the P3 cross-platform split item, and the "Plan hygiene" items.

Order: start with the plan-hygiene items and the P3 split (cheap, and they make
the document you're working from truthful), then 6b, then the P4 _decisions_
(they must land before 6c freezes its seams — a decision recorded in
engine-scope.json or TODO.md counts; implementation can be deferred to a
tracked item), then 6c, 6d, 7a, 7b, 7c, 7d. 7a does not depend on Phase 6 and
may be done earlier if convenient.

Rules of engagement:

- Work item by item. Check a box only when its section's definition of done is
  genuinely met; the repo's discipline is that claims match generated evidence.
- Every new tool, action, or behavior change goes through the "Implementation
  checklist for every new tool or action" in TODO.md: manifest entry, coverage
  rows, full-path E2E happy/failure tests, independent effect assertion,
  teardown/leak assertions, docs.
- `npm run check` must pass before every commit (the pre-commit hook enforces
  it). Run the Godot suites (tests/godot/\*.sh and npm run test:e2e) against
  Godot 4.7 for engine-touching changes; note anything needing a 4.4 floor run.
  $GODOT_BIN points at the engine binary.
- Commit per completed item or coherent group, conventional-commit style
  matching git log, on main, updating TODO.md checkboxes in the same commit.
- Known hazard: under --headless, RenderingServer.frame_post_draw never fires
  and root.get_texture() is null — never await it without a rendering context.
  The 6a spike results in TODO.md record what was proven; trust them.
- Where TODO.md defers a decision (6c replace-vs-inject, P4 editor-context
  seam, XR/web scope-outs), make the call yourself using the rationale already
  recorded in "End goal and architecture direction", and write the decision and
  reasoning into TODO.md rather than stopping to ask. Stop only for things that
  change the product's external claims in ways the plan doesn't already
  anticipate.
- 7d's golden test requires an agent as the test subject; if driving a real
  agent in CI is infeasible, implement the closest deterministic harness
  (scripted MCP client replaying an agent-authored build), record
  limitation in TODO.md, and do not silently weaken the exit criteria.

Done means: every checkbox in TODO.md is either checked with evide
converted to an explicit, justified scope-out recorded in the document; all
release-gate items still pass; and the working tree is clean with everything
committed.

Order: start with the plan-hygiene items and the P3 split (cheap, and they make
the document you're working from truthful), then 6b, then the P4 _decisions_
(they must land before 6c freezes its seams — a decision recorded in
engine-scope.json or TODO.md counts; implementation can be deferre
tracked item), then 6c, 6d, 7a, 7b, 7c, 7d. 7a does not depend on Phase 6 and
may be done earlier if convenient.

Rules of engagement:

- Work item by item. Check a box only when its section's definition of done is
  genuinely met; the repo's discipline is that claims match generated evidence.
- Every new tool, action, or behavior change goes through the "Imp
  checklist for every new tool or action" in TODO.md: manifest entry, coverage
  rows, full-path E2E happy/failure tests, independent effect assertion,
  teardown/leak assertions, docs.
- `npm run check` must pass before every commit (the pre-commit hook enforces
  it). Run the Godot suites (tests/godot/\*.sh and npm run test:e2e) against
  Godot 4.7 for engine-touching changes; note anything needing a 4.4 floor run.
  $GODOT_BIN points at the engine binary.
- Commit per completed item or coherent group, conventional-commit
  matching git log, on main, updating TODO.md checkboxes in the same commit.
- Known hazard: under --headless, RenderingServer.frame_post_draw
  and root.get_texture() is null — never await it without a rendering context.
  The 6a spike results in TODO.md record what was proven; trust th
- Where TODO.md defers a decision (6c replace-vs-inject, P4 editor-context
  seam, XR/web scope-outs), make the call yourself using the rationale already
  recorded in "End goal and architecture direction", and write the
  reasoning into TODO.md rather than stopping to ask. Stop only for things that
  change the product's external claims in ways the plan doesn't already
  anticipate.
- 7d's golden test requires an agent as the test subject; if driving a real
  agent in CI is infeasible, implement the closest deterministic h
  (scripted MCP client replaying an agent-authored build), record the gap as a
  limitation in TODO.md, and do not silently weaken the exit crite

Done means: every checkbox in TODO.md is either checked with evidence or
converted to an explicit, justified scope-out recorded in the docu
release-gate items still pass; and the working tree is clean with everything
committed.
