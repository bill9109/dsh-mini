(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else Object.defineProperty(root,'DSHAdapterCode',{value:api,configurable:true});})(globalThis,function(){
'use strict';
const alog = (event, data) => { try { if (typeof panelLog === 'function') panelLog('code/' + event, data); } catch (e) {} };
/**
 * CodeMirror 6 / Monaco through the MAIN-world code engine. The whole document is the target text;
 * offsets are the editor model's own, never DOM offsets, because both editors virtualize lines.
 */
function snapshot(ctx, t) {
  return ctx.bridge({ version: 2, engine: 'code', action: 'read', url: ctx.scope.url, editorId: t.editorId }).then(reply => {
    if (!reply?.ok || !reply.snapshot) throw ctx.fault(reply?.code || 'ADAPTER_UNAVAILABLE', reply?.message || 'No editor response');
    alog('snapshot', { kind: reply.snapshot.kind, chars: reply.snapshot.text.length });
    return { ...reply.snapshot, adapter: 'code', verification: 'editor-model', selection: reply.selection };
  });
}
async function write(ctx, t, before, a, b, op) {
  if (/[\r\n]/.test(op.text) === false && op.type === 'keep-block-kind') { /* plain single line is fine */ }
  ctx.mark();
  const raw = await ctx.bridge({ version: 2, engine: 'code', action: 'edit', url: ctx.scope.url, editorId: t.editorId, expectedRevision: before.revision, start: a, end: b, operation: op });
  if (!raw) return { after: null, result: { ok: false, code: 'RESULT_UNKNOWN', message: 'No editor response', modification: 'unknown', verification: 'none', retryable: false }, passthrough: true };
  const result = ctx.validateOutcome(raw);
  if (!result.ok) return { after: null, result, passthrough: true };
  return { after: { ...result.snapshot, adapter: 'code', verification: 'editor-model' }, result };
}
return { snapshot, write };
});
