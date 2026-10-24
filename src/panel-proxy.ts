import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { trace } from './trace.ts'

/**
 * Side-panel carrier: a loopback reverse proxy that serves the real DSH web client
 * (ui-chat, ui-conversation and every other client plugin) to the browser extension's
 * side panel, independent of how the Host was launched.
 *
 * The upstream is this process's own webServer (`dsh web` on 3080, Desktop on 19387).
 * Like the Desktop main process, the proxy holds the upstream browser cookie itself (minted
 * from the launch token in-process) and never hands it to the page. The page authenticates
 * to the proxy with a per-panel secret obtained by exchanging a one-time ticket, which the
 * extension gets from the Bearer-guarded pairing API.
 *
 * Authority: an admitted panel speaks for the operator, exactly like the GUI. Bundles
 * (`/plugins/`) and static assets are public upstream and are forwarded as is.
 */

export const PANEL_PORT_DEFAULT = 18_766
const TICKET_TTL = 60_000
const PANEL_TTL = 12 * 60 * 60_000
const MAX_PANELS = 64
const HEADER = 'x-dsh-panel'
const QUERY = 'panel'
const MUX_PATH = '/api/remote.mux'

/** Request headers never forwarded upstream: they belong to this hop or would leak the panel identity. */
const DROP_REQUEST = ['host', 'origin', 'cookie', 'referer', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', HEADER,
  'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']
/** Response headers never relayed: upstream authentication, framing policy we replace, and hop-by-hop transport. */
const DROP_RESPONSE = ['set-cookie', 'x-frame-options', 'content-security-policy', 'connection', 'keep-alive',
  'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authenticate', 'proxy-authorization']

export interface PanelUpstream {
  /** Upstream port (the webServer this Host composed). */
  port(): number
  /** A launch-token URL for the upstream root (`connection.authenticatedUrl`). */
  authenticatedUrl(base: string): string
}

interface Ticket { readonly expires: number; readonly session?: string }
interface Panel { readonly secret: Buffer; expires: number }

const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/
const equal = (a: Buffer, b: string): boolean => {
  const other = Buffer.from(b)
  return other.length === a.length && timingSafeEqual(other, a)
}

/** Inline bootstrap placed first in <head>: authenticates every /api call and the stream mux. */
function panelBootstrap(secret: string, session: string | undefined): string {
  const config = JSON.stringify({ secret, session: session ?? null })
  return '<script>(()=>{' +
    'const c=' + config.replace(/</g, '\\u003c') + ';' +
    'Object.defineProperty(globalThis,"__DSH_PANEL__",{value:Object.freeze({session:c.session}),configurable:false});' +
    'const o=location.origin,f=globalThis.fetch.bind(globalThis);' +
    'const isApi=u=>u.origin===o&&u.pathname.startsWith("/api/");' +
    'globalThis.fetch=(i,n)=>{const r=i instanceof Request?i:null;const u=new URL(r?r.url:String(i),document.baseURI);' +
    'if(!isApi(u))return f(i,n);const h=new Headers(n?.headers??r?.headers);h.set("' + HEADER + '",c.secret);' +
    'return r?f(new Request(r,{headers:h})):f(i,{...n,headers:h})};' +
    'const W=globalThis.WebSocket;globalThis.WebSocket=new Proxy(W,{construct(T,a){const u=new URL(String(a[0]),document.baseURI);' +
    'if(u.host===location.host)u.searchParams.set("' + QUERY + '",c.secret);a[0]=u.href;return Reflect.construct(T,a)}});' +
    '})()</script>'
}

export class PanelProxy {
  private server: Server | undefined
  private cookie: string | undefined
  private cookieInFlight: Promise<string> | undefined
  private readonly tickets = new Map<string, Ticket>()
  private readonly panels = new Map<string, Panel>()
  private readonly sockets = new Set<Duplex>()
  private closed = false

  constructor(private readonly upstream: PanelUpstream, private readonly port: number) {}

  get url(): string { return 'http://127.0.0.1:' + String(this.port) + '/' }

