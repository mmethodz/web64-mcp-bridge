# Setup and knowledge verification — 2026-09-13

## Scope and ownership

The Web64 frontend checkout already contained the post-release knowledge pass
when this task resumed. Those edits were preserved and their finite acceptance
checks were rerun; they were not reimplemented. New implementation in this bridge
checkout is limited to setup, client registration, download preparation and docs.
There is no MCP tool, pairing, grant, transport, schema or runtime change.
No publication, deployment, version bump or live client registration was performed.

## Knowledge findings and acceptance

The existing pass confirms three gaps: native schemas alone did not communicate
human-editable asset topology; detailed compiler documentation lacked a concise
hot/cold 6502 cost model; the exact joystick header lacked the active-low example
already available in the manual. The existing changes add two advisory authoring
profiles, manual sections, schema/SDK/template cross-links and joystick header and
search summaries. Schema validity and mutation policies remain unchanged.

`node --test test/web64-mcp-authoring-guidance.test.mjs test/web64-mcp-knowledge.test.mjs test/web64-mcp-tile-schema.test.mjs test/web64-manual-source-sync.test.mjs`

Result in the frontend checkout: **18/18 passed**. A/B discover independent map
assets and shared charset/blockset dependencies; C exposes target and hot-loop
costs; D states joystick polarity; E verifies public release/hash/bounds/paging
and relationships; F preserves native schemas and intentionally unbound maps.
The generated public manifest observed here identifies Web64 2.4.3, SDK 0.1,
829 resources and release
`37f2a1bbbf904285490ffde65208d3e714f30463b74b67dbe18e9b863488504e`.
This is repository evidence, not a claim that the hosted frontend has deployed it.
DreamGraph was unavailable; no semantic write-back was possible.

## Setup behavior

- Windows `setup.cmd`, macOS/Linux `sh setup.command`, or `node setup.mjs`.
- Chooser: Codex desktop/CLI/IDE, Claude Code, Claude Desktop.
- Node 22+, selected client/config folder and dependency checks.
- Real MCP initialize/tools-list probe before registration, without pairing.
- Absolute Node and bridge paths; client-owned stdio lifecycle.
- Codex TOML parser validation with existing text/comments retained.
- Claude Desktop JSON merge and exact previous-file backup.
- Claude Code official user-scope CLI registration and readback.
- Conflicting entries are not overwritten. Identical Codex/Desktop entries are
  idempotent. Claude Code existing entries require inspection/removal via its CLI.
- `--check` performs no installation or config writes. Claude Code's check
  establishes entry existence; `/mcp` is the final client connection check.
- Completion prints restart, pairing prompt, invitation and consent steps.

`npm run bundle:setup` stages a download with dependencies included, checks the
bridge, and creates a ZIP. A developer's pre-existing self-install dependency is
excluded in staging, preserving the checkout's package and lockfile edits.
No admin privileges, PATH/profile alias or globally installed bridge is required.
Node itself is not bundled; missing Node is reported with its official download.

## Verification

`node --test test/setup.test.mjs test/release.test.mjs test/knowledge.test.mjs test/public-knowledge-cache.test.mjs`

**21/21 passed**. Includes invalid/conflicting configs, repeat setup, exact backups,
stale-write rejection, Windows quoting, real stdio startup, isolated Codex and
Claude Desktop setup/check/rerun, and Claude Code adapter calls against a fixture.
Existing knowledge tests cover stdio/Streamable HTTP parity and cache integrity.
`git diff --check` passed. No unrelated M3–M6 campaign was run.

The produced ZIP was extracted into a fresh temporary directory and its real
setup/check/rerun test passed against isolated Windows client settings. Your live
client configuration was not touched.

Artifact: `dist/web64-mcp-bridge-0.1.0-setup.zip`, 3,569,855 bytes.
SHA-256: `042df357cafa0b856769518e33d62493ece321f7e4bd2c064bbbc7740f8b871a`.

Remaining checks before describing platform support as verified: native macOS/Linux
launcher execution and a real installed Claude Code client. The adapter is tested,
but a fixture is not a live-client certification. Browser invitation/consent uses
the existing pairing flow and was not re-certified. Publication remains separate.
