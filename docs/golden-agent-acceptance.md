# Golden agent acceptance

Phase 7's product claim is tested in three layers: a live, cold model run
provides behavioral evidence, a deterministic replay protects the original
headless workflow, and an interactive replay protects the attached-editor
workflow.

## Live cold run

On 2026-07-14, Claude Code 2.1.208 ran Claude Sonnet 5 at high effort with its
built-in tools disabled. It received only this server's 39-tool core MCP surface,
the initialization instructions, an empty allowed project directory, and the
game brief. No plugin skill was loaded and no human correction was supplied.

The agent created and saved a two-script Godot game with a main scene, four input
actions, visible player, goal, hazard, and PLAYING/WIN/LOSE label. It launched the
game, injected input to reach both terminal states on separate runs, observed UI,
logs, and screenshots, then ran `verify_project`. The final compound check passed,
captured an 800x600 screenshot, stopped cleanly, and left exactly four intentional
game files. The run took 441 seconds and 173 agent turns.

The machine-readable evidence and the observed selection failures are in
[`coverage/golden-agent-run.json`](coverage/golden-agent-run.json).

## Deterministic release gate

[`golden-agent-game.test.ts`](../tests/e2e/golden-agent-game.test.ts) distills the
successful live trace into a reproducible MCP-client test. Starting from no Godot
project, it creates the project, scene, script, nodes, input map, and main-scene
setting through the current 40-tool core surface. It then:

1. independently reads the authored files;
2. runs the compound verifier with node, log, screenshot, and teardown evidence;
3. discovers hidden `game_key_hold` through `godot_tools`;
4. proves movement from live UI coordinates;
5. proves WIN and LOSE through live UI plus independently decoded rendered pixels;
6. stops the game and checks that no injected files remain.

The current replay installs the persistent addon after project creation, opens
Godot normally, and reconnects a fresh MCP without calling `launch_editor`.
Supported scene changes use the editor backend and update selection; script and
project-setting fallbacks are acknowledged and disclosed. It also checks the
persisted hierarchy, correlated dock activity, realtime ordinary play,
deterministic verification, a bounded performance stress window, retained
persistent-addon files, and clean discovery-record removal. The macOS/Godot
4.7.1 evidence is recorded in
[`coverage/interactive-golden-agent-run.json`](coverage/interactive-golden-agent-run.json).

`npm run test:golden-agent` runs the focused gate. The test is also part of
`npm run test:e2e`, which CI runs on both Godot 4.4 and 4.7; it cannot be skipped
or quarantined under the repository's E2E metadata policy.

The release gate intentionally does not call a hosted model. Model availability,
sampling, credentials, and cost are nondeterministic release inputs. The live run
establishes that a cold agent can do the job; the replay prevents the exact MCP
capabilities and independent evidence that made it succeed from regressing.
