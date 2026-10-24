# DSH Mini Panel Extension

Chrome/Edge Manifest V3 extension for the DSH mini panel. The content script owns the
floating UI on the page and performs the actual text replacement; the service worker owns the
authenticated loopback calls to the DSH Host, which runs the model rewrite. There is no WebBridge
dependency, and the extension reads no cookies or unrelated page data.

## Pieces

| File | Role |
| --- | --- |
| `src/content.js` | Shadow-DOM floating marker and panel; selection capture; validated in-place replacement |
| `src/background.js` | Validates the sender, reads endpoint + pairing token from `chrome.storage.local`, calls the Host with `Authorization: Bearer` |
| `src/options.html` / `src/options.css` / `src/options.js` | Connection settings page in the DSH design language |
| `src/icons/orca.svg` + `icon-*.png` | Official DSH mark: SVG for the settings header, PNGs for the extension and toolbar icon |
| `scripts/icons.mjs` | Renders the PNG sizes from the SVG in a real browser |

## Load

Open `chrome://extensions`, enable Developer mode, choose Load unpacked, and select this directory.
Then open the extension options page and set:

- Bridge endpoint, default `http://127.0.0.1:18765`
- Pairing token, read from `~/.dsh/mini-panel/token` after the Host first starts

The endpoint must be `http://127.0.0.1:<port>`; anything else is rejected by the worker. The token
is stored in `chrome.storage.local` and is never written to the page.
The page mirrors the worker’s acceptance rule, so it cannot save an address the worker would
refuse, and it will not store a pairing token shorter than the 24 characters the worker requires.

### Markdown

The result is rendered as Markdown with DSH's GFM grammar subset instead of raw symbols. The
content script has no bundle and must never inject model HTML into the page, so the renderer builds
DOM nodes: HTML in the source stays literal text, matching mdast parsed without dangerous HTML.
Headings, emphasis, strikethrough, inline code, fenced code with a language label, nested and
task lists, quotes, rules, GFM tables and `http(s)`/`mailto` links are supported; the styling uses
the same board tokens as the settings page.

The rendered view is the default; clicking it swaps in the raw source editor (Escape or blur
returns). Copy and replace always use the raw text, so rendering never changes what is written back.

Folding back from the expanded card (via the card or the mark) always returns to the same 56px
capsule: title, one clamped result line, the mark, and nothing else. Folding also leaves the raw
editor, so a saved editor height can never spill outside the pill. The result card uses the same
translucent material as the composer (`--dsh-glass-text-bg` plus an 8px backdrop blur), so the page
behind it stays visible through a consistent surface.

The green completion mark follows the card state: on the capsule it sits beside the summary line and
clicking it confirms and closes the whole UI, while an expanded card moves it to the bottom-right
corner so it never competes with the text; from there it folds back to the capsule first, keeping the
result.

## Settings page

`src/options.html` follows DSH token vocabulary rather than approximating it, because an extension
page cannot import the app stylesheet. Values are copied from
`ui-theme/src/styles/design-platform.css` and `base.css`:

- Page column 720px, DSH font stack, `--dsw-alias-bg-layer-1` fill.
- Outlined settings card: 0.5px `border-l4` hairline, 16px radius, 14/16 padding - the same chrome
  as the settings model rows.
- Inputs match `ui-primitives` `Input.module.css`: 32px tall, 8px radius, hairline stroke that turns
  brand primary on focus.
- Buttons are DSH capsules (36px, 18px radius). The primary uses `button-primary-fill`, DSH contrast
  primary, which the design board labels as the brand primary and explicitly not link blue; the
  secondary is the outlined variant.
- The status module uses `--dsw-alias-bg-module-platform` like the settings editor card, with the
  12/18 caption ramp, an 8px state dot and the success/error tones.
- Both themes read the same tokens; `prefers-color-scheme: dark` applies DSH dark values.

Saving normalises the endpoint (trailing slashes removed) and reports either inline success or the
exact validation error. Testing the connection calls the authenticated `/v1/health` route and
separates a wrong pairing token (401) from an unreachable Host, then records the protocol version
under the current status. The token field can be unmasked, Enter in the endpoint field saves, and
Enter in the token field probes the connection.

## Icon

The extension icon is the official DSH orca, taken verbatim from
`apps/web/public/favicon.svg` in the checkout and rasterised to the 16/32/48/128 PNGs Chrome
requires (Chrome does not accept SVG for manifest icons). Regenerate after changing the artwork:

```bash
npm run icons   # renders src/icons/icon-*.png from src/icons/orca.svg
```

The mark is declared both as `icons` and as `action.default_icon`. Because this extension has no
popup, clicking the toolbar button opens this settings page.

Chrome has no theme-aware extension icon, so the toolbar and extensions-page tile always use the
black mark. The in-page mark is the SVG itself, which keeps the favicon behaviour of turning white
under `prefers-color-scheme: dark`.

## Live streaming

