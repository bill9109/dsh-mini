/* Canonical v2 wire validation. Copied byte-for-byte into the extension by sync-protocol.mjs. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.defineProperty(root, 'DSHPageProtocol', { value: api, configurable: true });
})(globalThis, function () {
  'use strict';
  const VERSION = 2;
  // Operations say WHAT happens; contentType says in what shape. Markdown may render into several
  // structured blocks, which is a property of the content, not a new operation to learn.
  const TYPES = ['replace-selection', 'insert-at-caret', 'replace-block', 'keep-block-kind', 'set-format'];
  const FORMATS = ['bold', 'italic', 'underline', 'strikethrough', 'color', 'highlight', 'autoNumber'];
  const MODIFICATIONS = ['not-modified', 'modified', 'partial', 'unknown'];
  const VERIFICATIONS = ['none', 'dom-observed', 'editor-model', 'persisted'];
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const object = o => o !== null && typeof o === 'object' && !Array.isArray(o);
  function failure(code, message, extra = {}) {
    return Object.assign({ ok: false, code, message, modification: 'not-modified', verification: 'none', retryable: false }, extra);
  }
  function keys(o, allowed) { return Object.keys(o).every(k => allowed.includes(k)); }
  // Only scopes that are actually implemented are advertised. A declared-but-unimplemented scope
  // silently fell back to the bound target, which is exactly the kind of quiet mismatch this
  // contract exists to prevent.
  // Vocabulary borrowed from the Feishu document tools, which a model already knows: outline is a
  // cheap map used to decide what to read next, range is the span between two blocks, keyword
  // searches the document. Nothing here is a name the caller has to learn from scratch.
  const SCOPES = ['target', 'outline', 'range', 'keyword'];
  const DETAILS = ['text', 'structure', 'format'];
  /**
   * Reading is a query, not a fixed response.
   *
   * Which scope the caller inspects is its own choice: reading has no side effects, so narrowing it
   * never protected anything - it only made the caller blind and forced a human to re-select. The
   * write boundary is unchanged: every location a read returns carries a page-issued ref, and only
   * those refs may be written through. Results are bounded and paged, like the built-in read tool.
   */
  function validateRead(args = {}) {
    // Only parameters with a real effect are accepted; an accepted-but-ignored parameter is how a
    // caller ends up believing it asked for something it never got.
    const allowed = ['targetRef', 'reason', 'at', 'to', 'scope', 'find', 'findText', 'limit', 'cursor'];
    if (!object(args) || !keys(args, allowed)) return failure('INVALID_ARGUMENT', 'page_read accepts ' + allowed.join(', ') + '.');
    const find = args.find !== undefined ? args.find : args.findText;
    // find/findText is the search term for whichever scope was asked for; it does NOT imply a
    // document-wide search. Only an explicit scope:'keyword' widens the search beyond the target.
    const scope = args.scope !== undefined ? args.scope : 'target';
    if (typeof scope !== 'string' || !SCOPES.includes(scope)) return failure('INVALID_SCOPE', 'scope must be one of ' + SCOPES.join(', ') + '.');
    if (scope === 'keyword' && (typeof find !== 'string' || !find)) return failure('INVALID_ARGUMENT', 'A keyword read needs find.');
    if (scope === 'range' && args.at === undefined) return failure('INVALID_ARGUMENT', 'A range read needs at as its starting ref.');
    if (find !== undefined && (typeof find !== 'string' || !find || find.length > 200)) return failure('INVALID_ARGUMENT', 'find must be 1..200 characters.');
    // 32 forced a second paged call on an ordinary 74-block document, so a plain outline of a
    // normal page now fits in one response; the 100 cap still bounds it.
    const limit = args.limit === undefined ? 100 : args.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return failure('INVALID_LIMIT', 'limit must be an integer from 1 to 100.');
    for (const key of ['targetRef', 'at', 'to', 'reason']) {
      const value = args[key];
      if (value === undefined) continue;
      if (typeof value !== 'string' || !value || value.length > 256) return failure('INVALID_TARGET', key + ' must be a non-empty ref this task issued.');
    }
    // Document-level scopes name no single target, so a target ref there is a contradiction.
    if (args.targetRef !== undefined && scope !== 'target') return failure('INVALID_ARGUMENT', 'scope ' + scope + ' reads the document, not a target; omit targetRef.');
    if (args.cursor !== undefined && (typeof args.cursor !== 'string' || args.cursor.length > 512)) return failure('INVALID_CURSOR', 'cursor must be the opaque value a previous read returned.');
    return { ok: true, value: { ...args, scope, limit, ...(find !== undefined ? { find } : {}) } };
  }
  function validateEdit(args) {
    if (!object(args) || !keys(args, ['targetRef', 'expectedRevision', 'operation'])) return failure('INVALID_ARGUMENT', 'Use targetRef?, expectedRevision and operation; no flat write fields.');
    if (own(args, 'targetRef') && (typeof args.targetRef !== 'string' || !args.targetRef || args.targetRef.length > 256)) return failure('INVALID_TARGET', 'targetRef must be issued by page_read.');
    if (typeof args.expectedRevision !== 'string' || !args.expectedRevision || args.expectedRevision.length > 256) return failure('REVISION_REQUIRED', 'Copy expectedRevision from the target revision returned by page_read or the initial snapshot.');
    const op = args.operation;
    if (!object(op) || !keys(op, ['type', 'text', 'contentType', 'format']) || !TYPES.includes(op.type)) return failure('INVALID_OPERATION', 'Unknown operation or fields; choose an explicit supported operation.');
    if (op.type === 'set-format') {
      if (own(op, 'text') || own(op, 'contentType')) return failure('INVALID_OPERATION', 'set-format never accepts text or contentType.');
      if (!object(op.format) || !Object.keys(op.format).length || !keys(op.format, FORMATS)) return failure('UNSUPPORTED_FORMAT', 'Supported formats: ' + FORMATS.join(', '));
      for (const [k, v] of Object.entries(op.format)) {
        if (['color', 'highlight'].includes(k)) {
          if (v !== null && (typeof v !== 'string' || !v || v.length > 80)) return failure('INVALID_FORMAT', k + ' must be a color token or null to clear.');
        } else if (typeof v !== 'boolean') return failure('INVALID_FORMAT', k + ' must be true or false.');
      }
      return { ok: true, value: { ...args, operation: { type: op.type, format: { ...op.format } } } };
    }
    if (own(op, 'format')) return failure('INVALID_OPERATION', 'Apply formatting separately with set-format; text operations do not have hidden formatting side effects.');
    if (typeof op.text !== 'string' || op.text.length > 20000) return failure('INVALID_ARGUMENT', 'Text operations require text (empty string is allowed), maximum 20000 characters.');
    const contentType = op.contentType === undefined ? 'plain' : op.contentType;
    if (!['plain', 'markdown'].includes(contentType)) return failure('INVALID_CONTENT_TYPE', 'contentType must be plain or markdown.');
    return { ok: true, value: { ...args, operation: { type: op.type, text: op.text, contentType } } };
  }
  function validateOutcome(value) {
    if (!object(value) || typeof value.ok !== 'boolean' || typeof value.code !== 'string' || !MODIFICATIONS.includes(value.modification) || !VERIFICATIONS.includes(value.verification)) return failure('INVALID_RESULT', 'Executor returned an invalid v2 result.', { modification: 'unknown' });
    if (value.retryable && value.modification !== 'not-modified') return failure('INVALID_RESULT', 'A partial or unknown write cannot be retried as a new edit.', { modification: 'unknown' });
    try {
      const encoded = JSON.stringify(value);
      if (encoded.length > 220000) return failure('RESULT_TOO_LARGE', 'Read a smaller target.', { modification: value.modification });
      return JSON.parse(encoded);
    } catch { return failure('INVALID_RESULT', 'Result must be lossless JSON.', { modification: 'unknown' }); }
  }
  return { VERSION, TYPES, FORMATS, MODIFICATIONS, VERIFICATIONS, failure, validateRead, validateEdit, validateOutcome };
});
