// Real Chromium: the unpacked extension's side panel page against the live Host, loading the real DSH client.
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const extension = dirname(here)
const endpoint = process.env.DSH_MINI_PANEL_ENDPOINT ?? 'http://127.0.0.1:18765'
const pairingToken = (await readFile(join(homedir(), '.dsh/mini-panel/token'), 'utf8')).trim()
const require = createRequire(join(process.env.DSH_MONOREPO ?? process.env.DSH_CHECKOUT ?? join(homedir(), '.dsh/source/current'), 'apps/web/package.json'))
const { chromium } = require('playwright')
const out = join(extension, 'artifacts', 'sidepanel'); await mkdir(out, { recursive: true })

const failures = []
const check = (name, ok, detail) => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' - ' + detail : '')); if (!ok) failures.push(name) }

const userDataDir = await mkdtemp(join(tmpdir(), 'dsh-sidepanel-e2e-'))
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: process.env.DSH_E2E_CHROME,
  headless: true, viewport: { width: 420, height: 820 }, deviceScaleFactor: 2,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension, '--disable-features=DisableLoadExtensionCommandLineSwitch', '--enable-unsafe-extension-debugging'],
})

try {
  let worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 30_000 })
  const id = new URL(worker.url()).host
  await worker.evaluate(async cfg => { await chrome.storage.local.set(cfg) }, { endpoint, pairingToken })
  console.log('extension', id)

  // A page in the foreground tab, so the panel page has an active tab to ask about.
  const page = await context.newPage()
  await page.goto('http://127.0.0.1:18765/v1/health').catch(() => {})

  // The panel page, opened as a tab (headless has no real side panel surface; it is the same document).
  const panel = await context.newPage()
  const errors = []
  panel.on('pageerror', e => errors.push(e.message))
  await panel.setViewportSize({ width: 420, height: 820 })
  await panel.goto('chrome-extension://' + id + '/src/sidepanel.html')
  await panel.waitForSelector('#back')
  check('panel page shows the hand-back control', await panel.locator('#back').isVisible())
  check('panel page has no script errors', errors.length === 0, errors.join('|'))
  await panel.screenshot({ path: join(out, 'panel-page.png') })

  // Ask for the state exactly as the panel does: a ticket for the real client, via the service worker.
  const frameEl = panel.locator('#frame')
  await frameEl.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {})
  const status = await panel.locator('#status').textContent().catch(() => '')
  check('panel got a ticket and shows the frame', await frameEl.isVisible(), status ?? '')
  const frame = panel.frames().find(f => f.url().startsWith('http://127.0.0.1:18766'))
  check('the frame is the Host panel origin', Boolean(frame), panel.frames().map(f => f.url()).join(' '))
  if (frame) {
    // The real client mounts into #root once every client plugin has activated.
    const mounted = await frame.waitForFunction(() => document.querySelector('#root')?.children.length > 0 && !document.querySelector('[data-boot-page]'), null, { timeout: 60_000 }).then(() => true, () => false)
    check('the real DSH client booted inside the extension frame', mounted)
    check('the panel bootstrap is present and frozen', await frame.evaluate(() => typeof globalThis.__DSH_PANEL__ === 'object' && Object.isFrozen(globalThis.__DSH_PANEL__)))
    await panel.waitForTimeout(2500)
    await panel.screenshot({ path: join(out, 'panel-client.png') })
  }
} finally {
  await context.close()
  await rm(userDataDir, { recursive: true, force: true })
}
if (failures.length) { console.error('FAILED: ' + failures.join('; ')); process.exit(1) }
console.log('sidepanel e2e passed')