During a rewrite the task card's second line — the one that used to say "正在思考…" — carries the
model's reasoning as it arrives, while the card keeps its two-line summary height and never expands.
The content script opens one `chrome.runtime.connect({ name: 'dsh-stream' })` channel per task; the
worker calls `POST /v1/rewrite/stream` and forwards each SSE event:

| Event | Effect |
| --- | --- |
| `ready` | records the bound session id |
| `reset` | a new model attempt: clears the live line |
| `thinking` | streams the model's reasoning into that status line |
| `text` | the answer is not previewed; the line reads 正在生成结果… |
| `done` | the line carries the result itself, truncated; expanding hides it and the body continues the same text |
| `error` | the task card switches to the error state |

The reasoning section only has content when the model route actually emits reasoning deltas.
Two real runs in this checkout produced 0 and 41 `thinking` deltas for the same kind of request, so the
section appears when there is something to show rather than fabricating a summary. Closing the
capsule, cancelling, or disconnecting the port aborts the turn on the Host.

If `chrome.runtime.connect` is unavailable the code falls back to the one-shot `/v1/rewrite` route,
which is still what the desktop capsule and the deterministic UI tests use.

## Page UI

The non-voice interaction follows the supplied Codex mini keyframes:

1. Focusing an editable caret without typing shows the round **edit icon** for **1.5 seconds**, offering paragraph generation; selecting text shows the same icon for the same **1.5 seconds**, offering a selection rewrite. Typing (including IME), losing focus, clicking elsewhere, scrolling, or leaving the window hides the hint. Incidental selection events do not restart an expired hint.
2. Clicking it opens a translucent capsule with **plus, single-line input, send arrow**.
3. Submitting clears the input and immediately shows a separate **task title + progress card**.
4. The separate chevron collapses the composer into an edit/chevron capsule while the request continues. Clicking outside also collapses it. The edit icon restores the composer; the compact chevron hides/shows the task card.
5. Completion shows the result summary and a **green check**. Click the task card to show/hide the editable result. The reply is display-only: the model writes through `page_edit`, and the card marks the task as applied only when the page reported a verified modification.
6. The plus menu contains the selected context or insertion-point description, connection settings, cancellation, and explicit close. The desktop handoff entry stays hidden: it is not part of the v2 task-bound target protocol. Voice controls are removed.

Nothing is applied from the reply. Every write is a `page_edit` call against an explicit `targetRef` and `expectedRevision`, so an edit that cannot prove its target was left untouched is refused instead of guessed. Closing cancels the current browser rewrite; collapsing retains it. New page selections can start a fresh interaction once the current task is no longer running. Only one generation runs at a time. Clicking outside an unused composer closes it without leaving a compact icon; explicitly started tasks continue.

See [UI_ALIGNMENT.md](UI_ALIGNMENT.md) for the frame-by-frame comparison, inferred behaviors, scope limits, and screenshots.

The Host accepts `mode: "insert"` with an empty `text` field. The instruction is sent verbatim; surrounding editor content stays local. Empty-range desktop handoff is not supported.

## Sessions

The first submission creates and binds a real DSH session. Further instructions, new selections within the same document, and retries resume that session. After confirmed writeback, another turn targets the newly applied text. Collapsing/closing the capsule does not detach the document.

The plus menu shows the current session ID and provides **新建会话**, **绑定已有会话**, and **解除绑定**. Binding supports the latest 200 stored sessions or an explicit session ID. The list currently uses IDs as labels. Detach changes only the browser mapping and never deletes DSH history. A missing or occupied session produces an error, never a silent switch to a new conversation.

Bindings live in trusted `chrome.storage.session`, keyed by endpoint, pairing configuration, tab ID, frame ID and complete document URL (including query/hash). They survive worker suspension and page refresh, but not browser restart or extension reload. Separate tabs do not implicitly share sessions. Returning to a previously bound URL in the same tab restores its mapping. Tab closure removes its mappings. Explicitly binding both tabs to one ID is supported, with Host refusal of concurrent turns.

The Host requires `sessionPersistence` for binding. Sessions currently owned by another live agent or another DSH process are not taken over; release that agent before using the session here. New sessions use the Host configured workspace and model, not the active browser GUI conversation. Desktop handoff uses the same bound session.

### Context Provenance

- `agent.followup()`: human instruction only, with `source.kind = "user"`.
- `agent.inject()`: JSON selection/page/mode context, with `source.kind = "plugin"`, plugin `dsh-mini-panel`, snapshot section `browser-selection`.
- `systemPrompt.section()`: rewrite/insert policy and untrusted-page boundary. Tools remain disabled for plugin-owned agents.

Context is still model-visible and logged; it is not disguised as part of the human query. Existing old-format turns are left untouched.

## Runtime messages
The floating panel talks to the service worker with:

