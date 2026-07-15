# Godot Asset Library submission

The optional **Godot Agent Loop Bridge** was submitted to the official
**Addons/Tools** category on 2026-07-15. Asset `23661` is **New / Pending** in
the moderator queue. It targets Godot 4.4 as the compatibility floor, is tested
primarily on Godot 4.7, uses SemVer `1.0.0`, and carries the same complete MIT
notices as the repository.

The addon does not install Node.js or an agent. It provides authenticated
connection state, bounded live activity, protocol diagnostics, setup help, and
a human Pause/Resume control. The external npm/MCP package remains independently
usable and falls back to a transient bridge when the persistent addon is absent.

An exact-name query against the official Asset Library API returned zero results
again immediately before submission on 2026-07-15. The official pending-detail
page now identifies the submission as asset `23661`; it will not be searchable
through the normal catalog until moderators approve it.

## Submitted listing

- Status: **New / Pending**
- Download branch: `assetlib-v1.0.0`
- Download commit: `dc576948024cbef039b01e9aca71464a550fd268`
- Parent: signed release tag commit
  `75f8241d7975f3142eebd80a1d5d694e2069caec`
- Computed download URL:
  `https://github.com/beremaran/godot-agent-loop/archive/dc576948024cbef039b01e9aca71464a550fd268.zip`
- Description: "Godot Agent Loop Bridge is an authenticated editor companion
  that shows live agent activity and compatibility status, provides setup help,
  and gives you a human Pause/Resume control."

The public pending-detail page, the user's authenticated submission receipt, and
the public review feed all agree on the asset name, status, version, Godot floor,
license, commit, repository, and icon. No reviewer feedback has been received.

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
only the root export attributes. Its real public GitHub archive contains exactly
the four expected addon files, each byte-identical to the tested release ZIP.

The packaging and metadata follow the official
[Asset Library submission requirements](https://docs.godotengine.org/en/stable/community/asset_library/submitting_to_assetlib.html).
