import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'

/** Every request in this suite carries this token; the plugin never writes a token file. */
const TOKEN = 'test-token-0123456789abcdef'

interface Calls {
  presentAs: string[]
  restrict: Array<{ allow: string[] }>
  guard: string[]
  assemble: Array<(...args: unknown[]) => unknown>
  followup: unknown[]
  injected: unknown[]
  rules: unknown[]
  resumed: string[]
  selections: Array<Record<string, unknown>>
  attached: string[]
  renamed: string[]
  disposed: number
}

interface Harness {
  ctx: Context
  calls: Calls
  /** Resolves once the rewrite turn was submitted and its listeners attached. */
  turnStarted: Promise<void>
  /** Publish one live assistant-stream frame to the subscribed rewrite. */
  emitFrame(frame: unknown): void
  /** Let a held turn settle; no-op for ordinary hosts. */
  resolveTurn(): void
  dispose(): Promise<void>
}

interface Host {
  harness: Harness
  port: number
  dispose(): Promise<void>
}

function completedEvents(): unknown[] {
  return [
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'REWRITTEN TEXT' }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

function failedEvents(): unknown[] {
  return [
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'PARTIAL' }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } } } },
  ]
}

/** A minimal Cordis-shaped context whose services record what the plugin did. */
function createHarness(events: unknown[] = completedEvents(), bare = false, options?: { holdTurn?: boolean }): Harness {
  const calls: Calls = {
    presentAs: [],
    restrict: [],
    guard: [],
    assemble: [],
    followup: [],
    injected: [],
    rules: [],
    resumed: [],
    selections: [],
    attached: [],
    renamed: [],
    disposed: 0,
  }
  const selection = { provider: 'test-provider', model: 'deepseek/deepseek-v4-flash' }
  const disposers: Array<() => Promise<void> | void> = []
  const workspaceRegistry = {
    async create(path: string): Promise<{ path: string; attachSession(id: unknown): Promise<void> }> {
      return {
        path,
        async attachSession(id: unknown): Promise<void> { calls.attached.push(String(id)) },
      }
    },
  }
  const sessionTitle = {
    rename(_session: unknown, title: string): undefined {
      calls.renamed.push(title)
      return undefined
    },
  }
  const stored = new Map<string, { header: { id: string; createdAt: number }; events: unknown[] }>()
  const live = new Set<string>()
  const streamListeners: Array<(payload: unknown) => void> = []
  const holdTurn = options?.holdTurn === true
  const turnStarted = Promise.withResolvers<void>()
  const turnGate = Promise.withResolvers<void>()
  const ctx = {
    effect(run: () => unknown, _label?: string): unknown {
      const disposer = run()
      if (typeof disposer === 'function') disposers.push(disposer as () => Promise<void> | void)
      return disposer
    },
    agents: {
      get(id: string): unknown { return live.has(id) ? {} : undefined },
      async resume(options: unknown): Promise<unknown> {
        const opts = options as { resumeSessionId: string }
        calls.resumed.push(opts.resumeSessionId)
        return this.create({ ...opts, sessionId: opts.resumeSessionId })
      },
      async create(options: unknown): Promise<unknown> {
        const id = (options as { sessionId: string }).sessionId
        const entry = stored.get(id) ?? { header: { id, createdAt: Date.now() }, events: [] }
        stored.set(id, entry)
        live.add(id)
        const setup = (options as { setup?: (agentCtx: unknown) => void }).setup
        if (!setup) throw new Error('agents.create received no setup callback')
        setup({
          systemPrompt: { section(value: unknown): void { calls.rules.push(value) } },
          tools: {
            presentAs(mode: string): void { calls.presentAs.push(mode) },
            restrict(value: { allow: string[] }): void { calls.restrict.push(value) },
            guard(callback: () => string): void { calls.guard.push(callback()) },
          },
          on(event: string, handler: (...args: unknown[]) => unknown): void {
            if (event === 'system-prompt/assemble') calls.assemble.push(handler)
          },
        })
        const listeners: Array<(payload: unknown) => void> = []
        return {
          agent: {
            id,
            // Agent-scoped context: the plugin subscribes here for live frames.
            ctx: {
              on(event: string, listener: (payload: unknown) => void): () => void {
                if (event !== 'agent/assistant-stream') return () => {}
                listeners.push(listener)
                return () => { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1) }
              },
            },
            session: { snapshotEvents: () => entry.events.slice() },
            whenIdle: async (): Promise<void> => { if (holdTurn) await turnGate.promise },
            inject(message: unknown): void { calls.injected.push(message) },
            followup(message: unknown): void {
              calls.followup.push(message)
              entry.events.push(...events)
              turnStarted.resolve()
              for (const listener of listeners) streamListeners.push(listener)
            },
            cancel(): void {},
          },
          async dispose(): Promise<void> { live.delete(id); calls.disposed += 1 },
        }
      },
    },
    agentDefaultModel: {
      currentSelection(): Record<string, unknown> {
        calls.selections.push(selection)
        return selection
      },
    },
    get(name: string): unknown {
      if (bare) return undefined
      if (name === 'sessionPersistence') return { list: async () => [...stored.values()], stat: async (id: string) => stored.get(id), open: async () => ({ close: async () => {} }) }
      if (name === 'workspaceRegistry') return workspaceRegistry
      if (name === 'sessionTitle') return sessionTitle
      return undefined
    },
  } as unknown as Context
  return {
    ctx,
    calls,
    turnStarted: turnStarted.promise,
    emitFrame(frame: unknown): void { for (const listener of [...streamListeners]) listener({ frame }) },
    resolveTurn(): void { turnGate.resolve() },
    async dispose(): Promise<void> {
      turnGate.resolve()
      for (const disposer of disposers.reverse()) await disposer()
    },
  }
}

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => resolve(port))
      probe.closeAllConnections()
    })
  })
}

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + 5_000
  let last = 'never attempted'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl(port), { headers: { authorization: 'Bearer ' + TOKEN } })
      if (response.status === 200) return
      last = 'status ' + String(response.status)
    } catch (error) {
      last = String(error)
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('mini-panel did not become healthy: ' + last)
}

