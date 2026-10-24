/**
 * Append-only event trace for the whole mini-panel chain.
 *
 * Shaped after how dsh records its own events: one record per event, a namespaced event name, a
 * level, structured data instead of prose, local time, and an id that ties records to one run or
 * command. Records from the browser layers are written into the SAME file, so one artifact shows the
 * whole chain instead of four separate ones.
 *
 * Writing is batched onto a later tick. An earlier version appended synchronously on every command
 * transition, which put file IO on the request path; logging must not be able to slow down or stall
 * the operation it describes.
 */
export type TraceLevel = 'debug' | 'info' | 'warn' | 'error';
export declare function traceFilePath(): string;
/** Drain queued records now. Tests and shutdown paths use this instead of waiting a tick. */
export declare function flushTrace(): void;
export declare function trace(event: string, data?: Record<string, unknown>, level?: TraceLevel): void;
/** Records forwarded from the browser layers (content script, background, page bridge). */
export declare function traceFromExtension(source: string, runId: string | undefined, records: unknown): void;
