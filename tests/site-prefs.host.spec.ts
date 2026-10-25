import { describe, expect, it } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatSiteFile, matchPattern, matchesUrl, parseSiteFile, promptFor, SitePrefStore, TEMPLATE, MAX_PROMPT_CHARS, type SitePref } from '../src/site-prefs.ts'

const file = (extra = '', body = 'Use short paragraphs.') => [
  '// ==DshSite==',
  '// @name         Feishu style',
  '// @namespace    https://example.test/me',
  '// @version      1.2.0',
  '// @match        *://*.feishu.cn/*',
  '// @match        *://*.larkoffice.com/*',
  extra,
  '// ==/DshSite==',
  body,
].filter(Boolean).join('\n')

describe('site file format', () => {
  it('parses a userscript-style header and keeps unknown keys', () => {
    const p = parseSiteFile(file('// @exclude      *://*.feishu.cn/sheets/*\n// @license      MIT'))
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(p.meta).toMatchObject({ name: 'Feishu style', version: '1.2.0', match: ['*://*.feishu.cn/*', '*://*.larkoffice.com/*'], exclude: ['*://*.feishu.cn/sheets/*'] })
    expect(p.meta.extra).toEqual([['license', 'MIT']])
    expect(p.body).toBe('Use short paragraphs.')
  })
  it('round-trips through formatSiteFile', () => {
    const p = parseSiteFile(file('// @license MIT'))
    if (!p.ok) throw new Error(p.message)
    const again = parseSiteFile(formatSiteFile(p.meta, p.body))
    expect(again).toEqual(p)
    expect(parseSiteFile(TEMPLATE).ok).toBe(true)
  })
  it('refuses headers that would be ambiguous about who sees the body', () => {
    expect(parseSiteFile('no header at all')).toMatchObject({ ok: false })
    expect(parseSiteFile(file().replace('// @version      1.2.0\n', ''))).toMatchObject({ ok: false, message: expect.stringContaining('@version') })
    expect(parseSiteFile(file().replace(/\/\/ @match.*\n/g, ''))).toMatchObject({ ok: false, message: expect.stringContaining('@match') })
    expect(parseSiteFile(file('// @match        feishu.cn'))).toMatchObject({ ok: false })
    expect(parseSiteFile(file('// @match        *://evil*.com/*'))).toMatchObject({ ok: false })
    expect(parseSiteFile(file('// @name dup'))).toMatchObject({ ok: false, message: expect.stringContaining('twice') })
    expect(parseSiteFile('text\n' + file())).toMatchObject({ ok: false })
    expect(parseSiteFile(file('', 'x'.repeat(40_000)))).toMatchObject({ ok: false })
  })
})

describe('match patterns', () => {
  it('follows userscript/Chrome semantics', () => {
    expect(matchPattern('*://*.feishu.cn/*', 'https://acme.feishu.cn/docx/abc')).toBe(true)
    expect(matchPattern('*://*.feishu.cn/*', 'https://feishu.cn/x')).toBe(true)
    expect(matchPattern('*://*.feishu.cn/*', 'https://notfeishu.cn/x')).toBe(false)
    expect(matchPattern('*://*.feishu.cn/*', 'https://feishu.cn.evil.com/x')).toBe(false)
    expect(matchPattern('https://*.feishu.cn/docx/*', 'http://a.feishu.cn/docx/1')).toBe(false)
    expect(matchPattern('https://*.feishu.cn/docx/*', 'https://a.feishu.cn/wiki/1')).toBe(false)
    expect(matchPattern('*://*/*', 'https://anything.test/')).toBe(true)
    expect(matchPattern('<all_urls>', 'chrome://extensions')).toBe(false)
    expect(matchPattern('*://a.test/x.y*', 'https://a.test/xzy')).toBe(false)
  })
  it('lets @exclude win over @match', () => {
    const p = parseSiteFile(file('// @exclude      *://*.feishu.cn/sheets/*'))
    if (!p.ok) throw new Error(p.message)
    expect(matchesUrl(p.meta, 'https://acme.feishu.cn/docx/1')).toBe(true)
    expect(matchesUrl(p.meta, 'https://acme.feishu.cn/sheets/1')).toBe(false)
  })
})

describe('prompt text', () => {
  const pref = (id: string, body: string, enabled = true, match = ['*://*.feishu.cn/*']): SitePref =>
    ({ id, enabled, body, meta: { name: id, version: '1.0.0', match, exclude: [], extra: [] } })
  it('includes only enabled files that match, labelled with name and version', () => {
    const text = promptFor([pref('a', 'rule A'), pref('b', 'rule B', false), pref('c', 'rule C', true, ['*://*.other.test/*'])], 'https://x.feishu.cn/docx/1')
    expect(text).toContain('[a v1.0.0]')
    expect(text).toContain('rule A')
    expect(text).not.toContain('rule B')
    expect(text).not.toContain('rule C')
    expect(promptFor([pref('a', 'rule A')], 'https://example.test/')).toBe('')
  })
  it('is bounded', () => {
    const big = Array.from({ length: 5 }, (_, i) => pref('p' + i, 'x'.repeat(5000)))
    const text = promptFor(big, 'https://x.feishu.cn/')
    expect(text.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS + 200)
    expect(text).toContain('omitted')
  })
})

describe('store', () => {
  it('saves, lists, disables, re-saves in place and removes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-site-'))
    try {
      const store = new SitePrefStore(dir)
      let changes = 0
      const off = store.onChange(() => { changes++ })
      const saved = await store.save(file())
      expect(saved).toEqual({ ok: true, id: 'feishu-style' })
      const second = await store.save(file())
      expect(second).toEqual({ ok: true, id: 'feishu-style-2' })
      expect((await store.list()).prefs.map(p => p.id).sort()).toEqual(['feishu-style', 'feishu-style-2'])
      expect(await store.setEnabled('feishu-style', false)).toBe(true)
      expect((await store.list()).prefs.find(p => p.id === 'feishu-style')!.enabled).toBe(false)
      expect(await store.save(file('', 'New body'), 'feishu-style')).toEqual({ ok: true, id: 'feishu-style' })
      expect((await store.list()).prefs.find(p => p.id === 'feishu-style')!.body).toBe('New body')
      expect(await store.save('broken')).toMatchObject({ ok: false })
      expect(await store.save(file(), '../escape')).toMatchObject({ ok: false })
      expect(await store.remove('feishu-style')).toBe(true)
      expect(await store.remove('feishu-style')).toBe(false)
      expect((await readdir(dir)).filter(n => n.includes('.tmp'))).toEqual([])
      expect(changes).toBeGreaterThanOrEqual(5)
      off()
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it('reports a hand-edited broken file instead of failing the whole list', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-site-'))
    try {
      const { writeFile } = await import('node:fs/promises')
      await writeFile(join(dir, 'bad.dshsite.txt'), 'nope')
      const store = new SitePrefStore(dir)
      await store.save(file())
      const listed = await store.list()
      expect(listed.prefs.map(p => p.id)).toEqual(['feishu-style'])
      expect(listed.invalid).toEqual([{ id: 'bad', message: expect.any(String) }])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
