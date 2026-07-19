# OpenCode Qwen experiment

## Setup

Date: 2026-07-19

- OpenCode: 1.18.3
- Model: `llama.cpp/qwen-35b` (Qwen 3.5 35B A3B)
- Godot: 4.7.1
- Node.js: 26.4.0
- OpenCode session: `ses_085197930ffeTCdexLoB1HasDY`
- Session title: `Godot Agent Loop Qwen experiment 01`
- Project: `experiments/opencode-qwen/game-01`

The repo has a local `opencode.jsonc`. It runs `build/index.js` from this checkout
with the core tool set and limits Godot paths to this repo. `.opencode/skills` is
a link to `agent-plugin/skills`, so a new OpenCode run reads local skill changes.

Before this run, the user-wide npm MCP entry, plugin entry, setup record, and four
installed Godot Agent Loop skills were removed. Old OpenCode logs were kept.

## Task

OpenCode was asked to use the build skill and make a small catch game. The player
moves left and right. Catching three targets should win, missing three should
lose, and R should restart. The run had to prove normal play, win, lose, and
restart, then stop Godot.

## Result

The run made a playable project and stopped Godot with no final engine errors.
It proved the normal UI, player movement, one catch, and the lose state. It did
not prove the win state. The observed R key press did not restart the lose state.
The final OpenCode answer still called restart implemented and win partly proved.
That claim was stronger than the run evidence.

The session used about 155k input tokens, 20k output tokens, and 7.9M cached input
tokens. Much of that load came from broad runtime node data and repeated logs.

## Findings

### High

1. Detached scene work needs a clear fallback. `editor_transaction` failed since
   the editor add-on was not ready. The model then wrote `.tscn` text by hand.
   It made invalid resource and parent fields, then removed nodes to get the scene
   to load. The skill now tells agents to use direct saved-scene tools instead.
2. Tool output can swamp a small local model. Broad node info returned hundreds
   of methods and properties. Repeated target parse errors produced more than
   60 KB of debug text. Defaults should cap or group this data.
3. `game_scenario` errors were hard to act on. One bad wait step returned 28
   linked `oneOf` errors. The model tried twice before it found a valid shape.
   The skill now gives one short, valid sample. The server now reduces nested
   branch errors to the branch chosen by `steps[n].type`; the same bad wait shape
   now returns two useful errors instead of fourteen in the saved test case.
4. Model delay changed real-time play. Tool calls took long enough for targets to
   fall. The model changed fall speed and spawn time to make tests easier. This
   changed the game to suit the agent, not the design. The skill now bars this.

### Medium

1. The model used old runtime log lines as waits. Those checks passed at once or
   timed out for the wrong reason. Waits should check current game state or new
   events. The skill now says this in plain terms.
2. The first script check listed 18 files, including 15 runtime bridge scripts.
   A later run listed only the three game scripts. The file scope should stay
   stable and hide injected bridge files.
3. Scene load errors did not give the parser line and message. Better parse data
   would have made the bad `.tscn` clear at once.
4. The model took script checks as full project proof. It skipped the required
   reread of scenes, settings, and project checks before play. The skill now
   calls this a hard gate.
5. The model checked runtime errors late. An early error check would have caught
   the broken target scene before many repeated spawn errors. The skill now asks
   for this right after the first runtime view.

## Next tests

1. Repeat the same game task in a new session with the changed skill. Check that
   the model avoids raw `.tscn`, uses a valid scenario on its first try, and does
   not tune game speed for test delay.
2. Test small default output for node info and grouped repeated runtime errors.
3. Test that script checks never include injected bridge files.
4. Add a task with a fixed win hook so win, lose, and restart can all be proved
   without random play.

## Experiment 02

### Setup and task

Date: 2026-07-20

- OpenCode: 1.18.3
- Model: `llama.cpp/qwen-35b`
- OpenCode session: `ses_084d80ae4ffe4fPUH7fU9nysX9`
- Session title: `Godot Agent Loop Qwen experiment 02`
- Project: `experiments/opencode-qwen/game-02`

The global Godot Agent Loop MCP and skill hooks were removed first. OpenCode's
model and provider settings, session data, logs, and unrelated packages were
left in place. The local config and skill link were then restored so this run
used this checkout's `build/index.js` and `agent-plugin/skills` files. Both the
core MCP connection and all four local skills passed OpenCode's discovery check.