| Message | Payload | Reply |
| --- | --- | --- |
| `rewrite` | `{ requestId, selectionId, mode, text, url, title, instruction }` | `{ ok: true, replacement, sessionId, binding }` |
| `session-state` | `{ url }` | `{ ok: true, binding }` |
| `session-new` / `session-detach` | `{ url, title? }` | `{ ok: true, binding }` |
| `session-list` | `{}` | `{ ok: true, sessions }` |
| `session-bind` | `{ url, sessionId }` | `{ ok: true, binding }` |
| `cancel` | `{ requestId }` | `{ ok: true }` |
| `desktop-open` | `{ selectionId, text, url, title }` | `{ ok: true }` |
| `desktop-result` | `{ selectionId }` | `{ ok: true, result }` |
| `options` | - | opens the options page |

Failures return `{ ok: false, error: { message } }`.

## Write-back policy

Replacement refuses to run when anything it depends on moved:

1. the page URL must still match the captured one;
2. the editor element must still be connected;
3. the editor full text must equal the snapshot taken at selection time;
4. a range selection must still resolve to the same text in the same block;
5. the selection must be editable, otherwise only copy is offered.

It then dispatches a cancelable `beforeinput`, applies the change with `document.execCommand('insertText')`,
and verifies that the resulting editor value equals the expected string. If any step fails the panel
reports why and never retries blindly. It claims only that the editor accepted the input; cloud
persistence is whatever the page itself reports.

### Feishu documents (Markdown-aware write)

A Feishu docx block is its own Slate editor and parses Markdown on paste, so on
`feishu.cn` / `larksuite.com` a range selection is written by one synthetic `paste` event
instead of the generic `insertText` path. That is what makes headings, lists, quotes,
code blocks, dividers, bold, italic, strikethrough and inline code survive as real block
and inline styles rather than literal symbols.

The event only reaches the block that currently owns focus, and every docx block is
`contenteditable`, so the target `.zone-container` is confirmed focused immediately
before the paste (with a synthetic press as a second attempt) and the rendered text is
confirmed afterwards. If either check fails nothing is written and the result stays in
the panel for manual use. The strict expected-text check above is deliberately skipped on
this path: the editor re-renders the Markdown, so its text no longer equals the string
that was handed over.

`readAnchor` must keep climbing to the outermost editable ancestor. Feishu keeps the real
caret in an offscreen `textarea.docx-selection-hidden-textarea` that lives outside every
zone, and `document.activeElement` is that textarea while a block is being edited;
narrowing the climb to `closest('.zone-container')` makes the containment check reject
every selection. See the comment in `src/content.js`.

## Verification

```bash
npm run check          # manifest + JavaScript syntax
npm run test:ui        # deterministic Chromium UI tests + screenshots (no Host needed)
npm run icons          # regenerate the extension icon PNGs from the official SVG
npm run test:options   # options page: DSH tokens in both themes + save/probe behaviour
npm run test:background # actual worker with controlled storage/transport
npm run test:sessions  # real Host: create, bind, resume two model turns
npm run test:stream    # real Host + real worker: live deltas over the stream route
npm run e2e:electron   # real Chromium DOM, real content script, real Host
npm run e2e            # same flow driven through Playwright Chromium
```

`npm run e2e:electron` launches the monorepo Electron, loads `tests/fixture.html`, injects the real
`src/content.js`, and replaces only the `chrome.runtime.sendMessage` transport with direct calls to
the Host. It asserts, for both a `<textarea>` and a `contenteditable` block: the marker appears, the
panel opens for the selected text, the Host returns a rewrite, the selection is replaced in place,
and the status line confirms it. Point it at a running Host with `DSH_MINI_PANEL_ENDPOINT` and
`DSH_MINI_PANEL_TOKEN_FILE`; `DSH_MONOREPO` locates the Electron binary.

`npm run e2e` needs a Chromium build that still honors `--load-extension`. Branded Chrome 136+
ignores it, so run `npx playwright install chromium` first; set `DSH_E2E_HEADLESS=0` because MV3
service workers do not start under old headless. If that download is blocked, use `e2e:electron`.

`npm run test:options` loads the real page and stylesheet, stubs only `chrome.storage.local` and
`fetch`, and asserts computed design values (card hairline, input geometry, capsule buttons, module
surface, caption ramp, focus ring) plus validation, save normalisation and the three probe outcomes
in light and dark themes; screenshots land in `artifacts/options-light.png` and `options-dark.png`.

`npm run test:ui` uses Playwright from `DSH_MONOREPO` and installed Chrome by default. Set
`DSH_UI_CHANNEL=chromium` to use a Playwright Chromium installation instead. It saves screenshots
to `artifacts/`; `tests/ui.html` is a standalone local preview with a clearly labeled mock response.

## Limits

- Verified against a local fixture; a real Feishu document editor has not been exercised.
- Cross-block and read-only selections intentionally fall back to copy only.
- Desktop handoff UI is covered with controlled responses; actual desktop capsule integration is not covered by these tests.
