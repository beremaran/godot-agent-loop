# AssetLib addon acceptance

The `1.0.0` addon candidate was exercised on 2026-07-14 through the same
full-path MCP harness used by the release suite.

## Engines

| Role | Engine | Provenance |
| --- | --- | --- |
| Compatibility floor | Godot 4.4.1 stable, official `49a5bc7b6` | Official GitHub release; Linux x86_64 ZIP matched SHA-512 `ef4e76880a514257175544952c61191106fdef3095b909bafed9fcbeb230c3e5533920a0f3012882dd4bbde83028a67549825794e2d2c3cf76eba7918b71370e` |
| Primary target | Godot 4.7 stable, official `5b4e0cb0f` | Installed system tools build |

Both engines passed the 19-file strict GDScript parse, including loading
`addons/godot_agent_loop/plugin.gd` through the real enabled `EditorPlugin`
lifecycle with warnings promoted to errors.

## Package lifecycle

`tests/e2e/assetlib-addon.test.ts` performs the complete acceptance on each
engine:

1. Build the deterministic ZIP and install it into a clean project through the
   same archive extraction boundary as the package installer.
2. Start the published-package MCP entry point and launch the editor.
3. Prove the persistent distribution is selected without overwriting addon
   files, authenticate protocol 1, and inspect addon/server/Godot status.
4. Start with the human lock paused and independently prove a scene mutation is
   refused before dispatch.
5. Kill and restart the editor, reconnect, and re-observe authenticated paused
   state.
6. Gracefully stop the MCP server, prove its enabled-plugin setting is removed,
   prove no transient addon exists, uninstall the persistent addon, and compare
   the normalized `project.godot` byte-for-byte with its pre-install state.

Godot 4.4.1 completed the latest path in 13.25 seconds; Godot 4.7 completed it
in 8.59 seconds. No Godot process or bridge residue survived either test.

`tests/e2e/crash-recovery.test.ts` separately SIGKILLs the server after a
transient launch. It proves the stale owned files and enabled entry exist, then
starts a replacement server, reclaims the installation using its hashed
ownership marker, and restores the normalized project configuration exactly.

## Ownership and protocol matrix

Unit and contract coverage additionally proves:

- persistent addons are enabled but never overwritten or removed;
- already-enabled persistent addons remain user-owned;
- missing scripts and protocol mismatches fail before editor launch;
- foreign or modified transient paths are never overwritten or deleted;
- unmodified stale transient installs are safely replaced;
- unrelated plugins and concurrent project edits survive cleanup;
- partial file-copy failures remove the partially created addon;
- the first bridge message is the authenticated version handshake; and
- protocol mismatches become explicit compatibility errors and refuse mutation.
