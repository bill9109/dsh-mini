import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
const DIR = join(homedir(), '.dsh', 'mini-panel');
const FILE = join(DIR, 'panel-trace.jsonl');
let ready = false;
let scheduled = false;
const queue = [];
function localTime() {
    const d = new Date();
    const p = (v, n = 2) => String(v).padStart(n, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
export function traceFilePath() {
    return FILE;
}
function flush() {
    scheduled = false;
    if (queue.length === 0)
        return;
    const batch = queue.splice(0, queue.length).join('');
    try {
        if (!ready) {
            mkdirSync(DIR, { recursive: true });
            ready = true;
        }
        appendFileSync(FILE, batch);
    }
    catch {
        // Tracing must never break the operation it is describing.
    }
}
/** Drain queued records now. Tests and shutdown paths use this instead of waiting a tick. */
export function flushTrace() {
    flush();
}
export function trace(event, data = {}, level) {
    try {
        const lv = level ?? (/miss|fail|error|refus|unknown|cancel/.test(event) || data.ok === false ? 'error' : 'info');
        queue.push(JSON.stringify({ t: localTime(), level: lv, pid: process.pid, event, data }) + '\n');
        // Bound memory under bursts; the flush itself always runs off the request path.
        if (queue.length > 5000)
            queue.splice(0, queue.length - 5000);
        if (!scheduled) {
            scheduled = true;
            setImmediate(flush);
        }
    }
    catch {
        // ignore
    }
}
/** Records forwarded from the browser layers (content script, background, page bridge). */
export function traceFromExtension(source, runId, records) {
    if (!Array.isArray(records) || records.length === 0)
        return;
    for (const r of records.slice(-60)) {
        try {
            const rec = r;
            trace(`${source}/${String(rec.event ?? rec.what ?? 'record')}`, {
                from: source,
                run: runId ?? null,
                at: rec.t ?? null,
                level: rec.level ?? null,
                data: rec.data ?? rec.detail ?? null,
            });
        }
        catch {
            // ignore malformed records
        }
    }
}
