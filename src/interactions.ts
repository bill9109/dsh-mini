import { randomUUID } from 'node:crypto'
import { boundedJson, type Json, type PageBroker } from './page-broker.ts'
import type { PageSockets } from './page-socket.ts'
import { trace } from './trace.ts'

/**
 * Human interactions (tool approvals and ask_user_question) for runs the browser page drives.
 *
 * Both seams are Agent-scoped Cordis waterfalls. This plugin registers prepended answerers that
 * claim a request only when the asking agent's session is bound to a page task with a live socket,
 * and otherwise call next(), so the DSH GUI answers exactly as before. If the page disconnects
 * while a question is open, the request is handed to next() as well: a run is never stranded on a
 * page that can no longer answer.
 */

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
export interface QuestionOption { label: string; description?: string }
export interface QuestionItem { id: string; question: string; detail?: string; header?: string; options?: QuestionOption[]; multiSelect?: boolean }
export interface QuestionAnswerItem { id: string; selected: string[]; custom?: string }
export interface QuestionAnswer { answers: QuestionAnswerItem[] }

interface AgentLike { id?: unknown; session?: { id?: unknown; snapshotEvents?: () => readonly unknown[] } }
export interface ApprovalRequest { agent?: AgentLike; toolName: string; callId?: string; reason?: string; displayReason?: { en: string; [locale: string]: string }; signal?: AbortSignal }
export interface QuestionRequest { agent?: AgentLike; questions: QuestionItem[]; signal?: AbortSignal }

interface Pending {
  taskId: string
  kind: 'approval' | 'question'
  questions?: QuestionItem[]
  /** The ask frame, re-sent when the page reconnects. */
  frame: Record<string, Json>
  settle(value: unknown): void
  /** Page went away: hand the request back to the rest of the waterfall. */
  delegate(): void
}

/** A worker restart reconnects within this window; only after it does the GUI take over. */
const RECONNECT_GRACE_MS = 4_000
const MAX_ARGS_PREVIEW = 4_000
const MAX_CUSTOM = 4_000

const sessionOf = (agent: AgentLike | undefined): string | undefined => {
  const id = agent?.id ?? agent?.session?.id
  return typeof id === 'string' ? id : undefined
}

/** Best-effort, bounded preview of the tool call being approved, read from the agent's own log. */
function argumentsPreview(agent: AgentLike | undefined, callId: string | undefined): string | undefined {
  if (!callId) return undefined
  try {
    const events = agent?.session?.snapshotEvents?.() ?? []
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index] as { type?: string; data?: { message?: { content?: readonly { type?: string; id?: string; arguments?: string }[] } } }
      if (event?.type !== 'assistant/message') continue
      const call = event.data?.message?.content?.find(block => block?.type === 'tool-call' && block.id === callId)
      if (call && typeof call.arguments === 'string') return call.arguments.length > MAX_ARGS_PREVIEW ? call.arguments.slice(0, MAX_ARGS_PREVIEW) + '…' : call.arguments
    }
  } catch { /* preview is cosmetic */ }
  return undefined
}

/** Validate a page answer against the questions that were actually asked. */
export function parseAnswer(questions: readonly QuestionItem[], value: unknown): QuestionAnswer | undefined {
  const raw = value as { answers?: unknown } | null
  if (!raw || !Array.isArray(raw.answers)) return undefined
  const answers: QuestionAnswerItem[] = []
  for (const question of questions) {
    const item = (raw.answers as unknown[]).find(a => (a as { id?: unknown })?.id === question.id) as { selected?: unknown; custom?: unknown } | undefined
    if (!item) return undefined
    const labels = new Set((question.options ?? []).map(option => option.label))
    const selected = Array.isArray(item.selected) ? item.selected.filter((s): s is string => typeof s === 'string' && labels.has(s)) : []
    if (Array.isArray(item.selected) && selected.length !== item.selected.length) return undefined
    if (!question.multiSelect && selected.length > 1) return undefined
    const custom = typeof item.custom === 'string' && item.custom.trim() ? item.custom.slice(0, MAX_CUSTOM) : undefined
    if (!selected.length && !custom) return undefined
    answers.push({ id: question.id, selected, ...(custom ? { custom } : {}) })
  }
  return { answers }
}

export class Interactions {
  private readonly pending = new Map<string, Pending>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private closed = false
  constructor(private readonly broker: PageBroker, private readonly sockets: PageSockets) {}

  /** `approval/request` waterfall listener. */
  approval(request: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    const target = this.target(request.agent)
    if (!target) return next()
    const interactionId = randomUUID()
    const frame: Record<string, Json> = {
      type: 'ask', kind: 'approval', interactionId, toolName: request.toolName,
      ...(request.reason ? { reason: request.reason.slice(0, 2_000) } : {}),
      ...(request.displayReason?.zh || request.displayReason?.en ? { displayReason: String(request.displayReason.zh ?? request.displayReason.en).slice(0, 2_000) } : {}),
    }
    const args = argumentsPreview(request.agent, request.callId)
    if (args) frame.arguments = args
    return this.open<ApprovalOutcome>(target, 'approval', frame, request.signal, next, value => {
      const decision = (value as { decision?: unknown } | null)?.decision
      return decision === 'allow' ? 'allowed-once' : decision === 'reject' ? 'rejected' : undefined
    }, 'cancelled')
  }

