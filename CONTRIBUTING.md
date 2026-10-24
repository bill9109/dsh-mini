# Contributing to dsh-mini

Focused fixes, tests, and documentation changes are welcome. By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

1. Read [README.md](README.md) — install, usage, and troubleshooting.
2. Search existing [issues](https://github.com/bill9109/dsh-mini/issues) and pull requests before opening duplicate work.
3. Open an issue before changing the loopback protocol, the edit protocol (`src/shared/edit-protocol.cjs`), the extension permissions, or the bundle manifest.
4. Keep each change narrowly scoped. Do not mix a feature or fix with unrelated refactoring or generated-output churn.

## Architecture and scope

dsh-mini is an out-of-tree DeepSeek Harness plugin (Host + Web client) with a separate Chrome extension in `chrome-extension/`. Contributions must preserve these responsibilities:

- The Cordis plugin (repository root) is a standard DSH **bundle**: the node half owns the loopback endpoint, page broker and side-panel proxy; the browser half (`dsh.client` + `exports["./client"]`) only adds the pairing card.
- The Chrome extension (`chrome-extension/`) must stay loadable as an unpacked folder with no build step, and must not depend on files outside its folder at runtime.
- `src/shared/edit-protocol.cjs` is the single source of the edit protocol; regenerate the extension copy with `npm run sync:protocol` in `chrome-extension/`.
- Every Host route stays bound to `127.0.0.1` and requires the pairing token. Never log or return the token.
- Every contribution must be owned by the Cordis fiber and released on dispose (ports, sockets, timers).

## Development

```sh
export DSH_CHECKOUT=/path/to/dsh   # toolchain + @deepseek-ai/* packages
pnpm run build            # tsc + tsdown -> lib/ (committed)
pnpm test                 # Host tests
pnpm run test:extension   # Chrome extension checks
```

Keep the bilingual README in sync (edit both `README.md` and `README.zh.md`, then `node scripts/verify-i18n.mjs --write`).

## Commit and release

- Bump the version and update `CHANGELOG.md` (Keep a Changelog format) in the same change that ships a user-visible difference.
- Tag releases with a semantic version (`v0.1.0`) and push tags with the release.
