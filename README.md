# Web64 MCP bridge v0.1.0

This separate local package adapts MCP clients to an explicitly paired Web64
browser tab. It does **not** contain Web64's compiler, project filesystem,
importers or Cloud credentials. It is not a hosted Web64 service.

Supported scope: explicit pairing and disconnect, browser capability/release
discovery, public SDK/documentation/schema lookup, and separately approved native
project reads, creation, atomic editing, imports, local save/export and asynchronous
PRG/Exomizer/D64 build jobs. **M0–M6 verification passed**, including clean-installed
stdio and authenticated Streamable HTTP clients against the production-bundle IDE
and human save/reopen/edit/Run Disk checks. Publication and deployment are separate
maintainer actions; this repository has not been published or pushed.

V1 is local-workspace only. Cloud project listing, remote open/create/save,
revision operations and credentials are excluded; the user handles Cloud in the
ordinary IDE. Native project provenance is data, never a Cloud permission grant.
The current capability contract continues to require `cloudAccess: false`.

## Install / start

Initial release version: **v0.1.0**. M6 external-client verification passed;
no npm publication or hosted frontend deployment is implied by this version.

From an empty installation directory, install the maintainer-provided archive:

```sh
npm install --omit=dev /path/to/web64-mcp-bridge-0.1.0.tgz
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

Optional independent local server:

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

With a matching M2 browser build, request an invitation using
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

### Native authoring (M3/G3 and M4/G4 passed)

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
their retained evidence includes native editor/import checks. No published release is claimed.

### Native build jobs (M5/G5 passed; unreleased)

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

Without a paired browser, lookup explicitly reports `public-release` and
`connectedReleaseVerified: false`. Auto lookup with a compatible paired production
browser uses that bundle's embedded release, not the host's mutable latest pointer.
An M0 browser or a Vite/HMR workspace cannot attest a release: auto lookup returns
`connected_knowledge_unavailable`; explicit `scope: public` remains available
without claiming to match that tab. No fallback silently substitutes latest.

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

Each logical client session must first validate its release: a paired production
tab supplies its embedded manifest, or public scope fetches a small HTTPS manifest.
Subsequent reads remain pinned to that release rather than changing with the host's
latest pointer. Explicit older-release URIs require their own immutable manifest
validation. A restarted bridge, new principal, pairing change or explicit
`web64_connection` disconnect requires validation again. In HTTP mode this boundary
is the authenticated client within the running bridge, **not each POST request**.
Every asynchronous read still rechecks client/grant identity before returning.
Public data may be shared across clients; their validated bindings are not shared.

A new public session cannot treat cached data as current when HTTPS validation
fails. There is no silent offline/stale fallback. This rule also means a host must
publish the immutable release manifest alongside each catalog. Cache deletion is
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

This repository has been initialized locally; it has not been published or pushed.
