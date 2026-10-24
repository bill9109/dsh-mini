(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else Object.defineProperty(root,'DSHTargetRegistry',{value:api,configurable:true});})(globalThis,function(){
'use strict';
/**
 * Target issuance and resolution.
 *
 * Kept apart from the executor because this is the security boundary: it decides WHICH thing an
 * edit may touch, and it owns the rule that an explicitly supplied unknown or expired ref never
 * falls back to the task's default target.
 */
class TargetRegistry {
  constructor({ id, now, fault }) { this.id = id; this.now = now; this.fault = fault; this.entries = new Map(); this.default = null; }
  clear() { this.entries.clear(); this.default = null; }
  issue(scope, desc, snapshot) {
    const ref = 'target-' + this.id();
    this.entries.set(ref, { ...desc, ref, taskId: scope.taskId, documentId: scope.documentId, url: scope.url, expires: this.now() + 600000, snapshot });
    if (this.entries.size > 512) for (const [key, value] of this.entries) if (value.expires < this.now() && key !== this.default) this.entries.delete(key);
    if (this.entries.size > 1024) throw this.fault('TOO_MANY_TARGETS', 'Start a new task');
    return ref;
  }
  resolve(scope, ref) {
    const key = ref === undefined ? this.default : ref;
    const target = this.entries.get(key);
    if (!target || target.expires < this.now() || target.taskId !== scope.taskId
      || target.documentId !== scope.documentId || target.url !== scope.url) {
      throw this.fault('STALE_TARGET', 'Unknown, expired or other-task target; no fallback permitted');
    }
    return target;
  }
}
return { TargetRegistry };
});
