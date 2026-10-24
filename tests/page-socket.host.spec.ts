import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { PageBroker, type PageSession } from '../src/page-broker.ts'
import { PageSockets, PAGE_SOCKET_PATH } from '../src/page-socket.ts'
import { Interactions } from '../src/interactions.ts'

const PAIRING = 'pairing-token-0123456789abcdef'
const page = (n = 1): PageSession => ({ version: 2, taskId: 'task-' + n, selectionId: 'sel-' + n, documentId: 'doc-' + n, token: 'page-token-0123456789-' + n, url: 'https://example.test/' })
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms))

interface Rig { broker: PageBroker; sockets: PageSockets; humans: Interactions; port: number; server: Server; close(): Promise<void> }
const rigs: Rig[] = []
async function rig(options: ConstructorParameters<typeof PageBroker>[0] = {}): Promise<Rig> {
  const broker = new PageBroker(options)
  let humans!: Interactions
  const sockets = new PageSockets(broker, {
    pairing: () => PAIRING, originAllowed: o => o === undefined || o.startsWith('chrome-extension://'),
    onAnswer: (t, i, v) => humans.answer(t, i, v), onDetach: t => humans.detach(t), onAttach: t => humans.reattach(t),
  })
  humans = new Interactions(broker, sockets)
  const server = createServer((_q, s) => { s.writeHead(404); s.end() })
  server.on('upgrade', (q, s, h) => sockets.upgrade(q, s, h))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  const value: Rig = { broker, sockets, humans, port, server, close: async () => { humans.close(); sockets.close(); broker.shutdown(); server.closeAllConnections(); await new Promise(r => server.close(() => r(undefined))) } }
  rigs.push(value)
  return value
}
afterEach(async () => { while (rigs.length) await rigs.pop()!.close() })

/** A page client: records frames, answers start/result RPCs by rid. */
async function connect(port: number, p: PageSession, pairing = PAIRING) {
  const ws = new WebSocket('ws://127.0.0.1:' + port + PAGE_SOCKET_PATH, { headers: { origin: 'chrome-extension://abc' } })
  const frames: Record<string, any>[] = []
  const waiters: Array<() => void> = []
  ws.on('message', raw => { frames.push(JSON.parse(String(raw))); waiters.splice(0).forEach(w => w()) })
  const closed = new Promise<number>(r => ws.on('close', code => r(code)))
  await new Promise<void>((r, j) => { ws.on('open', () => r()); ws.on('error', j) })
  ws.send(JSON.stringify({ type: 'hello', taskId: p.taskId, documentId: p.documentId, token: p.token, pairing }))
  let rid = 0
  const next = async (type: string, timeout = 2000) => {
    const end = Date.now() + timeout
    for (;;) {
      const i = frames.findIndex(f => f.type === type)
      if (i >= 0) return frames.splice(i, 1)[0]!
      if (Date.now() > end) throw new Error('no frame ' + type + ' in ' + JSON.stringify(frames))
      await new Promise<void>(r => { waiters.push(r); setTimeout(r, 50) })
    }
  }
  const rpc = async (frame: Record<string, unknown>) => {
    const id = ++rid
    ws.send(JSON.stringify({ ...frame, rid: id }))
    for (;;) { const f = await next('reply'); if (f.rid === id) return f }
  }
  return { ws, frames, next, rpc, closed }
}

