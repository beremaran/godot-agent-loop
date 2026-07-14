# AssetLib download commit

Godot Asset Library computes its download from a repository commit. The release
tag must retain the complete project source, so the AssetLib publication wave
uses a dedicated child commit whose only change is copying `.gitattributes` from
this directory to the repository root. The addon tree is unchanged from the
tested release tag.

Before requesting publication approval:

1. Build and test the release tag, npm tarball, and addon ZIP.
2. Create a child commit of that exact tag with the root export attributes.
3. Verify `git archive` contains only `addons/godot_agent_loop/` and matches the
   tested addon byte-for-byte.
4. Put that child commit SHA in the AssetLib submission payload.

This packaging commit is pushed only as part of the explicitly approved
AssetLib publication wave.