The task repeated the catch game with deterministic, test-only win and lose
actions. It also required a meaningful saved scene hierarchy, proof of ordinary
movement, independent win, lose, and restart checks, an early and final error
read, and clean shutdown. The agent had to use MCP tools only.

### Harness limits

This run is useful but not clean enough for a direct score comparison. The first
`opencode run` detached from its terminal output while its process kept running.
A second resume command briefly added a duplicate user turn and a large summary
of injected runtime bridge files to the same session. The duplicate process was
stopped, and the first run continued. This extra context may have made the later
retry loop worse. The first run was stopped with `TERM` after about 20 minutes;
OpenCode, its MCP child, and the game process then exited. The interrupted
session also makes `opencode export` invalid, though the SQLite event records
remain readable.

Future runs must track the OpenCode process, not the terminal tool's completion
state, and must never resume a session until that process has exited.

### Experiment outcome

The run failed the acceptance contract. It created a project and used saved-scene
tools instead of writing `.tscn` text, but the saved hierarchy was not playable:

- `main.tscn` contains a plain `CharacterBody2D` player with no player script,
  visual, or collision shape. The separate `player.tscn` was never instantiated.
- The player catch shape and all three UI labels were added at the scene root.
  The model omitted `parentNodePath` in all ten `add_node` calls.
- Both the player and target scenes contain empty sprites and collision shapes
  with no shape resources.
- Runtime UI showed `Caught 0/3`, then `Missed 3/3` and `GAME OVER`. It never
  showed `YOU WIN` or `Caught 3/3`.

The agent did not prove ordinary movement, win, lose-and-restart, or clean error
state. It never called `game_get_errors`, `get_debug_output`, `verify_project`,
or `run_project_tests`. It ran `validate_scripts` once, then changed files again
without repeating the static gate. Some writes also occurred while Godot ran.

The session recorded about 141k input tokens, 28k output tokens, and 4.3M cached
input tokens before interruption. It made 99 MCP calls. Ten `game_scenario`
calls returned about 304 KB of text in total; one node wait returned about 51 KB
because it included hundreds of reflected methods and properties.

### What improved

- The model loaded `$build-godot-game` and used `create_scene`, `add_node`, and
  `attach_script`; it did not hand-write scene text.
- It used canonical Vector2 objects.
- It kept the requested fall and spawn timing instead of slowing the game for
  agent response time.
- It added clearly named deterministic input actions for win and lose tests.
- The first baseline scenario matched the skill example and passed.

### New findings

1. A successful node wait returned full `get_node_info` data. Scenario evidence
   needs only node existence and identity. The server now returns `found`, path,
   name, and class for this case.
2. A scenario condition with no `condition` selector still returned 16 branch
   errors. Validation now reports one missing
   `steps[n].condition.condition` field.
3. The model treated observe-only scenarios as proof. Several scenarios passed
   after a key press, a node-existence wait, and a UI read, even though none
   asserted win text or state. A passed scenario means its declared steps ran;
   it does not mean an unstated game claim passed.
4. The direct scene tools allowed a wrong but valid hierarchy. The skill now
   states that nested `add_node` calls need `parentNodePath`, that a separate
   child scene must be instantiated or wired into the main scene, and that the
   saved paths must be checked against the planned hierarchy.
5. `editor_transaction` gave an apt `addon_missing_restart_required` error in
   unattended mode, but there is no direct persisted reparent tool on the core
   path. Once the labels landed at root, the model had no clear repair route.
6. A missing target directory led `get_project_info` to return the broad error
   `Invalid project path`. The skill says how to preflight an empty directory,
   but the error should distinguish a missing directory, an allowed empty
   directory, and a directory without `project.godot`.
7. Real-time loss happened during slow agent calls, so later force-win checks
   started from a lost state. Deterministic hooks still need a known reset step
   and a direct assertion after each action.

### Changes after this run

- Compact node-wait evidence in both `game_wait_until` and `game_scenario`.
- Reduce nested scenario validation noise when the condition kind is absent.
- Clarify `add_node.parentNodePath` and saved child-scene wiring in the build
  skill and public tool description.
- Add unit tests for compact node evidence and the one-error condition response.

The failed game remains in `experiments/opencode-qwen/game-02` as evidence.
