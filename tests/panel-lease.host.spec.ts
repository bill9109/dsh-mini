import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { PageBroker, type PageSession } from '../src/page-broker.ts'
import { PageSockets, PAGE_SOCKET_PATH, TASK_ENDED_CLOSE } from '../src/page-socket.ts'
import { Interactions, type ApprovalOutcome } from '../src/interactions.ts'

/**
 * Side-panel lease (A) and interaction surface (B): a page stays reachable for turns the side
 * panel starts, and approvals for a run whose capsule is hidden go to the DSH GUI.
 */
const PAIRING = 'pairing-token-0123456789abcdef'
const page = (n = 1): PageSession => ({ version: 2, taskId: 'task-' + n, selectionId: 'sel-' + n, documentId: 'doc-' + n, token: 'page-token-0123456789-' + n, url: 'https://example.test/' })
const identity = (p: PageSession) => ({ taskId: p.taskId, documentId: p.documentId, token: p.token })
const agent = (sessionId: string) => ({ id: sessionId, session: { id: sessionId } })

interface Rig { broker: PageBroker; sockets: PageSockets; humans: Interactions; port: number; server: Server; close(): Promise<void> }
const rigs: Rig[] = []
async function rig(options: ConstructorParameters<typeof PageBroker>[0] = {}): Promise<Rig> {
  const broker = new PageBroker(options)
  let humans!: Interactions
  const sockets = new PageSockets(broker, {
    pairing: () => PAIRING, originAllowed: o => o === undefined || o.startsWith('chrome-extension://'),
    onAnswer: (t, i, v) => humans.answer(t, i, v), onDetach: t => humans.detach(t), onAttach: t => humans.reattach(t),
    onSurface: (t, s) => humans.surface(t, s),
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

async function connect(port: number, p: PageSession) {
  const ws = new WebSocket('ws://127.0.0.1:' + port + PAGE_SOCKET_PATH, { headers: { origin: 'chrome-extension://abc' } })
  const frames: Record<string, any>[] = []
  ws.on('message', raw => frames.push(JSON.parse(String(raw))))
  const closed = new Promise<number>(r => ws.on('close', code => r(code)))
  await new Promise<void>((r, j) => { ws.on('open', () => r()); ws.on('error', j) })
  ws.send(JSON.stringify({ type: 'hello', ...identity(p), pairing: PAIRING }))
  let rid = 0
  const next = async (type: string, timeout = 2000) => {
    const end = Date.now() + timeout
    for (;;) {
      const i = frames.findIndex(f => f.type === type)
      if (i >= 0) return frames.splice(i, 1)[0]!
      if (Date.now() > end) throw new Error('no frame ' + type + ' in ' + JSON.stringify(frames))
      await new Promise(r => setTimeout(r, 20))
    }
  }
  const rpc = async (frame: Record<string, unknown>) => {
    const id = ++rid
    ws.send(JSON.stringify({ ...frame, rid: id }))
    for (;;) { const f = await next('reply'); if (f.rid === id) return f }
  }
  return { ws, frames, next, rpc, closed }
}

describe('side-panel lease', () => {
  it('lets a turn that no capsule run started read the page', async () => {
    const { broker, port } = await rig()
    const p = page()
    broker.bindLease('s1', p)
    const c = await connect(port, p)
    await c.next('ready')
    const pending = broker.submit('s1', 'read', { scope: 'outline' })
    const { command } = await c.next('command')
    expect(command.taskId).toBe(p.taskId)
    expect((await c.rpc({ type: 'start', commandId: command.commandId, leaseId: command.leaseId })).execute).toBe(true)
    await c.rpc({ type: 'result', commandId: command.commandId, leaseId: command.leaseId, outcome: { ok: true, code: 'READ', modification: 'not-modified' } })
    expect((await pending).code).toBe('READ')
  })

  it('outlives runs: the session stays bound until the lease is released', async () => {
    const { broker } = await rig()
    const p = page()
    broker.bindLease('s1', p)
    expect(broker.taskForSession('s1')?.taskId).toBe(p.taskId)
    broker.releaseLease(identity(p))
    expect(broker.taskForSession('s1')).toBeUndefined()
    expect((await broker.submit('s1', 'read', {})).code).toBe('NO_ACTIVE_PAGE_TASK')
  })

  it('refuses release without the page token, and refuses to release a run-bound task', async () => {
    const { broker } = await rig()
    const lease = page(1), run = page(2)
    broker.bindLease('s1', lease)
    expect(() => broker.releaseLease({ ...identity(lease), token: 'x'.repeat(30) })).toThrow(/authentication/)
    broker.bind('s2', run, new AbortController().signal)
    expect(() => broker.releaseLease(identity(run))).toThrow(/not a lease/)
  })

  it('waits for a run on the same session instead of stealing it (409)', async () => {
    const { broker } = await rig()
    const controller = new AbortController()
    broker.bind('s1', page(1), controller.signal)
    expect(() => broker.bindLease('s1', page(2))).toThrow(/run in progress/)
    controller.abort()
    expect(broker.bindLease('s1', page(2)).taskId).toBe('task-2')
  })

  it('a capsule run takes the session back and the lease socket is closed as final', async () => {
    const { broker, port } = await rig()
    const lease = page(1)
    broker.bindLease('s1', lease)
    const c = await connect(port, lease)
    await c.next('ready')
    broker.bind('s1', page(2), new AbortController().signal)
    expect(broker.taskForSession('s1')?.taskId).toBe('task-2')
    expect((await c.next('bye')).code).toBe('TASK_ENDED')
    expect(await c.closed).toBe(TASK_ENDED_CLOSE)
  })

  it('a new lease on the same session replaces the old one', async () => {
    const { broker } = await rig()
    broker.bindLease('s1', page(1))
    broker.bindLease('s1', page(2))
    expect(broker.taskForSession('s1')?.taskId).toBe('task-2')
    expect(broker.ended('task-1')).toBe(true)
  })

  it('expires a lease whose page stopped answering, but not one with a live socket', async () => {
    let now = 1_000
    const broker = new PageBroker({ now: () => now, leaseGraceMs: 30_000 })
    const gone = page(1), alive = page(2)
    broker.bindLease('s1', gone)
    broker.bindLease('s2', alive)
    const release = broker.attach(identity(alive))
    now += 31_000
    broker.expireLeases()
    expect(broker.taskForSession('s1')).toBeUndefined()
    expect(broker.taskForSession('s2')?.taskId).toBe('task-2')
    release()
    broker.shutdown()
  })
})

describe('interaction surface', () => {
  it('a lease never asks on the page: approvals go to the GUI', async () => {
    const { broker, humans, port } = await rig()
    const p = page()
    broker.bindLease('s1', p)
    const c = await connect(port, p)
    await c.next('ready')
    let gui = 0
    const outcome = await humans.approval({ agent: agent('s1'), toolName: 'bash' }, async (): Promise<ApprovalOutcome> => { gui += 1; return 'allowed-once' })
    expect(outcome).toBe('allowed-once')
    expect(gui).toBe(1)
    expect(c.frames.some(f => f.type === 'ask')).toBe(false)
  })

  it('handing a running capsule to the panel moves its open approval to the GUI', async () => {
    const { broker, humans, port } = await rig()
    const p = page()
    broker.bind('s1', p, new AbortController().signal)
    const c = await connect(port, p)
    await c.next('ready')
    let gui = 0
    const pending = humans.approval({ agent: agent('s1'), toolName: 'bash' }, async (): Promise<ApprovalOutcome> => { gui += 1; return 'rejected' })
    const ask = await c.next('ask')
    expect((await c.rpc({ type: 'surface', surface: 'gui' })).ok).toBe(true)
    expect((await c.next('ask-cancel')).interactionId).toBe(ask.interactionId)
    expect(await pending).toBe('rejected')
    expect(gui).toBe(1)
    // Later approvals of the same run skip the page while the capsule stays hidden.
    expect(await humans.approval({ agent: agent('s1'), toolName: 'bash' }, async () => 'allowed-once')).toBe('allowed-once')
    expect(c.frames.some(f => f.type === 'ask')).toBe(false)
  })

  it('moving back to the page makes the next approval ask on the page again', async () => {
    const { broker, humans, port } = await rig()
    const p = page()
    broker.bind('s1', p, new AbortController().signal)
    const c = await connect(port, p)
    await c.next('ready')
    await c.rpc({ type: 'surface', surface: 'gui' })
    await c.rpc({ type: 'surface', surface: 'page' })
    const pending = humans.approval({ agent: agent('s1'), toolName: 'bash' }, async () => 'cancelled')
    const ask = await c.next('ask')
    await c.rpc({ type: 'answer', interactionId: ask.interactionId, value: { decision: 'allow' } })
    expect(await pending).toBe('allowed-once')
  })

  it('rejects an invalid surface and a surface change for an ended task', async () => {
    const { broker, port } = await rig()
    const p = page()
    const controller = new AbortController()
    broker.bind('s1', p, controller.signal)
    const c = await connect(port, p)
    await c.next('ready')
    expect((await c.rpc({ type: 'surface', surface: 'desktop' })).ok).toBe(false)
    controller.abort()
    expect(() => broker.setSurface(identity(p), 'gui')).toThrow(/no longer active/)
  })
})