  /** `user-questions/request` waterfall listener. */
  question(request: QuestionRequest, next: () => Promise<QuestionAnswer>): Promise<QuestionAnswer> {
    const target = this.target(request.agent)
    if (!target || !Array.isArray(request.questions) || !request.questions.length) return next()
    const questions = request.questions
    const interactionId = randomUUID()
    let payload: Json
    try {
      payload = boundedJson(questions.map(q => ({
        id: q.id, question: q.question, ...(q.detail ? { detail: q.detail } : {}), ...(q.header ? { header: q.header } : {}),
        options: (q.options ?? []).map(o => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })),
        multiSelect: q.multiSelect === true,
      })), 120_000)
    } catch { return next() }
    const frame = { type: 'ask', kind: 'question', interactionId, questions: payload }
    return this.open<QuestionAnswer>(target, 'question', frame, request.signal, next, value => parseAnswer(questions, value), undefined, questions)
  }

  /** Page frame: a human answer for an interaction the sending task owns. */
  answer(taskId: string, interactionId: string, value: unknown): void {
    const p = this.pending.get(interactionId)
    if (!p || p.taskId !== taskId) return
    p.settle(value)
  }

  /** The task lost its last socket: after a reconnect grace, give open interactions back to the GUI. */
  detach(taskId: string): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      if (this.sockets.connected(taskId)) return
      for (const p of [...this.pending.values()]) if (p.taskId === taskId) p.delegate()
    }, RECONNECT_GRACE_MS)
    timer.unref?.()
    this.timers.add(timer)
  }

  /** A page (re)connected: show it every interaction still open for its task. */
  reattach(taskId: string): void {
    if (this.broker.taskForSurface(taskId) === 'gui') { this.handOver(taskId); return }
    for (const p of this.pending.values()) if (p.taskId === taskId) this.sockets.send(taskId, p.frame)
  }

  /**
   * The page moved its interactions. Moving to the GUI hands every open one to the rest of the
   * waterfall right away (the capsule that would show it is hidden); moving back only affects the
   * next ask, because an interaction already answered by the GUI cannot be taken back.
   */
  surface(taskId: string, surface: 'page' | 'gui'): void {
    if (surface === 'gui') this.handOver(taskId)
  }

  private handOver(taskId: string): void {
    for (const p of [...this.pending.values()]) if (p.taskId === taskId) p.delegate()
  }

  close(): void {
    this.closed = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    for (const p of [...this.pending.values()]) p.delegate()
  }

  private target(agent: AgentLike | undefined): string | undefined {
    if (this.closed) return undefined
    const sessionId = sessionOf(agent)
    const task = sessionId ? this.broker.taskForSession(sessionId) : undefined
    // A task whose capsule is hidden (side panel open, or a lease) is answered by the DSH GUI.
    return task && task.surface === 'page' && this.sockets.connected(task.taskId) ? task.taskId : undefined
  }

  private open<T>(
    taskId: string, kind: Pending['kind'], frame: Record<string, Json>, signal: AbortSignal | undefined,
    next: () => Promise<T>, decode: (value: unknown) => T | undefined, onAbort?: T, questions?: QuestionItem[],
  ): Promise<T> {
    const interactionId = frame.interactionId as string
    return new Promise<T>((resolve, reject) => {
      let done = false
      const finish = (): void => {
        done = true
        this.pending.delete(interactionId)
        signal?.removeEventListener('abort', aborted)
      }
      const aborted = (): void => {
        if (done) return
        finish()
        this.sockets.send(taskId, { type: 'ask-cancel', interactionId })
        trace('interaction/aborted', { interactionId, kind })
        if (onAbort !== undefined) resolve(onAbort)
        else reject(Object.assign(new Error('ask_user_question was aborted before the user answered'), { name: 'UserQuestionError', code: 'ASK_ABORTED' }))
      }
      const pending: Pending = {
        taskId, kind, frame, ...(questions ? { questions } : {}),
        settle: value => {
          if (done) return
          const decoded = decode(value)
          if (decoded === undefined) {
            this.sockets.send(taskId, { type: 'ask-invalid', interactionId })
            return
          }
          finish()
          this.sockets.send(taskId, { type: 'ask-done', interactionId })
          trace('interaction/answered', { interactionId, kind })
          resolve(decoded)
        },
        delegate: () => {
          if (done) return
          finish()
          this.sockets.send(taskId, { type: 'ask-cancel', interactionId })
          trace('interaction/delegated', { interactionId, kind }, 'warn')
          next().then(resolve, reject)
        },
      }
      if (signal?.aborted) { aborted(); return }
      signal?.addEventListener('abort', aborted, { once: true })
      this.pending.set(interactionId, pending)
      if (this.sockets.send(taskId, frame) === 0) { pending.delegate(); return }
      trace('interaction/asked', { interactionId, kind, taskId })
    })
  }
}