const healthUrl = (port: number): string => 'http://127.0.0.1:' + String(port) + '/v1/health'
const apiUrl = (port: number, path: string): string => 'http://127.0.0.1:' + String(port) + path

const started: Host[] = []

async function startHost(
  options: { events?: unknown[]; config?: Record<string, unknown>; bare?: boolean; holdTurn?: boolean } = {},
): Promise<Host> {
  const harness = createHarness(options.events ?? completedEvents(), options.bare === true, { holdTurn: options.holdTurn === true })
  const port = await freePort()
  apply(harness.ctx, { port, token: TOKEN, ...(options.config ?? {}) })
  await waitForHealth(port)
  const host: Host = { harness, port, dispose: harness.dispose }
  started.push(host)
  return host
}

async function call(
  port: number,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers = new Headers(init.headers ?? {})
  if (!headers.has('authorization')) headers.set('authorization', 'Bearer ' + TOKEN)
  if (!headers.has('content-type')) headers.set('content-type', 'application/json')
  const response = await fetch(apiUrl(port, path), { ...init, headers })
  const body = (await response.json()) as Record<string, unknown>
  return { status: response.status, body }
}

/** Minimal SSE reader: collects parsed events and waits for a named one. */
function sseReader(response: Response) {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const seen: Array<{ event: string; data: Record<string, unknown> }> = []
  let buffer = ''
  return {
    seen,
    async next(event: string): Promise<void> {
      const deadline = Date.now() + 5_000
      while (!seen.some(item => item.event === event)) {
        if (Date.now() > deadline) throw new Error('timed out waiting for ' + event + '; saw ' + seen.map(item => item.event).join(','))
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let index = buffer.indexOf('\n\n')
        while (index >= 0) {
          const block = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          const [eventLine = '', dataLine = ''] = block.split('\n')
          seen.push({ event: eventLine.replace('event: ', ''), data: JSON.parse(dataLine.replace('data: ', '')) })
          index = buffer.indexOf('\n\n')
        }
      }
    },
  }
}

afterEach(async () => {
  while (started.length > 0) {
    const host = started.pop()
    if (host) await host.dispose()
  }
})

