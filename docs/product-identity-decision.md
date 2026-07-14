# Product identity decision

Status: **Option 1 selected**

Prepared: 2026-07-14

Decision owner: Berke Arslan

This record defines the product-identity gate for the pre-release plan. It does
not authorize a repository change, push, package publication, registry write,
marketplace publication, Asset Library submission, or announcement.

## Verified current state

- The local release baseline is committed at `9efdc0a`.
- GitHub reports `beremaran/godot-mcp` as a public fork of
  `tugcantopaloglu/godot-mcp`, with `main` as its default branch.
- The current package is `@beremaran/godot-mcp` version `3.0.0`; its MCP
  Registry name is `io.github.beremaran/godot-mcp`.
- The current public binary is `godot-mcp`, and the client bundle still lives
  under `claude-plugin/`.
- The complete Git history and MIT notices already carry the Coding-Solo and
  Tugcan lineage. Any option below must preserve both.

The current source inventory finds the old npm package in three source files,
the old MCP Registry name in two, the `godot-mcp` slug in 31, the display name
in 14, and the client-specific `claude-plugin` root in six. Generated files and
`package-lock.json` add mechanical replacements but do not introduce another
identity decision.

## Coherent options

### Option 1 — Godot Agent Loop in a new independent repository (preferred)

| Field | Selected value |
| --- | --- |
| Product | **Godot Agent Loop** |
| Tagline | **Build it. Play it. Prove it.** |
| Category | **An evidence-first MCP automation loop for Godot 4** |
| Repository | `beremaran/godot-agent-loop` |
| npm package | `@beremaran/godot-agent-loop` |
| MCP Registry name | `io.github.beremaran/godot-agent-loop` |
| Binary | `godot-agent-loop` |
| Agent bundle | `agent-plugin/` |
| Godot addon | `addons/godot_agent_loop/` |
| Asset Library name | **Godot Agent Loop Bridge** |
| First release | `1.0.0` |

After separate publication approval, create an empty independent repository and
push the complete history and tags into it. GitHub documents a bare clone and
mirror push as the supported way to
[duplicate a repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/duplicating-a-repository?platform=linux).
Keep the current fork available at least until every public install path and
lineage link has been verified; deleting or archiving it is a later, separately
approved decision.

This option gives the product a distinct searchable identity without risking
the existing fork's GitHub metadata during release preparation.

### Option 2 — Godot Agent Loop by detaching and renaming the current fork

Use the same product, package, registry, binary, addon, and `1.0.0` values as
Option 1, but convert the existing GitHub fork to a standalone repository and
rename it.

GitHub's current
[fork-detachment documentation](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/detaching-a-fork)
says eligible public forks can leave the network directly. The operation is
permanent, preserves Git commit metadata, and does **not** retain repository
issues, pull requests, wikis, stars, watchers, comments, child forks, or related
metadata. A manual delete/recreate path is even more destructive. Eligibility
also depends on repository size and whether child forks exist, so it must be
rechecked immediately before approval.

This option retains one repository URL after its rename, but carries avoidable
metadata and rollback risk.

### Option 3 — retain the Godot MCP identity

| Field | Selected value |
| --- | --- |
| Product | **Godot MCP** |
| Repository | `beremaran/godot-mcp` |
| npm package | `@beremaran/godot-mcp` |
| MCP Registry name | `io.github.beremaran/godot-mcp` |
| Binary | `godot-mcp` |
| First release | `4.0.0` |

Retain the explicit GitHub fork relationship and describe the release as a hard
fork with complete Coding-Solo and Tugcan lineage. The neutral agent bundle and
optional persistent addon still ship, but their namespace follows the retained
product identity.

This option minimizes renaming, but keeps the generic name that the release plan
identified as weakly differentiated.

## Local work authorized by the eventual decision

Once one option is selected, local reversible work may proceed in this order:

1. Record the selected values in one product and adapter manifest.
2. Generate or validate package, binary, MCP, client, schema, badge, repository,
   issue, homepage, and addon identifiers from that manifest.
3. Move the canonical workflows to the neutral `agent-plugin/` bundle and build
   the Claude Code, Codex, OpenCode, and Pi adapters from it.
4. Rewrite the README first screen around the feedback loop and evidence while
   preserving complete MIT notices and a prominent Lineage section.
5. Build and lifecycle-test the optional Asset Library addon.
6. Produce launch evidence and verify exact candidate artifacts in clean
   environments.

Repository creation or detachment, remote changes, pushes, tags, releases,
package or registry publication, marketplace publication, Asset Library
submission, and announcements remain separate explicit-approval gates.

## Decision

Selected option: **1 — Godot Agent Loop in a new independent repository**

Confirmed by Berke Arslan on 2026-07-14. Local reversible identity and packaging
work is authorized. Repository creation, pushes, publication, submission, and
announcements remain behind their explicit approval gates.

There are no deliberate deviations from the Option 1 identifier table.
