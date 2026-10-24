import { createServer, type IncomingMessage, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { PanelProxy } from '../src/panel-proxy.ts'

const COOKIE = 'dsh-auth=upstream-secret'
const EXT = 'chrome-extension://abcdefghijklmnop'

/** A stand-in for the real webServer: token exchange, cookie-guarded index/api/mux, public bundles. */
interface Fake { port: number; seen: Array<{ url: string; cookie?: string; origin?: string; host?: string; panel?: string }>; close(): Promise<void> }
async function fakeUpstream(): Promise<Fake> {
  const seen: Fake['seen'] = []
  const guard = (req: IncomingMessage): boolean => req.headers.cookie === COOKIE
  const server: Server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', cookie: req.headers.cookie, origin: req.headers.origin, host: req.headers.host, panel: req.headers['x-dsh-panel'] as string | undefined })
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.searchParams.get('token') === 'launch') { res.writeHead(303, { 'set-cookie': COOKIE + '; Path=/; HttpOnly; SameSite=Strict', location: './' }); res.end(); return }
    if (url.pathname.startsWith('/plugins/')) { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'immutable' }); res.end('export const bundle = 1'); return }
    if (!guard(req)) { res.writeHead(401); res.end('upstream unauthorized'); return }
    if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY', 'set-cookie': 'leak=1' }); res.end('<!doctype html><html><head><base href="./"></head><body>dsh</body></html>'); return }
    if (url.pathname === '/api/echo') { const chunks: Buffer[] = []; req.on('data', c => chunks.push(c)); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(Buffer.concat(chunks)) }); return }
    res.writeHead(404); res.end()
  })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    seen.push({ url: req.url ?? '', cookie: req.headers.cookie, origin: req.headers.origin, host: req.headers.host })
    if (!guard(req)) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return }
    wss.handleUpgrade(req, socket, head, ws => ws.on('message', m => ws.send('echo:' + String(m))))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  return { port: (server.address() as { port: number }).port, seen, close: () => new Promise(r => { wss.close(); server.closeAllConnections(); server.close(() => r(undefined)) }) }
}

const closers: Array<() => Promise<void>> = []
afterEach(async () => { while (closers.length) await closers.pop()!() })

async function rig() {
  const upstream = await fakeUpstream()
  // port 0 would bind an OS port the proxy cannot report; pick a free one instead.
  const probe = createServer(); await new Promise<void>(r => probe.listen(0, '127.0.0.1', r)); const port = (probe.address() as { port: number }).port; await new Promise(r => probe.close(r))
  const real = new PanelProxy({ port: () => upstream.port, authenticatedUrl: base => base + '?token=launch' }, port)
  await real.listen()
  closers.push(() => real.close(), () => upstream.close())
  const base = 'http://127.0.0.1:' + String(port)
  /** Open the panel exactly like the extension: ticket, then the index. */
  const open = async (session?: string) => {
    const t = real.issueTicket(session)
    const res = await fetch(t.url, { headers: { origin: EXT } })
    const html = await res.text()
    const secret = /"secret":"([^"]+)"/.exec(html)?.[1]
    return { res, html, secret, ticket: t }
  }
  return { upstream, proxy: real, base, port, open }
}