describe('mini-panel HTTP surface', () => {
  it('serves an authenticated health probe', async () => {
    const host = await startHost()
    const result = await call(host.port, '/v1/health')
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ ok: true, protocolVersion: 1 })
  })

  it('rejects a missing or wrong pairing token with 401', async () => {
    const host = await startHost()
    const denied = await fetch(healthUrl(host.port), { headers: { authorization: 'Bearer wrong-token' } })
    expect(denied.status).toBe(401)
    const anonymous = await fetch(healthUrl(host.port))
    expect(anonymous.status).toBe(401)
  })

  it('rejects a disallowed origin with 403 before authentication', async () => {
    const host = await startHost()
    const denied = await fetch(healthUrl(host.port), {
      headers: { authorization: 'Bearer ' + TOKEN, origin: 'https://evil.example' },
    })
    expect(denied.status).toBe(403)
  })

  it('accepts a chrome-extension origin', async () => {
    const host = await startHost()
    const allowed = await fetch(healthUrl(host.port), {
      headers: { authorization: 'Bearer ' + TOKEN, origin: 'chrome-extension://abcdefghijklmnop' },
    })
    expect(allowed.status).toBe(200)
  })

  it('consumes a desktop selection exactly once', async () => {
    const host = await startHost()
    const opened = await call(host.port, '/v1/desktop/open', {
      method: 'POST',
      body: JSON.stringify({ selectionId: 'sel-1', text: 'hello world', title: 'Doc' }),
    })
    expect(opened.status).toBe(200)
    const first = await call(host.port, '/v1/desktop/pending')
    expect(first.body.selection).toMatchObject({ selectionId: 'sel-1', text: 'hello world', title: 'Doc' })
    const second = await call(host.port, '/v1/desktop/pending')
    expect(second.body.selection).toBeNull()
  })

  it('round-trips a desktop rewrite result', async () => {
    const host = await startHost()
    const stored = await call(host.port, '/v1/desktop/result', {
      method: 'POST',
      body: JSON.stringify({ selectionId: 'sel-2', replacement: 'cleaner text', apply: true }),
    })
    expect(stored.status).toBe(200)
    const read = await call(host.port, '/v1/desktop/result?selectionId=sel-2')
    expect(read.body.result).toMatchObject({ replacement: 'cleaner text', apply: true })
    const missing = await call(host.port, '/v1/desktop/result?selectionId=sel-3')
    expect(missing.body.result).toBeNull()
  })

  it('rejects an invalid rewrite payload with 400', async () => {
    const host = await startHost()
    const invalid = await call(host.port, '/v1/rewrite', {
      method: 'POST',
      body: JSON.stringify({ requestId: 'req-1', selectionId: 'sel-4', text: '   ', instruction: 'polish' }),
    })
    expect(invalid.status).toBe(400)
  })

  it('rejects a body larger than maxBodyBytes with 413', async () => {
    const host = await startHost({ config: { maxBodyBytes: 32 } })
    const oversized = await call(host.port, '/v1/desktop/open', {
      method: 'POST',
      body: JSON.stringify({ selectionId: 'sel-5', text: 'x'.repeat(500) }),
    })
    expect(oversized.status).toBe(413)
  })

  it('answers 404 for an unknown route', async () => {
    const host = await startHost()
    const missing = await call(host.port, '/v1/nope')
    expect(missing.status).toBe(404)
  })
})

