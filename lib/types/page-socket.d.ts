import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { PageBroker, type Json } from './page-broker.ts';
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
export declare const PAGE_SOCKET_PATH = "/v2/page/socket";
export interface PageSocketOptions {
    /** Current pairing token; read on every hello so rotation takes effect immediately. */
    pairing(): string;
    originAllowed(origin: string | undefined): boolean;
    /** Human answers arriving for an interaction this task owns. */
    onAnswer(taskId: string, interactionId: string, value: unknown): void;
    /** A task lost its last socket. */
    onDetach?(taskId: string): void;
    /** A socket (re)attached to the task. */
    onAttach?(taskId: string): void;
}
export declare class PageSockets {
    private readonly broker;
    private readonly options;
    private readonly server;
    private readonly connections;
    private readonly offChange;
    private readonly sweepTimer;
    private closed;
    constructor(broker: PageBroker, options: PageSocketOptions);
    /** Accept an HTTP upgrade on {@link PAGE_SOCKET_PATH}; anything else is refused. */
    upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
    /** True when at least one socket currently serves the task. */
    connected(taskId: string): boolean;
    /** Push one frame to every socket serving the task. @returns how many sockets received it. */
    send(taskId: string, frame: Record<string, Json>): number;
    close(): void;
    private accept;
    private hello;
    private handle;
    /**
     * Hand the task's next command to one socket. The broker decides what may run (ordering,
     * leases, unknown barrier); this only replaces the page's claim poll with an immediate claim.
     */
    private pump;
    private sweep;
    private drop;
    private write;
}
