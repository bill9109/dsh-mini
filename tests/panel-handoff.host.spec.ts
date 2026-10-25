import { describe, expect, it } from 'vitest'
import { AgentKeeper } from '../src/index.ts'
import { PageBroker, type PageSession } from '../src/page-broker.ts'

/** Handing a run to the side panel must neither stop it nor pull the session out from under the panel. */
const page = (n: number): PageSession => ({ version: 2, taskId: 'task-' + n, selectionId: 'sel-' + n, documentId: 'doc-1', token: 'page-token-0123456789-' + n, url: 'https://example.test/' })
const identity = (p: PageSession) => ({ taskId: p.taskId, documentId: p.documentId, token: p.token })

function agent(status: 'idle' | 'running' = 'idle') {
  const state = { disposed: 0, status }
  return { state, handle: { agent: { get status() { return state.status } } as never, dispose: async () => { state.disposed++ } } }
}

describe('lease after hand-off', () => {
  it('takes the page binding from a run handed to the panel, not from one the capsule still shows', () => {
    const broker = new PageBroker()
    const run = page(1)
    broker.bind('s1', run, new AbortController().signal)
    expect(() => broker.bindLease('s1', page(2))).toThrow(/in progress/)
    broker.setSurface(identity(run), 'gui')
    expect(broker.bindLease('s1', page(3))).toEqual({ taskId: 'task-3' })
    expect(broker.taskForSession('s1')?.taskId).toBe('task-3')
    expect(broker.leasedSession('s1')).toBe(true)
    broker.shutdown()
  })
})

describe('AgentKeeper', () => {
  it('disposes at once when no panel shows the session', async () => {
    const k = new AgentKeeper(() => false)
    const a = agent()
    await k.finish('s1', a.handle)
    expect(a.state.disposed).toBe(1)
    await k.close()
  })
  it('keeps a leased session until the lease ends and the agent is idle', async () => {
    let leased = true
    const k = new AgentKeeper(() => leased, 60_000, 0)
    const a = agent('running')
    await k.finish('s1', a.handle)
    await k.sweep(); expect(a.state.disposed).toBe(0)
    leased = false
    await k.sweep(); expect(a.state.disposed).toBe(0)
    a.state.status = 'idle'
    await k.sweep(); expect(a.state.disposed).toBe(1)
    await k.sweep(); expect(a.state.disposed).toBe(1)
    await k.close()
  })
  it('waits a grace period for the lease of a handed-off run, which binds after the run ends', async () => {
    let now = 0
    const k = new AgentKeeper(() => false, 60_000, 30_000, () => now)
    const a = agent()
    await k.finish('s1', a.handle, true)
    await k.sweep(); expect(a.state.disposed).toBe(0)
    now = 31_000
    await k.sweep(); expect(a.state.disposed).toBe(1)
    await k.close()
  })
  it('hands a kept agent back to the next run instead of a second resume', async () => {
    const k = new AgentKeeper(() => true)
    const a = agent()
    await k.finish('s1', a.handle)
    expect(k.take('s1')).toBe(a.handle)
    expect(k.holds('s1')).toBe(false)
    await k.close()
    expect(a.state.disposed).toBe(0)
  })
  it('disposes everything it holds on plugin unload', async () => {
    const k = new AgentKeeper(() => true)
    const a = agent(), b = agent()
    await k.finish('s1', a.handle); await k.finish('s2', b.handle)
    await k.close()
    expect([a.state.disposed, b.state.disposed]).toEqual([1, 1])
  })
})