  /** Mint a single-use ticket; the iframe URL carries it once and the page never sees the pairing token. */
  issueTicket(session?: string): { ticket: string; url: string; expires: number } {
    this.sweep()
    const ticket = randomBytes(24).toString('base64url')
    const expires = Date.now() + TICKET_TTL
    this.tickets.set(ticket, { expires, ...(session ? { session } : {}) })
    const url = new URL(this.url)
    url.searchParams.set('ticket', ticket)
    if (session) url.searchParams.set('session', session)
    return { ticket, url: url.href, expires }
  }

  async listen(): Promise<void> {
    const server = createServer((req, res) => { void this.handle(req, res).catch((error: unknown) => this.fail(res, error)) })
    server.on('upgrade', (req, socket, head) => { void this.upgrade(req, socket, head) })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.port, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    this.server = server
    trace('panel/listen', { port: this.port })
  }

  async close(): Promise<void> {
    this.closed = true
    this.tickets.clear()
    this.panels.clear()
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    const server = this.server
    this.server = undefined
    if (!server) return
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
  }

  private sweep(): void {
    const now = Date.now()
    for (const [key, t] of this.tickets) if (t.expires <= now) this.tickets.delete(key)
    for (const [key, p] of this.panels) if (p.expires <= now) this.panels.delete(key)
  }

  private authorized(secret: string | undefined): boolean {
    if (!secret) return false
    this.sweep()
    for (const panel of this.panels.values()) {
      if (equal(panel.secret, secret)) { panel.expires = Date.now() + PANEL_TTL; return true }
    }
    return false
  }

  private extensionOrigin(origin: string | undefined): boolean {
    return origin === undefined || origin.startsWith('chrome-extension://') || origin === 'http://127.0.0.1:' + String(this.port)
  }

  private async upstreamCookie(refresh = false): Promise<string> {
    if (this.cookie && !refresh) return this.cookie
    this.cookieInFlight ??= (async () => {
      try {
        const base = 'http://127.0.0.1:' + String(this.upstream.port()) + '/'
        const response = await fetch(this.upstream.authenticatedUrl(base), { redirect: 'manual' })
        const header = response.headers.get('set-cookie')
        await response.body?.cancel()
        if (response.status !== 303 || header === null) throw new Error('panel: upstream authentication failed (HTTP ' + String(response.status) + ')')
        const end = header.indexOf(';')
        this.cookie = end < 0 ? header : header.slice(0, end)
        return this.cookie
      } finally { this.cookieInFlight = undefined }
    })()
    return this.cookieInFlight
  }

