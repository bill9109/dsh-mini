(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else Object.defineProperty(root,'DSHAdapterInput',{value:api,configurable:true});})(globalThis,function(){
'use strict';
// Adapter-level records; panelLog lives in the kernel scope and may be absent.
const alog = (event, data) => { try { if (typeof panelLog === 'function') panelLog('input/' + event, data); } catch (e) {} };
/** Plain input and textarea. Offsets are the control's own value offsets. */
const operations = ['replace-selection', 'insert-at-caret', 'replace-block', 'keep-block-kind'];
function snapshot(ctx, t) {
  alog('snapshot/enter', { kind: (t.node && t.node.tagName || '').slice(0, 12) });
  const node = t.node;
  if (!node?.isConnected) throw ctx.fault('STALE_TARGET', 'Target node removed; replacement nodes are not guessed');
  const text = node.value, editable = !node.disabled && !node.readOnly;
  const base = { adapter: 'input', kind: node.tagName?.toLowerCase() || 'input', text, editable, inputType: node.type || '',
    capabilities: { operations, contentTypes: ['plain'], formats: [], clearFormats: [], atomicCellReplacement: false, scopes: ['target', 'document'] } };
  alog('snapshot/exit', { kind: base.kind, chars: String(text || '').length, editable });
  return { ...base, revision: ctx.revision([text, editable, node.type]), verification: 'dom-observed' };
}
async function write(ctx, t, before, a, b, op, signal) {
  alog('write/enter', { op: op && op.type, contentType: op && op.contentType || 'plain', range: [a, b], chars: String(op && op.text || '').length });
  const node = t.node, View = node.ownerDocument.defaultView;
  const expected = before.text.slice(0, a) + op.text + before.text.slice(b);
  node.focus({ preventScroll: true });
  if (!node.dispatchEvent(new View.InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: op.text }))) throw ctx.fault('EDITOR_REJECTED', 'Input handler rejected edit');
  const fresh = await ctx.snapshot(t);
  if (fresh.revision !== before.revision) throw ctx.fault('REVISION_CONFLICT', 'Input handler modified the value before commit', { modification: 'unknown' });
  if (signal?.aborted) throw ctx.fault('CANCELLED', 'Cancelled before commit');
  ctx.mark();
  node.setRangeText(op.text, a, b, 'end');
  node.dispatchEvent(new View.InputEvent('input', { bubbles: true, inputType: 'insertText', data: op.text }));
  const after = await ctx.snapshot(t), ok = after.text === expected;
  alog('write/exit', { code: ok ? 'EDIT_APPLIED' : 'POSTCONDITION_FAILED', ok, revision: String(after && after.revision || '').slice(0, 14) });
  return { after, result: { ok, code: ok ? 'EDIT_APPLIED' : 'POSTCONDITION_FAILED', modification: before.text === after.text ? 'not-modified' : ok ? 'modified' : 'partial', verification: 'dom-observed', retryable: false } };
}
return { snapshot, write, operations };
});
