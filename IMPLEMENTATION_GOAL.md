# Implementation goal: ship the pre-release plan

Complete every unchecked item in `TODO.md`, end to end, and prepare or publish
the first coherent release of the product described there.

`TODO.md` at the repository root is the authoritative plan. Read it completely
before changing code. Also read `AGENTS.md`, inspect the working tree and recent
history, and preserve all existing user changes. The completed Phase 6, Phase 7,
and P4 sections are decisions and release gates, not work to redo. The open work
is the `Pre-release follow-up` section: upstream regressions, metadata integrity,
product identity, shared agent packaging, Claude Code/Codex/OpenCode/Pi adapters,
the optional persistent Godot Asset Library addon, launch evidence, and
publication.

## Current verified baseline

- The callable catalog contains 167 tools and 358 traced public action rows.
- The default agent surface contains 39 tools; `godot_tools` progressively
  discloses the rest.
- The last complete local Godot 4.7 gate passed 655 TypeScript tests, 193
  full-path MCP E2E tests, 16 strict script parses, 75 authoring-operation
  checks, and 383 runtime checks.
- The generated engine-surface audit has zero gaps for Godot 4.7.
- These are starting facts to preserve, not permission to skip rerunning the
  applicable gates after changes.

## Required order

Work in the following dependency order. A coherent group may share a commit,
but do not mark downstream work complete on top of an unverified foundation.

1. **Make the release baseline truthful.**
   - Fix repeated-key merging in `manage_input_map` and add independent live
     `InputMap` E2E evidence.
   - Fix `validate_script` autoload resolution while preserving fresh, real
     compile failures; cover multiple autoloads and a genuine error through
     direct-Godot and MCP E2E tests.
   - Derive or validate registry metadata from the manifest so tool counts and
     release identity cannot drift.
2. **Resolve product identity.**
   - Prepare the concrete rename/detachment impact and present the decision if it
     has not already been made in the goal conversation.
   - Preferred direction is **Godot Agent Loop**, tagline **Build it. Play it.
     Prove it.**, an independent repository with full history and lineage, npm
     package `@beremaran/godot-agent-loop`, MCP name
     `io.github.beremaran/godot-agent-loop`, and version `1.0.0`.
   - Do not rename public identities or create a repository until the user
     confirms this decision. If the existing identity wins, use `4.0.0` and
     retain explicit hard-fork lineage.
3. **Apply the selected identity locally.**
   - Align package, binary, registry, plugin, repository, docs, schema, badge,
     issue, homepage, and AssetLib identifiers from one source of truth.
   - Rewrite the README first screen around the feedback loop, fast setup, proof,
     support boundary, and demo. Preserve complete MIT notices and a clear
     Lineage section.
4. **Build one portable agent bundle.**
   - Replace the client-specific plugin root with a neutral bundle containing one
     canonical `skills/` tree and MCP configuration.
   - Preserve `build-godot-game`, `debug-godot-game`, and
     `verify-godot-change`; add the scoped `ship-godot-game` workflow from the
     TODO.
   - Implement and test the Claude Code and Codex manifests/marketplaces, the
     explicit and reversible OpenCode setup command, and the Pi package plus
     stdio MCP-client extension.
   - Generate or validate all adapters from one manifest. Never maintain four
     divergent copies of the same skill.
5. **Productize the optional AssetLib bridge.**
   - Create the persistent addon described in `TODO.md` with real in-editor
     status, activity, human pause control, compatibility diagnostics, and setup
     help.
   - Keep AssetLib optional: the npm/MCP package must still install its transient
     bridge when no persistent addon exists.
   - Make `EditorPluginInstaller` respect user ownership, negotiate protocol
     versions, and never overwrite or remove a user-managed addon.
   - Produce a project-safe addon archive and run the clean install, restart,
     connect, pause, disable, uninstall, and residue tests required by the plan.
6. **Prepare launch evidence and artifacts.**
   - Produce the proof-oriented cold-agent demonstration, exact reproduction
     record, README evidence, release notes, icons/previews, npm tarball, MCP
     registry metadata, client marketplace entries, and AssetLib submission
     data.
   - Verify every artifact from the exact candidate tag or commit in a clean
     environment before requesting publication approval.
