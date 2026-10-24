import { type PageBroker } from './page-broker.ts';
import type { PageSockets } from './page-socket.ts';
/**
 * Human interactions (tool approvals and ask_user_question) for runs the browser page drives.
 *
 * Both seams are Agent-scoped Cordis waterfalls. This plugin registers prepended answerers that
 * claim a request only when the asking agent's session is bound to a page task with a live socket,
 * and otherwise call next(), so the DSH GUI answers exactly as before. If the page disconnects
 * while a question is open, the request is handed to next() as well: a run is never stranded on a
 * page that can no longer answer.
 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';
export interface QuestionOption {
    label: string;
    description?: string;
}
export interface QuestionItem {
    id: string;
    question: string;
    detail?: string;
    header?: string;
    options?: QuestionOption[];
    multiSelect?: boolean;
}
export interface QuestionAnswerItem {
    id: string;
    selected: string[];
    custom?: string;
}
export interface QuestionAnswer {
    answers: QuestionAnswerItem[];
}
interface AgentLike {
    id?: unknown;
    session?: {
        id?: unknown;
        snapshotEvents?: () => readonly unknown[];
    };
}
export interface ApprovalRequest {
    agent?: AgentLike;
    toolName: string;
    callId?: string;
    reason?: string;
    displayReason?: {
        en: string;
        [locale: string]: string;
    };
    signal?: AbortSignal;
}
export interface QuestionRequest {
    agent?: AgentLike;
    questions: QuestionItem[];
    signal?: AbortSignal;
}
/** Validate a page answer against the questions that were actually asked. */
export declare function parseAnswer(questions: readonly QuestionItem[], value: unknown): QuestionAnswer | undefined;
export declare class Interactions {
    private readonly broker;
    private readonly sockets;
    private readonly pending;
    private readonly timers;
    private closed;
    constructor(broker: PageBroker, sockets: PageSockets);
    /** `approval/request` waterfall listener. */
    approval(request: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome>;
    /** `user-questions/request` waterfall listener. */
    question(request: QuestionRequest, next: () => Promise<QuestionAnswer>): Promise<QuestionAnswer>;
    /** Page frame: a human answer for an interaction the sending task owns. */
    answer(taskId: string, interactionId: string, value: unknown): void;
    /** The task lost its last socket: after a reconnect grace, give open interactions back to the GUI. */
    detach(taskId: string): void;
    /** A page (re)connected: show it every interaction still open for its task. */
    reattach(taskId: string): void;
    /**
     * The page moved its interactions. Moving to the GUI hands every open one to the rest of the
     * waterfall right away (the capsule that would show it is hidden); moving back only affects the
     * next ask, because an interaction already answered by the GUI cannot be taken back.
     */
    surface(taskId: string, surface: 'page' | 'gui'): void;
    private handOver;
    close(): void;
    private target;
    private open;
}
export {};
