export type Json = null | boolean | number | string | Json[] | {
    [key: string]: Json;
};
export type Outcome = {
    ok: boolean;
    code: string;
    [key: string]: Json;
};
export interface PageSession {
    version: 2;
    taskId: string;
    selectionId: string;
    documentId: string;
    token: string;
    url: string;
}
export interface Identity {
    taskId: string;
    documentId: string;
    token: string;
}
export interface Command {
    version: 2;
    commandId: string;
    taskId: string;
    documentId: string;
    kind: 'read' | 'edit';
    args: Record<string, Json>;
    leaseId: string;
}
/** Where a page task's approvals and questions are shown. */
export type Surface = 'page' | 'gui';
/** Why a submit was refused before queueing because no page can execute it. */
export type Presence = 'connected' | 'pending' | 'not-connected' | 'disconnected';
export declare const failure: (code: string, message: string, extra?: Record<string, Json>) => Outcome;
export declare function validatePageSession(value: unknown, request: {
    requestId?: unknown;
    selectionId?: unknown;
    url?: unknown;
}): PageSession;
/** Owned JSON only, never live Host objects. Oversized results are rejected, not truncated. */
export declare function boundedJson(value: unknown, maxBytes?: number): Json;
/** In-memory, activation-owned state machine. No destructive dequeue and no global selection. */
export declare class PageBroker {
    private readonly tasks;
    private readonly sessions;
    private readonly readClearedUnknown;
    private readonly entries;
    private closed;
    private readonly now;
    private readonly timeoutMs;
    private readonly leaseMs;
    private readonly retentionMs;
    private readonly maxCommands;
    private readonly connectGraceMs;
    private readonly presenceTtlMs;
    private readonly leaseGraceMs;
    private readonly listeners;
    constructor(options?: {
        now?: () => number;
        timeoutMs?: number;
        leaseMs?: number;
        retentionMs?: number;
        maxCommands?: number;
        connectGraceMs?: number;
        presenceTtlMs?: number;
        leaseGraceMs?: number;
    });
    /** Observe queue changes for one task (new command, settled command, cancelled task). */
    onChange(listener: (taskId: string) => void): () => void;
    private notify;
    /** A socket proved it serves this task. Authenticated like every page call. */
    attach(identity: Identity): () => void;
    /** Heartbeat from an attached socket. */
    touch(taskId: string): void;
    presence(taskId: string): Presence;
    /** Session id -> active task id, for routing human interactions to the page that owns the run. */
    taskForSession(sessionId: string): {
        taskId: string;
        documentId: string;
        surface: Surface;
        url: string;
    } | undefined;
    /** Whether a side-panel lease currently shows this session (the GUI holds it open). */
    leasedSession(sessionId: string): boolean;
    /** The task's current interaction surface, or undefined when it is unknown or inactive. */
    taskForSurface(taskId: string): Surface | undefined;
    /** True when the task exists but no longer serves a session: its sockets have nothing left to do. */
    ended(taskId: string): boolean;
    bind(sessionId: string, page: PageSession, signal: AbortSignal): () => void;
    /**
     * Bind a page task to a session for as long as the side panel shows it, independent of any run.
     * Its interactions belong to the GUI from the start: the capsule is hidden while a lease exists.
     * A previous lease on the same session is replaced; a run in progress is refused (409) so the
     * caller retries once it settles.
     */
    bindLease(sessionId: string, page: PageSession): {
        taskId: string;
    };
    /** The page that holds a lease gives it up (panel closed). Authenticated like every page call. */
    releaseLease(identity: Identity): void;
    /** Move the task's human interactions between the capsule and the GUI. @returns the new surface. */
    setSurface(identity: Identity, surface: Surface): Surface;
    private endLease;
    /** Release leases whose page has not proved it is alive for the grace period. */
    expireLeases(): void;
    submit(sessionId: string | undefined, kind: 'read' | 'edit', args: Record<string, Json>, signal?: AbortSignal): Promise<Outcome>;
    claim(identity: Identity): {
        command: Command | null;
    };
    start(identity: Identity, commandId: string, leaseId: string): Record<string, Json>;
    result(identity: Identity, commandId: string, leaseId: string, raw: unknown): Record<string, Json>;
    status(sessionId: string | undefined, commandId: string): Outcome;
    cancelTask(taskId: string): void;
    shutdown(): void;
    /**
     * Fail commands still queued for a page that is gone. They were never handed out, so the page was
     * not modified; waiting for the command timeout would only stall the turn.
     */
    failAbsent(): void;
    diagnostics(): {
        tasks: number;
        commands: number;
        timers: number;
    };
    private authorize;
    private commandFor;
    private cancel;
    private settle;
    private sweep;
}
