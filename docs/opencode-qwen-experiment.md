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
