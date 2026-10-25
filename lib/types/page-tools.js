import { trace } from "./trace.js";
import { randomUUID } from 'node:crypto';
import protocol from './shared/edit-protocol.cjs';
import { failure } from "./page-broker.js";
/** A stored page image rides the result as an attachment ref under this key; render turns it into an image block. */
const SHOWN = 'shownImage';
const output = {
    schema: { type: 'object', properties: { ok: { type: 'boolean' }, code: { type: 'string' }, commandId: { type: 'string' } }, required: ['ok', 'code', 'commandId'], additionalProperties: true },
    render: (_args, value) => {
        const shown = value && typeof value === 'object' ? value[SHOWN] : undefined;
        if (!shown || typeof shown !== 'object')
            return [{ type: 'text', text: JSON.stringify(value) }];
        const { [SHOWN]: ref, ...rest } = value;
        return [{ type: 'text', text: JSON.stringify(rest) }, { type: 'image', attachment: ref }];
    },
};
const IMAGE_BYTES = (base64) => Uint8Array.from(Buffer.from(base64, 'base64'));
/**
 * scope image: the page returns a bounded JPEG as base64. Store it as a durable attachment (the same
 * path read_image uses) and hand the model the reference, so the pixels never ride the tool text.
 * Without an attachment store, or for a model that cannot take images, say so instead of sending bytes.
 */
