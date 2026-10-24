import { type NavigationLists, type WorkspaceNavigator } from './panel-session.ts';
export declare const name = "dsh-mini-panel-client";
/** `slots` is a hard dependency: apply() registers into it. */
export declare const inject: readonly ["slots"];
export declare function apply(ctx: {
    effect(callback: () => () => void, label: string): void;
    inject(services: readonly string[], callback: (scope: {
        effect(callback: () => () => void, label: string): void;
        uiWorkspace: WorkspaceNavigator;
    } & NavigationLists) => void): void;
    slots: {
        inject(name: string, register: () => unknown): void;
        register(options: Record<string, unknown>, render: () => unknown): unknown;
    };
}): void;
