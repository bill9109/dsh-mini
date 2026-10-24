import type { Context } from '@deepseek-ai/cordis';
import { PageBroker } from './page-broker.ts';
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
}
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
export declare function registerPagePolicy(systemPrompt: SystemPromptService, broker: PageBroker): () => void;
export declare function apply(rawContext: Context, config?: Config): Promise<void>;
export {};
