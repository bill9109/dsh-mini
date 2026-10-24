// Real-browser end-to-end: unpacked MV3 extension + a real rewrite Host.
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const extension = dirname(here)
const monorepo = (process.env.DSH_MONOREPO ?? process.env.DSH_CHECKOUT ?? (() => { throw new Error('set DSH_CHECKOUT=/path/to/dsh (a dsh source checkout)') })())
const endpoint = process.env.DSH_MINI_PANEL_ENDPOINT ?? 'http://127.0.0.1:18765'
const tokenFile = process.env.DSH_MINI_PANEL_TOKEN_FILE ?? join(process.env.HOME ?? '', '.dsh/mini-panel/token')
const pairingToken = (await readFile(tokenFile, 'utf8')).trim()
const require = createRequire(join(monorepo, 'apps/web/package.json'))
const { chromium } = require('playwright')
// Branded Chrome 136+ ignores --load-extension, so the e2e uses Playwright's own
// Chromium (Chrome for Testing), which still honors it.
const channel = process.env.DSH_E2E_CHANNEL ?? 'chromium'

const failures = []
const check = (name, condition, detail) => {
  if (condition) { console.log('PASS ' + name) } else { failures.push(name + (detail ? ' - ' + detail : '')); console.log('FAIL ' + name + (detail ? ' - ' + detail : '')) }
}

const fixture = await readFile(join(here, 'fixture.html'))
const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(fixture)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = 'http://127.0.0.1:' + String(server.address().port)

const userDataDir = await mkdtemp(join(tmpdir(), 'dsh-mini-panel-e2e-'))
// MV3 service workers do not start under old headless; DSH_E2E_HEADLESS=0 runs headed.
const headless = process.env.DSH_E2E_HEADLESS !== '0'
const context = await chromium.launchPersistentContext(userDataDir, {
  channel,
  headless,
  // Playwright disables extensions by default; the unpacked plugin needs them on.
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [
    '--disable-extensions-except=' + extension,
    '--load-extension=' + extension,
    // Chrome 137+ gates the command-line load switch behind feature flags.
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--enable-unsafe-extension-debugging',
  ],
})

try {
  let worker = context.serviceWorkers()[0]
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30_000 })
  await worker.evaluate(async cfg => { await chrome.storage.local.set(cfg) }, { endpoint, pairingToken })
  console.log('extension worker ready; endpoint ' + endpoint)

  const page = await context.newPage()
  await page.goto(origin + '/fixture.html')
  await page.waitForSelector('#doc')

  // --- textarea path ---
  await page.evaluate(() => {
    const box = document.getElementById('doc')
    box.focus()
    box.setSelectionRange(0, 8)
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
  await page.waitForSelector('#marker:not([hidden])', { timeout: 10_000 })
  check('floating marker appears for a textarea selection', true)

  await page.locator('#marker').click()
  await page.waitForSelector('section:not([hidden])', { timeout: 10_000 })
  const original = (await page.locator('#doc').inputValue()).slice(0, 8)
  check('panel opens the input capsule', await page.locator('#instruction').isVisible())

  await page.locator('#instruction').fill('改得更专业一些')
  await page.locator('#generate').click()
  await page.waitForSelector('#preview:not([hidden])', { timeout: 90_000 })
  const replacement = await page.locator('#result').inputValue()
  check('real Host returned a rewrite', replacement.trim().length > 0 && replacement !== original, JSON.stringify(replacement))

  await page.locator('#replace').click()
  await page.waitForTimeout(600)
  const after = await page.locator('#doc').inputValue()
  check('textarea content was replaced in place', after.includes(replacement), JSON.stringify(after))
  const statusText = await page.locator('#status').textContent()
  check('status reports the replacement', (statusText ?? '').includes('已替换'), JSON.stringify(statusText))

  // --- contenteditable path ---
  await page.locator('#add').click()
  await page.locator('#close').click()
  await page.evaluate(() => {
    const host = document.getElementById('editable')
    host.focus()
    const range = document.createRange()
    range.setStart(host.firstChild, 0)
    range.setEnd(host.firstChild, 7)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
  await page.waitForSelector('#marker:not([hidden])', { timeout: 10_000 })
  await page.locator('#marker').click()
  await page.waitForSelector('section:not([hidden])', { timeout: 10_000 })
  await page.locator('#instruction').fill('改成更短的表达')
  await page.locator('#generate').click()
  await page.waitForSelector('#preview:not([hidden])', { timeout: 90_000 })
  const second = await page.locator('#result').inputValue()
  check('real Host returned a second rewrite', second.trim().length > 0, JSON.stringify(second))
  const canReplace = await page.locator('#replace').isEnabled()
  check('contenteditable selection is offered as editable', canReplace)
  if (canReplace) {
    await page.locator('#replace').click()
    await page.waitForTimeout(600)
    const editableText = await page.locator('#editable').textContent()
    check('contenteditable content was replaced in place', (editableText ?? '').includes(second), JSON.stringify(editableText))
  }
} finally {
  await context.close()
  await new Promise(resolve => server.close(resolve))
  await rm(userDataDir, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.log('FAILED: ' + failures.join(' | '))
  process.exit(1)
}
console.log('ALL BROWSER CHECKS PASSED')
