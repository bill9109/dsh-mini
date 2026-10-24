// Rasterise src/icons/orca.svg into the PNG sizes Chrome needs for an
// extension icon. Chrome does not accept SVG here, so the mark is rendered in a
// real browser instead of approximating the artwork.
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const monorepo = (process.env.DSH_MONOREPO ?? process.env.DSH_CHECKOUT ?? (() => { throw new Error('set DSH_CHECKOUT=/path/to/dsh (a dsh source checkout)') })())
const require = createRequire(join(monorepo, 'apps/web/package.json'))
const { chromium } = require('playwright')
const SIZES = [16, 32, 48, 128]

const svg = await readFile(join(root, 'src/icons/orca.svg'), 'utf8')
const browser = await chromium.launch({ channel: process.env.DSH_UI_CHANNEL ?? 'chrome', headless: true })
try {
  for (const size of SIZES) {
    // One document per size: the SVG keeps its own 50x50 viewBox and scales.
    const context = await browser.newContext({ viewport: { width: size, height: size }, deviceScaleFactor: 1, colorScheme: 'light' })
    const page = await context.newPage()
    await page.setContent('<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}img{display:block;width:' + size + 'px;height:' + size + 'px}</style><img id="mark" alt="" src="data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64') + '">')
    await page.waitForFunction(() => { const mark = document.getElementById('mark'); return mark.complete && mark.naturalWidth > 0 })
    const png = await page.locator('#mark').screenshot({ omitBackground: true })
    await writeFile(join(root, 'src/icons/icon-' + size + '.png'), png)
    console.log('icon-' + size + '.png ' + png.length + ' bytes')
    await context.close()
  }
} finally {
  await browser.close()
}
