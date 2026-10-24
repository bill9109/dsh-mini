import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { timingSafeEqual } from 'node:crypto'
import { WebSocketServer, type WebSocket, type RawData } from 'ws'
import { PageBroker, boundedJson, type Identity, type Json } from './page-broker.ts'
import { trace } from './trace.ts'

/**
 * Per-task duplex channel between the Host and the extension's service worker.
 *
 * Replaces claim polling as the primary transport: the Host pushes a command the moment the broker
 * queues it, and the socket's liveness IS the page's presence. The broker's state machine (lease,
 * start/result, unknown barrier) is unchanged; this layer only moves its frames. HTTP claim/start/
 * result stay as the fallback, notably for results a restarted worker re-delivers.
 *
 * Wire (JSON text frames):
 *   page -> host  hello {taskId, documentId, token, pairing}   first frame, within HELLO_MS
 *                 start {rid, commandId, leaseId}               -> reply {rid, ...broker.start}
 *                 result {rid, commandId, leaseId, outcome}     -> reply {rid, ...broker.result}
 *                 answer {interactionId, value}                 human answer to an ask/approval
 *                 ping {}                                       -> pong {}
 *   host -> page  ready {} | command {command} | ask {...} | ask-cancel {interactionId}
 *                 reply {rid, ok, ...} | pong {} | bye {code}
 *
 * Browsers cannot set headers on a WebSocket, so the pairing token travels in hello; the
 * upgrade itself only admits loopback origins the HTTP API admits.
 */

export const PAGE_SOCKET_PATH = '/v2/page/socket'
const HELLO_MS = 5_000
const IDLE_MS = 15_000
const MAX_FRAME = 512 * 1024

export interface PageSocketOptions {
  /** Current pairing token; read on every hello so rotation takes effect immediately. */
  pairing(): string
  originAllowed(origin: string | undefined): boolean
  /** Human answers arriving for an interaction this task owns. */
  onAnswer(taskId: string, interactionId: string, value: unknown): void
  /** A task lost its last socket. */
  onDetach?(taskId: string): void
  /** A socket (re)attached to the task. */
  onAttach?(taskId: string): void
}

interface Connection {
  socket: WebSocket
  identity: Identity
  release: () => void
  lastFrame: number
}