  private headersFor(req: IncomingMessage, cookie: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || DROP_REQUEST.includes(name)) continue
      out[name] = Array.isArray(value) ? value.join(', ') : value
    }
    const authority = '127.0.0.1:' + String(this.upstream.port())
    out.host = authority
    out.cookie = cookie
    // The upstream Origin fence wants same-origin; the browser's real origin was checked here.
    if (req.headers.origin !== undefined) out.origin = 'http://' + authority
    return out
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.closed) { res.writeHead(503); res.end(); return }
    if (!this.extensionOrigin(req.headers.origin)) { res.writeHead(403); res.end('origin not allowed'); return }
    const url = new URL(req.url ?? '/', this.url)
    if (url.pathname === '/' && url.searchParams.has('ticket')) { await this.index(req, res, url); return }
    if (url.pathname === '/' || url.pathname === '/index.html') { res.writeHead(401); res.end('open the side panel from the extension'); return }
    if (url.pathname.startsWith('/api/') && !this.authorized(req.headers[HEADER] as string | undefined)) {
      res.writeHead(401); res.end('unauthorized'); return
    }
    await this.forward(req, res, url, false)
  }

  /** Exchange a ticket for a panel secret and serve the real index with the panel bootstrap first in <head>. */
  private async index(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    this.sweep()
    const key = url.searchParams.get('ticket') ?? ''
    const ticket = this.tickets.get(key)
    if (!ticket || ticket.expires <= Date.now()) { res.writeHead(401); res.end('ticket expired; reopen the side panel'); return }
    this.tickets.delete(key)
    if (this.panels.size >= MAX_PANELS) {
      const oldest = [...this.panels.entries()].sort((a, b) => a[1].expires - b[1].expires)[0]
      if (oldest) this.panels.delete(oldest[0])
    }
    const secret = randomBytes(32).toString('base64url')
    this.panels.set(secret, { secret: Buffer.from(secret), expires: Date.now() + PANEL_TTL })
    const html = await this.fetchIndex(req)
    const session = url.searchParams.get('session') ?? ticket.session
    const body = html.replace(/<head(\s[^>]*)?>/i, open => open + panelBootstrap(secret, session && SESSION_ID.test(session) ? session : undefined))
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "frame-ancestors chrome-extension:",
    })
    res.end(body)
    trace('panel/opened', { panels: this.panels.size, session: session ?? null })
  }

  private async fetchIndex(req: IncomingMessage, retry = true): Promise<string> {
    const cookie = await this.upstreamCookie()
    const base = 'http://127.0.0.1:' + String(this.upstream.port()) + '/'
    const response = await fetch(base, { headers: { cookie, accept: req.headers.accept ?? 'text/html' }, redirect: 'manual' })
    if (response.status === 401 && retry) { await response.body?.cancel(); await this.upstreamCookie(true); return this.fetchIndex(req, false) }
    if (!response.ok) throw new Error('panel: upstream index HTTP ' + String(response.status))
    return response.text()
  }

  /** Stream one request upstream with the proxy-held cookie; retries once on an expired cookie. */
  private async forward(req: IncomingMessage, res: ServerResponse, url: URL, retried: boolean): Promise<void> {
    const cookie = await this.upstreamCookie(retried)
    await new Promise<void>((resolve, reject) => {
      const upstream = httpRequest({
        host: '127.0.0.1', port: this.upstream.port(), method: req.method, path: url.pathname + url.search,
        headers: this.headersFor(req, cookie),
      }, (incoming) => {
        if (incoming.statusCode === 401 && !retried && (req.method === 'GET' || req.method === 'HEAD')) {
          incoming.resume()
          this.forward(req, res, url, true).then(resolve, reject)
          return
        }
        const headers: Record<string, string | string[]> = {}
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value !== undefined && !DROP_RESPONSE.includes(name)) headers[name] = value
        }
        res.writeHead(incoming.statusCode ?? 502, headers)
        incoming.pipe(res)
        incoming.once('end', resolve)
        incoming.once('error', reject)
      })
      upstream.once('error', reject)
      res.once('close', () => upstream.destroy())
      if (req.method === 'GET' || req.method === 'HEAD') upstream.end()
      else req.pipe(upstream)
    })
  }

  /** WebSocket mux: authenticate by the panel secret, then splice raw TCP to the upstream with its cookie. */
  private async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? '/', this.url)
    const refuse = (status: number): void => { socket.end('HTTP/1.1 ' + String(status) + ' Refused\r\nconnection: close\r\n\r\n') }
    if (this.closed || !this.extensionOrigin(req.headers.origin)) { refuse(403); return }
    if (!this.authorized(url.searchParams.get(QUERY) ?? undefined)) { refuse(401); return }
    url.searchParams.delete(QUERY)
    let cookie: string
    try { cookie = await this.upstreamCookie() } catch { refuse(502); return }
    const target: Socket = connect(this.upstream.port(), '127.0.0.1')
    this.sockets.add(socket); this.sockets.add(target)
    const done = (): void => { this.sockets.delete(socket); this.sockets.delete(target); socket.destroy(); target.destroy() }
    socket.once('close', done); target.once('close', done)
    socket.once('error', done); target.once('error', done)
    target.once('connect', () => {
      const headers = this.headersFor(req, cookie)
      headers.origin = 'http://127.0.0.1:' + String(this.upstream.port())
      headers.connection = 'Upgrade'
      headers.upgrade = String(req.headers.upgrade ?? 'websocket')
      const lines = ['GET ' + url.pathname + url.search + ' HTTP/1.1', ...Object.entries(headers).map(([k, v]) => k + ': ' + v), '', '']
      target.write(lines.join('\r\n'))
      if (head.length) target.write(head)
      socket.pipe(target)
      target.pipe(socket)
    })
  }

  private fail(res: ServerResponse, error: unknown): void {
    trace('panel/error', { message: String((error as Error)?.message ?? error).slice(0, 160) }, 'error')
    if (!res.headersSent) { res.writeHead(502); res.end('panel upstream unavailable') }
    else res.destroy()
  }
}
