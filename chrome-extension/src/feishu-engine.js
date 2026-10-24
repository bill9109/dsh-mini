/* Versioned MAIN-world adapter. No module-loader scans, paste, DOM writes, deletion or guessed caret. */
(function (root) {
  'use strict';
  const VERSION = 2;
  const booleanMarks = ['bold', 'italic', 'underline', 'strikethrough'];
  const palette = { red: 'rgb(216,57,49)', pink: 'rgb(216,57,49)', orange: 'rgb(222,120,2)', yellow: 'rgb(220,155,4)', green: 'rgb(46,161,33)', blue: 'rgb(36,91,219)', purple: 'rgb(100,37,208)', gray: 'rgb(100,106,115)', grey: 'rgb(100,106,115)' };
  const highlights = { yellow: 'rgba(255,246,122,0.8)', red: 'rgba(251,191,188,0.8)', green: 'rgba(183,237,177,0.8)', blue: 'rgba(186,206,253,0.8)' };
  const fail = (code, message, extra = {}) => ({ ok: false, code, message, modification: 'not-modified', verification: 'none', retryable: false, ...extra });
  const wait = () => new Promise(r => setTimeout(r, 0));
  function hash(s) { let h=2166136261; for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);} return (h>>>0).toString(36); }
  function engine(recordId) {
    if (typeof recordId !== 'string' || !recordId) throw Error('Missing stable record ID');
    const bm = manager();
    const el = [...document.querySelectorAll('[data-record-id][data-block-id]')].find(e => e.getAttribute('data-record-id') === recordId) || null;
    // Resolve from the editor MODEL first. A long document is virtualised, so a block outside the
    // viewport has no DOM node at all - yet it is a legitimate target the caller reached through a
    // read (measured:29 mounted of32). Requiring the DOM would make those blocks readable but not
    // writable, which is exactly the "I cannot write below the table" gap.
    const models = Array.isArray(bm.allBlockModels) ? bm.allBlockModels : [];
    const model = models.find(m => (m?.recordId ?? m?.id ?? m?.blockId ?? m?.struct?.id) === recordId)
      || (el ? bm.getBlockModelByBlockId?.(Number(el.getAttribute('data-block-id'))) : null);
    if (!model) throw Error('Target block is unknown to the editor model');
    // The document title is not document content: it cannot be a write target. Type alone was not
    // enough - the title LINE is its own block whose record id is the ROOT record id, so that
    // identity is the rule, and it is checked before anything else can use this resolver.
    const rootId = bm.getRootRecordId ? bm.getRootRecordId() : null;
    if (model.type === 'page' || (rootId !== null && recordId === rootId)) {
      throw Object.assign(Error('The document title is not an editable block'), { code: 'UNSUPPORTED_TARGET' });
    }
    const ed = model.editor;
    const state = ed?.getContentState?.();
    const zoneId = model.zoneId;
    const zs = state && typeof state.getZoneState === 'function' ? state.getZoneState(zoneId) : null;
    if (!state || !zs || typeof zs.getContent !== 'function' || typeof zs.offsetToPoint !== 'function') throw Error('Unsupported editor content-state contract');
    const record = bm.getRecord(recordId) || model.struct?.record || null;
    const z = el ? (el.querySelector('.zone-container') || (el.matches('.zone-container') ? el : null)) : null;
    return { el, z, bm, model, state, zoneId, zs, record };
  }
  /** The facts both snapshot paths must agree on, or a ref's revision would not survive a re-read. */
  function blockFacts(fx) {
    // The MODEL is the authority on type. The DOM attribute reported the document title as "text"
    // while the model called it "page", which is how a write once landed on the title itself.
    const kind = fx.model?.type || (fx.el ? fx.el.getAttribute('data-block-type') : null) || 'text';
    const record = fx.record || fx.model?.struct?.record || null;
    const seq = record?.snapshot?.seq || 'none';
    const editable = Boolean(fx.model?.editor) && !record?.snapshot?.locked && !record?.snapshot?.hidden;
    return { kind, seq, editable };
  }
  function marks(attrs) {
    const m = {};
    for(const k of booleanMarks) m[k] = attrs?.[k] === 'true' || attrs?.[k] === true;
    m.color = typeof attrs?.textHighlight === 'string' && attrs.textHighlight ? attrs.textHighlight : null;
    m.highlight = typeof attrs?.textHighlightBackground === 'string' && attrs.textHighlightBackground ? attrs.textHighlightBackground : null;
    return m;
  }
  /**
   * Attributes this adapter manages, so they are the only ones an operation may change.
   * Everything else on a run must survive an edit untouched.
   */
  const MANAGED = new Set(['bold','italic','underline','strikethrough','textHighlight','textHighlightBackground','seq']);
  /** Every attribute outside the managed set must be identical on both sides. */
  function unmanagedPreserved(beforeRaw, afterRaw) {
    const left = beforeRaw || {}, right = afterRaw || {};
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      if (MANAGED.has(key)) continue;
      if (left[key] !== right[key]) return false;
    }
    return true;
  }
  /**
   * Same, over corresponding slices.
   *
   * The two slices need their OWN offsets: a replacement that changes length shifts every later
   * index, so comparing before[i] with after[i] compared unrelated characters and reported a
   * correct edit as an unmet postcondition. Only the overlapping tail is compared; a length change
   * beyond the range is already caught by the text equality check.
   */
  function slicePreserved(before, after, beforeFrom, afterFrom, count) {
    for (let i = 0; i < count; i++) if (!unmanagedPreserved(before[beforeFrom + i]?.raw, after[afterFrom + i]?.raw)) return false;
    return true;
  }
  /** Read one zone state. Shared by the DOM path and the outline path so both compute the SAME revision. */
  function readZone(zs) {
    const delta = zs && typeof zs.getContent === 'function' ? zs.getContent() : null;
    if (!Array.isArray(delta?.ops)) return { text:'',chars:[],boundaries:[0],runs:[],signature:[],complex:true,unverifiable:false };
    let text='',rawOffset=0,complex=false,unverifiable=false;
    const chars=[],boundaries=[],runs=[],signature=[];
    for(const op of delta.ops) {
      const attrs={};
      for(const k of Object.keys(op.attributes || {}).sort()) {
        const v=op.attributes[k];
        if(typeof v==='string'||typeof v==='boolean'||typeof v==='number'||v===null) attrs[k]=v;
        // A value we cannot read back cannot be proven preserved, so an edit must refuse rather
        // than claim it left something alone it never examined.
        else unverifiable=true;
      }
      if(typeof op.insert!=='string'){complex=true;rawOffset++;continue;}
      signature.push([op.insert,attrs]);
      if(attrs.lmkr){complex=true;rawOffset+=op.insert.length;continue;}
      const start=text.length, style=marks(attrs);
      for(let i=0;i<op.insert.length;i++) {boundaries.push(rawOffset+i);chars.push({c:op.insert[i],marks:style,raw:attrs});}
      text+=op.insert; rawOffset+=op.insert.length;
      runs.push({start,end:text.length,text:op.insert,marks:style});
    }
    boundaries.push(rawOffset);
    // The editor terminates each block with an internal newline. It is not editable text.
    if(text.endsWith('\n')) {text=text.slice(0,-1);chars.pop();boundaries.pop();}
    const filtered=runs.filter(x=>x.start<text.length).map(x=>({...x,end:Math.min(x.end,text.length),text:x.text.slice(0,Math.max(0,text.length-x.start))}));
    return {text,chars,boundaries,runs:filtered,signature,complex,unverifiable};
  }
  /** A block snapshot from one zone read. Both entry points must agree byte-for-byte on revision. */
  function snapshotOf(recordId, kind, editable, seq, zone) {
    const formats=[...booleanMarks,'color','highlight'];
    if(/^heading[1-9]$/.test(kind)) formats.push('autoNumber');
    // A block whose attributes cannot be read back advertises no operations at all, so the refusal
    // is visible when the target is read instead of only when an edit is attempted.
    const blocked=zone.complex||zone.unverifiable;
    const snapshot={recordId,kind,text:zone.text,runs:zone.runs,autoNumber:seq==='auto',editable,complex:zone.complex,unverifiable:zone.unverifiable,
      // Writes here only work through the editor's own command pipeline, which needs the editor to hold
    // the caret. That state was never exposed, so a caller could not tell whether a write was likely to
    // land or why one silently did nothing. It travels with every target read now.
    focus:(()=>{try{const active=document.activeElement;const inside=Boolean(fx.el&&active&&fx.el.contains(active));return {blockHoldsFocus:inside,activeTag:active?active.tagName:null,selectionCollapsed:(()=>{const s=getSelection();return s?s.isCollapsed:null;})()};}catch(e){return null;}})(),
    capabilities:{operations:blocked?[]:['replace-selection','insert-at-caret','replace-block','keep-block-kind','set-format'],contentTypes:['plain','markdown'],formats:blocked?[]:formats,clearFormats:[...booleanMarks,'color','highlight','autoNumber'],atomicCellReplacement:false}};
    snapshot.revision='fs-'+hash(JSON.stringify([recordId,kind,zone.signature,seq,editable]));
    return snapshot;
  }
  function capture(fx, recordId) {
    const zone=readZone(fx.zs);
    const {kind,seq,editable}=blockFacts(fx);
    return {snapshot:snapshotOf(recordId,kind,editable,seq,zone),chars:zone.chars,boundaries:zone.boundaries};
  }
  /**
   * Every block in the document, from the block manager rather than the DOM.
   *
   * A long document is virtualised: measured on a real document,29 blocks were mounted while the
   * manager held32. Enumerating the DOM would therefore show an incomplete outline and hide exactly
   * the blocks an instruction like "below the table" refers to. Atomic blocks carry no editor and
   * report no text, which is expected - not an error.
   */
  function manager() {
    const start = document.querySelector('.zone-container') || document.querySelector('[data-block-id]');
    if (!start) throw Error('Document is not mounted yet');
    const key = Object.keys(start).find(k => k.startsWith('__reactInternalInstance$') || k.startsWith('__reactFiber$'));
    let fiber = key ? start[key] : null, found = null;
    for (let n = 0; fiber && n < 200; n++, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (props) found = found || props.recursionProps?.blockManager || props.model?.blockManager;
    }
    if (!found) throw Error('Editor adapter unavailable');
    return found;
  }
  /** Model-derived snapshot for a block that may not be mounted at all. */
  function modelSnapshot(model) {
    // `id`/`recordId` live on the prototype, so Object.keys never showed them; try the same chain
    // the live probe resolved them with rather than assuming an own property.
    const recordId = model?.recordId ?? model?.id ?? model?.blockId ?? model?.struct?.id ?? model?.struct?.record?.id;
    if (typeof recordId !== 'string' || !recordId) return null;
    const kind = model.type || 'text';
    const state = model.editor?.getContentState?.();
    const zone = state && model.zoneId !== undefined && typeof state.getZoneState === 'function'
      ? readZone(state.getZoneState(model.zoneId)) : readZone(null);
    const facts = (() => { try { return blockFacts(engine(recordId)); } catch { 
      const record = model.struct?.record;
      return { kind, seq: record?.snapshot?.seq || 'none', editable: model.type !== 'page' && Boolean(model.editor) && !record?.snapshot?.locked && !record?.snapshot?.hidden };
    } })();
    // Two id spaces: recordId is the stable string a ref is built from, while struct.id and
    // struct.parent.id are numeric block ids. Both are needed to rebuild the tree.
    return { recordId, kind: facts.kind, editable: facts.editable, blockId: model.id ?? model.struct?.id ?? null,
      parentBlockId: model.struct?.parent?.id ?? null,
      snapshot: snapshotOf(recordId, facts.kind, facts.editable, facts.seq, zone), prefix: zone.text.slice(0, 120) };
  }
  function rangeAt(fx, before, start, end) {
    return {start:fx.zs.offsetToPoint(before.boundaries[start]),end:fx.zs.offsetToPoint(before.boundaries[end])};
  }
  function attributes(format) {
    const attrs={};
    for(const [key,value] of Object.entries(format)) {
      if(booleanMarks.includes(key)) attrs[key]=value?'true':'';
      else if(key==='color'||key==='highlight') {
        const map=key==='color'?palette:highlights;
        const val=value===null?'':map[value] || (/^#[0-9a-f]{6}$/i.test(value||'') ? value : null);
        if(val===null) throw Error('Unsupported color token: '+value);
        attrs[key==='color'?'textHighlight':'textHighlightBackground']=val;
      } else if(key!=='autoNumber') throw Error('Unsupported format '+key);
    }
    return attrs;
  }
  /**
   * Bounded, paged enumeration of every block, served from the block manager.
   * Returns the same revision a later write will be checked against, so a ref taken from the
   * outline is directly writable without a second round trip per block.
   */
  function list(request) {
    const bm = manager();
    const models = bm.allBlockModels;
    if (!Array.isArray(models)) throw Error('Block manager does not expose a model list');
    const rootRecordId = bm.getRootRecordId ? bm.getRootRecordId() : null;
    const all = [];
    for (const model of models) {
      const entry = modelSnapshot(model);
      if (entry) all.push(entry);
    }
    // Map the numeric block-id space onto record ids so the tree can be expressed in the ids refs use.
    const recordOfBlock = new Map();
    for (const entry of all) if (entry.blockId !== null) recordOfBlock.set(String(entry.blockId), entry.recordId);
    const parentOf = entry => entry.parentBlockId === null ? null : recordOfBlock.get(String(entry.parentBlockId)) ?? null;
    const depthOf = entry => { let d = 0, cur = entry; while (d < 12) { const p = parentOf(cur); if (!p) break; const next = all.find(x => x.recordId === p); if (!next) break; d += 1; cur = next; } return d; };
    const mode = typeof request.mode === 'string' ? request.mode : 'all';
    let items = all;
    // outline is a MAP, not content: only the top level, so "what comes after the table" is one
    // cheap call instead of paging through every cell bullet in the document.
    if (mode === 'outline') items = all.filter(entry => parentOf(entry) === null || parentOf(entry) === rootRecordId);
    if (mode === 'range') {
      const from = all.findIndex(entry => entry.recordId === request.at);
      if (from < 0) throw Error('range start is not a block of this document');
      const to = request.to ? all.findIndex(entry => entry.recordId === request.to) : all.length - 1;
      if (to < 0) throw Error('range end is not a block of this document');
      items = all.slice(from, Math.max(from, to) + 1);
    }
    const needle = typeof request.find === 'string' && request.find ? request.find : null;
    const described = items
      .filter(entry => !needle || entry.prefix.includes(needle))
      .map(entry => ({ recordId: entry.recordId, blockType: entry.kind, text: entry.prefix, editable: entry.editable,
        parentId: parentOf(entry), depth: depthOf(entry),
        revision: entry.snapshot.revision, capabilities: entry.snapshot.capabilities }));
    const limit = Number.isInteger(request.limit) ? Math.min(Math.max(request.limit, 1), 100) : 100;
    const offset = typeof request.cursor === 'string' && request.cursor ? Math.max(0, parseInt(request.cursor, 10) || 0) : 0;
    const window = described.slice(offset, offset + limit);
    const next = offset + window.length;
    return { ok: true, code: 'READ', modification: 'not-modified', verification: 'editor-model', retryable: false,
      mode, total: described.length, blocksInDocument: all.length, returned: window.length, truncated: next < described.length,
      ...(next < described.length ? { cursor: String(next) } : {}), items: window };
  }
  /**
   * Markdown in, a small whitelist of tags out. The model never authors HTML: it states intent in
   * markdown and this converts it, so the paste channel cannot carry script, iframe or styles.
   */
  function markdownToHtml(markdown) {
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const inline = s => esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
    const out = [];
    let list = null;
    const closeList = () => { if (list) { out.push('</' + list + '>'); list = null; } };
    for (const raw of String(markdown).split(/\r?\n/)) {
      const line = raw.replace(/\s+$/, '');
      const heading = /^(#{1,3})\s+(.*)$/.exec(line);
      const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
      const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (heading) { closeList(); const n = heading[1].length; out.push('<h' + n + '>' + inline(heading[2]) + '</h' + n + '>'); continue; }
      if (bullet || ordered) {
        const want = bullet ? 'ul' : 'ol';
        if (list !== want) { closeList(); out.push('<' + want + '>'); list = want; }
        out.push('<li>' + inline((bullet || ordered)[1]) + '</li>');
        continue;
      }
      if (!line.trim()) { closeList(); continue; }
      closeList();
      out.push('<p>' + inline(line) + '</p>');
    }
    closeList();
    return out.join('');
  }
  // The editor turns these key combinations into its own commands, which is the only mechanism
  // observed to change block structure through the real editing pipeline (state stays in sync).
  const STRUCTURE_KEYS = {
    ordered: { key: '7', code: 'Digit7', keyCode: 55, metaKey: true, shiftKey: true },
    bullet: { key: '8', code: 'Digit8', keyCode: 56, metaKey: true, shiftKey: true },
    heading1: { key: '1', code: 'Digit1', keyCode: 49, metaKey: true, altKey: true },
    heading2: { key: '2', code: 'Digit2', keyCode: 50, metaKey: true, altKey: true },
    heading3: { key: '3', code: 'Digit3', keyCode: 51, metaKey: true, altKey: true },
    heading4: { key: '4', code: 'Digit4', keyCode: 52, metaKey: true, altKey: true },
    text: { key: '0', code: 'Digit0', keyCode: 48, metaKey: true, altKey: true },
  };
  /** Focus a block the way a user does - the editor routes commands only from a real focus. */
  /** What the editor itself thinks is focused - .click() does not necessarily establish edit state. */
  function focusFacts() {
    try {
      const a = document.activeElement;
      const s = getSelection();
      const n = s && s.anchorNode;
      const el = n && (n.nodeType === 1 ? n : n.parentElement);
      const blk = el && el.closest ? el.closest('[data-record-id]') : null;
      return { activeTag: a ? a.tagName : null, activeBlockinfo: a && a.getAttribute ? String(a.getAttribute('blockinfo')).slice(0, 24) : null,
        caretBlock: blk ? String(blk.getAttribute('data-record-id')).slice(-6) : null, collapsed: s ? s.isCollapsed : null };
    } catch (e) { return { error: String(e.message || e).slice(0, 60) }; }
  }
  function focusBlock(fx) {
    // An unmounted block has no zone to click. Guard here so no caller can turn a missing mount
    // into a raw TypeError (that is what the log showed for a structure write on a heading).
    if (!fx || !fx.z) return false;
    try { fx.z.click(); } catch (e) {}
    try { (fx.z.querySelector('.ace-line') || fx.z).click(); } catch (e) {}
  }
  /**
   * Markdown in, a structure SPEC out. The model states intent in markdown; this maps it onto the
   * editor's own structure commands. Inline emphasis is dropped rather than guessed, and the result is
   * read back per block, so what actually landed is reported instead of assumed.
   */
  function markdownToItems(markdown) {
    const items = [];
    for (const raw of String(markdown || '').split(/\r?\n/)) {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim()) continue;
      let m;
      if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) { items.push({ kind: 'heading' + m[1].length, text: m[2].replace(/\*\*/g, '').replace(/`/g, '').trim() }); continue; }
      if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) { items.push({ kind: 'ordered', text: m[1].replace(/\*\*/g, '').replace(/`/g, '').trim() }); continue; }
      if ((m = /^\s*[-*+]\s+(.*)$/.exec(line))) { items.push({ kind: 'bullet', text: m[1].replace(/\*\*/g, '').replace(/`/g, '').trim() }); continue; }
      items.push({ kind: 'text', text: line.replace(/\*\*/g, '').replace(/`/g, '').trim() });
    }
    return items;
  }
  const normalize = s => String(s == null ? '' : s).replace(/[\u200b\u200c\u200d\ufeff\u00a0]/g, '').trim();
  /**
   * Type text through the editor's own input path, and CONFIRM it landed. Unconfirmed steps were the
   * source of every remaining flake: the editor drops an occasional input just like it drops commands,
   * so a write that is not read back can leave a heading with the wrong content.
   */
  async function typeIntoBlock(recordId, text) {
    const want = normalize(text);
    if (!want) return true;
    const matches = v => normalize(v).startsWith(want.slice(0, Math.min(12, want.length)));
    const readNow = () => { try { return capture(engine(recordId), recordId).snapshot.text; } catch (e) { return ''; } };
    // Idempotence first: re-typing text a block already holds churned the editor, and on a large
    // document that wedged its main thread so timers stopped firing.
    if (matches(readNow())) return true;
    let wrote = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      logStep('text#'+attempt, 'want='+String(text).slice(0,14)+' focus='+JSON.stringify(focusFacts()));
      const cur = engine(recordId);
      const line = cur.z.querySelector('.ace-line') || cur.z;
      cur.z.focus();
      try {
        const range = document.createRange();
        range.selectNodeContents(line);
        const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
      } catch (e) {}
      logStep('sel-set','range applied');
      await wait(60);
      logStep('wait60','resumed');
      logStep('insertText', 'before; focus='+JSON.stringify(focusFacts()));
      // Never type the same text into the same block twice: a second write on top of an unconfirmed
      // first one is what produced duplicated text and a stalled page.
      if (wrote) return false;
      document.execCommand('insertText', false, String(text));
      wrote = true;
      // The editor commits its model asynchronously, so an immediate readback is often stale and used
      // to be reported as failure. Poll with a bound instead.
      for (let poll = 0; poll < 12; poll++) {
        await wait(150);
        const seen = readNow();
        if (matches(seen)) { logStep('text/ok', { attempt, poll, observed: normalize(seen).slice(0, 24), ok: true }); return true; }
      }
      logStep('text/miss', { attempt, want: want.slice(0, 24), observed: normalize(readNow()).slice(0, 24), ok: false });
    }
    return false;
  }
  /**
   * Turn one block into the ordered sequence the caller asked for: each item becomes its own block,
   * split with the editor's Enter command and typed with the editor's own input path, and each block's
   * kind is applied with the editor's own shortcut. Every block is read back afterwards, so a partial
   * result is reported as partial instead of assumed.
   */
  /** The editor's own auto-numbering shows as a heading-order mark on the block. It IS readable, and
   * it is reported so callers do not have to assume they cannot see it. */
  function autoNumberedOf(recordId) {
    try {
      const m = manager().allBlockModels.find(x => x.recordId === recordId);
      const seq = m && m.struct && m.struct.record && m.struct.record.snapshot ? m.struct.record.snapshot.seq : undefined;
      if (seq !== undefined && seq !== null && seq !== '') return true;
    } catch (e) {}
    try {
      const el = document.querySelector('[data-record-id="' + recordId + '"]');
      return Boolean(el && /heading-order/.test(String(el.innerHTML || '').slice(0, 500)));
    } catch (e) { return null; }
  }
  /**
   * Remove the editor's own outline numbering from a block. There is no "numbering off" operation to
   * call, but Backspace at the very start of the line is what a user does, and it clears the block's
   * seq while leaving its kind and text alone (measured: seq auto -> undefined, heading2 kept).
   */
  async function clearNumbering(recordId) {
    if (!autoNumberedOf(recordId)) return true;
    for (let attempt = 0; attempt < 2; attempt++) {
      logStep('clearnum#'+attempt, 'block='+String(recordId).slice(-6)+' focus='+JSON.stringify(focusFacts()));
      const fx = engine(recordId);
      focusBlock(fx);
      await wait(220 + attempt * 200);
      const line = fx.z.querySelector('.ace-line') || fx.z;
      try {
        const r = document.createRange(); r.selectNodeContents(line); r.collapse(true);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      } catch (e) {}
      await wait(60);
      (document.activeElement || line).dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', keyCode: 8, bubbles: true, cancelable: true }));
      await wait(600);
      const stillNumbered = autoNumberedOf(recordId);
      logStep('clearnum/verdict', { attempt, block: String(recordId).slice(-6), stillNumbered, ok: !stillNumbered });
      if (!stillNumbered) return true;
    }
    return !autoNumberedOf(recordId);
  }
  async function restructure(recordId, items) {
    const list = (Array.isArray(items) ? items : []).filter(i => i && typeof i.text === 'string');
    if (!list.length) return fail('NOTHING_TO_DO', 'No structure items were given');
    const fx = engine(recordId);
    if (!fx.z) return fail('NOT_MOUNTED', 'The target block is not mounted, so it cannot be restructured', { modification: 'not-modified' });
    if (!capture(fx, recordId).snapshot.editable) return fail('READ_ONLY', 'Target is not editable');
    const typeMap = { ordered: 'ordered', bullet: 'bullet', heading1: 'heading1', heading2: 'heading2', heading3: 'heading3', heading4: 'heading4', text: 'text' };
    const produced = [];
    let currentId = recordId;
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (i > 0) {
        // Enter is the editor's own block split. The editor drops a command now and then, so the effect
        // is CONFIRMED (a new block must appear) and retried before anything else is attempted; a step
        // that did not happen is never treated as if it had.
        let fresh = [];
        for (let attempt = 0; attempt < 3 && !fresh.length; attempt++) {
          logStep('split#'+attempt, 'from='+String(currentId).slice(-6)+' focus='+JSON.stringify(focusFacts()));
          const cur = engine(currentId);
          focusBlock(cur);
          await wait(220 + attempt * 200);
          const line = cur.z.querySelector('.ace-line') || cur.z;
          try {
            const r = document.createRange(); r.selectNodeContents(line); r.collapse(false);
            const s = getSelection(); s.removeAllRanges(); s.addRange(r);
          } catch (e) {}
          await wait(50);
          const known = new Set(manager().allBlockModels.map(m => m.recordId));
          (document.activeElement || cur.z).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
          await wait(650 + attempt * 250);
          fresh = manager().allBlockModels.filter(m => !known.has(m.recordId));
          logStep('split/verdict', { attempt, created: fresh.length, newId: fresh.length ? String(fresh[0].recordId).slice(-6) : null, ok: fresh.length > 0 });
        }
        if (!fresh.length) return { ok: false, code: 'SPLIT_FAILED', modification: 'partial', verification: 'editor-model', retryable: false, produced,
          message: 'Could not split the target into another block after retries; ' + produced.length + ' block(s) were created.' };
        currentId = fresh[0].recordId;
      }
      const kind = typeMap[item.kind] || 'text';
      // KIND FIRST, then the text: typing through execCommand disturbs the caret, and a shortcut sent
      // right after a text write lands on the wrong focus and is dropped (measured: item 2 of 3 failed
      // consistently in that order while items 1 and 3 succeeded).
      if (kind !== 'text') {
        const res = await setStructureKind(currentId, kind);
        if (!res.ok) { produced.push({ recordId: currentId, kind: 'text', text: item.text, error: res.code }); continue; }
      }
      const textOk = await typeIntoBlock(currentId, item.text);
      // Applying a heading through the editor's shortcut can also switch on its auto-numbering; record
      // the state so the caller can turn it off deliberately instead of being surprised by 1. 2. 3..
      produced.push({ recordId: currentId, kind, text: item.text, textOk });
      produced.push({ recordId: currentId, kind, text: item.text, textOk });
    }
    // Numbering is cleared ONCE, at the end. Doing it per item re-focuses the block and moves the caret
    // away, which broke the next item's split and kind (measured: all three items were reported failed).
    // No step may depend on caret state left behind by an earlier step.
    const autoNumbered = [];
    for (const p of produced) {
      try {
        if (autoNumberedOf(p.recordId)) {
          autoNumbered.push({ recordId: p.recordId, kind: p.kind, text: p.text, cleared: await clearNumbering(p.recordId, p.kind) });
        }
      } catch (e) {}
    }
    const after = manager().allBlockModels.map(m => modelSnapshot(m)).filter(Boolean);
    const verified = produced.map(p => {
      const hit = after.find(a => a.recordId === p.recordId);
      return { recordId: p.recordId, wanted: p.kind, actual: hit ? hit.kind : null, text: p.text, effective: !!(hit && hit.kind === p.kind && String(hit.prefix).startsWith(p.text.replace(/\*\*/g, '').slice(0, 12))) };
    });
    const failed = verified.filter(v => !v.effective);
    let snapshot = null;
    try { snapshot = capture(engine(recordId), recordId).snapshot; } catch (e) { snapshot = null; }
    logStep('restructure/verdict', { failed: failed.length, produced: produced.length, numberingCleared: autoNumbered.filter(a => a.cleared).length, items: verified.map(v => v.actual + (v.effective ? '' : '!')), ok: failed.length === 0 });
    const out = { verification: 'editor-model', retryable: false, verified, produced, snapshot, autoNumbered };
    return failed.length
      ? Object.assign({ ok: false, code: 'PARTIAL_STRUCTURE', modification: 'partial', failed: failed.length }, out)
      : Object.assign({ ok: true, code: 'EDIT_APPLIED', modification: 'modified' }, out);
  }
  /** Change one block's structure kind and report the type that actually resulted. */
  async function setStructureKind(recordId, kind) {
    const keys = STRUCTURE_KEYS[kind];
    if (!keys) return fail('UNSUPPORTED_STRUCTURE', 'Unsupported structure kind: ' + String(kind));
    const fx = engine(recordId);
    const before = capture(fx, recordId);
    if (!before.snapshot.editable) return fail('READ_ONLY', 'Target is not editable');
    focusBlock(fx);
    await wait(250);
    const target = document.activeElement || fx.z;
    target.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, keys)));
    await wait(700);
    // The editor drops an occasional command. Retry a bounded number of times, re-focusing the block
    // and re-establishing the caret each time, because a stale focus is exactly what makes it fail.
    let after = capture(engine(recordId), recordId);
    for (let attempt = 1; attempt <= 3 && after.snapshot.kind !== kind; attempt++) {
      logStep('kind:'+kind+'#b'+attempt, 'kind='+after.snapshot.kind+' focus='+JSON.stringify(focusFacts()));
      await wait(300 + attempt * 200);
      const again = engine(recordId);
      focusBlock(again);
      await wait(200 + attempt * 150);
      const line2 = again.z.querySelector('.ace-line') || again.z;
      try {
        const r2 = document.createRange(); r2.selectNodeContents(line2); r2.collapse(false);
        const s2 = getSelection(); s2.removeAllRanges(); s2.addRange(r2);
      } catch (e) {}
      await wait(40);
      (document.activeElement || again.z).dispatchEvent(new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, keys)));
      await wait(650 + attempt * 300);
      after = capture(engine(recordId), recordId);
    }
    logStep('kind/verdict', { want: kind, got: after.snapshot.kind, ok: after.snapshot.kind === kind });
    if (after.snapshot.kind === kind) {
      return { ok: true, code: 'EDIT_APPLIED', modification: 'modified', verification: 'editor-model', retryable: false,
        structure: kind, kindBefore: before.snapshot.kind, kindAfter: after.snapshot.kind, snapshot: after.snapshot };
    }
    return fail('STRUCTURE_NOT_APPLIED', 'The editor did not apply ' + kind + ' (still ' + after.snapshot.kind + ')',
      { modification: after.snapshot.kind === before.snapshot.kind ? 'not-modified' : 'partial' });
  }
  /**
   * Build structure, then (optionally) remove the block it replaced.
   *
   * A paste INSERTS alongside the selection, it does not replace it, so replacing means creating the
   * new blocks and then deleting the one block the caller named. That single deletion is the only
   * irreversible step, it is verified against the revision the caller read, and it is attempted
   * once - reported honestly if it fails rather than retried blind. Blocks created by this call are
   * never left as a guessed cleanup target for a later call.
   */
  async function insertStructure(request) {
    const fx = engine(request.recordId);
    const before = capture(fx, request.recordId);
    if (request.expectedRevision !== before.snapshot.revision) return fail('REVISION_CONFLICT', 'Editor model changed; read again before editing');
    if (!before.snapshot.editable) return fail('READ_ONLY', 'Target is not editable');
    const html = markdownToHtml(request.text || '');
    if (!html) return fail('NOTHING_TO_DO', 'Nothing to insert');
    // The synthetic paste and setHTML were both measured wrong (one broke page/server sync, the other
    // created nothing). This entry point is closed so no reachable path can reach them.
    return fail('UNSUPPORTED_OPERATION', 'Use replace-block with contentType markdown: that path is the verified one', { modification: 'not-modified' });
    const bm = manager();
    const idsBefore = new Set(bm.allBlockModels.map(m => m.recordId));
    // A paste is delivered to whichever editor currently owns the caret; dispatched at a block that
    // is not the active editing zone it is discarded and the whole operation looks like a no-op.
    // So the caret is established first and then VERIFIED to be inside this block.
    // The block must be mounted to receive a paste at all. An unmounted block used to throw a raw
    // TypeError here; a clear refusal is the honest answer and cannot be mistaken for a write.
    if (!fx.z) return fail('NOT_MOUNTED', 'The target block is not mounted, so nothing can be inserted at it', { modification: 'not-modified' });
    if (fx.el && typeof fx.el.scrollIntoView === 'function') { fx.el.scrollIntoView({ block: 'center' }); await wait(150); }
    // No caret and no synthetic paste event are involved any more: setHTML is called directly.
    // Commit through the editor's OWN api. A synthetic paste mutates the content without going
    // through the transaction system, so the local model drifts from the server and Feishu has to
    // warn the user to copy everything before refreshing. setHTML deserialises then setContent(),
    // which is the pipeline the editor itself uses.
    const editor = fx.model?.editor;
    if (typeof editor?.setHTML !== 'function') {
      return fail('ADAPTER_UNAVAILABLE', 'This editor does not expose setHTML; refusing rather than mutating outside its transaction system');
    }
    const pasteOnce = async () => {
      // Unreachable by design: this whole function is superseded by restructure() and refuses below.
      await wait(0);
      return bm.allBlockModels.filter(m => !idsBefore.has(m.recordId)).map(m => modelSnapshot(m)).filter(Boolean)
        .map(c => ({ recordId: c.recordId, blockType: c.kind, text: c.prefix, revision: c.snapshot.revision }));
    };
    let created = await pasteOnce();
    // Measured on a real document: the FIRST write after a page load is silently dropped while the
    // next ones succeed (3 lines, 10 lines and 41 lines all landed once the editor had settled).
    // One bounded retry turns that from a user-visible failure into a slow success.
    if (!created.length) {
      const untouched = capture(engine(request.recordId), request.recordId).snapshot.text === before.snapshot.text;
      if (untouched) { await wait(600); created = await pasteOnce(); }
    }
    if (!created.length) {
      // A single-paragraph paste creates no block: it replaces the selected line in place. An empty
      // created list is therefore NOT evidence that nothing happened - the anchor's text decides.
      const settled = capture(engine(request.recordId), request.recordId);
      const changed = settled.snapshot.text !== before.snapshot.text;
      // The editor's observed behaviour is that a pasted structure REPLACES the selected line. That
      // is exactly what replace-with-structure asks for, and it is a failure for 'after' - reporting
      // it as success would tell the caller something was inserted when its target was overwritten.
      if (request.mode === 'replace-with-structure') {
        // Compare what the page RENDERS: strip block markers AND inline emphasis, or a correct write
        // whose expectation still carried ** would be reported as missing (the same projection bug
        // that was fixed once already in the range verification).
        const wanted = String(request.text || '').split('\n').map(l => l.replace(/^\s*(#{1,3}|[-*+]|\d+[.)])\s+/, '').replace(/\*\*/g, '').replace(/`/g, '').trim()).filter(Boolean);

        const seen = bm.allBlockModels.map(m => modelSnapshot(m)).filter(Boolean).map(c => c.prefix);
        const missing = wanted.filter(line => !seen.some(text => text.startsWith(line.slice(0, 12))));
        return missing.length
          ? { ok: false, code: 'PARTIAL_STRUCTURE', modification: changed ? 'partial' : 'not-modified', verification: 'editor-model', retryable: false, missing, replaced: request.recordId }
          : { ok: true, code: 'EDIT_APPLIED', modification: 'modified', verification: 'editor-model', retryable: false, replaced: request.recordId, targetText: settled.snapshot.text.slice(0, 200) };
      }
      if (changed) return fail('REPLACED_TARGET', 'The editor replaced the target instead of inserting after it; the content is not where this operation promised', { modification: 'partial' });
      return fail('NOT_RENDERED', 'The editor accepted nothing; the target is unchanged', { modification: 'not-modified' });
    }
    // 1) Verify FIRST, delete SECOND. A partial structure must never cost the caller the block it
    //    was replacing: if any requested line did not land, the original stays and we say so.
    if (request.mode === 'replace' || request.mode === 'replace-with-structure') {
      const wanted = String(request.text || '').split('\n')
        .map(l => l.replace(/^\s*(#{1,3}|[-*+]|\d+[.)])\s+/, '').replace(/\*\*/g, '').replace(/`/g, '').trim())
        .filter(Boolean);
      const seen = bm.allBlockModels.map(m => modelSnapshot(m)).filter(Boolean).map(c => c.prefix);
      const missing = wanted.filter(line => !seen.some(text => text.startsWith(line.slice(0, 12))));
      if (missing.length) {
        return { ok: false, code: 'PARTIAL_STRUCTURE', modification: 'partial', verification: 'editor-model', retryable: false,
          missing, created, removed: null,
          message: 'The new blocks were created, but not every requested line landed; the original block was left in place.' };
      }
    }
    // 2) Replace means the original goes away - it is the block the caller named, verified above.
    let removed = null;
    if (request.mode === 'replace' || request.mode === 'replace-with-structure') {
      try {
        // The type argument is an OPERATION NAME the data service understands, not a label of my
        // own: an invented name made every delete fail, which is what left the new blocks and the
        // original side by side. 'delete' is the name this API uses.
        await bm.applyTransaction('delete', tx => tx.delete(request.recordId));
      } catch (e) {
        return { ok: false, code: 'ANCHOR_NOT_REMOVED', modification: 'partial', verification: 'editor-model', retryable: false, created, removed: null,
          message: 'The new blocks were written, but the original block could not be removed: ' + String(e.message || e) };
      }
      await wait(200);
      if (!bm.allBlockModels.some(m => m.recordId === request.recordId)) removed = request.recordId;
      if (!removed) {
        return { ok: false, code: 'ANCHOR_NOT_REMOVED', modification: 'partial', verification: 'editor-model', retryable: false, created, removed: null,
          message: 'The new blocks were written, but the original block is still present.' };
      }
    }
    // 3) The caller's success path reads a post-write snapshot. Returning none threw inside the
    //    executor, which is what left the last run with blocks written and an unknown state.
    let snapshot = null;
    try { snapshot = capture(engine(removed ? created[0].recordId : request.recordId), removed ? created[0].recordId : request.recordId).snapshot; } catch (e) { snapshot = null; }
    return { ok: true, code: 'EDIT_APPLIED', modification: 'modified', verification: 'editor-model', retryable: false, created, removed, snapshot };
  }
  // The extension wrote no logs at all, so a failure could only be seen as a bare code. A small ring
  // buffer makes the internal steps readable (DSHFeishuV2.logs()) and travels with failure results.
  // The ring lives on window, not in this closure: the engine is re-injected per call, so a closure
  // buffer loses every record exactly when it is needed.
  // Persisted to sessionStorage: a reload (by the user, or by a probe navigating the tab) used to wipe
  // the only evidence of what happened. sessionStorage survives reloads within the tab.
  const RING = (() => {
    try {
      if (Array.isArray(root.__dshPanelLog)) return root.__dshPanelLog;
      const saved = root.sessionStorage && root.sessionStorage.getItem('__dshPanelLog');
      const restored = saved ? JSON.parse(saved) : [];
      return (root.__dshPanelLog = Array.isArray(restored) ? restored : []);
    } catch (e) { return []; }
  })();
  function persistRing() {
    try { root.sessionStorage.setItem('__dshPanelLog', JSON.stringify(RING.slice(-200))); } catch (e) {}
  }
  // Shaped after how dsh itself records events: append-only records, one per event, a namespaced
  // event name, structured data instead of prose, a level, and an id that ties a record to its run.
  const RUN_ID = 'run-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  function localTime() {
    const d = new Date();
    return [d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map(v => String(v).padStart(2, '0')).join(':') + '.' + String(d.getMilliseconds()).padStart(3, '0');
  }
  function logEvent(event, data, level) {
    try {
      const fields = (data && typeof data === 'object') ? data : { value: data == null ? null : String(data).slice(0, 200) };
      const name = String(event);
      const lv = level || (/miss|threw|fail|error|refused/.test(name) || fields.ok === false ? 'error' : 'info');
      RING.push({ t: localTime(), level: lv, run: RUN_ID, event: name, data: fields });
      while (RING.length > 400) RING.shift();
      persistRing();
    } catch (e) {}
  }
  function logStep(name, data) { logEvent('step/' + name, data); }
  async function run(request) {
    const started = Date.now();
    let out;
    try { out = await runInner(request); }
    catch (e) { out = fail('EDITOR_ERROR', String(e.message || e), { modification: 'unknown', verification: 'none' }); }
    logEvent((request && request.action) + (request && request.operation ? ':' + request.operation.type : ''), { code: out && out.code ? out.code : '?', ok: !!(out && out.ok), ms: Date.now() - started, run: RUN_ID }, out && out.ok === false ? 'error' : 'info');
    logEvent('run/end', { run: RUN_ID, action: request && request.action, ok: !!(out && out.ok), code: out && out.code ? out.code : null, ms: Date.now() - started });
    if (out && out.ok === false) out.recent = RING.slice(-8);
    return out;
  }
  async function runInner(request) {
    if(!request || request.version!==VERSION || !['read','edit','list','insert','structure','restructure'].includes(request.action)) return fail('PROTOCOL_MISMATCH','Expected editor adapter protocol v2');
    if(request.url!==location.href) return fail('PAGE_CHANGED','Document URL changed');
    if(request.action==='list') { try { return list(request); } catch(e) { return fail('ADAPTER_UNAVAILABLE',String(e.message||e)); } }
    if(request.action==='insert') return fail('UNSUPPORTED_OPERATION', 'This action is closed; use replace-block with contentType markdown', { modification: 'not-modified' });
    if(request.action==='structure') { try { return await setStructureKind(request.recordId, request.kind); } catch(e) { return fail('EDITOR_ERROR',String(e.message||e),{modification:'unknown',verification:'none'}); } }
    if(request.action==='restructure') { try { return await restructure(request.recordId, request.items); } catch(e) { return fail('EDITOR_ERROR',String(e.message||e),{modification:'unknown',verification:'none'}); } }
    // A whole-block replacement asked for as markdown is rendered into structured blocks - the one
    // case where an operation changes a block's TYPE. It is still just replace-block, with markdown.
    if(request.operation && request.operation.type==='replace-block' && request.operation.contentType==='markdown') {
      try {
        // The verified path: split with the editor's Enter, then apply each block's kind with the
        // editor's own shortcut and write its text, confirming every step. The synthetic paste and
        // setHTML paths are gone - both were measured to either break syncing or do nothing.
        const items=markdownToItems(request.operation.text);
        if(!items.length) return fail('NOTHING_TO_DO','No structure lines were given',{modification:'not-modified'});
        return await restructure(request.recordId, items);
      } catch(e) { return fail('EDITOR_ERROR',String(e.message||e),{modification:'unknown',verification:'none'}); }
    }
    let fx,before;
    try {fx=engine(request.recordId);before=capture(fx,request.recordId);} catch(e) {return fail(e.code||'ADAPTER_UNAVAILABLE',String(e.message||e));}
    if(request.action==='read') return {ok:true,code:'READ',modification:'not-modified',verification:'editor-model',retryable:false,snapshot:before.snapshot};
    const op=request.operation;
    if(request.expectedRevision!==before.snapshot.revision) return fail('REVISION_CONFLICT','Editor model changed; read again before editing');
    if(!before.snapshot.editable) return fail('READ_ONLY','Target is not editable');
    if(before.snapshot.complex) return fail('UNSUPPORTED_STRUCTURE','Embedded/marked content is not supported for mutation');
    if(before.snapshot.unverifiable) return fail('UNSUPPORTED_STRUCTURE','This block carries editor attributes that cannot be read back, so an edit could not prove it preserved them');
    const start=request.start,end=request.end;
    if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<start||end>before.snapshot.text.length) return fail('INVALID_RANGE','Invalid exact model offsets');
    if(!op || !before.snapshot.capabilities.operations.includes(op.type)) return fail('UNSUPPORTED_OPERATION','Unsupported model operation');
    if(op.type==='replace-selection'&&start===end) return fail('EMPTY_SELECTION','Replacing a selection requires a nonempty range');
    if(op.type==='insert-at-caret'&&start!==end) return fail('NOT_A_CARET','Insertion requires an explicit caret target');
    if(op.type==='set-format'&&start===end) return fail('EMPTY_SELECTION','Formatting requires a nonempty range');
    let attrs;
    try { if(op.type==='set-format') attrs=attributes(op.format||{}); } catch(e){return fail('UNSUPPORTED_FORMAT',e.message);}
    if(op.type==='set-format' && Object.hasOwn(op.format||{},'autoNumber')) {
      if(!/^heading[1-9]$/.test(before.snapshot.kind)||Object.keys(op.format).length!==1||start!==0||end!==before.snapshot.text.length) return fail('UNSUPPORTED_FORMAT','autoNumber requires a whole heading and a separate operation');
    }
    if(op.type!=='set-format' && (op.contentType!=='plain'||typeof op.text!=='string'||/[\r\n]/.test(op.text))) return fail('UNSUPPORTED_CONTENT','This Feishu adapter supports plain single-block text and explicit range formatting; multiline/Markdown replacement is not atomic and is disabled');
    // All validation and model reads precede the single synchronous model mutation.
    let submitted=false;
    try {
      const r=rangeAt(fx,before,start,end);
      submitted=true;
      if(op.type==='set-format'&&Object.hasOwn(op.format,'autoNumber')) {
        // Same rule as the delete below: the first argument is an operation name the data service
        // knows. The previous 'mini-panel:set-format' was invented here, so auto-numbering was never
        // actually applied. 'replace' is the operation this data service uses for attribute changes.
        await fx.bm.applyTransaction('replace',tx=>tx.replace(request.recordId,['seq'],op.format.autoNumber?'auto':'none'));
      } else if(op.type==='set-format') {
        await fx.state.setAttributes(r,attrs);
      } else {
        const inherited={};const style=before.chars[Math.min(start,before.chars.length-1)]?.marks;
        if(style) for(const key of booleanMarks) if(style[key]) inherited[key]='true';
        if(style?.color) inherited.textHighlight=style.color;
        if(style?.highlight) inherited.textHighlightBackground=style.highlight;
        await fx.state.replaceText(r,op.text,inherited);
      }
      await wait();
      fx=engine(request.recordId);
      const after=capture(fx,request.recordId);
      let verified=after.snapshot.kind===before.snapshot.kind;
      if(op.type==='set-format') {
        verified=verified&&after.snapshot.text===before.snapshot.text;
        for(let i=0;i<before.chars.length&&verified;i++) {
          const wanted={...before.chars[i].marks};
          if(i>=start&&i<end) for(const k of Object.keys(op.format)) {
            if(k==='autoNumber') continue;
            wanted[k]=k==='color'?(attrs.textHighlight||null):k==='highlight'?(attrs.textHighlightBackground||null):op.format[k];
          }
          verified=JSON.stringify(wanted)===JSON.stringify(after.chars[i]?.marks)
            // Attributes this operation does not manage must be untouched wherever they sit, so a
            // formatting edit can never quietly strip a link or an editor annotation.
            &&unmanagedPreserved(before.chars[i]?.raw, after.chars[i]?.raw);
        }
        if(Object.hasOwn(op.format,'autoNumber')) verified=verified&&after.snapshot.autoNumber===op.format.autoNumber;
      } else {
        verified=verified&&after.snapshot.text===before.snapshot.text.slice(0,start)+op.text+before.snapshot.text.slice(end);
        // Range-external characters AND every attribute on them must be identical - not only the
        // handful of fields this adapter manages. Comparing the whole attribute map is what covers
        // links, inline code and editor annotations without guessing what the editor calls them.
        const afterEnd=start+op.text.length;
        const head=Math.min(start,after.chars.length);
        const tail=Math.max(0,Math.min(before.chars.length-end,after.chars.length-afterEnd));
        verified=verified&&slicePreserved(before.chars,after.chars,0,0,head)
          &&slicePreserved(before.chars,after.chars,end,afterEnd,tail);
      }
      const changed=before.snapshot.revision!==after.snapshot.revision;
      return {ok:verified,code:verified?(changed?'EDIT_APPLIED':'NO_CHANGE'):'POSTCONDITION_FAILED',modification:changed?(verified?'modified':'partial'):'not-modified',verification:'editor-model',retryable:false,snapshot:after.snapshot,
        observed:{textUnchanged:before.snapshot.text===after.snapshot.text,rangeOutsideConfirmed:verified},message:verified?'Editor model confirmed the requested range operation.':'Observed state differs; do not repeat the write. Read and inspect the target.'};
    } catch(e){return fail('EDITOR_ERROR',String(e.message||e),{modification:submitted?'unknown':'not-modified',verification:'none'});}
  }
  Object.defineProperty(root,'DSHFeishuV2',{configurable:true,value:Object.freeze({version:VERSION,run,unmanagedPreserved,slicePreserved,markdownToHtml,
    // Readable without any Host wiring, which is exactly what was missing when diagnosing a failure.
    logs:n=>RING.slice(-(n||30))})});
})(globalThis);
