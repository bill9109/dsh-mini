/**
 * MAIN-world code-editor engine: CodeMirror 6 and Monaco.
 *
 * Both keep the document in a model the DOM only partly shows (lines are virtualized), so reads and
 * writes go through the editor's own API: EditorView.dispatch for CodeMirror, executeEdits for
 * Monaco. The isolated content script marks the editor element with data-dsh-code; DOM attributes
 * are the one thing both worlds share. Every write is read back from the model.
 */
(function () {
  'use strict';
  if (globalThis.DSHCodeV1) return;
  const MAX = 2000000;
  const fail = (code, message, extra) => Object.assign({ ok: false, code, message, modification: 'not-modified', verification: 'none', retryable: false }, extra || {});
  const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
  function cmView(el) {
    const content = el.matches('.cm-content') ? el : el.querySelector('.cm-content');
    // cmView up to CodeMirror 6.3x, cmTile after the view rewrite (measured on codemirror.net).
    const handle = content && (content.cmView || content.cmTile);
    let v = handle && (handle.view || handle.rootView && handle.rootView.view);
    if (!v && content) for (const k of Object.keys(content)) { const x = content[k]; if (x && x.view && x.view.state && typeof x.view.dispatch === 'function') { v = x.view; break; } }
    return v && v.state && typeof v.dispatch === 'function' ? v : null;
  }
  function monacoEditor(el) {
    const m = globalThis.monaco;
    if (!m || !m.editor || typeof m.editor.getEditors !== 'function') return null;
    return m.editor.getEditors().find(e => { const n = e.getContainerDomNode && e.getContainerDomNode(); return n && (n === el || n.contains(el) || el.contains(n)); }) || null;
  }
  function find(id) {
    const el = document.querySelector('[data-dsh-code="' + String(id).replace(/[^a-z0-9-]/gi, '') + '"]');
    if (!el) return { error: fail('STALE_TARGET', 'The code editor is gone') };
    const v = cmView(el);
    if (v) return { kind: 'codemirror', el, text: () => v.state.doc.toString(), editable: () => v.state.readOnly !== true && v.contentDOM.getAttribute('contenteditable') !== 'false',
      selection: () => { const s = v.state.selection.main; return { from: s.from, to: s.to }; },
      write: (from, to, insert) => v.dispatch({ changes: { from, to, insert }, userEvent: 'input.dsh' }) };
    const ed = monacoEditor(el);
    if (ed) { const model = ed.getModel(); if (!model) return { error: fail('ADAPTER_UNAVAILABLE', 'Monaco editor has no model') };
      return { kind: 'monaco', el, text: () => model.getValue(), editable: () => !(ed.getOption && globalThis.monaco.editor.EditorOption && ed.getOption(globalThis.monaco.editor.EditorOption.readOnly)),
        selection: () => { const s = ed.getSelection(); return s ? { from: model.getOffsetAt(s.getStartPosition()), to: model.getOffsetAt(s.getEndPosition()) } : { from: 0, to: 0 }; },
        write: (from, to, insert) => { const a = model.getPositionAt(from), b = model.getPositionAt(to); return ed.executeEdits('dsh-mini', [{ range: new globalThis.monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column), text: insert, forceMoveMarkers: true }]); } };
    }
    return { error: fail('UNSUPPORTED_EDITOR', 'This code editor does not expose an editing API to the page (CodeMirror 6 view or global monaco)') };
  }
  function snapshot(e) {
    const text = e.text();
    if (text.length > MAX) throw Object.assign(new Error('Document too large'), { code: 'TARGET_TOO_LARGE' });
    const editable = !!e.editable();
    return { kind: e.kind, text, editable, revision: 'code-' + hash(e.kind + '|' + text + '|' + editable),
      capabilities: { operations: editable ? ['replace-selection', 'insert-at-caret', 'replace-block', 'keep-block-kind'] : [], contentTypes: ['plain'], formats: [], clearFormats: [], atomicCellReplacement: false, scopes: ['target', 'document'] } };
  }
  async function run(spec) {
    try {
      if (!spec || spec.version !== 2 || spec.url !== location.href) return fail('PAGE_CHANGED', 'Document URL changed');
      const e = find(spec.editorId); if (e.error) return e.error;
      if (spec.action === 'read') return { ok: true, code: 'READ', modification: 'not-modified', verification: 'editor-model', retryable: false, snapshot: snapshot(e), selection: e.selection() };
      if (spec.action !== 'edit') return fail('PROTOCOL_MISMATCH', 'Unknown code engine action');
      const before = snapshot(e);
      if (spec.expectedRevision !== before.revision) return fail('REVISION_CONFLICT', 'Editor model changed; read again before editing');
      if (!before.editable) return fail('READ_ONLY', 'The editor is read-only');
      const { start, end } = spec, op = spec.operation;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > before.text.length) return fail('INVALID_RANGE', 'Invalid model offsets');
      if (!op || (op.contentType || 'plain') !== 'plain' || typeof op.text !== 'string') return fail('UNSUPPORTED_CONTENT', 'Code editors take plain text only');
      const expected = before.text.slice(0, start) + op.text + before.text.slice(end);
      e.write(start, end, op.text);
      await new Promise(r => setTimeout(r, 0));
      const after = snapshot(e), ok = after.text === expected;
      return { ok, code: ok ? 'EDIT_APPLIED' : 'POSTCONDITION_FAILED', modification: after.text === before.text ? 'not-modified' : ok ? 'modified' : 'partial', verification: 'editor-model', retryable: false, snapshot: after,
        observed: { rangeOutsideConfirmed: ok } };
    } catch (err) { return fail(err && err.code || 'EDITOR_ERROR', String(err && err.message || err), { modification: 'unknown' }); }
  }
  Object.defineProperty(globalThis, 'DSHCodeV1', { value: { run }, configurable: true });
})();
