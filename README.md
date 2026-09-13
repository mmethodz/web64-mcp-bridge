# Web64 MCP bridge v0.1.2

Version **0.1.2** adds separately approved emulator capture/control/input and the
IDE's native table/matrix generator. It retains guided setup for Codex and Claude,
prerequisite/startup checks, safe registration and a dependency-included setup ZIP.
The shared contract is v0.1.1 (runtime wire 5); browser approval is still required.

Connect Codex or Claude to the [Web64 IDE](https://web64.nofs.ai/ide/) to read,
author and build native Web64 projects, and look up SDK documentation and asset
schemas. The bridge runs on your computer; Web64's compiler, project filesystem
and build system remain in your explicitly paired browser tab.

**Download bridge → run setup → choose your MCP client → restart client → ask
to pair → open the invitation → approve capabilities → done.**

No Web64 source checkout, manual client configuration or continuously open
terminal is needed. Setup registers the bridge; it does not grant access to a
browser project. You approve that separately in Web64.

## Easy setup: Codex and Claude

Download the **`web64-mcp-bridge-0.1.2-setup.zip`** asset from
[GitHub Releases](https://github.com/mmethodz/web64-mcp-bridge/releases) when
available, or use the setup ZIP supplied by the maintainer. Extract it into a
permanent folder you can write to, such as `Documents\Web64-Bridge`, then run setup:

- **Windows:** double-click `setup.cmd` in the extracted `web64-mcp-bridge` folder.
- **macOS/Linux:** open a terminal in that folder and run `sh setup.command`.

If no setup ZIP has been attached to a release yet, use **Code → Download ZIP**
on the [repository page](https://github.com/mmethodz/web64-mcp-bridge), extract it,
and run the same setup launcher. This source download needs npm and internet
access to install dependencies; the prepared setup ZIP already includes them.
Do not run setup inside the ZIP viewer.

Choose **Codex**, **Claude Code**, or **Claude Desktop**. Setup checks Node.js 22+,
checks the selected client, starts a temporary bridge to verify its MCP handshake
and pairing tool, and registers the bridge. The setup ZIP includes runtime
dependencies. A source/archive installation can install missing dependencies
using npm; that step needs internet access. If Node is missing, setup gives the
[Node.js LTS download](https://nodejs.org/) and tells you to rerun it after installing.
Install and launch your MCP client once before setup. No administrator account is
required. Keep the extracted folder where it is: registration points to it.

After **Setup complete**:

1. Fully quit and restart your client (closing only its window may not quit it).
2. Ask: **“Pair with Web64 so you can edit and build my project. Show me the invitation link.”**
3. Open the invitation and click **Connect local bridge**.
4. Accept a browser local-network prompt if shown, then approve **Allow editing and builds**.

The client starts the bridge automatically. You can close the setup window.
No shell alias, global npm installation, background service or port configuration
is needed. Setup registers local stdio only; capabilities still require your
explicit approval in Web64. A startup check does not mean the browser is paired.
Invitations expire after five minutes; ask for another if necessary.

### Visual checks and bounded input (v0.1.2)

Ask your client: **“Pair with Web64 so you can edit, build, run and visually test
my project. Show me the invitation.”** The client requests
`project:write+build+runtime`; if editing is unnecessary, use `build+runtime`.
Open the invitation and explicitly approve the requested emulator access.
Older read/edit/build connections cannot silently acquire it. The updated Web64
browser deployment is required; reload/save your work before re-pairing after an update.

`web64_runtime` accepts these actions:

| Action | Meaning |
| --- | --- |
| `status` | Runtime state, actual frame counter, and last operation outcome. |
| `start_current_build` | Normal IDE compile/Run of the current VFS (PRG only); also requires `build`. No Save prerequisite. |
| `stop` | Pause the emulator; does not destroy it. |
| `reset` | Power reset to BASIC; running machine state is lost. |
| `capture_frame` | Current emulator-only PNG, returned as an MCP image. No IDE/source screenshots. |
| `wait_frames` | Observe at least 1–120 new presented emulator frames. |
| `input` | Up to 32 sequential held controls, at most 120 frames total; every control is released. |

Mutating actions require `operationId` (UUID) and the current `expected` workspace
token from `web64_project_read`. They return promptly: poll `status` for
`lastOperation.state`, or retry the **identical** request with the **same** ID.
Do not submit a second ID merely because a response was lost. Each grant retains
up to 256 IDs; re-pair if that limit is reached. Only one MCP runtime operation
may run at a time, including across clients connected to the same tab.

Input step example: `{"type":"joystick","port":2,"code":"fire","frames":3}`.
Joystick codes: `up`, `down`, `left`, `right`, `fire`; ports 1 or 2.
Key codes: `KeyA`–`KeyZ`, `Digit0`–`Digit9`, `SPACE`, `RETURN`, `DEL`, `HOME`,
`RUNSTOP`, `CURSOR_UP/DOWN/LEFT/RIGHT`, `SHIFT_LEFT/RIGHT`, `F1`–`F8`.
Sequences are sequential, not chords. Use short holds for typing; keyboard repeat
remains the C64's behavior. Avoid simultaneous human input during a sequence.

Frame waits use emulator counters, not elapsed milliseconds. They are **not
cycle-exact stepping**: the returned observed count may exceed the request.
Keep the tab foreground/visible; a stalled or paused runtime fails rather than
claiming progress (five-second input/wait deadline). Disconnect releases held
controls and prevents further commands; already-running code is not rolled back.
Running code or keyboard commands may modify mounted emulated disks. Audio is
not unlocked automatically, Live preferences are unchanged, and there is no
MCP disk/cartridge mount, arbitrary memory access or Cloud operation.

### Native table/matrix generation (v0.1.2)

With `project:read` or broader approval, call `web64_generate_table` with
`action: "describe"` for the browser's supported presets/options. Then request
`action: "generate"`, `kind: "table"` or `"matrix"`, and native `options`.
For example: `{"preset":"sine","path":"wave.inc","name":"wave","count":256,"numericType":"uint8"}`.
`.c`/`.h` selects C source; `.asm`/`.inc` selects assembler source.

The browser uses the **same generator as the IDE dialog**: wave/easing/reciprocal/
multiplication tables and 2D/3D/projection/custom numeric matrices, with native
fixed-point types, clamping/wrapping/error rules and the 16 KiB generated-data cap.
Large source responses are paged using `nextOffset` (UTF-16 characters). Native
validation errors are returned explicitly. No JavaScript/formula evaluation,
automatic file mutation, binary export or new asset format is introduced.
Apply the returned source through ordinary `web64_project_apply` when editing
is approved, then use normal native includes/build targets/disk mastering.

### Client-specific details

**Codex desktop / CLI / IDE extension:** setup adds `[mcp_servers.web64]` to
`~/.codex/config.toml` (or the directory selected by `CODEX_HOME`). It preserves
existing TOML and comments, validates the result, and backs up the old file.
No separate Codex CLI installation is required for desktop users. Restart Codex
and check its MCP settings if the tools do not appear.
[Official Codex MCP configuration](https://developers.openai.com/codex/mcp).

**Claude Code:** setup requires `claude` on PATH and uses its supported
`claude mcp add --transport stdio --scope user web64 -- ...` command. This makes
Web64 available across projects. Restart Claude Code and use `/mcp` to check it.
Existing registrations are left in place; `claude mcp get web64` helps inspect a
conflict. [Official Claude Code MCP guide](https://code.claude.com/docs/en/mcp).

**Claude Desktop:** setup merges `mcpServers.web64` into
`%APPDATA%\Claude\claude_desktop_config.json` on Windows or
`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS.
Unrelated settings and servers are retained, and the original file is backed up.
Fully quit and reopen Claude. This local route is for the desktop application;
it is not the Claude web application's remote connector form.
[MCP's Claude Desktop configuration guide](https://py.sdk.modelcontextprotocol.io/get-started/real-host/).

### Check or repair setup

From the bridge folder, use `node setup.mjs --client codex --check` (substitute
`claude-code` or `claude-desktop`). This installs nothing and changes no client
settings. For Claude Code it checks that the named entry exists; `/mcp` is the
client's final connection check. Run without `--check` to register a missing entry.
Codex and Claude Desktop repeat setup without changes when already registered
with the same executable and bridge path. Conflicting entries are not replaced.

If a config file is malformed, setup reports its path and stops before writing.
If a conflicting Web64 registration exists, remove that entry in client settings
and rerun setup; for Claude Code use `claude mcp remove --scope user web64`.
Setup backups have `.web64-backup-<id>` appended to the original filename.
To undo registration, remove only the `web64` entry or restore the backup while
the client is closed. If you move the bridge folder or reinstall Node at another
path, remove the old registration and rerun setup from the new location.

### Preparing the download (maintainers)

Run `npm run bundle:setup` to produce the setup ZIP under `dist/`. It stages only
the distributable files, installs pinned runtime dependencies, verifies a real
stdio handshake, and includes those dependencies in the ZIP. It does not change
versions, publish npm packages or deploy Web64. A developer's smoke-installed
self-dependency is excluded from the staged package without editing the checkout.
An existing ZIP is never overwritten; move it aside before rebuilding. macOS/Linux
maintainers need `zip`; Windows uses the built-in `Compress-Archive` command.

## What the bridge can do

- Look up public SDK documentation, native schemas and project templates.
- Read the current project, including unsaved virtual sources and asset drafts.
- Create and edit native projects, import assets, and save/export `.web64proj`.
- Build PRG, Exomizer and D64 targets through the browser's native build system.

Project access and builds require the corresponding explicit capability grant.
Builds use the current virtual filesystem: saving first is not required.
Read/edit/build grants do not run or live-patch the emulator. Separately approved
`build+runtime` access enables the normal current-program Run path. Run Disk and
disk/cartridge mounting remain user actions.

Cloud operations and credentials are not exposed. Continue using the ordinary
Web64 Cloud interface yourself. “Local” describes the bridge process and browser
working copy, not a requirement to host Web64 locally: the default IDE is
**https://web64.nofs.ai/ide/**.

## Manual install / start (advanced)

Prefer the setup route above. For manual archive installation, substitute the
archive filename you downloaded in the commands below. The bridge's own version
is recorded in `package.json`; it is separate from the Web64 IDE version.

From an empty installation directory, install the maintainer-provided archive:

```sh
npm install --omit=dev /path/to/web64-mcp-bridge-0.1.2.tgz
node node_modules/web64-mcp-bridge/src/cli.mjs --help
```

Configure your MCP client with `command: "node"` and the absolute path to
`node_modules/web64-mcp-bridge/src/cli.mjs` as its argument. A common configuration:

```json
{
  "mcpServers": {
    "web64": {
      "command": "node",
      "args": ["C:/Tools/web64-bridge/node_modules/web64-mcp-bridge/src/cli.mjs"]
    }
  }
}
```

Use your own installation path (forward slashes also work on Windows). Client
configuration formats vary; these are the executable/argument fields for local
stdio. The client spawns the bridge; no terminal/server needs to be left open.
Do not use `npx web64-mcp-bridge` until an official npm release exists.

Use Node 22 or newer. From this repository run `npm ci`.
The Web64-owned contract is a pinned tarball under `vendor/`; no Web64 source
checkout is needed to run the bridge. SDK packages are pinned at 2.0.0.

Configure your MCP client to spawn `node` with the absolute path to
`src/cli.mjs`. This is the default stdio mode. Only MCP messages use stdout;
operational messages use stderr. There is no HTTP MCP endpoint in stdio mode.
`--transport stdio` is equivalent. The process exits when its input ends.

### Optional Streamable HTTP server (advanced)

Ordinary Codex/Claude setup uses stdio and does not need this section.
For an independent local server:

```sh
node src/cli.mjs --transport http --port 8764
```

The endpoint is `http://127.0.0.1:8764/mcp`, using **Streamable HTTP**, not the
deprecated separate HTTP+SSE transport. It refuses anonymous access. Configure
`WEB64_MCP_HTTP_CREDENTIALS` before starting: a JSON array of distinct client
records, each containing `id`, `label`, a cryptographically random 32-byte
lowercase hexadecimal `token`, and `expiresAt` (Unix milliseconds, no more than
eight hours ahead). Up to eight clients are allowed. Use an OS-protected secret
store/environment handoff, not a command-line token, project file or committed
configuration. Configure each MCP client to send its own token in an
`Authorization: Bearer …` header. Credentials are removed from the bridge's
environment after parsing and never included in logs.

This is a **preconfigured local-credential profile**, not OAuth discovery.
Clients that require OAuth-only setup are not yet certified. Stop/restart with
new credentials to rotate or revoke CLI clients; the server library additionally
supports individual client revocation. HTTP client identity is independent of
browser consent, MCP session IDs and client-supplied display labels.

The bridge binds loopback only. There is no `--host 0.0.0.0`, public proxy,
automatic service installation or unattended browser replacement.

## Pair explicitly

For the full local workflow, ask the assistant to call `web64_connection` with
`{"action":"begin_pairing","scope":"project:write+build"}`, then open its URL,
click **Connect local bridge**, answer any browser local-network prompt and
separately approve **Allow editing and builds**. The IDE host must have a matching
MCP frontend deployed. Build operates on unsaved VFS content; Save persists the
native project. Run/F5 and Run Disk are human-only. For a minimal capability
check instead, follow the steps below.

1. Call `web64_connection` with `{"action":"begin_pairing"}`.
2. Open the returned invitation URL, or paste it into the address bar of an
   existing IDE tab. Its fragment is consumed immediately; it is never sent to
   the web host or saved in a project. Treat this URL as a short-lived secret.
3. Click **Connect local bridge** and respond to any browser network permission.
4. After mutual authentication, separately click **Allow capability check**.
5. Read `web64://connection` for the live browser echo. `web64://capabilities`
   describes the ungranted baseline without private project access.
6. Use **Disconnect** in the temporary panel or `web64_connection` with
   `{"action":"disconnect"}`. Canceling before connection opens no socket.

Invitations expire after five minutes and are single-use. Reloading or losing a
connection requires a new invitation; the bridge does not silently follow tabs.
Ordinary Web64 visits show no MCP controls and perform no bridge discovery.
Project sources, native assets, build configuration and emulator state are untouched.

Default IDE: `https://web64.nofs.ai/ide/`. The explicitly supported staging URL is
`https://web64-react-p6twac9nn-mika-jussilas-projects.vercel.app/ide/`; choose it
with `--ide-url`. Vercel currently requires an authenticated browser. No wildcard
Vercel origin is accepted. For local maintainer tests only, use
`--ide-url https://localhost:9443/ide/ --allow-local-ide`. The same explicit flag
also permits local HTTP smoke tests, which do not prove HTTPS/LNA compatibility.

The verified M0 staging deployment of commit `d35c014` is
`https://web64-react-nbo02ig2k-mika-jussilas-projects.vercel.app/ide/` and is also
accepted as an exact `--ide-url`. Vercel deployment URLs are immutable; the older
URL does not automatically receive later commits. No wildcard origin was added.

## Boundaries and verification

### Read-only working copy

With a compatible Web64 browser build, request an invitation using
`web64_connection` with `{"action":"begin_pairing","scope":"project:read"}`.
The user must approve **Allow project read**, which names the current project
and includes unsaved source/asset drafts. Capability-only invitations remain
available and cannot access project content. There is no silent scope upgrade.

Use `web64_project_read` with `{"action":"manifest"}` first. The manifest
returns the current workspace token, snapshot ID, files and private resource
URIs. Actions are `manifest`, `file`, `configuration` and literal `search`.
For example, `{"action":"file","input":{"path":"main.asm","representation":"source"}}`
reads the current root source. **Saving is never required.**

Continue pages with the returned `snapshotId` and `nextOffset`. Text offsets are
UTF-16 code units; file `record` mode pages native serialized Web64 file JSON,
including base64 bytes and native metadata. The default file view is `project`;
`view:"contextual-sdk"` reads the native generated header for the captured
active target, separate from any same-named manual project file. Manifest
`contextualSdk` links are private and never enter the public knowledge cache.
Old snapshots return `current:false`; evicted snapshots fail explicitly.
Persistence is `not-reported` unless the native owner supplies a verified state;
a readable working snapshot is not evidence of a saved disk file.

The browser keeps at most two snapshots / 32 MiB total, 64 KiB text pages and
100 manifest/search items per page. Responses are bounded to 256 KiB. No project
mirror is written to the local cache. Each authenticated HTTP client has its own
grant, and supplied resource/session/project IDs cannot select another tab.
Project/account replacement, disconnect, expiry and page closure revoke reads.
An unanswered browser request fails after ten seconds as `session_unresponsive`;
connection status reports that separately from an open transport.

G2 combines native-owner/SDK/socket checks with human-approved live stdio and
two-Chrome-tab HTTP checks: unsaved source and drawn charset capture, private
header isolation, reload and independent revocation. Expiry, account/project
replacement and unresponsive handling have deterministic test authority, not
a claim of exhaustive manual browser coverage. A read-only grant exposes no
writes, saves, target builds, previews, Cloud APIs or emulator commands.

### Native authoring

Request `{"action":"begin_pairing","scope":"project:write"}` and approve
**Allow project editing** in the selected IDE. This creates a new explicit
read/write grant; it never upgrades an existing read-only connection.

`web64_project_create` accepts a native template ID and exact version, and refuses
to discard unsaved work. `web64_project_apply` submits a bounded atomic batch of
native file records and typed compiler/build/media configuration changes. Both
require a caller operation UUID and the current `workspaceToken` as `expected`.
The browser validates, checks the revision again and publishes; the bridge does
not own a project mirror or compile locally.

`web64_project_save` with `mode:"export"` returns a native `.web64proj` artifact,
not a saved host file (`persisted:false`). `web64_transfer` reads bounded chunks.
`mode:"handle"` requires an existing browser-authorized local handle; it cannot
open a picker, silently download, or invoke Cloud. `web64_operation` reads a
grant-local operation outcome. Repeating an identical operation ID returns its
retained result; changing the request under that ID fails. Reconnect/revoke
expires operations and artifacts, so an unknown outcome requires inspection,
not a blind retry with a fresh ID.

Dirty source/assets are the current VFS and need no save for authoring. MCP edits
do not run or live-patch the emulator. The user retains the ordinary Live setting
and explicitly runs the modified program. The hybrid template has passed an
actual MCP create/human save/native reopen check. G3 and G4 are closed;
their retained evidence includes native editor/import checks.

### Native build jobs

Request pairing with `scope:"build"` for read/build or
`scope:"project:write+build"` for read/write/build, then explicitly approve in
the IDE. Previous invitations/grants cannot be upgraded. `web64_build` takes an
operation UUID, current `workspaceToken` as `expected`, and `kind:"project"`,
`kind:"target"` with `targetIds`, or `kind:"disk-set"` with `diskSetId`.
It builds the current virtual sources/assets/settings, including unsaved edits.
It does not save, mount a disk, initialize the emulator, run or live-patch.

Submission returns a job ID promptly. Use `web64_operation` with `action:"status"`,
`"output"` or `"cancel"`. Status artifact metadata is paged with `offset`/`limit`
(16 by default, maximum 32). Output is paged JSON text (maximum 16,384 UTF-16
characters); concatenate pages before parsing. `web64_transfer` reads artifact
bytes in base64 chunks up to 48 KiB. Verify the SHA-256 and byte length in metadata.
Artifacts are private to the grant, not public download URLs.

One job owns the browser's shared native build lane, including disk preparation.
Identical ID/request retries return the original receipt; changed requests under
the same ID fail. Later edits label output `older-snapshot`; they do not change
captured bytes. Failed/cancelled/timed-out jobs publish no artifact bytes. Default
deadline is 120 seconds, maximum 300 seconds. Retention is ten minutes with up to
eight jobs, 64 deduplication IDs and 32 MiB artifact bytes; output is limited to
1 MiB per job. Revoke/reconnect clears private jobs and artifacts. Expired bytes
are unavailable, never silently rebuilt. MCP disk jobs currently build referenced
targets fresh rather than borrowing the interactive compiler's output cache.

Production artifacts identify the embedded immutable Web64/SDK knowledge release.
Vite development builds explicitly report `releaseBinding:"development-unattested"`
and `knowledgeRelease:null`; this is not a claim that a fetched latest release
matches the development code. Missing production identity fails closed.

### Public knowledge

`web64://knowledge` reports the available release and source binding.
`web64_knowledge_search` accepts `query`, optional `kind`, `offset`, `limit`
(maximum 20) and `scope` (`auto` or `public`). Results identify immutable
`web64://knowledge/{release}/...` resources, source hashes and SDK/Web64 versions.
`web64_knowledge_read` reads a result URI with optional `offset` and `limit`
(maximum 24,000 UTF-16 code units). Follow `nextOffset` until it is null.
Resource reads also return a bounded first page, never an implicitly complete
truncated file. Full Markdown retains code examples; SDK headers retain exact source.

Web64's hosted IDE, compiler and SDK are current: lookup always uses the **latest
published knowledge**, not a historical authoring target selected by project version.
Knowledge publication is organized by major/minor compatibility line; patch
metadata alone does not require another serialized corpus. Missing browser
knowledge metadata, a fresh project or a newer reported version does not block
lookup. The available publication is returned with honest binding metadata.

The host keeps one current published corpus and at most one replaceable development
corpus, not an archive of older SDK versions. A production build promotes generated
knowledge and removes the superseded corpus. If a deployment retires a session's
hash before a resource is fetched, the bridge revalidates current publication once.
Integrity errors and offline access still do not permit stale-cache success.
The host enforces a 64 MiB historical/transient safety ceiling without truncating
the complete current corpus. Normal retention is stricter: current plus one dev,
with no historical snapshots retained.

`binding` reports `requestedVersion`, `resolvedKnowledgeLine`, `exactMatch`,
`fallback`, `contentHash`, `knowledgeReleaseIdentity` and `selection: "latest-published"`.
`connectedReleaseVerified` is true only when the browser's echoed hash actually
matches the validated publication. Otherwise the response does not claim an exact
browser match. An explicitly declared incompatible major boundary still fails
clearly; none are declared currently. Public scope does not contact the browser.

An old resource URI resolves by resource ID against the session's current corpus,
returning its actual URI/hash and explicit fallback metadata. If its page offset
belongs to a different hash, `paginationReset: true` returns the new first page;
discard previous pages and follow the returned `nextOffset`. A missing resource
still reports not found rather than inventing equivalent content.

Knowledge requests fetch only `/docs/mcp/` on the configured approved origin.
There is no arbitrary URL, redirect following, browser-cookie forwarding, arbitrary filesystem
read, private generated `assets/generated.h`, or compiler installation. Downloads
are lazy, bounded, timed, hash-verified and cached with bounded memory across clients.
The two MCP transports use exactly the same knowledge handlers.

The current local catalog publishes trajectory v1, block/map v2, charset/sprite v3,
overlay-pair v1, SID Tracker v3 and W64P v1 envelope metadata schemas alongside
SDK/manuals and the IDE's native template manifests. Block/map
records include authoring metadata and all three optional map planes; structural
validation still requires the documented native semantic checks. Template discovery
does not instantiate a project or certify a build. Graphics records preserve native
color/display and animation metadata; linked overlay descriptors retain separate
editable banks. SID sources retain native instruments, tables, typed orders and
codec provenance, separate from derived PSID/PRG files. W64P metadata describes
binary storage only: envelope validity is not verified capture/source-binding
evidence, and its synthetic example is explicitly not a real observation.
Project/target/media schemas and import profiles are included in completed G1
coverage. A host that has not
received the knowledge publication returns `knowledge_unavailable`, not invented data.

Exact SDK source results link to `source.declarationsResourceId` in the same
release. Read `web64://knowledge/{release}/{declarationsResourceId}` to inspect C
signatures/types/macros or ASM declarations and native-registry ABI/clobber data.
Each index links back to its exact definition resource and hash. Known runtime
argument windows, dependencies and clobbers come from Web64's registry; missing
properties (including intrinsic clobbers) remain `unspecified`. The index is not
a substitute for full macro bodies or source syntax outside the native docs
parser's coverage. Follow `nextOffset` for large declaration indexes as for any
other knowledge resource.

### Public-only local cache and session validation

The CLI lazily caches verified public catalogs and resource blobs on disk, with a
32 MiB committed-entry budget shared across origins. It never stores manifests as
authority, project data, credentials, pairing invitations or private artifacts.
Entries are origin-separated and content-addressed; disk reads recheck hashes.
Corrupt entries are refetched. Cache failures leave network lookup available.

The default directory on Windows is
`%LOCALAPPDATA%/web64-mcp-bridge/public-knowledge-v1`; elsewhere it is
`$XDG_CACHE_HOME/web64-mcp-bridge/public-knowledge-v1`, falling back to
`~/.cache/web64-mcp-bridge/public-knowledge-v1`. Use `--no-knowledge-cache` to
disable disk caching; bounded in-memory reuse remains. No cache directory is
created until a public knowledge resource is actually cached.

Each logical client session first fetches the small HTTPS `knowledge-lines.json`
index and validates its latest line/hash. During host rollout, a missing index
falls back to the host's current `manifest.json`; invalid data, network errors or
hash mismatches never permit stale-cache success. Subsequent reads remain pinned
to that validated hash for consistent pagination. A restarted bridge, new
principal, pairing change or explicit
`web64_connection` disconnect requires validation again. In HTTP mode this boundary
is the authenticated client within the running bridge, **not each POST request**.
Every asynchronous read still rechecks client/grant identity before returning.
Public data may be shared across clients; their validated bindings are not shared.

A new public session cannot treat cached data as current when HTTPS validation
fails. There is no silent offline/stale fallback. This rule also means a host must
publish its current index/manifest alongside the complete hashed catalog. Cache deletion is
safe when the bridge is stopped; the next successful lookup repopulates it. A
process crash can leave an incomplete `.write-*.tmp` file, ignored on reads and
outside the committed-entry budget; it can be removed with the stopped cache.

### Connection security

- Both stdio and Streamable HTTP use one handler factory and support the tested
  2026-07-28 and 2025-11-25 MCP revisions. Legacy HTTP is stateless; GET/DELETE
  protocol sessions and deprecated HTTP+SSE endpoints are not provided.
- Browser transport is a separate loopback WebSocket channel with exact
  Origin/Host checks and HMAC-bound nonces, invitation, instance and tab identity.
- Requests and sockets are bounded. Each HTTP client has independent grants,
  SDK state and budgets. A client cannot select another client's identity.
- Local malware that can inspect process memory or control the browser is
  outside the pairing threat model; loopback alone is never authentication.

Run `npm test` for real SDK client, raw protocol and browser-wire tests. These
use isolated fixtures, no accounts or private projects. The complete compiled
IDE and real HTTPS permission tests belong to Web64's maintainer harness.
No browser permission, production-host equivalence or release-readiness claim
is implied by passing the Node tests.

Web64's separate production-bundle HTTPS harness passed on Chrome 152.0.7977.83
and Edge 152.0.4191.66: normal TLS/isolation, enforced permission allow/deny,
mutual proof and independent consent, rejected replay/secret/Origin/Host/version,
and cleanup. A human-approved native Chrome permission prompt also passed.
The deployed M0 Vercel staging frontend also passed a bounded user-browser check
through the actual stdio CLI and official MCP 2026-07-28 client: authenticated
capability echo, MCP revoke, and human-confirmed UI cleanup/source preservation.
`scripts/verify-hosted.mjs` is the one-shot maintainer check; its invitation is an
explicit short-lived user handoff, not retained evidence. With `--hostinger`, the
single production-origin check also passed: actual deployment/security headers,
authenticated capability response and revoke, with human-confirmed panel cleanup
and unchanged source. **M0/G0 is closed.** No fallback or repeated deployment
testing was necessary. The bridge itself needs no TLS certificate or trust-store
change. Other browsers and OAuth-only clients remain uncertified. The complete
24-test bridge suite also passed on Node 22.23.2 during M6; earlier implementation
tests used Node 25.2.1. M1/G1 is complete. M2 read-only routes
are implemented with 23 passing bridge tests and separate real-SDK/socket
checks for both transports/protocol versions. Human-approved live browser checks
complete G2's read-only evidence. G3 native mutation/save/reopen and G4 imports
are complete. M5 native build jobs passed G5, including the actual paired IDE
build and user-confirmed ordinary Build All/Build Output comparison. M6 passed
using a clean-installed v0.1.0 package with the official SDK client: both transports
produced identical PRG, Exomizer and D64 hashes through the real production-bundle
browser. The user saved/reopened/edited and used normal Run Disk without MCP.
HTTP also saved a comment edit through the existing browser-permitted file handle.
No emulator execution or Cloud calls were exposed. The final browser scenario
used Chrome; Edge HTTPS pairing has the earlier M0 evidence, not a duplicate
full end-to-end application run. This is the verified scope, not an assertion
that every browser or third-party MCP client has been tested.

Setup-specific test results and remaining platform verification limits are recorded
in [Setup verification](docs/setup-quality-pass.md). In particular, native
macOS/Linux launcher execution and a real installed Claude Code client remain
separate verification items; fixture tests are not live-client certification.
