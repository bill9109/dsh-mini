import { PageBroker } from './page-broker.ts';
/** Exact used slice of inspected ToolDefinition / ToolRunContext. No identity fallbacks. */
export interface Execution {
    agent?: {
        session: {
            id: string;
        };
    };
    signal?: AbortSignal;
}
export interface PageTool {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    output: {
        schema: Record<string, unknown>;
        render(args: unknown, value: unknown): {
            type: 'text';
            text: string;
        }[];
    };
    execute(args: unknown, exec: Execution): Promise<unknown>;
}
export interface ToolRegistry {
    register(definition: PageTool): () => void;
}
export declare function registerPageTools(tools: ToolRegistry, broker: PageBroker): () => void;
