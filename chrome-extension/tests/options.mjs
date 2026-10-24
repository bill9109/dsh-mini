// Real Chromium checks for the options page: DSH design tokens and behaviour.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const root = dirname(dirname(fileURLToPath(import.meta.url)))
// The monorepo is only used to resolve playwright. Discover it rather than pinning one
// machine's staging directory: those rotate, and a stale path made this test unrunnable
// ("Cannot find module 'playwright'") on a machine where playwright IS installed.
const monorepoCandidates = [
  join(homedir(), '.dsh/source/current'),
  join(homedir(), '.dsh/source'),
].filter((candidate, index, all) => all.indexOf(candidate) === index)
const monorepo = process.env.DSH_MONOREPO
  ?? monorepoCandidates.find(candidate => existsSync(join(candidate, 'apps/web/package.json')))
  ?? homedir()
const require = createRequire(join(monorepo, 'apps/web/package.json'))
const { chromium } = require('playwright')

const server = createServer(async (req, res) => {
  const path = (req.url ?? '/').split('?')[0]
  const file = path === '/' ? 'src/options.html' : path.slice(1)
  try {
    const body = await readFile(join(root, file))
    const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8'
    res.writeHead(200, { 'content-type': type })
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = 'http://127.0.0.1:' + String(server.address().port)

const failures = []
const check = (name, ok, detail) => {
  if (ok) console.log('PASS ' + name)
  else { failures.push(name); console.log('FAIL ' + name + (detail === undefined ? '' : ' - ' + JSON.stringify(detail))) }
}

/** chrome.storage.local stand-in that records writes for assertions. */
const stub = () => {
  window.__writes = []
  window.chrome = {
    storage: {
      local: {
        _data: { endpoint: 'http://127.0.0.1:18765', pairingToken: 'k'.repeat(32) },
        async get(defaults) { return { ...defaults, ...window.chrome.storage.local._data } },
        async set(values) { Object.assign(window.chrome.storage.local._data, values); window.__writes.push({ ...values }) },
      },
      onChanged: { addListener() {} },
    },
  }
}

const browser = await chromium.launch({ channel: process.env.DSH_UI_CHANNEL ?? 'chrome', headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 900, height: 720 }, deviceScaleFactor: 2 })
  const page = await context.newPage()
  page.setDefaultTimeout(10000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(stub)
  await page.goto(origin + '/src/options.html')
  await mkdir(join(root, 'artifacts'), { recursive: true })
  // The document keeps its real path so relative CSS/JS resolve as they do in
  // chrome-extension://<id>/src/options.html.
  const prop = (selector, name) => page.locator(selector).first().evaluate((node, name) => getComputedStyle(node)[name], name)
  // The mark is an <img> of the official SVG, so its tone proves the artwork
  // loaded and that the SVG's own prefers-color-scheme rule still applies.
  const markTone = target => target.evaluate(async () => {
    const img = document.getElementById('brand-mark')
    if (!img.complete || !img.naturalWidth) return { loaded: false }
    const canvas = new OffscreenCanvas(img.naturalWidth, img.naturalHeight)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
    let sum = 0, painted = 0
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue
      sum += (data[i] + data[i + 1] + data[i + 2]) / 3
      painted++
    }
    return { loaded: true, size: img.naturalWidth, coverage: painted / (data.length / 4), tone: painted ? sum / painted : -1 }
  })

  // --- design language: tokens, geometry, states ---
  check('page uses the DSH column width', await prop('.page', 'maxWidth') === '720px')
  check('page background is layer-1', await prop('body', 'backgroundColor') === 'rgb(255, 255, 255)')
  check('page uses the DSH font stack', (await prop('body', 'fontFamily')).startsWith('-apple-system'))
  // Chrome resolves a declared 0.5px border to 1px in computed style, exactly as
  // it does inside DSH, so the declaration is checked from the stylesheet and the
  // computed value only has to stay a hairline.
  const declared = await page.evaluate(() => {
    const rules = [...document.styleSheets].flatMap(sheet => { try { return [...sheet.cssRules] } catch { return [] } })
    // The shorthand keeps its var() token unexpanded, so read it as authored.
    const width = selector => {
      const style = rules.find(rule => rule.selectorText === selector)?.style
      return (style?.getPropertyValue('border') || style?.getPropertyValue('border-top-width') || '').split(' ')[0]
    }
    return { card: width('.card'), input: width('.input-wrap'), outline: width('.button.outline'), chip: width('.chip') }
  })
  check('hairlines are declared at the DSH 0.5px width',
    Object.values(declared).every(value => value === '0.5px'), declared)
  const card = { width: await prop('.card', 'borderTopWidth'), radius: await prop('.card', 'borderRadius'), color: await prop('.card', 'borderTopColor') }
  check('card uses the hairline stroke and 16px radius',
    parseFloat(card.width) <= 1 && card.radius === '16px' && card.color === 'rgba(0, 0, 0, 0.16)', card)
  const input = { height: await prop('#endpoint-wrap', 'height'), radius: await prop('#endpoint-wrap', 'borderRadius'),
    width: await prop('#endpoint-wrap', 'borderTopWidth'), color: await prop('#endpoint-wrap', 'borderTopColor'), pad: await prop('#endpoint-wrap', 'paddingLeft') }
  check('input matches the primitives Input chrome',
    input.height === '32px' && input.radius === '8px' && parseFloat(input.width) <= 1 && input.color === 'rgba(0, 0, 0, 0.16)' && input.pad === '8px', input)
  check('primary button is the DSH contrast capsule',
    await prop('.button.primary', 'height') === '36px' && await prop('.button.primary', 'borderRadius') === '18px'
    && await prop('.button.primary', 'backgroundColor') === 'rgb(15, 17, 21)'
    && await prop('.button.primary', 'color') === 'rgb(255, 255, 255)'
    && await prop('.button.primary', 'paddingLeft') === '14px')
  const outline = { width: await prop('.button.outline', 'borderTopWidth'), color: await prop('.button.outline', 'borderTopColor'),
    fill: await prop('.button.outline', 'backgroundColor'), radius: await prop('.button.outline', 'borderRadius') }
  check('secondary button is the outlined capsule',
    parseFloat(outline.width) <= 1 && outline.color === 'rgba(0, 0, 0, 0.12)' && outline.fill === 'rgba(0, 0, 0, 0)' && outline.radius === '18px', outline)
  check('status module uses the filled module surface',
    await prop('.module', 'backgroundColor') === 'rgb(245, 246, 247)' && await prop('.module', 'borderRadius') === '12px'
    && await prop('.module', 'paddingLeft') === '16px')
  check('field label and hint follow the caption ramp',
    await prop('.field-label', 'fontSize') === '12px' && await prop('.field-label', 'fontWeight') === '500'
    && await prop('.field-label', 'color') === 'rgb(97, 102, 107)'
    && await prop('.hint', 'fontSize') === '12px' && await prop('.hint', 'color') === 'rgb(129, 133, 140)')
  const chip = { radius: await prop('#state-chip', 'borderRadius'), size: await prop('#state-chip', 'fontSize'), width: await prop('#state-chip', 'borderTopWidth') }
  check('chip matches the settings row tag', chip.radius === '4px' && chip.size === '11px' && parseFloat(chip.width) <= 1, chip)
  check('code hint uses the DSH code stack', (await prop('.hint code', 'fontFamily')).includes('SF Mono'))

  const lightMark = await markTone(page)
  check('header shows the black DSH orca mark',
    lightMark.loaded && lightMark.size >= 32 && lightMark.coverage > 0.15 && lightMark.coverage < 0.85 && lightMark.tone < 60, lightMark)

  await page.locator('#endpoint').focus()
  check('input focus turns the hairline into the brand primary',
    await prop('#endpoint-wrap', 'borderTopColor') === 'rgb(15, 17, 21)')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  const ring = await page.evaluate(() => ({ active: document.activeElement?.id, shadow: getComputedStyle(document.getElementById('reveal')).boxShadow }))
  check('keyboard focus shows the 2px DSH ring', ring.active === 'reveal' && ring.shadow.includes('2px'), ring)

  // --- loaded state ---
  check('saved config loads into the fields',
    await page.locator('#endpoint').inputValue() === 'http://127.0.0.1:18765'
    && await page.locator('#token').inputValue() === 'k'.repeat(32))
  check('status facts reflect the stored config',
    await page.locator('#fact-endpoint').textContent() === 'http://127.0.0.1:18765'
    && await page.locator('#fact-token').textContent() === '已配置 · 32 字符'
    && await page.locator('#fact-protocol').textContent() === '未探测')
  check('connection chip starts unprompted', await page.locator('#state-chip').textContent() === '未探测')
  check('stored token hides the warning', await page.locator('#feedback').isHidden())

  // --- validation ---
  await page.locator('#endpoint').fill('https://example.test:1234')
  await page.locator('#save').click()
  check('a non-loopback endpoint is refused',
    (await page.locator('#feedback').textContent()).includes('127.0.0.1')
    && await page.locator('#feedback').getAttribute('data-kind') === 'error'
    && await page.evaluate(() => window.__writes.length) === 0)
  await page.locator('#endpoint').fill('http://127.0.0.1:18765/')
  await page.locator('#token').fill('short')
  await page.locator('#save').click()
  check('a token shorter than 24 characters is refused',
    (await page.locator('#feedback').textContent()).includes('24') && await page.evaluate(() => window.__writes.length) === 0)

  // --- save normalisation ---
  await page.locator('#token').fill('z'.repeat(30))
  await page.locator('#save').click()
  await page.waitForFunction(() => document.getElementById('feedback').dataset.kind === 'ok')
  const written = await page.evaluate(() => window.__writes.at(-1))
  check('save stores the normalised endpoint and the token',
    written.endpoint === 'http://127.0.0.1:18765' && written.pairingToken === 'z'.repeat(30))
  check('the field shows the normalised endpoint', await page.locator('#endpoint').inputValue() === 'http://127.0.0.1:18765')
  check('the status facts refresh after saving',
    await page.locator('#fact-token').textContent() === '已配置 · 30 字符')

  await page.locator('#endpoint').fill('http://127.0.0.1:18766')
  await page.locator('#endpoint').press('Enter')
  await page.waitForFunction(() => window.__writes.length === 2)
  check('Enter in the endpoint field saves', (await page.evaluate(() => window.__writes.at(-1))).endpoint === 'http://127.0.0.1:18766')

  // --- connection probe ---
  const answer = (status, body) => page.evaluate(({ status, body }) => {
    window.fetch = async (url, init) => {
      window.__lastFetch = { url: String(url), authorization: init?.headers?.authorization }
      return new Response(body === null ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    }
  }, { status, body })
  await answer(200, { ok: true, protocolVersion: 1 })
  await page.locator('#test').click()
  await page.waitForFunction(() => document.getElementById('feedback').dataset.kind === 'ok')
  check('a healthy Host reports the protocol',
    (await page.locator('#feedback').textContent()).includes('v1')
    && await page.locator('#dot').getAttribute('data-state') === 'ok'
    && await page.locator('#state-chip').textContent() === '已连接'
    && await page.locator('#fact-protocol').textContent() === 'v1')
  check('the probe targets health with the bearer token',
    await page.evaluate(() => window.__lastFetch.url) === 'http://127.0.0.1:18766/v1/health'
    && await page.evaluate(() => window.__lastFetch.authorization) === 'Bearer ' + 'z'.repeat(30))

  await answer(401, { error: 'unauthorized' })
  await page.locator('#test').click()
  await page.waitForFunction(() => document.getElementById('feedback').dataset.kind === 'error')
  check('a rejected token is explained',
    (await page.locator('#feedback').textContent()).includes('401')
    && await page.locator('#dot').getAttribute('data-state') === 'error'
    && await page.locator('#state-chip').textContent() === '配对码无效')

  await page.evaluate(() => { window.fetch = async () => { throw new TypeError('Failed to fetch') } })
  await page.locator('#test').click()
  await page.waitForFunction(() => document.getElementById('state-chip').textContent === '无法连接')
  check('an unreachable Host is explained',
    (await page.locator('#feedback').textContent()).includes('Host')
    && await page.locator('#dot').getAttribute('data-state') === 'error')

  // --- token reveal ---
  await page.locator('#reveal').click()
  check('the reveal control unmasks the token',
    await page.locator('#token').getAttribute('type') === 'text'
    && await page.locator('#reveal').getAttribute('aria-pressed') === 'true'
    && await page.locator('#reveal').textContent() === '隐藏')
  await page.locator('#reveal').click()
  check('the reveal control masks it again',
    await page.locator('#token').getAttribute('type') === 'password'
    && await page.locator('#reveal').textContent() === '显示')

  await page.screenshot({ path: join(root, 'artifacts', 'options-light.png'), fullPage: true })
  check('no uncaught page errors', errors.length === 0, errors)

  // --- dark theme ---
  const dark = await browser.newContext({ viewport: { width: 900, height: 720 }, deviceScaleFactor: 2, colorScheme: 'dark' })
  const darkPage = await dark.newPage()
  darkPage.setDefaultTimeout(10000)
  const darkErrors = []
  darkPage.on('pageerror', error => darkErrors.push(error.message))
  await darkPage.addInitScript(stub)
  await darkPage.goto(origin + '/src/options.html')
  const darkProp = (selector, name) => darkPage.locator(selector).first().evaluate((node, name) => getComputedStyle(node)[name], name)
  check('dark page background is layer-1 dark', await darkProp('body', 'backgroundColor') === 'rgb(35, 35, 36)')
  const darkMark = await markTone(darkPage)
  check('dark theme inverts the mark to white, like the DSH favicon',
    darkMark.loaded && darkMark.tone > 195 && Math.abs(darkMark.coverage - lightMark.coverage) < 0.05, darkMark)
  check('dark text is the light label',
    await darkProp('body', 'color') === 'rgb(249, 250, 251)' && await darkProp('.page-intro', 'color') === 'rgb(173, 178, 184)')
  check('dark module uses the raised surface', await darkProp('.module', 'backgroundColor') === 'rgb(53, 54, 56)')
  check('dark hairlines stay light-alpha',
    await darkProp('.card', 'borderTopColor') === 'rgba(255, 255, 255, 0.2)'
    && await darkProp('#endpoint-wrap', 'borderTopColor') === 'rgba(255, 255, 255, 0.2)'
    && await darkProp('.chip', 'borderTopColor') === 'rgba(255, 255, 255, 0.16)')
  check('dark primary button inverts to near-white',
    await darkProp('.button.primary', 'backgroundColor') === 'rgb(249, 250, 251)'
    && await darkProp('.button.primary', 'color') === 'rgb(15, 17, 21)')
  await darkPage.locator('#endpoint').fill('https://example.test')
  await darkPage.locator('#save').click()
  check('dark error state uses the dark error tone', await darkProp('#feedback', 'color') === 'rgb(242, 90, 90)')
  await darkPage.screenshot({ path: join(root, 'artifacts', 'options-dark.png'), fullPage: true })
  check('no uncaught page errors in dark mode', darkErrors.length === 0, darkErrors)
  await dark.close()
} finally {
  await browser.close()
  await new Promise(resolve => server.close(resolve))
}

if (failures.length > 0) {
  console.log('FAILED: ' + failures.join(' | '))
  process.exit(1)
}
console.log('ALL OPTIONS CHECKS PASSED')