describe('page socket', () => {
  it('pushes a command as soon as it is queued and settles over the same socket', async () => {
    const { broker, port } = await rig()
    const p = page()
    broker.bind('s1', p, new AbortController().signal)
    const c = await connect(port, p)
    await c.next('ready')
    const pending = broker.submit('s1', 'read', { scope: 'target' })
    const { command } = await c.next('command')
    expect(command.kind).toBe('read')
    expect((await c.rpc({ type: 'start', commandId: command.commandId, leaseId: command.leaseId })).execute).toBe(true)
    const ack = await c.rpc({ type: 'result', commandId: command.commandId, leaseId: command.leaseId, outcome: { ok: true, code: 'READ', modification: 'not-modified' } })
    expect(ack.ok).toBe(true)
    expect((await pending).code).toBe('READ')
  })

  it('rejects a wrong pairing token and a wrong page token', async () => {
    const { broker, port } = await rig()
    const p = page()
    broker.bind('s1', p, new AbortController().signal)
    expect(await (await connect(port, p, 'wrong-pairing-token-xxxxxxxx')).closed).toBe(4401)
    expect(await (await connect(port, { ...p, token: 'x'.repeat(30) })).closed).toBe(4403)
  })

  it('refuses web-page origins at the upgrade', async () => {
    const { port } = await rig()
    const ws = new WebSocket('ws://127.0.0.1:' + port + PAGE_SOCKET_PATH, { headers: { origin: 'https://evil.test' } })
    await expect(new Promise<void>((r, j) => { ws.on('open', () => r()); ws.on('error', j) })).rejects.toThrow(/403/)
  })
})

describe('presence', () => {
  it('fails fast with PAGE_NOT_CONNECTED when no page shows up within the grace', async () => {
    const { broker } = await rig({ connectGraceMs: 30 })
    broker.bind('s1', page(), new AbortController().signal)
    await tick(60)
    const started = Date.now()
    const out = await broker.submit('s1', 'read', {})
    expect(out.code).toBe('PAGE_NOT_CONNECTED')
    expect(Date.now() - started).toBeLessThan(50)
  })

  it('a command queued during the grace fails once the grace lapses, without waiting the timeout', async () => {
    const { broker } = await rig({ connectGraceMs: 100, timeoutMs: 60_000 })
    broker.bind('s1', page(), new AbortController().signal)
    const out = await broker.submit('s1', 'read', {})
    expect(out.code).toBe('PAGE_NOT_CONNECTED')
    expect(out.modification).toBe('not-modified')
  }, 4000)

  it('a closed socket makes later submits fail with PAGE_DISCONNECTED', async () => {
    const { broker, port } = await rig({ presenceTtlMs: 30 })
    const p = page()
    broker.bind('s1', p, new AbortController().signal)
    const c = await connect(port, p)
    await c.next('ready')
    c.ws.close()
    await c.closed
    await tick(80)
    expect((await broker.submit('s1', 'read', {})).code).toBe('PAGE_DISCONNECTED')
  })

  it('an edit executing when the page vanished becomes unknown, not a silent success', async () => {
    const { broker, port } = await rig({ presenceTtlMs: 30 })
    const p = page()
    broker.bind('s1', p, new AbortController().signal)
    const c = await connect(port, p)
    await c.next('ready')
    const pending = broker.submit('s1', 'edit', { operation: { type: 'insert-at-caret', text: 'x' } })
    const { command } = await c.next('command')
    await c.rpc({ type: 'start', commandId: command.commandId, leaseId: command.leaseId })
    c.ws.terminate()
    const out = await pending
    expect(out.code).toBe('PAGE_DISCONNECTED')
    expect(out.modification).toBe('unknown')
  }, 4000)

  it('legacy HTTP polling still counts as presence', async () => {
    const { broker } = await rig({ connectGraceMs: 10, presenceTtlMs: 1000 })
    const p = page()
    broker.bind('s1', p, new AbortController().signal)
    broker.claim({ taskId: p.taskId, documentId: p.documentId, token: p.token })
    await tick(30)
    expect(broker.presence(p.taskId)).toBe('connected')
  })
})

