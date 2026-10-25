(function(root,factory){const M=typeof module==='object'&&module.exports?require('../markup.js'):root.DSHMarkup;const api=factory(M);if(typeof module==='object'&&module.exports)module.exports=api;else Object.defineProperty(root,'DSHAdapterRichtext',{value:api,configurable:true});})(globalThis,function(M){
'use strict';
// Adapter-level records; panelLog lives in the kernel scope and may be absent.
const alog = (event, data) => { try { if (typeof panelLog === 'function') panelLog('richtext/' + event, data); } catch (e) {} };
/**
 * Generic contenteditable. Writes go through the editor's own input paths - insertText for a plain
 * single line, a paste for structure, formatting commands for marks - so editors that own a model
 * (ProseMirror, Lexical, Slate, Quill) apply them as their own transactions. Every write is checked
 * against the text the editor actually shows afterwards; nothing is assumed to have landed.
 */
const operations = ['replace-selection', 'insert-at-caret', 'replace-block', 'keep-block-kind', 'set-format', 'insert-before', 'insert-after', 'delete-block', 'insert-image'];
const formats = ['bold', 'italic', 'underline', 'strikethrough', 'link', 'color', 'highlight'];
const BLOCKS = 'p,li,h1,h2,h3,h4,h5,h6,pre,blockquote';
const editableNode = n => n?.isContentEditable === true || (n?.isContentEditable === undefined && !!n?.closest?.('[contenteditable]') && n.closest('[contenteditable]').getAttribute('contenteditable') !== 'false');
function snapshot(ctx, t) {
  alog('snapshot/enter', { kind: (t.node && t.node.tagName || '').slice(0, 12) });
  const node = t.node;
  if (!node?.isConnected) throw ctx.fault('STALE_TARGET', 'Target node removed; replacement nodes are not guessed');
  const text = node.textContent || '', editable = editableNode(node);
  const runs = M.runs(node, ctx.doc);
  const base = { adapter: 'richtext', kind: node.tagName.toLowerCase(), text, editable, html: node.innerHTML, runs,
    capabilities: { operations, contentTypes: ['plain', 'markdown', 'html'], formats, clearFormats: ['bold', 'italic', 'underline', 'strikethrough', 'link'], atomicCellReplacement: false,
      scopes: ['target', 'outline', 'range', 'keyword', 'document'] } };
  alog('snapshot/exit', { kind: base.kind, chars: String(text || '').length, editable });
  return { ...base, revision: ctx.revision([text, base.html, editable]), verification: 'dom-observed' };
}
/** Leaf blocks of an editor root in document order; the root itself when it holds no blocks. */
function blocks(rootEl) {
  const all = [...rootEl.querySelectorAll(BLOCKS)].filter(el => !el.querySelector(BLOCKS) || /^(LI)$/.test(el.tagName) && !el.querySelector('p,h1,h2,h3,h4,h5,h6,pre,blockquote'));
  return all.length ? all : [rootEl];
}
// A hidden tab never runs animation frames, so a frame wait alone hung every write there.
const frame = view => new Promise(r => { const done = () => { clearTimeout(t); r(); }; const t = setTimeout(done, 80); try { view.requestAnimationFrame(() => setTimeout(done, 30)); } catch (e) { /* timer covers it */ } });
// Model-owning editors (ProseMirror, Lexical) read the DOM selection on selectionchange, which is
// dispatched asynchronously. Acting before it lands applies the write at the editor's OLD selection.
// Editors place their own <img> plumbing (ProseMirror-separator, cursor hacks); only images with a
// source are content.
const contentImages = el => [...el.querySelectorAll('img')].filter(i => i.getAttribute('src') && !/separator|cursor|placeholder/i.test(i.className)).length;
function editable(ctx, node) { const d = ctx.doc.activeElement; return d && d.isContentEditable ? d : node.closest('[contenteditable]') || node; }
/** Returns true when the editor took the beforeinput (preventDefault): it owns the change. */
function input(ctx, node, inputType) { const v = ctx.doc.defaultView; try { return !editable(ctx, node).dispatchEvent(new v.InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true, composed: true })); } catch (e) { return false; } }
function shortcut(ctx, node, key) { const v = ctx.doc.defaultView, mac = /Mac|iPhone|iPad/.test(v.navigator.platform || ''); const init = { key, code: 'Key' + key.toUpperCase(), keyCode: key.toUpperCase().charCodeAt(0), metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true, composed: true }; const el = editable(ctx, node); el.dispatchEvent(new v.KeyboardEvent('keydown', init)); el.dispatchEvent(new v.KeyboardEvent('keyup', init)); }
const pause = () => new Promise(r => setTimeout(r, 40));
function select(ctx, node, a, b) {
  const range = typeof a === 'number' ? ctx.plainRange(node, a, b, ctx.doc) : (() => { const r = ctx.doc.createRange(); r.selectNodeContents(node); if (a === 'start') r.collapse(true); else if (a === 'end') r.collapse(false); return r; })();
  (node.closest?.('[contenteditable]') || node).focus?.({ preventScroll: true });
  const selection = ctx.doc.defaultView.getSelection();
  selection.removeAllRanges(); selection.addRange(range);
  return range;
}
/** Deliver content through the editor's paste handler; fall back to the native command only when nobody handled it. */
function paste(ctx, target, { html, text, file }) {
  const view = ctx.doc.defaultView;
  let data = null;
  try { data = new view.DataTransfer(); if (html !== undefined) data.setData('text/html', html); if (text !== undefined) data.setData('text/plain', text); if (file) data.items.add(file); } catch (e) { data = null; }
  let handled = false;
  if (data) {
    let event;
    try { event = new view.ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }); } catch (e) { event = null; }
    if (!event || !event.clipboardData) { event = new view.Event('paste', { bubbles: true, cancelable: true }); Object.defineProperty(event, 'clipboardData', { value: data }); }
    const at = ctx.doc.activeElement && ctx.doc.activeElement !== ctx.doc.body ? ctx.doc.activeElement : target;
    handled = !at.dispatchEvent(event);
  }
  if (!handled) {
    if (file) return { handled: false, fallback: false };
    ctx.doc.execCommand('insertHTML', false, html);
  }
  return { handled, fallback: !handled };
}
function offsetOf(ctx, rootEl, node) { if (node === rootEl) return 0; const r = ctx.doc.createRange(); r.selectNodeContents(rootEl); r.setEndBefore(node); return r.toString().length; }
function contentOf(op, doc) {
  const type = op.contentType || 'plain';
  if (type === 'html') { const html = M.sanitize(op.text, doc); return { html, text: M.htmlText(html, doc), structured: true }; }
  if (type === 'markdown') { const html = M.markdownToHtml(op.text); return { html, text: M.htmlText(html, doc), structured: true }; }
  return { html: M.plainToHtml(op.text), text: op.text, structured: /[\r\n]/.test(op.text) };
}
function rootOf(t) { return t.editor?.isConnected ? t.editor : (t.node.closest?.('[contenteditable]:not([contenteditable="false"])') || t.node); }
const ok = (modified, code, extra = {}) => ({ ok: true, code, modification: modified ? 'modified' : 'not-modified', verification: 'dom-observed', retryable: false, ...extra });
async function write(ctx, t, before, a, b, op, signal) {
  alog('write/enter', { op: op && op.type, contentType: op && op.contentType || 'plain', range: [a, b] });
  const node = t.node, rootEl = rootOf(t), view = ctx.doc.defaultView;
  if (node.querySelector('[contenteditable="false"]') && op.type !== 'insert-before' && op.type !== 'insert-after') throw ctx.fault('UNSUPPORTED_STRUCTURE', 'The block holds embedded non-editable content; edit around it or replace a different block');
  const check = await ctx.snapshot(t);
  if (check.revision !== before.revision) throw ctx.fault('REVISION_CONFLICT', 'Editor changed before writing');
  if (signal?.aborted) throw ctx.fault('CANCELLED', 'Cancelled before commit');
  const rootText = rootEl.textContent || '', base = offsetOf(ctx, rootEl, node);
  const retarget = () => ({ adapter: 'richtext', node: rootEl, editor: rootEl, kind: 'block', start: 0, end: (rootEl.textContent || '').length });
  const settle = async (expectedRoot, extra = {}) => {
    await frame(view);
    const now = rootEl.textContent || '';
    const done = M.squash(now) === M.squash(expectedRoot), changed = now !== rootText;
    const live = node.isConnected;
    const after = await ctx.snapshot(live && !extra.forceRoot ? t : { ...t, node: rootEl });
    alog('write/exit', { code: done ? 'EDIT_APPLIED' : 'POSTCONDITION_FAILED', ok: done });
    return { after, retarget: live && !extra.forceRoot ? extra.retarget : retarget(), span: live && !extra.forceRoot ? extra.span : undefined,
      result: done ? ok(true, 'EDIT_APPLIED', extra.result) : { ok: false, code: changed ? 'POSTCONDITION_FAILED' : 'NOT_APPLIED', message: changed ? 'The editor changed, but not to the requested content.' : 'The editor did not accept the change.', modification: changed ? 'partial' : 'not-modified', verification: 'dom-observed', retryable: false } };
  };
  if (op.type === 'delete-block') {
    const gone = () => !node.isConnected || !(node.textContent || '').trim();
    select(ctx, node, 0, before.text.length); await pause(); ctx.mark();
    // beforeinput first, as a real browser would: model-owning editors (Lexical, Slate) act on it and
    // ignore execCommand, whose raw DOM change they then reconcile away. Native only if nobody took it.
    if (!input(ctx, node, 'deleteContentBackward')) ctx.doc.execCommand('delete', false);
    await frame(view);
    if (!gone()) { select(ctx, node, 0, before.text.length); await pause(); ctx.doc.execCommand('delete', false); await frame(view); }
    if (node.isConnected && !(node.textContent || '').trim() && node !== rootEl) {
      // The text is gone; remove the now-empty block itself the same way.
      select(ctx, node, 0, 0); await pause();
      ctx.doc.execCommand('delete', false); await frame(view);
      if (node.isConnected && !(node.textContent || '').trim()) { input(ctx, node, 'deleteContentBackward'); await frame(view); }
    }
    return settle(rootText.slice(0, base) + rootText.slice(base + before.text.length), { forceRoot: true });
  }
  if (op.type === 'insert-image') {
    if (typeof ctx.fetchImage !== 'function') throw ctx.fault('ADAPTER_UNAVAILABLE', 'Image fetching is not available on this page');
    const image = await ctx.fetchImage(op.image.src, signal);
    if (!image?.ok) throw ctx.fault(image?.code || 'IMAGE_UNAVAILABLE', image?.message || 'The image could not be fetched');
    if (t.kind === 'block') select(ctx, node, 'end'); else select(ctx, node, a, a);
    await pause();
    const count = contentImages(rootEl);
    ctx.mark();
    const file = new view.File([image.bytes], image.name || 'image', { type: image.type });
    // One representation per paste. A file and an <img> together are two images to most editors
    // (measured on ProseMirror: one insert produced two). The file goes first because that is what
    // makes upload-backed editors store the image; an <img> by URL is only the fallback.
    let delivered = paste(ctx, node, { file });
    if (!delivered.handled && /^https?:/i.test(op.image.src)) {
      const html = '<img src="' + String(op.image.src).replace(/"/g, '&quot;') + '" alt="' + String(op.image.alt || '').replace(/"/g, '&quot;') + '">';
      delivered = paste(ctx, node, { html });
    }
    // Editors upload pasted files asynchronously; give them a bounded moment to render.
    let added = 0; for (let i = 0; i < 20 && !added; i++) { await frame(view); added = contentImages(rootEl) - count; }
    const after = await ctx.snapshot(node.isConnected ? t : { ...t, node: rootEl });
    return { after, retarget: retarget(), result: added === 1 ? ok(true, 'EDIT_APPLIED', { delivery: delivered.handled ? 'editor-paste' : 'native-insert' }) : added > 1 ? { ok: false, code: 'POSTCONDITION_FAILED', message: added + ' images appeared instead of one; check the page.', modification: 'partial', verification: 'dom-observed', retryable: false } : { ok: false, code: 'NOT_APPLIED', message: 'No image appeared in the editor. It may not accept pasted images; upload it through the editor UI.', modification: 'unknown', verification: 'dom-observed', retryable: false } };
  }
  if (op.type === 'set-format') {
    const range = select(ctx, node, a, b); await pause(); ctx.mark();
    for (const [key, value] of Object.entries(op.format)) {
      if (key === 'link') {
        if (value === null) { ctx.doc.execCommand('unlink', false); continue; }
        // Paste the same text as a link, marks kept. createLink is the fallback only: on Lexical it
        // replaced the selected words with the URL (measured), which verification can report but not undo.
        const esc = x => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const cur = await ctx.snapshot(t);
        const inner = cur.runs.filter(r => r.end > a && r.start < b).map(r => {
          let h = esc(cur.text.slice(Math.max(r.start, a), Math.min(r.end, b)));
          for (const [m, tag] of [['bold', 'strong'], ['italic', 'em'], ['underline', 'u'], ['strikethrough', 's']]) if (r.marks[m]) h = '<' + tag + '>' + h + '</' + tag + '>';
          return h;
        }).join('') || esc(cur.text.slice(a, b));
        const delivered = paste(ctx, node, { html: '<a href="' + esc(value) + '">' + inner + '</a>', text: cur.text.slice(a, b) });
        if (!delivered.handled) ctx.doc.execCommand('createLink', false, value);
        await frame(view); select(ctx, node, a, b); await pause();
        continue;
      }
      if (key === 'color' || key === 'highlight') { try { ctx.doc.execCommand('styleWithCSS', false, true); } catch (e) {} ctx.doc.execCommand(key === 'color' ? 'foreColor' : 'hiliteColor', false, value === null ? 'inherit' : value); continue; }
      const cmd = { bold: 'bold', italic: 'italic', underline: 'underline', strikethrough: 'strikeThrough' }[key];
      const done = async () => { const snap = await ctx.snapshot(t); return snap.runs.filter(r => r.end > a && r.start < b).every(r => !!r.marks[key] === value); };
      if (await done()) continue;
      // Three routes, each tried only if the previous left the text unchanged: the native command,
      // the beforeinput an editor that owns its model listens for, and the editor's shortcut key.
      // A route that changes the TEXT is damage, not formatting (measured: native italic on Lexical
      // dropped a space while the editor reconciled). Stop at once; the verification below reports it.
      const intact = async () => (await ctx.snapshot(t)).text === before.text;
      const taken = input(ctx, node, 'format' + cmd[0].toUpperCase() + cmd.slice(1));
      await frame(view);
      if (!(await intact())) break;
      if (await done()) { select(ctx, node, a, b); await pause(); continue; }
      if (!taken) {
        select(ctx, node, a, b); await pause();
        ctx.doc.execCommand(cmd, false);
        await frame(view);
        if (!(await intact())) break;
        if (await done()) { select(ctx, node, a, b); await pause(); continue; }
      }
      const letter = { bold: 'b', italic: 'i', underline: 'u' }[key];
      if (letter) { select(ctx, node, a, b); await pause(); shortcut(ctx, node, letter); await frame(view); if (!(await intact())) break; }
      select(ctx, node, a, b); await pause();
    }
    await frame(view);
    if (!node.isConnected) return settle(rootText, { forceRoot: true });
    const after = await ctx.snapshot(t);
    const inRange = after.runs.filter(r => r.end > a && r.start < b);
    const bad = Object.entries(op.format).filter(([k, v]) => !inRange.every(r => k === 'link' ? (v === null ? !r.marks.link : !!r.marks.link) : (k === 'color' || k === 'highlight') ? (v === null ? true : !!r.marks[k]) : !!r.marks[k] === v)).map(([k]) => k);
    const sameText = after.text === before.text;
    void range;
    return { after, result: bad.length || !sameText ? { ok: false, code: 'POSTCONDITION_FAILED', message: 'Not applied: ' + (bad.join(', ') || 'text changed'), failedFormats: bad, modification: after.revision === before.revision ? 'not-modified' : 'partial', verification: 'dom-observed', retryable: false } : ok(true, 'EDIT_APPLIED') };
  }
  const content = contentOf(op, ctx.doc);
  if (op.type === 'keep-block-kind' && content.structured) throw ctx.fault('UNSUPPORTED_STRUCTURE', 'keep-block-kind keeps one block; use replace-block for several lines or structure');
  if (op.type === 'insert-after' || op.type === 'insert-before') {
    if (node === rootEl && !node.querySelector(BLOCKS)) throw ctx.fault('UNSUPPORTED_STRUCTURE', 'This editor has no separate blocks to insert between; edit the text instead');
    select(ctx, node, op.type === 'insert-after' ? 'end' : 'start'); await pause(); ctx.mark();
    // The empty paragraph is what the editor merges into the block at the caret, so the block
    // itself is left untouched and the content arrives as new blocks next to it.
    const html = op.type === 'insert-after' ? '<p></p>' + content.html : content.html + '<p></p>';
    paste(ctx, node, { html, text: content.text });
    const at = base + (op.type === 'insert-after' ? before.text.length : 0);
    return settle(rootText.slice(0, at) + content.text + rootText.slice(at), { forceRoot: true });
  }
  const whole = op.type === 'replace-block';
  if (whole) select(ctx, node); else select(ctx, node, a, b);
  await pause();
  ctx.mark();
  const start = whole ? 0 : a, end = whole ? before.text.length : b;
  if (!content.structured && (op.contentType || 'plain') === 'plain') ctx.doc.execCommand('insertText', false, op.text);
  else paste(ctx, node, { html: content.html, text: content.text });
  return settle(rootText.slice(0, base + start) + content.text + rootText.slice(base + end), { span: { start, end: start + content.text.length } });
}
return { snapshot, write, operations, blocks };
});
