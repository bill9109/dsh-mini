import { randomUUID, timingSafeEqual } from 'node:crypto';
import { trace, traceFromExtension } from "./trace.js";
export const failure = (code, message, extra = {}) => ({ ok: false, code, message, retryable: false, modification: 'not-modified', verification: 'none', ...extra });
const error = (status, message) => Object.assign(new Error(message), { status });
const id = (value) => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
export function validatePageSession(value, request) {
    const p = value;
    if (!p || p.version !== 2 || !id(p.taskId) || !id(p.selectionId) || !id(p.documentId) ||
        typeof p.token !== 'string' || p.token.length < 16 || p.token.length > 256 ||
        typeof p.url !== 'string' || p.url.length > 8192 || p.taskId !== request.requestId ||
        p.selectionId !== request.selectionId || (request.url !== undefined && p.url !== request.url)) {
        throw error(400, 'A consistent pageSession version 2 is required');
    }
    return { version: 2, taskId: p.taskId, selectionId: p.selectionId, documentId: p.documentId, token: p.token, url: p.url };
}
/** Owned JSON only, never live Host objects. Oversized results are rejected, not truncated. */
export function boundedJson(value, maxBytes = 240_000) {
    let nodes = 0;
    const visit = (v, depth) => {
        if (++nodes > 30_000 || depth > 32)
            throw error(400, 'JSON complexity limit exceeded');
        if (v === null || typeof v === 'string' || typeof v === 'boolean')
            return;
        if (typeof v === 'number' && Number.isFinite(v))
            return;
        if (typeof v !== 'object' || !v || (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype))
            throw error(400, 'Expected lossless JSON');
        for (const item of Object.values(v))
            visit(item, depth + 1);
    };
    visit(value, 0);
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) > maxBytes)
        throw error(413, 'JSON size limit exceeded');
    return JSON.parse(json);
}
const canonical = (v) => {
    if (v === null || typeof v !== 'object')
        return JSON.stringify(v);
    if (Array.isArray(v))
        return '[' + v.map(canonical).join(',') + ']';
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
};
/** In-memory, activation-owned state machine. No destructive dequeue and no global selection. */
export class PageBroker {
    tasks = new Map();
    sessions = new Map();
    // A read after an unconfirmed write is how the caller re-establishes what the page holds. Blocking
    // that path forever turned a recoverable failure into a dead end (the model did read, then was refused).
    readClearedUnknown = new Set();
    entries = new Map();
    closed = false;
    now;
    timeoutMs;
    leaseMs;
    retentionMs;
    maxCommands;
    connectGraceMs;
    presenceTtlMs;
    leaseGraceMs;
    listeners = new Set();
    constructor(options = {}) {
        this.now = options.now ?? Date.now;
        this.timeoutMs = options.timeoutMs ?? 60_000;
        this.leaseMs = options.leaseMs ?? 10_000;
        this.retentionMs = options.retentionMs ?? 300_000;
        this.maxCommands = options.maxCommands ?? 1000;
        // A page gets this long after bind to show up (socket hello or HTTP claim) before
        // submits fail fast instead of waiting out the whole command timeout.
        this.connectGraceMs = options.connectGraceMs ?? 5_000;
        // Without a live socket, an HTTP-polling page counts as present for this long after its last claim.
        this.presenceTtlMs = options.presenceTtlMs ?? 3_000;
        // A lease whose page stopped proving it is alive (tab closed, extension reloaded, worker gone for
        // good) is released after this long, so it never pins a session to a page that cannot answer.
        this.leaseGraceMs = options.leaseGraceMs ?? 30_000;
    }
    /** Observe queue changes for one task (new command, settled command, cancelled task). */
    onChange(listener) {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }
    notify(taskId) {
        for (const listener of [...this.listeners]) {
            try {
                listener(taskId);
            }
            catch { /* a broken observer must not break the queue */ }
        }
    }
    /** A socket proved it serves this task. Authenticated like every page call. */
    attach(identity) {
        const task = this.authorize(identity);
        task.sockets += 1;
        task.viaSocket = true;
        task.lastSeen = this.now();
        let done = false;
        return () => {
            if (done)
                return;
            done = true;
            task.sockets = Math.max(0, task.sockets - 1);
            task.lastSeen = this.now();
        };
    }
    /** Heartbeat from an attached socket. */
    touch(taskId) {
        const task = this.tasks.get(taskId);
        if (task)
            task.lastSeen = this.now();
    }
    presence(taskId) {
        const task = this.tasks.get(taskId);
        if (!task)
            return 'not-connected';
        if (task.sockets > 0)
            return 'connected';
        // An HTTP-polling page that holds a lease or is executing is demonstrably there, even if it is not polling.
        if (!task.viaSocket && [...this.entries.values()].some(e => e.command.taskId === taskId && (e.state === 'claimed' || e.state === 'executing')))
            return 'connected';
        const now = this.now();
        if (task.lastSeen > 0)
            return now - task.lastSeen <= this.presenceTtlMs ? 'connected' : 'disconnected';
        return now - task.boundAt <= this.connectGraceMs ? 'pending' : 'not-connected';
    }
    /** Session id -> active task id, for routing human interactions to the page that owns the run. */
    taskForSession(sessionId) {
        const taskId = this.sessions.get(sessionId);
        const task = taskId ? this.tasks.get(taskId) : undefined;
        return task?.active ? { taskId: task.page.taskId, documentId: task.page.documentId, surface: task.surface } : undefined;
    }
    /** The task's current interaction surface, or undefined when it is unknown or inactive. */
    taskForSurface(taskId) {
        const task = this.tasks.get(taskId);
        return task?.active ? task.surface : undefined;
    }
    /** True when the task exists but no longer serves a session: its sockets have nothing left to do. */
    ended(taskId) {
        const task = this.tasks.get(taskId);
        return task !== undefined && !task.active;
    }
    bind(sessionId, page, signal) {
        this.sweep();
        if (this.closed || signal.aborted)
            throw error(409, 'Page request is no longer active');
        if (!id(sessionId))
            throw error(500, 'Execution agent has no actual session id');
        // A run started from the capsule takes the page back from a side-panel lease on the same session.
        this.endLease(sessionId, 'superseded by a page run');
        if (this.tasks.has(page.taskId) || this.sessions.has(sessionId))
            throw error(409, 'Page task or session is already bound');
        if (this.tasks.size >= this.maxCommands)
            throw error(429, 'Page task capacity exceeded');
        const release = () => this.cancelTask(page.taskId);
        const task = { page: { ...page }, sessionId, active: true, expires: Infinity, detach: () => signal.removeEventListener('abort', release), boundAt: this.now(), lastSeen: 0, sockets: 0, viaSocket: false, lease: false, surface: 'page' };
        this.tasks.set(page.taskId, task);
        this.sessions.set(sessionId, page.taskId);
        signal.addEventListener('abort', release, { once: true });
        return release;
    }
    /**
     * Bind a page task to a session for as long as the side panel shows it, independent of any run.
     * Its interactions belong to the GUI from the start: the capsule is hidden while a lease exists.
     * A previous lease on the same session is replaced; a run in progress is refused (409) so the
     * caller retries once it settles.
     */
    bindLease(sessionId, page) {
        this.sweep();
        if (this.closed)
            throw error(503, 'Page broker is closed');
        if (!id(sessionId))
            throw error(400, 'invalid sessionId');
        this.endLease(sessionId, 'replaced by a new lease');
        if (this.sessions.has(sessionId))
            throw error(409, 'Session has a page run in progress');
        if (this.tasks.has(page.taskId))
            throw error(409, 'Page task is already bound');
        if (this.tasks.size >= this.maxCommands)
            throw error(429, 'Page task capacity exceeded');
        const task = { page: { ...page }, sessionId, active: true, expires: Infinity, detach: () => { }, boundAt: this.now(), lastSeen: 0, sockets: 0, viaSocket: false, lease: true, surface: 'gui' };
        this.tasks.set(page.taskId, task);
        this.sessions.set(sessionId, page.taskId);
        trace('lease/bound', { taskId: page.taskId, sessionId });
        return { taskId: page.taskId };
    }
    /** The page that holds a lease gives it up (panel closed). Authenticated like every page call. */
    releaseLease(identity) {
        const task = this.authorize(identity);
        if (!task.lease)
            throw error(409, 'Page task is not a lease');
        trace('lease/released', { taskId: task.page.taskId });
        this.cancelTask(task.page.taskId);
    }
    /** Move the task's human interactions between the capsule and the GUI. @returns the new surface. */
    setSurface(identity, surface) {
        const task = this.authorize(identity);
        if (!task.active)
            throw error(409, 'Page task is no longer active');
        task.surface = surface;
        trace('task/surface', { taskId: task.page.taskId, surface });
        return surface;
    }
    endLease(sessionId, reason) {
        const taskId = this.sessions.get(sessionId);
        const task = taskId ? this.tasks.get(taskId) : undefined;
        if (!task?.active || !task.lease)
            return;
        trace('lease/ended', { taskId: task.page.taskId, reason }, 'warn');
        this.cancelTask(task.page.taskId);
    }
    /** Release leases whose page has not proved it is alive for the grace period. */
    expireLeases() {
        const now = this.now();
        for (const task of [...this.tasks.values()]) {
            if (!task.active || !task.lease || task.sockets > 0)
                continue;
            const since = task.lastSeen > 0 ? task.lastSeen : task.boundAt;
            if (now - since > this.leaseGraceMs) {
                trace('lease/expired', { taskId: task.page.taskId }, 'warn');
                this.cancelTask(task.page.taskId);
            }
        }
    }
    submit(sessionId, kind, args, signal) {
        this.sweep();
        const commandId = randomUUID();
        const taskId = sessionId ? this.sessions.get(sessionId) : undefined;
        const task = taskId ? this.tasks.get(taskId) : undefined;
        if (this.closed || !task?.active || signal?.aborted)
            return Promise.resolve(failure('NO_ACTIVE_PAGE_TASK', 'No browser page is attached to this session. Nothing was sent; tell the user to select the target on the page with the extension (the capsule), or reopen the side panel from it.', { commandId }));
        if (this.entries.size >= this.maxCommands)
            return Promise.resolve(failure('BROKER_CAPACITY', 'Page command capacity exceeded.', { commandId }));
        // Fail fast when no page can execute this. Waiting out the command timeout only hid the cause.
        const presence = this.presence(task.page.taskId);
        if (presence === 'not-connected')
            return Promise.resolve(failure('PAGE_NOT_CONNECTED', 'No browser page connected to this task. Nothing was sent to the page; tell the user to keep the page open with the extension enabled.', { commandId }));
        if (presence === 'disconnected')
            return Promise.resolve(failure('PAGE_DISCONNECTED', 'The browser page for this task disconnected (tab closed, reloaded, or extension stopped). Nothing was sent to the page.', { commandId }));
        // A write that never established what the page now holds leaves this page's ordering closed.
        // Refusing here is honest; queueing it would only time out and hide why.
        if (kind === 'edit' && !this.readClearedUnknown.has(task.page.taskId)
            && [...this.entries.values()].some(e => e.command.documentId === task.page.documentId && e.state === 'unknown')) {
            return Promise.resolve(failure('UNKNOWN_PREVIOUS_OPERATION', 'A previous edit on this page never confirmed its result. Read the target once (page_read) to re-establish it, then you may edit again; page_operation_status reports the unconfirmed outcome.', { commandId }));
        }
        // The allowance is consumed when the edit is CLAIMED, not when it is submitted - clearing it here
        // let the barrier re-appear at claim time and the retry was never delivered.
        const entry = { command: { version: 2, commandId, taskId: task.page.taskId, documentId: task.page.documentId, kind, args: boundedJson(args), leaseId: '' }, sessionId: task.sessionId, state: 'queued', leaseUntil: 0, expires: Infinity };
        this.entries.set(commandId, entry);
        return new Promise(resolve => {
            entry.resolve = resolve;
            entry.timer = setTimeout(() => this.cancel(entry, 'COMMAND_TIMEOUT'), this.timeoutMs);
            const abort = () => this.cancel(entry, 'COMMAND_CANCELLED');
            signal?.addEventListener('abort', abort, { once: true });
            entry.detach = () => signal?.removeEventListener('abort', abort);
            this.notify(task.page.taskId);
        });
    }
    claim(identity) {
        const task = this.authorize(identity);
        task.lastSeen = this.now();
        if (!task.active || this.closed)
            return { command: null };
        // Across tasks on the same page, executing/unknown commands remain a barrier.
        const open = [...this.entries.values()].filter(e => e.command.documentId === task.page.documentId && !['completed', 'cancelled'].includes(e.state));
        if (!open.length)
            return { command: null };
        // Another task's unfinished command owns this page; only its own session may act on it.
        if (open[0].command.taskId !== identity.taskId)
            return { command: null };
        if (open.some(e => e.state === 'executing'))
            return { command: null };
        // An unconfirmed write closes the page for further writes, but a read mutates nothing: without
        // it the target could never be inspected again, which is the only way out of an unknown state.
        const stuck = open.some(e => e.state === 'unknown');
        // While a write is unconfirmed the page may still be READ (that is how the caller re-establishes
        // it). Once such a read has completed, one queued write of this task may proceed as well.
        const first = stuck
            ? (this.readClearedUnknown.has(identity.taskId)
                ? open.find(e => e.command.taskId === identity.taskId && e.state !== 'unknown')
                : open.find(e => e.command.kind === 'read'))
            : open[0];
        if (!first)
            return { command: null };
        if (first.state === 'claimed' && first.leaseUntil > this.now())
            return { command: null };
        // Consume the read-derived allowance exactly once, at the moment the edit is handed out.
        if (stuck && first.command.kind !== 'read')
            this.readClearedUnknown.delete(identity.taskId);
        first.state = 'claimed';
        trace('broker/claimed', { commandId: first.command.commandId, kind: first.command.kind, taskId: first.command.taskId });
        first.command.leaseId = randomUUID();
        first.leaseUntil = this.now() + this.leaseMs;
        return { command: boundedJson(first.command) };
    }
    start(identity, commandId, leaseId) {
        const task = this.authorize(identity);
        const e = this.commandFor(identity, commandId);
        if (!leaseId || e.command.leaseId !== leaseId)
            return { execute: false, code: 'INVALID_LEASE' };
        if (e.state !== 'claimed')
            return { execute: false, code: e.state === 'executing' || e.state === 'unknown' || e.state === 'completed' ? 'ALREADY_STARTED' : 'CANCELLED', ...(e.outcome ? { outcome: e.outcome } : {}) };
        if (!task.active || this.closed) {
            this.cancel(e, 'COMMAND_CANCELLED');
            return { execute: false, code: 'CANCELLED' };
        }
        if (e.leaseUntil <= this.now())
            return { execute: false, code: 'LEASE_EXPIRED' };
        e.state = 'executing';
        task.lastSeen = this.now();
        trace('broker/executing', { commandId: e.command.commandId, kind: e.command.kind });
        return { execute: true, code: 'EXECUTE' };
    }
    result(identity, commandId, leaseId, raw) {
        this.authorize(identity);
        const e = this.commandFor(identity, commandId);
        if (!leaseId || e.command.leaseId !== leaseId)
            throw error(409, 'Invalid execution lease');
        if (!['executing', 'unknown', 'completed'].includes(e.state))
            throw error(409, 'Command was not started');
        const value = boundedJson(raw);
        if (!value || Array.isArray(value) || typeof value !== 'object' || typeof value.ok !== 'boolean' || typeof value.code !== 'string' || !value.code)
            throw error(400, 'Invalid page outcome');
        const key = canonical(value);
        // An "unknown" report is not final evidence. A later definite report on the SAME execution
        // lease is the resolution path out of the barrier, so it upgrades rather than conflicts.
        const upgrade = e.resultKey !== undefined
            && e.outcome?.modification === 'unknown'
            && value.modification !== 'unknown';
        if (e.resultKey !== undefined && !upgrade) {
            if (e.resultKey !== key)
                throw error(409, 'Conflicting result replay');
            return { ok: true, commandId, duplicate: true };
        }
        e.resultKey = key;
        e.outcome = value;
        // "unknown" means the page's state was never established. Completing it here would let the next
        // edit through on an unverified page, so the barrier stays up until a definite result arrives.
        // "partial" is bounded and known: the command finishes, and the caller must not retry it.
        // A completed READ is the evidence that clears the write barrier for this task.
        if (e.command.kind === 'read')
            this.readClearedUnknown.add(e.command.taskId);
        e.state = value.modification === 'unknown' ? 'unknown' : 'completed';
        trace('broker/result', { commandId: e.command.commandId, kind: e.command.kind, code: value.code, ok: value.ok, modification: value.modification, state: e.state }, value.ok === false ? 'error' : 'info');
        traceFromExtension('browser', e.command.commandId, value.recent);
        traceFromExtension('background', e.command.commandId, value.bgRecent);
        e.expires = e.state === 'unknown' ? Infinity : this.now() + this.retentionMs;
        this.settle(e);
        this.notify(e.command.taskId);
        return { ok: true, commandId, duplicate: false };
    }
    status(sessionId, commandId) {
        this.sweep();
        const e = this.entries.get(commandId);
        if (!e || !sessionId || e.sessionId !== sessionId)
            return failure('COMMAND_NOT_FOUND', 'Command is unavailable to this session.', { commandId });
        return { ok: true, code: 'OPERATION_STATUS', commandId, state: e.state, ...(e.outcome ? { outcome: boundedJson(e.outcome) } : {}) };
    }
    cancelTask(taskId) {
        const task = this.tasks.get(taskId);
        if (!task?.active)
            return;
        task.active = false;
        task.expires = this.now() + this.retentionMs;
        task.detach();
        if (this.sessions.get(task.sessionId) === taskId)
            this.sessions.delete(task.sessionId);
        for (const e of this.entries.values())
            if (e.command.taskId === taskId)
                this.cancel(e, 'TASK_CANCELLED');
        this.notify(taskId);
    }
    shutdown() {
        if (this.closed)
            return;
        this.closed = true;
        for (const taskId of this.tasks.keys())
            this.cancelTask(taskId);
        // cancel() drains every waiter and removes timers/listeners before dropping secrets.
        this.tasks.clear();
        this.sessions.clear();
        this.entries.clear();
    }
    /**
     * Fail commands still queued for a page that is gone. They were never handed out, so the page was
     * not modified; waiting for the command timeout would only stall the turn.
     */
    failAbsent() {
        for (const e of [...this.entries.values()]) {
            // queued/claimed were never started: not modified. executing becomes unknown (cancel() keeps the
            // write barrier), and a late result delivered over HTTP can still upgrade it.
            if (e.state !== 'queued' && e.state !== 'claimed' && e.state !== 'executing')
                continue;
            const presence = this.presence(e.command.taskId);
            if (presence === 'disconnected' || presence === 'not-connected')
                this.cancel(e, presence === 'disconnected' ? 'PAGE_DISCONNECTED' : 'PAGE_NOT_CONNECTED');
        }
    }
    diagnostics() {
        return { tasks: this.tasks.size, commands: this.entries.size, timers: [...this.entries.values()].filter(e => e.timer !== undefined).length };
    }
    authorize(identity) {
        this.sweep();
        const t = this.tasks.get(identity.taskId);
        const supplied = typeof identity.token === 'string' ? Buffer.from(identity.token) : Buffer.alloc(0);
        const expected = Buffer.from(t?.page.token ?? '');
        if (!t || identity.documentId !== t.page.documentId || supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
            throw error(403, 'Page task authentication failed');
        return t;
    }
    commandFor(identity, commandId) {
        const e = this.entries.get(commandId);
        if (!e || e.command.taskId !== identity.taskId || e.command.documentId !== identity.documentId)
            throw error(404, 'Command not found for page task');
        return e;
    }
    cancel(e, code) {
        if (e.state === 'completed' || e.state === 'cancelled' || e.state === 'unknown')
            return;
        const executing = e.state === 'executing';
        e.state = executing ? 'unknown' : 'cancelled';
        trace('broker/cancel', { commandId: e.command.commandId, state: e.state, executing: !!executing }, 'warn');
        // Unknown execution is retained as a page barrier until its valid late result or shutdown.
        e.expires = executing ? Infinity : this.now() + this.retentionMs;
        e.outcome = failure(code, executing ? 'Execution started; outcome is unknown. Query status; do not repeat the edit.' : 'Cancelled before execution; page was not modified.', { modification: executing ? 'unknown' : 'not-modified' });
        this.settle(e);
        this.notify(e.command.taskId);
    }
    settle(e) {
        if (e.timer !== undefined)
            clearTimeout(e.timer);
        e.timer = undefined;
        e.detach?.();
        e.detach = undefined;
        e.resolve?.({ ...boundedJson(e.outcome), commandId: e.command.commandId });
        e.resolve = undefined;
    }
    sweep() {
        for (const [key, e] of this.entries)
            if (e.expires <= this.now())
                this.entries.delete(key);
        for (const [key, t] of this.tasks)
            if (!t.active && t.expires <= this.now() && ![...this.entries.values()].some(e => e.command.taskId === key))
                this.tasks.delete(key);
    }
}
