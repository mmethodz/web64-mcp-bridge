# Web64 MCP bridge changelog

## Unreleased

- C64 Ultimate preflight now reads CPU Speed as the firmware's REST API reports it (raw option text such as `" 1"`, not `"1 MHz"`) and accepts any CPU Speed while Turbo Control is Off. Previously every Run on C64U failed preflight with `cpu_not_standard`.
- REU launches check the TCP DMA service (port 64) and its password during preflight, before the device is reset or written; failures report `dma_service_unavailable` or `dma_auth_rejected`.
- Unknown drive-list entries no longer block every launch; an unknown entry that occupies IEC unit 8/9 is still reported as a conflict.
- Network failures report specific codes (`device_connection_refused`, `device_unreachable`, `device_connect_timeout`, ...) instead of `device_request_failed`. HTTP connects time out after 5 s.
- A failed or timed-out upload closes its staged file, so Windows cleanup no longer replaces the real error with `staging_cleanup_failed`.
- Job-state errors on `job.commit`/`job.status` are returned as errors instead of closing the pairing. An expired grant answers `device_session_expired` and is not revoked while its job is transferring or releasing the guest.
- Disk bootstraps report a LOADING phase after release, so a slow KERNAL load counts as an observed guest handoff (`guestPhase: "loading"`). Mailbox polling is 250 ms instead of 50 ms.

## 0.1.3 — 2026-09-19

- Native portable-template inspection through `web64_project_create`: inspect bundled templates or a completed `.web64template` upload with all five bounded parameter types. Default stock creation remains compatible.
- Published template schema and authoring guide discovery; output summaries are bounded and inspection never replaces the current project.
- External templates are installed by the user into My Templates in Web64 Cloud, not through MCP or browser-local storage. Staged-template apply returns `user_action_required`; the bridge does not gain Cloud credentials or operations.
- Shared contract v0.1.2 adds optional create-request fields without changing the approved capability set. Use Web64 IDE v2.4.4 and restart the updated bridge.

## 0.1.2 — 2026-09-14

- Optional, separately approved `runtime` scope: emulator status, emulator-only PNG captures, pause and power reset. `build+runtime` also enables normal IDE current-VFS compilation and PRG Run, including unsaved sources.
- Bounded joystick/key sequences and actual presented-frame waits, with automatic key release, operation retry protection and grant-revocation cleanup. No cycle-exact stepping claim, disk mounting, audio unlock or Cloud access.
- Browser-authoritative native table/matrix generation with discoverable presets, validation, numeric overflow rules and paginated C/ASM source. No arbitrary formula evaluation or parallel asset pipeline.
- Shared contract v0.1.1 adds authenticated wire 5. Existing grants retain their original permissions; runtime access requires a fresh invitation and human approval.

## 0.1.1

- Guided local setup for Codex and Claude, prerequisite checks, client registration and packaged setup archive.
