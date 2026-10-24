(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else Object.defineProperty(root,'DSHAdapterRichtext',{value:api,configurable:true});})(globalThis,function(){
'use strict';
// Adapter-level records; panelLog lives in the kernel scope and may be absent.
const alog = (event, data) => { try { if (typeof panelLog === 'function') panelLog('richtext/' + event, data); } catch (e) {} };
/** Generic contenteditable. A bounded single paragraph is the largest target this adapter edits. */
const operations = ['replace-selection', 'insert-at-caret', 'replace-block', 'keep-block-kind'];
function snapshot(ctx, t) {
  alog('snapshot/enter', { kind: (t.node && t.node.tagName || '').slice(0, 12) });
  const node = t.node;
  if (!node?.isConnected) throw ctx.fault('STALE_TARGET', 'Target node removed; replacement nodes are not guessed');
  const text = node.textContent || '', editable = node.isContentEditable;
  const base = { adapter: 'richtext', kind: node.tagName.toLowerCase(), text, editable, html: node.innerHTML,
    capabilities: { operations, contentTypes: ['plain'], formats: [], clearFormats: [], atomicCellReplacement: false } };
  alog('snapshot/exit', { kind: base.kind, chars: String(text || '').length, editable });
  return { ...base, revision: ctx.revision([text, base.html, editable]), verification: 'dom-observed' };
}
async function write(ctx, t, before, a, b, op, signal) {
  alog('write/enter', { op: op && op.type, contentType: op && op.contentType || 'plain', range: [a, b], chars: String(op && op.text || '').length });
  const node = t.node;
  if (/[\r\n]/.test(op.text) || node.querySelector('br,img,table,[contenteditable="false"]')) throw ctx.fault('UNSUPPORTED_STRUCTURE', 'Generic rich text supports only bounded single-line text edits');
  const range = ctx.plainRange(node, a, b, ctx.doc);
  node.focus({ preventScroll: true });
  const selection = ctx.doc.defaultView.getSelection();
  selection.removeAllRanges(); selection.addRange(range);
  if (signal?.aborted) throw ctx.fault('CANCELLED', 'Cancelled before commit');
  const check = await ctx.snapshot(t);
  if (check.revision !== before.revision) throw ctx.fault('REVISION_CONFLICT', 'Editor changed while selecting');
  ctx.mark();
  ctx.doc.execCommand('insertText', false, op.text);
  const after = await ctx.snapshot(t);
  const expected = before.text.slice(0, a) + op.text + before.text.slice(b), ok = after.text === expected;
  alog('write/exit', { code: ok ? 'EDIT_APPLIED' : 'POSTCONDITION_FAILED', ok, revision: String(after && after.revision || '').slice(0, 14) });
  return { after, result: { ok, code: ok ? 'EDIT_APPLIED' : 'POSTCONDITION_FAILED', modification: after.revision === before.revision ? 'not-modified' : ok ? 'modified' : 'partial', verification: 'dom-observed', retryable: false } };
}
return { snapshot, write, operations };
});
