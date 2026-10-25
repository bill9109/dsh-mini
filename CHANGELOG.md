# Changelog

All notable user-facing changes to dsh-mini are documented in this file. The project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic version tags.

## [Unreleased]

### Security

- The plugin's routes on the DSH web server (`/dsh-mini-panel/api/v1/*`) were not authenticated: DSH runs its connection admission only on its own `/api` route. Any local process could read the pairing token, and any web page could rotate it. Every route now runs the same Host/Origin fence and signed-cookie check as DSH's `/api` (401 without a login, 403 cross-site), and refuses when the connection service is absent.

### Added

- Site preferences: user-written guidance for a kind of page (for example Feishu documents), one file each in `~/.dsh/mini-panel/sites/` (`*.dshsite.txt`, configurable with `sitesDir`). The header follows the userscript metadata convention between `// ==DshSite==` and `// ==/DshSite==`: `@name`, `@version` and at least one `@match` are required; `@namespace`, `@description`, `@author`, `@homepage` and `@exclude` are optional, and unknown keys are kept. Match patterns follow Tampermonkey/Chrome (`*://*.feishu.cn/*`), `@exclude` wins, and malformed patterns are refused. Only a session whose bound page matches gets the body, inside the page policy prompt section, labelled with name and version. A file that fails to parse is listed with the reason and never used.
- Settings → DSH Mini (after 金融账户): list, create, edit, enable/disable, delete, import and export site files, and test which files a URL matches and the exact text the model receives.

- `page_read` `scope: "document"`: a read-only view of the visible page (title, headings, paragraphs, lists, links, images, tables, form fields) on any site, paged by cursor. It issues no refs, so it never widens what can be written.
- Generic rich-text editors: block outline/range/keyword reads, formatting runs on every target, multi-paragraph plain/markdown/html writes, `insert-before` / `insert-after` / `delete-block`, links via `set-format`, and `insert-image` (public http(s) URL fetched by the extension, or a small data: URL). Verified on ProseMirror, Lexical and Quill pages.
- Feishu: `insert-before` / `insert-after` / `delete-block` through the editor's own Enter split and block delete.
- Code editors: CodeMirror 6 and Monaco are written through their own APIs (plain text), with the selection taken from the editor model.
- `page_edit` `edits: [...]` applies up to 20 edits in order and stops at the first failure.
- `page_read` `scope: "image"` shows one page image to the model: by `index` (an image item from `scope: "document"`) or by `targetRef` (a Feishu image block from the outline, whose metadata - name, size, dimensions - the outline now reports). The page draws the image as it already loaded it, or fetches it with the page's own login state; a cross-origin image falls back to the extension's public fetch (no cookies, no private addresses). It is reduced to a bounded JPEG, stored as a DSH attachment like `read_image`, and returned as an image block. Refused when the model does not declare image input or no attachment store is mounted. Host build tag `sp7`.
- The content script runs in every frame (including about:blank editor frames) and follows the selection into open shadow roots.

### Changed

- Handing a running task to the side panel no longer stops it or locks the panel. A run whose task was handed over survives its capsule stream closing; the panel's lease takes over its page binding, so later page tools still reach the page; and its agent is kept (not disposed) while the panel shows the session, then released once the panel lets it go and the agent is idle. Before, the run was cancelled and the panel showed 会话不可用, because disposing the agent made DSH announce the session as removed.
- The streamed rewrite sends a keep-alive comment every 20 s, so a tool call that streams nothing for more than 90 s no longer trips the extension's idle stop and cancels the turn.
- `page_edit` shape errors name the offending fields and show the exact expected form (`operation` is an object; the new text goes in `operation.text`). Host build tag `sp11`.
- `npm run build` and `npm test` no longer delete the repository's real `node_modules` (the `pnpm install --prod` that DSH loads `ws` from) when they swap in the build-only checkout link; it is moved aside and restored. Before, the next DSH start failed to import the Host (`Cannot find package 'ws'`), so the plugin and its settings page disappeared.
- Smaller page reads. Targets leave out internals (`adapter`, `recordId`) and default values (`editable: true`, `truncated: false`, false marks in runs). Lists (`outline`, `range`, `keyword`) name each distinct capability set once in `capabilitySets` and point blocks at it with `caps`; read-only blocks carry none; a block's text is clipped to 80 characters (`clipped: true`). A target read of a whole block no longer repeats it as `containingBlock` or repeats its capabilities at the top level, and an edit result returns the text once. Measured on a 19-block Feishu document: outline 14.4 KB → 4.2 KB, target read 4.8 KB → 2.9 KB.
- The page policy prompt section is shorter (3.3 KB → 1.9 KB): operation details it repeated from the `page_edit` schema were removed. Host build tag `sp10`.
- The page-edit policy now separates content edits (page tools only; never `webbridge_fill` / `webbridge_evaluate` on the bound page) from navigation and clicks, which may use the browser tools. A read-only selection still binds the task. extension 0.4.0.
- Rich-text writes try the editor's `beforeinput` before `execCommand`, and a formatting attempt that changes the text stops at once and is reported.

## [0.2.0] - 2026-10-24

### Added

- Side-panel lease: after "Expand in side panel", the page stays attached to the conversation for as long as the panel shows it. Turns started from the panel can use `page_read` / `page_edit` on the page the capsule was handed over from, with the handed-over selection as the initial target. The lease ends when the panel closes, the tab closes or navigates, or a new capsule run takes the session back. The Host also expires it after 30 s without a live page.
- Interaction surface: once the capsule is hidden, approvals and `ask_user_question` for the run go to the DSH GUI in the side panel. An approval already open in the capsule moves there, and handing back to the capsule returns later approvals to the page.

### Changed

- The page-edit policy ("edit the page only with page_read / page_edit / page_operation_status") is now a conditional global system-prompt section, like plan mode's policy. It renders for every turn whose session has a page attached, including turns started in the side panel, and is empty otherwise. Host build tag `sp5`.
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