describe('human interactions', () => {
  const agent = (id: string) => ({ id, session: { id, snapshotEvents: () => [
    { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"rm -rf build"}' }] } } },
  ] } })

  it('asks the connected page, never the GUI, and maps the decision', async () => {
    const { broker, humans, port } = await rig()
    const p = page()
    broker.bind('s1', p, new AbortController().signal)
    const c = await connect(port, p)
    await c.next('ready')
    let gui = 0
    const out = humans.approval({ agent: agent('s1'), toolName: 'bash', callId: 'call-1', reason: 'writes files' }, async () => { gui++; return 'unavailable' })
    const ask = await c.next('ask')
    expect(ask).toMatchObject({ kind: 'approval', toolName: 'bash', reason: 'writes files', arguments: '{"command":"rm -rf build"}' })
    c.ws.send(JSON.stringify({ type: 'answer', interactionId: ask.interactionId, value: { decision: 'allow' } }))
    expect(await out).toBe('allowed-once')
    expect((await c.next('ask-done')).interactionId).toBe(ask.interactionId)
    expect(gui).toBe(0)
  })

  it('falls through to the GUI for sessions no page drives', async () => {
    const { humans } = await rig()
    expect(await humans.approval({ agent: agent('other'), toolName: 'bash' }, async () => 'rejected')).toBe('rejected')
  })

  it('validates question answers against the asked options', async () => {
    const { broker, humans, port } = await rig()
    const p = page()
    broker.bind('s1', p, new AbortController().signal)
    const c = await connect(port, p)
    await c.next('ready')
    const out = humans.question({ agent: agent('s1'), questions: [{ id: 'q', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] }, async () => ({ answers: [] }))
    const ask = await c.next('ask')
    c.ws.send(JSON.stringify({ type: 'answer', interactionId: ask.interactionId, value: { answers: [{ id: 'q', selected: ['Z'] }] } }))
    expect((await c.next('ask-invalid')).interactionId).toBe(ask.interactionId)
    c.ws.send(JSON.stringify({ type: 'answer', interactionId: ask.interactionId, value: { answers: [{ id: 'q', selected: ['B'] }] } }))
    expect(await out).toEqual({ answers: [{ id: 'q', selected: ['B'] }] })
    expect((await c.next('ask-done')).interactionId).toBe(ask.interactionId)
  })

  it('re-shows an open ask after a quick reconnect instead of handing it to the GUI', async () => {
    const { broker, humans, port } = await rig()
    const p = page()
    broker.bind('s1', p, new AbortController().signal)
    const first = await connect(port, p)
    await first.next('ready')
    let gui = 0
    const out = humans.approval({ agent: agent('s1'), toolName: 'bash' }, async () => { gui++; return 'unavailable' })
    const ask = await first.next('ask')
    first.ws.terminate()
    await first.closed
    const second = await connect(port, p)
    await second.next('ready')
    expect((await second.next('ask')).interactionId).toBe(ask.interactionId)
    second.ws.send(JSON.stringify({ type: 'answer', interactionId: ask.interactionId, value: { decision: 'reject' } }))
    expect(await out).toBe('rejected')
    expect(gui).toBe(0)
  })

  it('hands an open ask to the GUI when the page stays gone', async () => {
    const { broker, humans, port } = await rig()
    const p = page()
    broker.bind('s1', p, new AbortController().signal)
    const c = await connect(port, p)
    await c.next('ready')
    const out = humans.approval({ agent: agent('s1'), toolName: 'bash' }, async () => 'allowed-once')
    await c.next('ask')
    c.ws.terminate()
    expect(await out).toBe('allowed-once')
  }, 8000)

  it('a cancelled run withdraws the ask from the page', async () => {
    const { broker, humans, port } = await rig()
    const p = page()
    broker.bind('s1', p, new AbortController().signal)
    const c = await connect(port, p)
    await c.next('ready')
    const run = new AbortController()
    const out = humans.approval({ agent: agent('s1'), toolName: 'bash', signal: run.signal }, async () => 'allowed-once')
    const ask = await c.next('ask')
    run.abort()
    expect(await out).toBe('cancelled')
    expect((await c.next('ask-cancel')).interactionId).toBe(ask.interactionId)
  })
})
