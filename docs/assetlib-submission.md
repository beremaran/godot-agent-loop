# Godot Asset Library submission

The optional **Godot Agent Loop Bridge** is prepared for the **Addons/Tools**
category. It targets Godot 4.4 as the compatibility floor, is tested primarily
on Godot 4.7, uses SemVer `1.0.0`, and carries the same complete MIT notices as
the repository.

The addon does not install Node.js or an agent. It provides authenticated
connection state, bounded live activity, protocol diagnostics, setup help, and
a human Pause/Resume control. The external npm/MCP package remains independently
usable and falls back to a transient bridge when the persistent addon is absent.

An exact-name query against the official Asset Library API returned zero results
on 2026-07-14, so the proposed English listing name was unique at preparation
time. Uniqueness must be rechecked immediately before submission.

## Candidate artifacts

- `npm run assetlib:pack` creates
  `dist/godot-agent-loop-1.0.0.zip`, containing only
  `addons/godot_agent_loop/`. Its contract test proves identical bytes across
  UTC and Australia/Perth release environments.
- `npm run assetlib:preview` reproducibly captures the real headed editor UI.
- `assets/previews/.gdignore` prevents Godot from importing submission media.
- `distribution/assetlib/.gitattributes` is applied only to the dedicated
  AssetLib download commit, preserving the complete release-tag source archive.
- `node scripts/build-assetlib-submission.js <download-commit>` writes the exact
  commit-pinned submission payload, including raw direct image URLs.

The dedicated download commit is a child of the tested release tag and changes
only the root export attributes; the addon bytes must match the release tag and
the tested ZIP. Creating or pushing that commit and submitting the payload are
publication actions and require explicit approval.

The packaging and metadata follow the official
[Asset Library submission requirements](https://docs.godotengine.org/en/stable/community/asset_library/submitting_to_assetlib.html).
