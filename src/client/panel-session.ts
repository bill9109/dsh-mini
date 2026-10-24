/**
 * Side-panel session targeting (see README of the side panel design).
 * Opens the handed-over session once both lists are ready.
 */
export interface WorkspaceNavigator { openSession(target: string): void }
type Snap<T> = { getSnapshot(): T; subscribe(fn: () => void): () => void }
export interface NavigationLists {
  sessions: { list: Snap<{ phase: string; byId: Record<string, unknown> }> }
  workspaces: { list: Snap<{ phase: string }> }
}
const SESSION_ID = /^[A-Za-z0-9._:-]{1,200}$/
export function followPanelSession(
  workspace: WorkspaceNavigator,
  lists: NavigationLists,
  host: Window = window,
): () => void {
  const g = host as unknown as { __DSH_PANEL__?: { session: string | null } }
  const panel = g.__DSH_PANEL__
  if (!panel) return () => {}
  let wanted: string | null = null
  const ready = (): boolean =>
    lists.workspaces.list.getSnapshot().phase === 'ready'
    && lists.sessions.list.getSnapshot().phase === 'ready'
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = (): void => {
    if (wanted === null || !ready() || timer) return
    timer = setTimeout(() => {
      timer = undefined
      const id = wanted
      wanted = null
      if (id === null) return
      try { workspace.openSession(id) }
      catch (error) { console.warn('dsh-mini-panel: open session failed', error) }
    }, 0)
  }
  const open = (id: unknown): void => {
    if (typeof id !== 'string' || !SESSION_ID.test(id)) return
    wanted = id
    flush()
  }
  const offS = lists.sessions.list.subscribe(flush)
  const offW = lists.workspaces.list.subscribe(flush)
  open(panel.session)
  const onMessage = (event: MessageEvent): void => {
    if (event.source !== host.parent || host.parent === host) return
    const data = event.data as { type?: unknown; sessionId?: unknown } | null
    if (data?.type === 'dsh-panel/open-session') open(data.sessionId)
  }
  host.addEventListener('message', onMessage)
  return () => { offS(); offW(); clearTimeout(timer); host.removeEventListener('message', onMessage) }
}
