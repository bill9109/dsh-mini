/**
 * Side-panel session targeting (see README of the side panel design).
 * Opens the handed-over session once both lists are ready.
 */
export interface WorkspaceNavigator {
    openSession(target: string): void;
}
type Snap<T> = {
    getSnapshot(): T;
    subscribe(fn: () => void): () => void;
};
export interface NavigationLists {
    sessions: {
        list: Snap<{
            phase: string;
            byId: Record<string, unknown>;
        }>;
    };
    workspaces: {
        list: Snap<{
            phase: string;
        }>;
    };
}
export declare function followPanelSession(workspace: WorkspaceNavigator, lists: NavigationLists, host?: Window): () => void;
export {};
