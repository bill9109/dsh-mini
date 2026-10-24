# Changelog

All notable user-facing changes to dsh-mini are documented in this file. The project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic version tags.

## [0.2.0] - 2026-10-24

### Added

- Side-panel lease: after "Expand in side panel", the page stays attached to the conversation for as long as the panel shows it. Turns started from the panel can use `page_read` / `page_edit` on the page the capsule was handed over from, with the handed-over selection as the initial target. The lease ends when the panel closes, the tab closes or navigates, or a new capsule run takes the session back. The Host also expires it after 30 s without a live page.
- Interaction surface: once the capsule is hidden, approvals and `ask_user_question` for the run go to the DSH GUI in the side panel. An approval already open in the capsule moves there, and handing back to the capsule returns later approvals to the page.

### Changed

- `NO_ACTIVE_PAGE_TASK` now tells the model that no page is attached and how the user can attach one.
- Host build tag `sp4`; new routes `POST /v1/panel/lease`, `POST /v1/panel/lease/release`, `POST /v2/page/surface` and socket frame `surface`. A task the Host ended closes its socket with `bye TASK_ENDED` / 4410.

## [0.1.0] - 2026-10-24

First public release, verified against dsh `0.2.1`.

### Added

- Cordis plugin (Host + Web UI) published as a DSH bundle: authenticated loopback API on `127.0.0.1:18765`, page WebSocket `/v2/page/socket`, side-panel reverse proxy on `18766`, and a pairing card in Settings → Plugins.
- Chrome extension (Manifest V3) in its own `chrome-extension/` folder, loadable with "Load unpacked": selection capsule, side panel, in-page write-back, connection settings.
- Design notes under `docs/`.

### Changed

- Rebuilt against the dsh `0.2.1` toolchain (`clientBundle` preset); the client half uses the current icon and Button props.