const equal = (a: string, b: string): boolean => {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export class PageSockets {
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME })
  private readonly connections = new Map<string, Set<Connection>>()
  private readonly offChange: () => void
  private readonly sweepTimer: ReturnType<typeof setInterval>
  private closed = false

  constructor(private readonly broker: PageBroker, private readonly options: PageSocketOptions) {
    this.offChange = broker.onChange(taskId => this.pump(taskId))
    // Liveness: idle sockets are dropped, and commands for pages that are gone fail fast.
    this.sweepTimer = setInterval(() => this.sweep(), 1_000)
    this.sweepTimer.unref?.()
  }

  /** Accept an HTTP upgrade on {@link PAGE_SOCKET_PATH}; anything else is refused. */
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (this.closed || path !== PAGE_SOCKET_PATH || !this.options.originAllowed(request.headers.origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    this.server.handleUpgrade(request, socket, head, ws => this.accept(ws))
  }

  /** True when at least one socket currently serves the task. */
  connected(taskId: string): boolean {
    return (this.connections.get(taskId)?.size ?? 0) > 0
  }

  /** Push one frame to every socket serving the task. @returns how many sockets received it. */
  send(taskId: string, frame: Record<string, Json>): number {
    let sent = 0
    for (const connection of this.connections.get(taskId) ?? []) if (this.write(connection.socket, frame)) sent += 1
    return sent
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.offChange()
    clearInterval(this.sweepTimer)
    for (const set of this.connections.values()) {
      for (const connection of set) {
        this.write(connection.socket, { type: 'bye', code: 'HOST_CLOSING' })
        connection.socket.terminate()
        connection.release()
      }
    }
    this.connections.clear()
    this.server.close()
  }

  private accept(ws: WebSocket): void {
    let connection: Connection | undefined
    const hello = setTimeout(() => { if (!connection) ws.close(4401, 'hello timeout') }, HELLO_MS)
    ws.on('message', (raw: RawData, binary: boolean) => {
      let frame: Record<string, unknown>
      try {
        if (binary) throw new Error('binary')
        const value = JSON.parse(raw.toString()) as unknown
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape')
        frame = value as Record<string, unknown>
      } catch {
        ws.close(4400, 'invalid frame')
        return
      }
      if (!connection) {
        clearTimeout(hello)
        connection = this.hello(ws, frame)
        return
      }
      connection.lastFrame = Date.now()
      this.broker.touch(connection.identity.taskId)
      this.handle(connection, frame)
    })
    ws.on('close', () => {
      clearTimeout(hello)
      if (connection) this.drop(connection)
    })
    ws.on('error', () => { /* 'close' follows and owns cleanup */ })
  }

  private hello(ws: WebSocket, frame: Record<string, unknown>): Connection | undefined {
    const pairing = this.options.pairing()
    if (frame.type !== 'hello' || typeof frame.pairing !== 'string' || !pairing || !equal(frame.pairing, pairing)) {
      ws.close(4401, 'unauthorized')
      return undefined
    }
    const identity = { taskId: frame.taskId, documentId: frame.documentId, token: frame.token } as Identity
    let release: () => void
    try {
      release = this.broker.attach(identity)
    } catch {
      ws.close(4403, 'page task authentication failed')
      return undefined
    }
    const connection: Connection = { socket: ws, identity, release, lastFrame: Date.now() }
    let set = this.connections.get(identity.taskId)
    if (!set) this.connections.set(identity.taskId, set = new Set())
    set.add(connection)
    trace('socket/attached', { taskId: identity.taskId, sockets: set.size })
    this.write(ws, { type: 'ready' })
    this.options.onAttach?.(identity.taskId)
    this.pump(identity.taskId)
    return connection
  }

  private handle(connection: Connection, frame: Record<string, unknown>): void {
    const { identity, socket } = connection
    const rid = typeof frame.rid === 'string' || typeof frame.rid === 'number' ? frame.rid : null
    const reply = (value: Record<string, unknown>): void => {
      this.write(socket, { type: 'reply', rid, ...(boundedJson(value) as Record<string, Json>) })
    }
    try {
      switch (frame.type) {
        case 'ping':
          this.write(socket, { type: 'pong' })
          return
        case 'start':
          reply({ ok: true, ...this.broker.start(identity, String(frame.commandId), String(frame.leaseId)) })
          return
        case 'result':
          reply({ ...this.broker.result(identity, String(frame.commandId), String(frame.leaseId), frame.outcome) })
          return
        case 'answer':
          if (typeof frame.interactionId !== 'string') throw Object.assign(new Error('interactionId required'), { status: 400 })
          this.options.onAnswer(identity.taskId, frame.interactionId, frame.value)
          reply({ ok: true })
          return
        default:
          reply({ ok: false, status: 400, error: 'unknown frame type' })
      }
    } catch (error) {
      const failure = error as { status?: number; message?: string }
      reply({ ok: false, status: failure.status ?? 500, error: failure.message ?? 'internal error' })
    }
  }

  /**
   * Hand the task's next command to one socket. The broker decides what may run (ordering,
   * leases, unknown barrier); this only replaces the page's claim poll with an immediate claim.
   */
  private pump(taskId: string): void {
    const set = this.connections.get(taskId)
    if (!set?.size) return
    const connection = [...set][set.size - 1]!
    let claimed
    try {
      claimed = this.broker.claim(connection.identity)
    } catch {
      return
    }
    if (claimed.command) this.write(connection.socket, { type: 'command', command: claimed.command as unknown as Json })
  }

  private sweep(): void {
    const now = Date.now()
    for (const [taskId, set] of this.connections) {
      for (const connection of set) if (now - connection.lastFrame > IDLE_MS) connection.socket.terminate()
      // A lease that expired unclaimed-in-practice (lost frame) is re-offered here.
      this.pump(taskId)
    }
    this.broker.failAbsent()
  }

  private drop(connection: Connection): void {
    const taskId = connection.identity.taskId
    const set = this.connections.get(taskId)
    if (!set?.delete(connection)) return
    connection.release()
    if (!set.size) this.connections.delete(taskId)
    trace('socket/detached', { taskId, sockets: set.size }, set.size ? 'info' : 'warn')
    if (!set.size) this.options.onDetach?.(taskId)
  }

  private write(socket: WebSocket, frame: Record<string, Json>): boolean {
    if (socket.readyState !== 1) return false
    try {
      socket.send(JSON.stringify(frame))
      return true
    } catch {
      return false
    }
  }
}