describe('mini-panel rewrite session', () => {
  it('returns assistant text and hard-disables tools', async () => {
    const host = await startHost()
    const result = await call(host.port, '/v1/rewrite', {
      method: 'POST',
      body: JSON.stringify({
        requestId: 'req-2',
        selectionId: 'sel-6',
        text: 'SEGMENT original wording',
        instruction: 'make it more professional',
        url: 'https://example.test/doc',
        title: 'Example',
      }),
    })
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({
      requestId: 'req-2',
      selectionId: 'sel-6',
      replacement: 'REWRITTEN TEXT',
    })
    // The configured model selection is inherited, not hard-coded by the plugin.
    expect(host.harness.calls.selections[0]).toEqual({ provider: 'test-provider', model: 'deepseek/deepseek-v4-flash' })
    // User input stays human-only; page context is an attributed plugin injection.
    expect(host.harness.calls.followup).toHaveLength(1)
    expect(host.harness.calls.followup[0]).toMatchObject({ content: [{ type: 'text', text: 'make it more professional' }], source: { kind: 'user' } })
    expect(JSON.stringify(host.harness.calls.followup[0])).not.toContain('SEGMENT')
    expect(host.harness.calls.injected[0]).toMatchObject({ source: { kind: 'plugin', plugin: 'dsh-mini-panel', form: 'snapshot' } })
    expect(JSON.stringify(host.harness.calls.injected[0])).toContain('SEGMENT original wording')
    expect(host.harness.calls.rules[0]).toMatchObject({ name: 'selection-rewrite-policy' })
    // Tools are disabled visibly and executably.
    expect(host.harness.calls.presentAs).toEqual(['native'])
    expect(host.harness.calls.restrict).toEqual([{ allow: [] }])
    expect(host.harness.calls.guard).toHaveLength(1)
    expect(host.harness.calls.assemble).toHaveLength(1)
    const assemble = host.harness.calls.assemble[0]
    const assembled = await assemble?.(undefined, undefined, async () => ({ system: 'x', tools: ['bash'] }))

    expect(assembled).toMatchObject({ tools: [] })
    // Optional services are used when present.
    expect(host.harness.calls.attached).toHaveLength(1)
    expect(host.harness.calls.renamed).toHaveLength(1)
    // The session handle is disposed once the request settles.
    expect(host.harness.calls.disposed).toBe(1)
  })

  it('rewrites in a bare profile without workspace or title services', async () => {
    const host = await startHost({ bare: true })
    const result = await call(host.port, '/v1/rewrite', {
      method: 'POST',
      body: JSON.stringify({
        requestId: 'req-bare',
        selectionId: 'sel-bare',
        text: 'bare segment',
        instruction: 'polish',
      }),
    })
    expect(result.status).toBe(200)
    expect(result.body.replacement).toBe('REWRITTEN TEXT')
    expect(host.harness.calls.attached).toHaveLength(0)
    expect(host.harness.calls.renamed).toHaveLength(0)
  })

  it('fails the request when the turn did not complete', async () => {
    const host = await startHost({ events: failedEvents() })
    const result = await call(host.port, '/v1/rewrite', {
      method: 'POST',
      body: JSON.stringify({
        requestId: 'req-3',
        selectionId: 'sel-7',
        text: 'text to rewrite',
        instruction: 'polish',
      }),
    })
    expect(result.status).toBe(502)
    expect(host.harness.calls.disposed).toBe(1)
  })
})

describe('mini-panel binding', () => {
  it('creates, lists, binds and resumes the same session across rewrites', async () => {
    const host = await startHost()
    const created = await call(host.port, '/v1/sessions/new', { method: 'POST', body: JSON.stringify({ title: 'Document' }) })
    expect(created.status).toBe(200)
    const sessionId = created.body.sessionId
    const bind = await call(host.port, '/v1/sessions/bind', { method: 'POST', body: JSON.stringify({ sessionId }) })
    expect(bind.status).toBe(200)
    for (const instruction of ['polish', 'make it shorter']) {
      const result = await call(host.port, '/v1/rewrite', { method: 'POST', body: JSON.stringify({ sessionId, requestId: instruction.replaceAll(' ', '-'), selectionId: 'sel', text: 'original', instruction }) })
      expect(result.status).toBe(200)
      expect(result.body.sessionId).toBe(sessionId)
    }
    expect(host.harness.calls.resumed).toEqual([sessionId, sessionId])
    expect(host.harness.calls.selections.slice(1)).toEqual([
      { provider: 'test-provider', model: 'deepseek/deepseek-v4-flash' },
      { provider: 'test-provider', model: 'deepseek/deepseek-v4-flash' },
    ])
    expect(host.harness.calls.injected).toHaveLength(2)
    expect(host.harness.calls.attached).toHaveLength(1)
    const listed = await call(host.port, '/v1/sessions')
    expect(listed.body.sessions).toMatchObject([{ sessionId, busy: false }])
    expect(host.harness.calls.disposed).toBe(3)
  })
  it('rejects missing bindings instead of silently creating a new session', async () => {
    const host = await startHost()
    const result = await call(host.port, '/v1/rewrite', { method: 'POST', body: JSON.stringify({ sessionId: 'missing', requestId: 'req', selectionId: 'sel', text: 'text', instruction: 'polish' }) })
    expect(result.status).toBe(404)
    expect(host.harness.calls.followup).toHaveLength(0)
  })
  it('accepts actual empty text for insertion and keeps the instruction unchanged', async () => {
    const host = await startHost()
    const result = await call(host.port, '/v1/rewrite', { method: 'POST', body: JSON.stringify({ requestId: 'insert', selectionId: 'caret', mode: 'insert', text: '', instruction: 'write a greeting' }) })
    expect(result.status).toBe(200)
    expect(host.harness.calls.followup[0]).toMatchObject({ content: [{ text: 'write a greeting' }] })
    expect(JSON.stringify(host.harness.calls.injected)).toContain('selectedText')
  })
})