async function showImage(out, support, exec) {
    const image = out.image;
    if (out.ok !== true || !image || typeof image.base64 !== 'string')
        return out;
    const { image: _drop, ...rest } = out;
    const store = support?.store();
    if (!store || !support)
        return failure('IMAGE_UNSUPPORTED', 'This deployment has no attachment store, so page images cannot be shown. Use scope document for the image alt text and size.', { commandId: out.commandId ?? randomUUID() });
    try {
        await support.gate(exec);
    }
    catch (error) {
        return failure('IMAGE_UNSUPPORTED', String(error.message || error), { commandId: out.commandId ?? randomUUID() });
    }
    const data = IMAGE_BYTES(image.base64);
    if (data.byteLength > Math.min(store.imageLimits.maxImageBytes, store.imageLimits.maxMessageImageBytes))
        return failure('IMAGE_TOO_LARGE', 'The reduced image still exceeds the deployment limit.', { commandId: out.commandId ?? randomUUID() });
    const label = [image.name, image.caption, image.alt].find(v => typeof v === 'string' && v);
    let ref;
    try {
        ref = await store.saveImage({ data, mediaType: 'image/jpeg', name: (label ?? 'page-image').slice(0, 80).replace(/[\\/]/g, '_') + '.jpg' });
    }
    catch (error) {
        return failure('IMAGE_NOT_STORED', 'The image could not be stored: ' + String(error.message || error), { commandId: out.commandId ?? randomUUID() });
    }
    const scaled = image.originalWidth !== image.width || image.originalHeight !== image.height;
    return { ...rest, [SHOWN]: ref, shown: { width: image.width, height: image.height, ...(scaled ? { originalWidth: image.originalWidth, originalHeight: image.originalHeight } : {}), ...(label ? { label } : {}) } };
}
const targetRef = { type: 'string', description: 'Exact opaque ref from this task snapshot or page_read. Never invent one. Omit only to use the task-bound initial target.' };
const expectedRevision = { type: 'string', description: 'Revision returned with this exact target; prevents stale writes.' };
const MAX_BATCH = 20;
/** Several edits, applied in order; the first failure stops the batch and is reported with every result so far. */
async function batch(broker, edits, exec) {
    if (!Array.isArray(edits) || edits.length < 1 || edits.length > MAX_BATCH)
        return failure('INVALID_ARGUMENT', 'edits must hold 1..' + MAX_BATCH + ' edits.', { commandId: randomUUID() });
    const checked = edits.map(edit => protocol.validateEdit(edit));
    const bad = checked.findIndex(c => !c.ok);
    if (bad >= 0)
        return { ...checked[bad], index: bad, message: 'edits[' + bad + ']: ' + checked[bad].message, commandId: randomUUID() };
    const results = [];
    for (const [index, c] of checked.entries()) {
        if (!c.ok)
            break;
        let out;
        try {
            out = await broker.submit(exec.agent?.session?.id, 'edit', c.value, exec.signal);
        }
        catch {
            out = failure('INVALID_COMMAND', 'Page command must be bounded lossless JSON.', { commandId: randomUUID() });
        }
        results.push(out);
        if (out?.ok !== true)
            return { ok: false, code: 'BATCH_STOPPED', commandId: randomUUID(), stoppedAt: index, applied: index, results,
                message: 'edits[' + index + '] failed (' + String(out?.code) + '); later edits were not attempted.' };
    }
    return { ok: true, code: 'BATCH_APPLIED', commandId: randomUUID(), applied: results.length, results };
}
const execute = (broker, kind, images) => async (args, exec) => {
    if (kind === 'edit' && args && typeof args === 'object' && 'edits' in args) {
        const { edits, ...rest } = args;
        if (Object.keys(rest).length)
            return failure('INVALID_ARGUMENT', 'Use either edits or a single targetRef/expectedRevision/operation, not both.', { commandId: randomUUID() });
        return batch(broker, edits, exec);
    }
    trace('tool/' + kind + '/enter', { args: args && typeof args === 'object' ? Object.keys(args).join(',') : String(args) });
    const checked = kind === 'read' ? protocol.validateRead(args) : protocol.validateEdit(args);
    if (!checked.ok)
        return { ...checked, commandId: randomUUID() };
    try {
        let out = await broker.submit(exec.agent?.session?.id, kind, checked.value, exec.signal);
        if (kind === 'read' && checked.value.scope === 'image')
            out = await showImage(out, images, exec);
        trace('tool/' + kind + '/exit', { ok: out?.ok === true, code: out?.code ?? null, commandId: out?.commandId ?? null, state: out?.state ?? null }, out?.ok === false ? 'error' : 'info');
        return out;
    }
    catch {
        return failure('INVALID_COMMAND', 'Page command must be bounded lossless JSON.', { commandId: randomUUID() });
    }
};
export function registerPageTools(tools, broker, images) {
    if (protocol.VERSION !== 2)
        throw new Error('Page tools require shared protocol version 2');
    const disposers = [];
    try {
        disposers.push(tools.register({
            name: 'page_read', description: 'Read the page. scope:target (default) reads the bound target with its formatting runs. scope:document reads the whole visible page (title, headings, paragraphs, links, images, tables, form fields) on ANY page - read-only, it issues no refs. In an editor, scope:outline lists its blocks (a cheap map: type and a short lead each; read a block for its full text), scope:range the blocks between at and to, scope:keyword the blocks matching find; these return writable block refs. Lists name each distinct capability set once in capabilitySets and point each block at it with caps; a block without caps or with editable:false cannot be written. Reading has no side effects. scope:image shows ONE image to you (you see the picture itself, reduced to fit): give index (the i of an image item from scope:document) or targetRef (an image block from scope:outline). Items of type image carry only alt/size until you ask. Results are bounded and paged by cursor.',
            parameters: { type: 'object', properties: {
                    targetRef,
                    reason: { type: 'string' },
                    at: { type: 'string', description: 'Read anchor: the target for scope:target, the range start for scope:range. Must be a ref this page issued.' },
                    to: { type: 'string', description: 'Range end (scope:range only); omit to read through to the end of the document.' },
                    scope: { type: 'string', enum: ['target', 'outline', 'range', 'keyword', 'document', 'image'],
                        description: 'target (default) reads the bound target. document reads the visible page as read-only items, on every page, even when nothing is editable. outline lists the editor blocks - a map; use it first when you do not yet know where to work. range returns the span from at to to. keyword searches the editor. Items carry depth (and parentId on Feishu, where outline also includes blocks the DOM has not mounted).' },
                    find: { type: 'string', description: 'Search text for scope:keyword, or within the chosen scope.' },
                    findText: { type: 'string', description: 'Search inside the bound target (legacy alias for find with the default scope).' },
                    limit: { type: 'integer', minimum: 1, maximum: 100, default: 32, description: 'Maximum items to return.' },
                    cursor: { type: 'string', description: 'Opaque cursor returned by a previous read; pass it back to continue.' },
                    index: { type: 'integer', minimum: 0, description: 'scope:image only: the "i" of an image item from scope:document. Instead of index, a Feishu/editor image block may be named by targetRef (from scope:outline).' },
                }, additionalProperties: false }, output, execute: execute(broker, 'read', images),
        }));
        disposers.push(tools.register({
            name: 'page_edit', description: 'Edit only the authenticated task-bound frontend page. Use exact targetRef/revision and the operations, contentTypes and formats the target reports in capabilities. Block refs (outline, range, keyword, or a target read of a whole block) allow replace-block, insert-before, insert-after and delete-block; delete-block and replace-block need explicit user intent. Pass edits:[...] to apply up to ' + MAX_BATCH + ' edits in order (each with its own targetRef/expectedRevision; the first failure stops the rest) - edit different blocks in one batch, since an edit changes the revision of its block. A timeout after start is unknown; query status, never repeat blindly. Final replies never write.',
            parameters: { type: 'object', properties: { targetRef, expectedRevision,
                    edits: { type: 'array', minItems: 1, maxItems: MAX_BATCH, description: 'Batch form, instead of targetRef/expectedRevision/operation: each item is { targetRef?, expectedRevision, operation }.', items: { type: 'object' } },
                    operation: {
                        type: 'object', properties: {
                            type: { type: 'string', enum: ['replace-selection', 'insert-at-caret', 'replace-block', 'keep-block-kind', 'set-format', 'insert-before', 'insert-after', 'delete-block', 'insert-image'] },
                            text: { type: 'string', description: 'Required except for set-format, delete-block and insert-image, where text is forbidden. With contentType markdown on a whole block this is the new SHAPE. One call may mix types (#/##/### headings, 1. ordered list, - bullet, **bold**) - do not split it into several calls. Write ordinals as list syntax "1.", never as a bold number inside the item, or they render as bullets that merely contain digits. A heading may also carry the editors own auto-numbering (the "1. " the page renders, which markdown cannot express): create the heading first, then set-format { autoNumber: true } on that heading block - that takes a second call. Structures outside this subset (callout, grid, table, mermaid, checkboxes) are refused, not silently degraded. ALWAYS check the returned missing/PARTIAL_STRUCTURE: it names the lines that did not materialise.' },
                            contentType: { type: 'string', enum: ['plain', 'markdown', 'html'], default: 'plain', description: 'Plain writes literally; in a generic editor a multi-line plain text becomes one paragraph per line. Markdown is rendered (headings, lists, quotes, code, **bold**, *italic*, `code`, [links](https://...)). html is sanitized to the same small vocabulary (generic editors only). Request it explicitly; capabilities.contentTypes says what the target accepts.' },
                            image: { type: 'object', description: 'insert-image only: { src: https URL or small data:image/... URL, alt? }. Goes at a caret target or after a block ref; the editor uploads it like a pasted image.', properties: { src: { type: 'string' }, alt: { type: 'string' } }, required: ['src'], additionalProperties: false },
                            format: { type: 'object', properties: { bold: { type: 'boolean' }, italic: { type: 'boolean' }, underline: { type: 'boolean' }, strikethrough: { type: 'boolean' }, color: { oneOf: [{ type: 'string' }, { type: 'null' }] }, highlight: { oneOf: [{ type: 'string' }, { type: 'null' }] }, autoNumber: { type: 'boolean' }, link: { oneOf: [{ type: 'string', description: 'http(s) or mailto URL' }, { type: 'null' }] } }, additionalProperties: false },
                        }, required: ['type'], additionalProperties: false,
                    } }, additionalProperties: false }, output, execute: execute(broker, 'edit'),
        }));
        disposers.push(tools.register({
            name: 'page_operation_status', description: 'Session-authorized status for a previous commandId, including the full actual nested outcome. Available after the page task turn ends; never implies an edit succeeded.',
            parameters: { type: 'object', properties: { commandId: { type: 'string' } }, required: ['commandId'], additionalProperties: false }, output,
            async execute(args, exec) {
                const commandId = args?.commandId;
                if (typeof commandId !== 'string' || !commandId || commandId.length > 128)
                    return failure('INVALID_COMMAND_ID', 'A commandId is required.', { commandId: randomUUID() });
                return broker.status(exec.agent?.session?.id, commandId);
            },
        }));
    }
    catch (error) {
        for (const dispose of disposers.reverse())
            dispose();
        throw error;
    }
    return () => { for (const dispose of disposers.splice(0).reverse())
        dispose(); };
}
