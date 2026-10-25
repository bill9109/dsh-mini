import { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import { type SessionEvent } from '@deepseek-ai/dsh-session';
import { PageBroker } from './page-broker.ts';
import { type SitePref } from './site-prefs.ts';
/**
 * Loopback Host plugin behind the browser extension and the desktop
 * capsule. It owns one authenticated HTTP endpoint on 127.0.0.1 and turns a
 * rewrite request into one isolated DSH agent session with authenticated page tools. The selected text is untrusted data: it enters the session log as
 * a user message and is never treated as instructions beyond the rewrite task.
 */
export declare const name = "dsh-mini-panel";
export declare const inject: readonly ["agents", "agentDefaultModel", "tools"];
export interface Config {
    /** Loopback port; defaults to 18765. */
    readonly port?: number;
    /** Explicit pairing token. When set, no token file is read or written. */
    readonly token?: string;
    /** Token file path; defaults to ~/.dsh/mini-panel/token. */
    readonly tokenFile?: string;
    /** Working directory for rewrite sessions; defaults to the process cwd. */
    readonly workspace?: string;
    /** Per-rewrite deadline; defaults to 120s. */
    readonly timeoutMs?: number;
    /** Maximum accepted request body; defaults to 256 KiB. */
    readonly maxBodyBytes?: number;
    /** Maximum simultaneous rewrites; defaults to 2. */
    readonly maxConcurrent?: number;
    /** Loopback port of the side-panel carrier (the real DSH client, proxied); defaults to 18766. */
    readonly panelPort?: number;
    /** Directory of site preference files; defaults to ~/.dsh/mini-panel/sites. */
    readonly sitesDir?: string;
}
/** Session surface this plugin needs; declared locally so the package stays a boundary. */
interface AgentSession {
    readonly id: string;
    /** Agent-scoped context: listeners here only observe this agent's events. */
    readonly ctx: {
        on(event: string, listener: (payload: unknown) => void): unknown;
    };
    readonly session: {
        readonly id: string;
        snapshotEvents(): readonly SessionEvent[];
    };
    whenIdle(): Promise<void>;
    followup(message: unknown): void;
    inject(message: unknown): void;
    cancel?: (...args: unknown[]) => unknown;
}
interface CreatedAgent {
    readonly agent: AgentSession;
    dispose(): Promise<void>;
}
/**
 * A run's agent is disposed when the run ends - except while the side panel shows that session. The
 * DSH GUI drives the SAME live agent (ctx.agents is keyed by session id), and disposing it fires
 * session/disposed, which the GUI treats as "session removed": the panel locked itself as
 * 会话不可用 and stayed so. Such an agent is kept until the panel lets the session go and the
 * agent is idle, then disposed exactly once.
 */
export declare class AgentKeeper {
    private readonly leased;
    private readonly everyMs;
    private readonly graceMs;
    private readonly now;
    private readonly held;
    /** Until when a kept agent waits for the panel's lease, which the extension binds just AFTER the run ends. */
    private readonly until;
    private timer;
    constructor(leased: (sessionId: string) => boolean, everyMs?: number, graceMs?: number, now?: () => number);
    /**
     * Dispose now, or keep the agent while its session is leased. A run handed to the side panel
     * (`handedOff`) has no lease yet when it ends - the extension binds it after the stream completes -
     * so it is kept for a grace period instead of being judged on the lease alone.
     */
    finish(sessionId: string, handle: CreatedAgent, handedOff?: boolean): Promise<void>;
    /** Whether this keeper still holds the session's agent (a later run then reuses it). */
    holds(sessionId: string): boolean;
    /** Hand a kept agent to a new run, which becomes its owner again. */
    take(sessionId: string): CreatedAgent | undefined;
    sweep(): Promise<void>;
    close(): Promise<void>;
}
/** The slice of DSH's `connection` service that fences a plain webServer route like its own /api. */
interface ConnectionGate {
    requestRejection(request: {
        headers: IncomingMessage['headers'];
    }): 401 | 403 | undefined;
}
type RouteHandler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
export type PairingStatus = {
    state: 'connected' | 'stale-code' | 'idle' | 'never';
    lastSeen?: number;
};
/**
 * Paired = an extension reached this Host with the current code recently. A wrong code seen more
 * recently than any accepted call means the extension still holds an old code.
 */
export declare function pairingStatus(seen: {
    accepted?: number;
    refused?: number;
}, now: number): PairingStatus;
export declare function guarded(gate: () => ConnectionGate | undefined, handler: RouteHandler): RouteHandler;
/** What the policy section reads; both registrations resolve through it, so they never diverge. */
interface PolicySources {
    broker: PageBroker;
    sitePrefs: () => readonly SitePref[];
}
type PromptContextLike = {
    agent?: {
        id?: unknown;
        session?: {
            id?: unknown;
        };
    };
};
/**
 * The page policy for one assembly: empty without an active page task; otherwise the rules plus
 * the user's site preferences for the bound page URL (empty when none match).
 */
export declare function pagePolicyText(sources: PolicySources, context: PromptContextLike): string;
/** The slice of `ctx.systemPrompt` the page policy needs. */
interface SystemPromptService {
    section(section: {
        name: string;
        order: number;
        text: (context: {
            agent?: {
                id?: unknown;
                session?: {
                    id?: unknown;
                };
            };
        }) => string;
    }): () => void;
}
/**
 * The same policy for every other turn on a session the page is attached to - in practice the turns
 * the side panel starts, which DSH's own client creates without {@link setupRewrite}. Global but
 * conditional, like plan mode's policy: the text is resolved at each assembly and is empty (so the
 * section disappears) unless the asking agent's session currently has an active page task. A
 * capsule run registers the same name in its agent scope, which shadows this one with equal text.
 */
export declare function registerPagePolicy(systemPrompt: SystemPromptService, sources: PolicySources): () => void;
export declare function apply(rawContext: Context, config?: Config): Promise<void>;
export {};