describe('mini-panel streaming rewrite', () => {
  it('forwards live frames before settlement and the settled replacement after', async () => {
    const host = await startHost({ holdTurn: true })
    const response = await fetch(apiUrl(host.port, '/v1/rewrite/stream'), {
      method: 'POST',
      headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'req-stream', selectionId: 'sel-stream', text: 'SEGMENT original', instruction: 'polish' }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const stream = sseReader(response)
    await stream.next('ready')
    await host.harness.turnStarted
    expect(stream.seen[0]?.event).toBe('ready')
    host.harness.emitFrame({ type: 'start' })
    host.harness.emitFrame({ type: 'chunk', chunk: { type: 'reasoning-delta', text: '先说重点' } })
    host.harness.emitFrame({ type: 'chunk', chunk: { type: 'text-delta', text: 'REWRITTEN' } })
    host.harness.emitFrame({ type: 'end' })
    // Nothing below may wait for settlement: these frames arrived mid-turn.
    await stream.next('thinking')
    await stream.next('text')
    expect(stream.seen.map(item => item.event)).toEqual(['ready', 'reset', 'thinking', 'text'])
    expect(stream.seen.some(item => item.event === 'done')).toBe(false)
    host.harness.resolveTurn()
    await stream.next('done')
    expect(stream.seen.find(item => item.event === 'done')?.data).toMatchObject({ requestId: 'req-stream', selectionId: 'sel-stream', replacement: 'REWRITTEN TEXT' })
    // The streaming route reuses the same policy, provenance and teardown.
    expect(host.harness.calls.rules[0]).toMatchObject({ name: 'selection-rewrite-policy' })
    expect(host.harness.calls.followup).toHaveLength(1)
    expect(JSON.stringify(host.harness.calls.injected[0])).toContain('SEGMENT original')
    expect(host.harness.calls.disposed).toBe(1)
  })

  it('reports a failed turn as a stream error instead of a result', async () => {
    const host = await startHost({ events: failedEvents(), holdTurn: true })
    const response = await fetch(apiUrl(host.port, '/v1/rewrite/stream'), {
      method: 'POST',
      headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'req-fail', selectionId: 'sel-fail', text: 'text', instruction: 'polish' }),
    })
    const stream = sseReader(response)
    await stream.next('ready')
    host.harness.resolveTurn()
    await stream.next('error')
    expect(stream.seen.find(item => item.event === 'error')?.data.status).toBe(502)
    expect(stream.seen.some(item => item.event === 'done')).toBe(false)
    expect(host.harness.calls.disposed).toBe(1)
  })

  it('shares payload validation with the one-shot route', async () => {
    const host = await startHost()
    const invalid = await call(host.port, '/v1/rewrite/stream', {
      method: 'POST',
      body: JSON.stringify({ requestId: 'bad id', selectionId: 'sel', text: 'text', instruction: 'polish' }),
    })
    expect(invalid.status).toBe(400)
    // A binding failure surfaces after the stream opened, so it is reported
    // in-band as an error event instead of a JSON status.
    const missing = await fetch(apiUrl(host.port, '/v1/rewrite/stream'), {
      method: 'POST',
      headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'missing', requestId: 'req', selectionId: 'sel', text: 'text', instruction: 'polish' }),
    })
    const failed = sseReader(missing)
    await failed.next('error')
    expect(failed.seen.find(item => item.event === 'error')?.data.status).toBe(404)
  })
})

describe('mini-panel lifecycle', () => {
  it('closes the loopback port when the fiber is disposed', async () => {
    const host = await startHost()
    await host.dispose()
    started.pop()
    await expect(fetch(healthUrl(host.port))).rejects.toBeTruthy()
  })
})
