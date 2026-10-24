import { afterEach, describe, expect, it, vi } from 'vitest'
import { followPanelSession } from '../src/client/panel-session.ts'

function snap(phase: string) {
  let state = { phase, byId: {} }
  const fns = new Set<() => void>()
  return {
    getSnapshot: () => state,
    subscribe: (fn: () => void) => { fns.add(fn); return () => { fns.delete(fn) } },
    set: (p: string) => { state = { phase: p, byId: {} }; fns.forEach(f => f()) },
    size: () => fns.size,
  }
}

function lists(phase = 'ready') {
  const s = snap(phase), w = snap(phase)
  return { s, w, lists: { sessions: { list: s }, workspaces: { list: w } } }
}

type Listener = (event: MessageEvent) => void
function fakeWindow() {
  const parent = {}
  let listener: Listener | undefined
  const host = {
    parent,
    addEventListener: (_t: string, fn: Listener) => { listener = fn },
    removeEventListener: () => { listener = undefined },
  }
  return {
    host: host as unknown as Window,
    parent,
    post: (source: unknown, data: unknown) =>
      listener?.({ source, data } as unknown as MessageEvent),
    listening: () => listener !== undefined,
  }
}

const setPanel = (w: Window, v: unknown) => { (w as any).__DSH_PANEL__ = v }

describe('followPanelSession', () => {
  afterEach(() => { vi.useRealTimers() })
  it('opens only after both lists are ready, after restoration', () => {
    vi.useFakeTimers()
    const w = fakeWindow(), l = lists('loading')
    const opened: string[] = []
    setPanel(w.host, { session: 'session-1' })
    const nav = { openSession: (id: string) => { opened.push(id) } }
    followPanelSession(nav, l.lists, w.host)
    vi.runAllTimers()
    expect(opened).toEqual([])
    l.s.set('ready'); vi.runAllTimers()
    expect(opened).toEqual([])
    l.w.set('ready')
    expect(opened).toEqual([])
    vi.runAllTimers()
    expect(opened).toEqual(['session-1'])
    l.s.set('ready'); vi.runAllTimers()
    expect(opened).toEqual(['session-1'])
  })

  it('switches only on messages from the parent frame', () => {
    vi.useFakeTimers()
    const w = fakeWindow(), l = lists()
    const opened: string[] = []
    setPanel(w.host, { session: null })
    const nav = { openSession: (id: string) => { opened.push(id) } }
    followPanelSession(nav, l.lists, w.host)
    const msg = (id: unknown) => ({ type: 'dsh-panel/open-session', sessionId: id })
    w.post({}, msg('session-x'))
    w.post(w.parent, msg(42))
    w.post(w.parent, null)
    w.post(w.parent, msg('session-2'))
    vi.runAllTimers()
    expect(opened).toEqual(['session-2'])
  })

  it('is inert in the ordinary GUI and cleans up when disposed', () => {
    const gui = fakeWindow(), l = lists()
    const nav = { openSession: () => {} }
    followPanelSession(nav, l.lists, gui.host)
    expect(gui.listening()).toBe(false)
    expect(l.s.size()).toBe(0)
    const w = fakeWindow()
    setPanel(w.host, { session: null })
    const stop = followPanelSession(nav, l.lists, w.host)
    expect(w.listening()).toBe(true)
    expect(l.s.size()).toBe(1)
    stop()
    expect(w.listening()).toBe(false)
    expect(l.s.size() + l.w.size()).toBe(0)
  })
})