7. **Publish only with explicit approval.**
   - Repository creation or detachment, pushes, tags/releases, npm publication,
     MCP Registry writes, marketplace publication, AssetLib submission, and
     public announcements are external state changes. Prepare them completely,
     show the exact targets and commands/payloads, and obtain explicit user
     approval before each publication wave.
   - After approval, publish every adapter against the same tested server release
     and perform clean public-install smoke tests.

## Rules of engagement

- Work item by item. Check a `TODO.md` box only when its full text and applicable
  definition of done are genuinely met. Put the evidence or a concise reference
  beside the checkbox in the same commit.
- Treat `TODO.md` as executable scope. If implementation reveals a missing
  prerequisite, regression, security issue, or distribution constraint, add a
  narrowly scoped item before proceeding. Do not silently weaken a claim.
- Follow the implementation checklist in `TODO.md` for every tool, action, or
  behavior change: schemas, strict validation, routing, privilege and cleanup
  semantics, unit/contract/direct-Godot/full MCP E2E coverage, independent
  observation, version/platform cases, traceability, and documentation.
- Prefer one source of truth plus generated adapters over duplicated manifests or
  workflow text. Keep the 39-tool default surface and use `godot_tools` for
  specialized discovery unless measured evidence justifies a change.
- Verify current official primary documentation before implementing Claude Code,
  Codex, OpenCode, Pi, MCP Registry, npm, GitHub, or Godot AssetLib packaging;
  these formats and review requirements can change.
- Preserve the security model: authenticated loopback bridges, default-denied
  privileged command groups, bounded payloads and logs, redaction, cooperative
  human pause, and deterministic cleanup. Packaging convenience must not bypass
  these controls.
- Preserve user projects byte-for-byte outside intentional changes. Test
  transient and persistent bridge ownership, crash/SIGKILL cleanup, repetition,
  stale installations, version mismatches, and partial failures.
- Godot is available locally through `GODOT_BIN`/`GODOT_PATH`. Run
  `npm run check` before every commit. For engine-touching changes, also run all
  direct Godot suites and `npm run test:e2e` on Godot 4.7. Run the applicable
  Godot 4.4 compatibility-floor suites when a 4.4 binary is available; otherwise
  keep the claim pending and require the 4.4 CI job before release.
- Test packaging from what users receive, not only from the checkout: `npm pack`,
  cached marketplace/plugin copies, OpenCode setup/uninstall, Pi npm/Git installs,
  and the AssetLib export archive.
- Use conventional commits matching the repository history. Commit each completed
  item or coherent group on the current branch, update its TODO checkbox and
  evidence in the same commit, and keep unrelated user changes untouched.
- Do not push, publish, submit, announce, delete/replace repositories, or rewrite
  public history without explicit user approval. Local reversible preparation and
  read-only remote verification are allowed.
- Do not delegate to subagents unless the user explicitly authorizes delegation.
  If authorized, use GPT 5.6 Luna (High) as required by `AGENTS.md`.
- Continue autonomously through safe local work. Ask only at the product-identity
  gate, an external publication gate, or when a newly discovered choice would
  materially change product claims or scope.

## Release message to preserve

The primary message is:

> Other integrations give agents tools. This project gives them a tested
> feedback loop to author, run, observe, playtest, and independently verify
> Godot games.

Lead with reproducible evidence: 167/167 E2E tools, 358 traced actions, 193
full-path E2E tests, the compact 39-tool surface and measured schema reduction,
the cold-agent acceptance run, tested Godot versions, the human pause control,
and default-denied privileged groups. Do not lead with raw tool count, claim
unbounded/full engine control, call the project official, or obscure its lineage.

## Completion condition

The goal is complete only when:

- every unchecked item in `TODO.md` is checked with evidence or converted to an
  explicit, justified scope-out accepted by the user;
- both upstream regressions and the metadata-drift guard are closed;
- the selected product identity is consistent across every artifact;
- Claude Code, Codex, OpenCode, and Pi install and complete the required real
  MCP smoke path against the same release;
- the optional AssetLib addon passes its supported-version install and ownership
  lifecycle and, if publication was approved, is submitted successfully;
- all release gates pass from the exact release tag, with no unexpected warning,
  error, process, socket, input state, temporary artifact, object, resource, or
  RID leak;
- approved GitHub, npm, MCP Registry, marketplace, AssetLib, and announcement
  actions are complete and their public install paths are re-verified; and
- the working tree is clean and all work is committed.

If external publication approval has not yet been granted, finish every safe
local artifact and verification step, present the exact release plan and targets,
and wait for approval without marking the goal complete.
