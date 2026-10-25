import { PageBroker } from './page-broker.ts';
/** Exact used slice of inspected ToolDefinition / ToolRunContext. No identity fallbacks. */
export interface Execution {
    agent?: {
        session: {
            id: string;
            requestHeader?(): {
                config?: {
                    provider?: string;
                    model?: string;
                };
            } | undefined;
        };
        options?: {
            provider?: string;
            model?: string;
        };
    };
    signal?: AbortSignal;
}
/** The slice of the attachment store this plugin uses (the service is optional; see registerPageTools). */
export interface ImageStore {
    saveImage(input: {
        data: Uint8Array;
        mediaType: 'image/jpeg';
        name?: string;
    }): Promise<{
        attachmentId: string;
        mediaType: string;
        bytes: number;
        width: number;
        height: number;
        name?: string;
        originalDimensions?: {
            width: number;
            height: number;
        };
    }>;
    imageLimits: {
        maxImageBytes: number;
        maxMessageImageBytes: number;
    };
}
/** Resolves whether the model serving this turn accepts images; throws a plain reason when it does not. */
export type ImageGate = (exec: Execution) => Promise<void>;
export interface ImageSupport {
    store(): ImageStore | undefined;
    gate: ImageGate;
}
export type PageContent = {
    type: 'text';
    text: string;
} | {
    type: 'image';
    attachment: unknown;
};
export interface PageTool {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    output: {
        schema: Record<string, unknown>;
        render(args: unknown, value: unknown): PageContent[];
    };
    execute(args: unknown, exec: Execution): Promise<unknown>;
}
export interface ToolRegistry {
    register(definition: PageTool): () => void;
}
export declare function registerPageTools(tools: ToolRegistry, broker: PageBroker, images?: ImageSupport): () => void;
