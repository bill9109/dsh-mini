# Changelog

All notable user-facing changes to dsh-mini are documented in this file. The project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic version tags.

## [0.1.0] - 2026-10-24

First public release, verified against dsh `0.2.1`.

### Added

- Cordis plugin (Host + Web UI) published as a DSH bundle: authenticated loopback API on `127.0.0.1:18765`, page WebSocket `/v2/page/socket`, side-panel reverse proxy on `18766`, and a pairing card in Settings → Plugins.
- Chrome extension (Manifest V3) in its own `chrome-extension/` folder, loadable with "Load unpacked": selection capsule, side panel, in-page write-back, connection settings.
- Design notes under `docs/`.

### Changed

- Rebuilt against the dsh `0.2.1` toolchain (`clientBundle` preset); the client half uses the current icon and Button props.
