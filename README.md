# dsh-mini — use DSH from any web page

[![License: BSD-3-Clause](https://img.shields.io/badge/license-BSD--3--Clause-0B7285?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%5E20%20%7C%20%3E%3D22-339933?style=flat-square&logo=nodedotjs&logoColor=white)](package.json)
[![DSH profiles](https://img.shields.io/badge/DSH-Web-5B4CF0?style=flat-square)](cordis.patch.yml)

**Install the plugin:** `dsh plugin --profile web add github:bill9109/dsh-mini`

**Select text on any page, ask DeepSeek Harness to rewrite or extend it, and write the result back in place. A Cordis plugin (Host + Web UI) plus a separate Chrome extension.**

[English](README.md) | [中文](README.zh.md)

## Two parts, installed separately

| Part | Folder | What it is | How you install it |
| --- | --- | --- | --- |
| Cordis plugin | repository root (`src/`, `lib/`, `package.json`) | DSH bundle: a loopback Host endpoint plus a pairing card in Settings → Plugins | `dsh plugin` (below) |
| Chrome extension | [`chrome-extension/`](chrome-extension/) | Manifest V3 extension: floating selection capsule, side panel, in-page write-back | Load the folder in Chrome (below) |

The extension talks only to `http://127.0.0.1` and authenticates with a pairing token. It never needs the plugin's source, and the plugin never needs the extension's files, so each can be updated on its own.

## Install the Cordis plugin

```sh
dsh plugin --profile web add github:bill9109/dsh-mini
```

The command runs `pnpm add` in the profile directory and appends the bundle to `dsh.profile.bundles`. The repository ships its build output (`lib/`), so no build step is needed. Restart the Web UI and hard-refresh the browser afterwards.

The only runtime dependency is `ws`; DSH packages come from the running DSH. The bundle mounts the Host plugin with its defaults (`cordis.patch.yml` lists every optional key: ports, workspace, timeout).

Check that the Host is up. The token file is created on first start:

```sh
curl -s -H "Authorization: Bearer $(cat ~/.dsh/mini-panel/token)" http://127.0.0.1:18765/v1/health
# {"ok":true,...,"panel":true}
```

### Uninstall

```sh
dsh plugin --profile web remove dsh-mini
```

## Install the Chrome extension

1. Get the `chrome-extension/` folder (clone this repository, or download it as a ZIP and unpack it).
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose the `chrome-extension/` folder itself (the one that contains `manifest.json`).
4. Open the extension's options page and set:
   - **Endpoint**: `http://127.0.0.1:18765` (default)
   - **Pairing token**: the content of `~/.dsh/mini-panel/token`. The same value is shown in DSH under **Settings → Plugins → Mini Panel**, where you can also rotate it.

Select text on a page and the capsule appears. Requires Chrome 116 or newer. Details: [`chrome-extension/README.md`](chrome-extension/README.md).

## Security model

- Every route is bound to `127.0.0.1` and requires `Authorization: Bearer <pairing token>`.
- Cross-origin requests are accepted only from `localhost`, `127.0.0.1` and `chrome-extension://` origins.
- The token file is created with mode 0600 and is never logged or returned by any route. Rotating it takes effect immediately.
- The extension's `<all_urls>` host permission is what lets the capsule appear on any page. The extension reads no cookies, and the token stays in `chrome.storage.local`, never in the page.
- Selected text goes to your configured DSH model as attributed, untrusted data. It is recorded in the session log.

## Layout

| Path | Contents |
| --- | --- |
| `src/` | Host plugin (`index.ts`), page broker, page WebSocket, side-panel proxy; `src/client/` is the Web UI half |
| `src/shared/edit-protocol.cjs` | The edit protocol. Single source of truth; `chrome-extension/src/edit-protocol.js` is a synced copy (`npm run sync:protocol` in the extension folder) |
| `lib/` | Committed build output |
| `tests/` | Host tests (vitest) |
| `chrome-extension/` | The Chrome extension, with its own tests |
| `docs/` | Design notes: Feishu front-end engine, write-loop design, verified operations |

## Development and verification

```sh
# Toolchain and @deepseek-ai/* packages come from a DSH source checkout.
export DSH_CHECKOUT=/path/to/dsh

pnpm run build        # tsc + tsdown -> lib/ (committed)
pnpm test             # Host tests
pnpm run test:extension   # extension: check + background + edit-core
```

Known gaps:

- `tests/host-http.host.spec.ts` has 19 failing cases. Its test harness does not provide the `tools` service the Host now requires. The other Host suites pass.
- `chrome-extension/tests/ui.mjs`, `options.mjs`, `e2e.mjs` and `sidepanel-e2e.mjs` drive a real browser through Playwright from the DSH checkout. Set `DSH_CHECKOUT` (and `DSH_E2E_CHROME` for the side-panel test).
- Opening the side panel from a real click, and the capsule coming back after you reclaim a session, have not been verified on a real browser.

## Community

- [GitHub Issues](https://github.com/bill9109/dsh-mini/issues) for reproducible bugs and focused requests.
- Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing changes; report vulnerabilities privately via [SECURITY.md](SECURITY.md).
- Release notes: [CHANGELOG.md](CHANGELOG.md).

## License

BSD-3-Clause
