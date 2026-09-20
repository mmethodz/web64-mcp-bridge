# Web64 MCP bridge changelog

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
