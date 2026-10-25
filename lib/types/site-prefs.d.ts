export declare const HEADER_OPEN = "// ==DshSite==";
export declare const HEADER_CLOSE = "// ==/DshSite==";
/** One file's cap: guidance, not a document. Bodies beyond it are refused, not truncated. */
export declare const MAX_FILE_BYTES = 32768;
/** Cap on everything one prompt may carry from all matching files together. */
export declare const MAX_PROMPT_CHARS = 12000;
export declare const MAX_FILES = 200;
export interface SiteMeta {
    name: string;
    namespace?: string;
    version: string;
    description?: string;
    author?: string;
    homepage?: string;
    match: string[];
    exclude: string[];
    /** Unknown @keys are preserved verbatim so a newer file round-trips through an older editor. */
    extra: [string, string][];
}
export interface SitePref {
    id: string;
    meta: SiteMeta;
    body: string;
    enabled: boolean;
}
export type ParseResult = {
    ok: true;
    meta: SiteMeta;
    body: string;
} | {
    ok: false;
    message: string;
};
/** Parse a site file. Strict on the header (it decides who sees the body), lenient on the body. */
export declare function parseSiteFile(text: string): ParseResult;
/** Render a file from its parts; the canonical form the store writes and exports. */
export declare function formatSiteFile(meta: SiteMeta, body: string): string;
export declare function matchPattern(pattern: string, url: string): boolean;
export declare function matchesUrl(meta: SiteMeta, url: string): boolean;
/** A short file id derived from the name; kept stable once created. */
export declare function slugOf(name: string): string;
/**
 * The prompt text for one page URL: every enabled matching file, each fenced with its name and
 * version so the model (and a reviewer of the session log) can tell where a rule came from.
 */
export declare function promptFor(prefs: readonly SitePref[], url: string): string;
/** One directory of site files plus a small state file for the enabled flags. */
export declare class SitePrefStore {
    private readonly dir;
    private cache;
    private listeners;
    constructor(dir: string);
    get directory(): string;
    onChange(listener: () => void): () => void;
    private changed;
    private state;
    private atomic;
    /** All files. An unreadable or invalid file is reported, never dropped silently and never fatal. */
    list(): Promise<{
        prefs: SitePref[];
        invalid: {
            id: string;
            message: string;
        }[];
    }>;
    /** Prefs for prompt assembly; cached between edits so a turn never waits on the disk twice. */
    cached(): Promise<SitePref[]>;
    read(id: string): Promise<string | undefined>;
    /** Create (id omitted) or replace a file. The text is validated and stored in canonical form. */
    save(text: string, id?: string): Promise<{
        ok: true;
        id: string;
    } | {
        ok: false;
        message: string;
    }>;
    setEnabled(id: string, enabled: boolean): Promise<boolean>;
    remove(id: string): Promise<boolean>;
}
/** The starter file the settings page offers; also documents the format by example. */
export declare const TEMPLATE: string;