describe('side panel proxy', () => {
  it('exchanges a one-time ticket for the real index with the bootstrap first and no upstream secrets', async () => {
    const { open, upstream } = await rig()
    const { res, html, secret } = await open('session-1')
    expect(res.status).toBe(200)
    expect(html).toContain('dsh</body>')
    expect(html.indexOf('__DSH_PANEL__')).toBeLessThan(html.indexOf('<base'))
    expect(secret).toBeTruthy()
    expect(html).toContain('"session":"session-1"')
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(res.headers.get('x-frame-options')).toBeNull()
    expect(res.headers.get('content-security-policy')).toBe('frame-ancestors chrome-extension:')
    expect(html).not.toContain('upstream-secret')
    expect(upstream.seen.some(s => s.cookie === COOKIE)).toBe(true)
  })

  it('refuses a replayed, unknown or missing ticket', async () => {
    const { proxy, base, open } = await rig()
    const first = proxy.issueTicket()
    expect((await fetch(first.url)).status).toBe(200)
    expect((await fetch(first.url)).status).toBe(401)
    expect((await fetch(base + '/?ticket=nope')).status).toBe(401)
    expect((await fetch(base + '/')).status).toBe(401)
    await open()
  })

  it('guards /api by the panel secret and forwards it with the upstream cookie, not the panel header', async () => {
    const { open, base, upstream } = await rig()
    const { secret } = await open()
    expect((await fetch(base + '/api/echo', { method: 'POST', body: '{}' })).status).toBe(401)
    expect((await fetch(base + '/api/echo', { method: 'POST', body: '{}', headers: { 'x-dsh-panel': 'wrong' } })).status).toBe(401)
    const ok = await fetch(base + '/api/echo', { method: 'POST', body: '{"a":1}', headers: { 'x-dsh-panel': secret!, origin: EXT, 'sec-fetch-site': 'cross-site' } })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ a: 1 })
    const hit = upstream.seen.filter(s => s.url === '/api/echo').at(-1)!
    expect(hit.cookie).toBe(COOKIE)
    expect(hit.panel).toBeUndefined()
    expect(hit.origin).toBe('http://127.0.0.1:' + String(upstream.port))
    expect(hit.host).toBe('127.0.0.1:' + String(upstream.port))
  })

  it('serves public bundles without a panel secret and keeps their headers', async () => {
    const { base } = await rig()
    const res = await fetch(base + '/plugins/x/client.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('immutable')
    expect(await res.text()).toBe('export const bundle = 1')
  })

  it('refuses web-page origins', async () => {
    const { base, open } = await rig()
    const { secret } = await open()
    const res = await fetch(base + '/api/echo', { method: 'POST', body: '{}', headers: { 'x-dsh-panel': secret!, origin: 'https://evil.test' } })
    expect(res.status).toBe(403)
  })

  it('splices the stream mux for a valid secret only, with the upstream cookie and origin', async () => {
    const { open, port, upstream } = await rig()
    const { secret } = await open()
    const url = (s: string) => 'ws://127.0.0.1:' + String(port) + '/api/remote.mux?panel=' + s
    const bad = new WebSocket(url('wrong'), { headers: { origin: EXT } })
    await expect(new Promise((r, j) => { bad.on('open', () => r(undefined)); bad.on('error', (e: Error) => j(e)) })).rejects.toThrow(/401/)
    const ws = new WebSocket(url(secret!), { headers: { origin: EXT } })
    const reply = await new Promise<string>((resolve, reject) => { ws.on('open', () => ws.send('hi')); ws.on('message', m => resolve(String(m))); ws.on('error', reject) })
    expect(reply).toBe('echo:hi')
    const hit = upstream.seen.filter(s => s.url.startsWith('/api/remote.mux')).at(-1)!
    expect(hit.url).toBe('/api/remote.mux')
    expect(hit.cookie).toBe(COOKIE)
    expect(hit.origin).toBe('http://127.0.0.1:' + String(upstream.port))
    ws.close()
  })

  it('re-mints the upstream cookie when the index is rejected, and forwards bundles regardless', async () => {
    const { open, base, proxy, upstream } = await rig()
    await open()
    ;(proxy as unknown as { cookie: string }).cookie = 'dsh-auth=stale'
    const again = await open()
    expect(again.res.status).toBe(200)
    expect(upstream.seen.filter(s => s.cookie === 'dsh-auth=stale')).toHaveLength(1)
    expect(upstream.seen.at(-1)?.cookie).toBe(COOKIE)
    expect((await fetch(base + '/plugins/x/client.js')).status).toBe(200)
  })
})
