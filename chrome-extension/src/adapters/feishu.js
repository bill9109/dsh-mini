(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else Object.defineProperty(root,'DSHAdapterFeishu',{value:api,configurable:true});})(globalThis,function(){
'use strict';
// Adapter-level records. panelLog lives in the kernel's script scope; guard in case it is absent.
const alog = (event, data) => { try { if (typeof panelLog === 'function') panelLog('adapter/feishu/' + event, data); } catch (e) {} };
/**
 * Feishu editor model adapter.
 *
 * It never touches the DOM: the MAIN-world bridge validates and performs the operation against the
 * editor's own content state, then reports the model revision it observed.
 */
function snapshot(ctx, t) {
  alog('snapshot/enter', { recordId: String(t.recordId).slice(-6) });
  return ctx.bridge({ version: 2, action: 'read', url: ctx.scope.url, recordId: t.recordId }).then(reply => {
    if (!reply?.ok || !reply.snapshot) { alog('snapshot/fail', { recordId: String(t.recordId).slice(-6), code: reply?.code || null, ok: false }); throw ctx.fault(reply?.code || 'ADAPTER_UNAVAILABLE', reply?.message || 'No editor response'); }
    alog('snapshot/ok', { recordId: String(t.recordId).slice(-6), kind: reply.snapshot.kind, chars: String(reply.snapshot.text || '').length, revision: String(reply.snapshot.revision || '').slice(0, 14) });
    return { ...reply.snapshot, adapter: 'feishu', verification: 'editor-model' };
  });
}
async function write(ctx, t, before, a, b, op) {
  ctx.mark();
  alog('write/enter', { recordId: String(t.recordId).slice(-6), op: op && op.type, contentType: op && op.contentType || 'plain', range: [a, b] });
  const raw = await ctx.bridge({ version: 2, action: 'edit', url: ctx.scope.url, recordId: t.recordId, expectedRevision: before.revision, start: a, end: b, operation: op });
  if (!raw) { alog('write/fail', { code: 'RESULT_UNKNOWN', ok: false }); return { after: null, result: { ok: false, code: 'RESULT_UNKNOWN', message: 'No editor response', modification: 'unknown', verification: 'none', retryable: false }, passthrough: true }; }
  const result = ctx.validateOutcome(raw);
  if (!result.ok) { alog('write/fail', { code: result.code, modification: result.modification, ok: false }); return { after: null, result, passthrough: true }; }
  alog('write/ok', { code: result.code, modification: result.modification, ok: true });
  return { after: { ...result.snapshot, adapter: 'feishu', verification: result.verification }, result };
}
return { snapshot, write };
});
