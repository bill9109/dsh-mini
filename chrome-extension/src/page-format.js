/**
 * MAIN-world half of the mini panel's formatting channel.
 *
 * Everything here needs the page's own objects: the editor engine lives behind the
 * React fiber attached to each block, and the colour tables live in the page's
 * webpack modules. An isolated content script cannot see either - expandos set by
 * the page are per-world - so this file is injected with world:"MAIN" and called
 * through chrome.scripting.executeScript, which also returns its result directly.
 *
 * Module ids drift between builds, so nothing is looked up by id: every module is
 * found by the shape it exports.
 */
(function () {
  'use strict';
  if (window.__dshPageFormat) return;

  var cache = { w: null, keys: null, consts: null, callout: null, emoji: undefined };

  function require_() {
    if (!window.__W) {
      try { window.webpackChunk.push([['dsh-panel'], {}, function (r) { window.__W = r }]); } catch (e) { return null; }
    }
    return window.__W || null;
  }

  /** Scan the page's module registry for the first module matching a shape. */
  function findModule(pred) {
    var req = require_();
    if (!req || !req.m) return null;
    var ids = Object.keys(req.m);
    for (var i = 0; i < ids.length; i++) {
      var mod = null;
      try { mod = req(ids[i]); } catch (e) { continue; }
      try { if (mod && pred(mod)) return mod; } catch (e) { /* not this one */ }
    }
    return null;
  }

  function colourModule() {
    if (!cache.w) cache.w = findModule(function (m) { return typeof m.dO === 'function' && typeof m.JI === 'function'; });
    return cache.w;
  }
  // The text/background selector table and the readable colour names live in two
  // different modules; looking for both in one object is what made the first version
  // fail to find either.
  function colourKeys() {
    if (!cache.keys) {
      cache.keys = findModule(function (m) {
        return m.y && typeof m.y === 'object' && m.y.Text !== undefined && m.y.Background !== undefined;
      });
    }
    return cache.keys;
  }
  function colourConstants() {
    if (!cache.consts) {
      cache.consts = findModule(function (m) {
        return m.CK && typeof m.CK === 'object'
          && Object.keys(m.CK).some(function (k) { return k.indexOf('COLOR_') === 0; });
      });
    }
    return cache.consts;
  }
  function calloutModule() {
    if (!cache.callout) cache.callout = findModule(function (m) { return m.fn && m.fn.BackgroundColor && m.Vy && m.Rh; });
    return cache.callout;
  }
  function emojiApi() {
    if (cache.emoji !== undefined) return cache.emoji;
    var mod = findModule(function (m) {
      if (!m.A || typeof m.A.getInstance !== 'function') return false;
      try {
        var api = m.A.getInstance();
        return !!(api && typeof api.getEmojiIdByNativeEmoji === 'function' && typeof api.getUnified === 'function');
      } catch (e) { return false; }
    });
    try { cache.emoji = mod ? mod.A.getInstance() : null; } catch (e) { cache.emoji = null; }
    return cache.emoji;
  }

  /** Case-insensitive name match against a table of constants. */
  function byName(table, token) {
    var want = String(token || '').toLowerCase().replace(/[^a-z]/g, '');
    if (!table || !want) return null;
    var names = Object.keys(table);
    for (var i = 0; i < names.length; i++) {
      if (names[i].toLowerCase().replace(/[^a-z]/g, '') === want) return table[names[i]];
    }
    return null;
  }

  /**
   * Resolve a colour by name.
   *
   * The readable names (COLOR_<NAME>_<SUFFIX>) live in the constants table while the
   * selector table maps those constants to css values, so the name is matched first
   * and the map is consulted with the constant - matching the map's own keys would
   * depend on them being strings.
   */
  // The editor's red is stored as PINK; accept the name a person would use.
  var COLOUR_ALIASES = { red: 'PINK', grey: 'GRAY', gray: 'GRAY', black: 'DEFAULT', default: 'DEFAULT' };

  function colourValue(map, consts, token, suffix) {
    if (!map || !consts || !consts.CK || typeof map.get !== 'function' || !token) return null;
    var want = String(token).toUpperCase();
    if (COLOUR_ALIASES[String(token).toLowerCase()]) want = COLOUR_ALIASES[String(token).toLowerCase()];
    var names = Object.keys(consts.CK);
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      if (name.indexOf('COLOR_') !== 0) continue;
      if (name.indexOf(want) < 0) continue;
      if (name.slice(-suffix.length) !== suffix) continue;
      var value = map.get(consts.CK[name]);
      if (value) return value;
    }
    return null;
  }

  function engineFor(el) {
    if (!el) return null;
    var keys = Object.keys(el).filter(function (k) { return k.indexOf('__reactInternalInstance$') === 0; });
    var fiber = keys.length ? el[keys[0]] : null;
    var out = { rec: null, ed: null, bm: null };
    var guard = 0;
    while (fiber && guard++ < 120) {
      var props = fiber.memoizedProps;
      if (props) {
        if (!out.rec && props.recursionProps) {
          out.rec = props.recursionProps;
          out.bm = props.recursionProps.blockManager || null;
        }
        if (!out.ed && props.model && props.model.editor) out.ed = props.model.editor;
      }
      if (out.rec && out.ed) break;
      fiber = fiber.return;
    }
    return out;
  }

  function blockElement(blockId) {
    if (blockId) return document.querySelector('[data-block-id="' + blockId + '"]');
    var active = document.querySelector('.zone-container.text-editor-focused') || document.querySelector('[data-block-id]');
    return active ? active.closest('[data-block-id]') || active : null;
  }

  function report(ok, code, message, extra) {
    var out = { ok: ok, code: code };
    if (message) out.message = message;
    if (extra) Object.keys(extra).forEach(function (k) { out[k] = extra[k]; });
    return out;
  }

  /**
   * Select what an engine command should apply to.
   *
   * A real selection is left exactly as it is: changing "these two words" must not grow into
   * the whole line. Only a collapsed caret, or an explicit scope:"block", selects the line.
   */
  function selectBlockLine(block, zone, scope) {
    if (!block || !zone) return false;
    var line = block.querySelector('.ace-line') || block;
    try { zone.focus({ preventScroll: true }); } catch (e) { /* the editor may ignore focus */ }
    var selection = getSelection();
    if (scope !== 'block' && selection && selection.rangeCount > 0 && !selection.isCollapsed) {
      var current = selection.getRangeAt(0).commonAncestorContainer;
      if (line.contains(current) || current === line) return true;
    }
    var range = document.createRange();
    range.selectNodeContents(line);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  function applyInlineColour(spec) {
    var block = blockElement(spec.blockId);
    if (!block) return report(false, 'TARGET_MOVED', '找不到目标块。');
    var zone = block.closest('.zone-container') || block;
    var fx = engineFor(zone);
    if (!fx.ed) return report(false, 'TARGET_MOVED', '拿不到这个块的编辑器。');
    selectBlockLine(block, zone, spec.scope);
    var w = colourModule();
    var keys = colourKeys();
    var consts = colourConstants();
    if (!w || !keys || !consts) return report(false, 'EDITOR_REJECTED', '页面的颜色表没有找到。');
    var isBackground = spec.op === 'highlight';
    var map = isBackground ? w.dO(keys.y.Background) : w.dO(keys.y.Text);
    var value = colourValue(map, consts, spec.token, isBackground ? '_BACKGROUND' : '_TEXT');
    if (!value) return report(false, 'EDITOR_REJECTED', '不认识的颜色名：' + spec.token);
    try {
      fx.ed.execCommand(isBackground ? 'textHighlightBackground' : 'textHighlight', { value: value });
    } catch (e) {
      return report(false, 'EDITOR_REJECTED', '编辑器拒绝了这次改色：' + (e && e.message));
    }
    return report(true, 'APPLIED', null, { applied: spec.op, token: spec.token, value: value });
  }

  function applyAutoNumber(spec) {
    var block = blockElement(spec.blockId);
    if (!block) return report(false, 'TARGET_MOVED', '找不到目标块。');
    var recordId = block.getAttribute('data-record-id');
    if (!recordId) return report(false, 'TARGET_MOVED', '这个块没有 recordId。');
    var fx = engineFor(block.closest('.zone-container') || block);
    var bm = fx.bm;
    if (!bm || typeof bm.applyTransaction !== 'function') return report(false, 'EDITOR_REJECTED', '拿不到 blockManager。');
    // 'none' clears the numbering; 'auto' turns it on. Verified live: after writing 'none'
    // the heading-order control disappears from the block.
    var value = spec.clear ? 'none' : 'auto';
    var done = false;
    bm.applyTransaction('page-format-seq', function (tx) {
      tx.replace(recordId, ['seq'], value);
      done = true;
    });
    return done ? report(true, 'APPLIED', null, { applied: 'autoNumber', value: value })
      : report(false, 'EDITOR_REJECTED', '自动编号没写进去。');
  }

  function applyCallout(spec) {
    var block = blockElement(spec.blockId);
    if (!block) return report(false, 'TARGET_MOVED', '找不到目标块。');
    var recordId = block.getAttribute('data-record-id');
    var fx = engineFor(block.closest('.zone-container') || block);
    var bm = fx.bm;
    if (!bm || !recordId) return report(false, 'EDITOR_REJECTED', '拿不到块或 blockManager。');
    var S = calloutModule();
    var w = colourModule();
    var fields = {};
    var api = emojiApi();
    if (spec.emoji && api) {
      var id = api.getEmojiIdByNativeEmoji(spec.emoji) || (api.getUnified && api.getUnified(spec.emoji) ? spec.emoji : null);
      if (id && api.getUnified) fields.emoji_id = id, fields.emoji_value = api.getUnified(id);
    }
    if (spec.token && S && w) {
      var bgMap = w.JI(S.fn.BackgroundColor);
      var bdMap = w.JI(S.fn.Border);
      var bgValue = byName(S.Vy, spec.token);
      if (bgValue && bgMap.get) fields.background_color = bgMap.get(bgValue);
      var borderValue = byName(S.Rh, spec.token.replace(/^light|^dark/i, ''));
      if (borderValue && bdMap && bdMap.light && bdMap.light.get) fields.border_color = bdMap.light.get(borderValue);
    }
    var names = Object.keys(fields);
    if (!names.length) return report(false, 'EDITOR_REJECTED', '没有可用的样式参数。');
    bm.applyTransaction('page-format-callout', function (tx) {
      names.forEach(function (key) { tx.replace(recordId, [key], fields[key]); });
    });
    return report(true, 'APPLIED', null, { applied: 'callout', fields: names });
  }


  /**
   * The record that owns a child record.
   *
   * The record states its own parent, so no traversal is needed - and this is not an
   * optimisation. Walking down from the root never reached blocks inside a table cell (their
   * children are not linked the way the walk assumes), so the lookup always failed there and
   * clearing a cell silently did nothing. Verified live: snapshot.parent_id on the cell's inner
   * block equals the cell record's own id.
   */
  function parentOfRecord(bm, targetRecordId) {
    try {
      var record = bm.getRecord(targetRecordId);
      var parent = record && record.snapshot && record.snapshot.parent_id;
      if (parent) return parent;
    } catch (e) { /* fall through to the walk */ }

    // Fallback for a record that does not carry parent_id: walk down from the root.
    var root = null;
    try { root = typeof bm.getRootRecordId === 'function' ? bm.getRootRecordId() : bm.rootRecordId; } catch (e2) { root = bm.rootRecordId; }
    if (!root) return null;
    var queue = [root];
    var seen = 0;
    while (queue.length && seen++ < 8000) {
      var id = queue.shift();
      var node = null;
      try { node = bm.getRecord(id); } catch (e3) { continue; }
      var children = node && node.snapshot && node.snapshot.children;
      if (!children || !children.length) continue;
      if (children.indexOf(targetRecordId) >= 0) return id;
      for (var i = 0; i < children.length; i++) queue.push(children[i]);
    }
    return null;
  }

  /**
   * Delete blocks by block id.
   *
   * Feishu's paste replaces the block it lands in but leaves the cell's other blocks
   * untouched, so writing new content into a cell that already had some left the old
   * blocks behind and the cell read as duplicated. Clearing them first is what makes
   * a write a replacement.
   */
  function removeBlocks(spec) {
    var ids = Array.isArray(spec.ids) ? spec.ids : [];
    if (!ids.length) return report(true, 'APPLIED', null, { removed: [] });
    var removed = [];
    var failed = [];
    ids.forEach(function (blockId) {
      var el = document.querySelector('[data-block-id="' + blockId + '"]');
      if (!el) { failed.push({ blockId: blockId, message: '找不到这个块' }); return; }
      var recordId = el.getAttribute('data-record-id');
      var fx = engineFor(el.closest('.zone-container') || el);
      var bm = fx.bm;
      if (!bm || !recordId) { failed.push({ blockId: blockId, message: '拿不到 blockManager 或 recordId' }); return; }
      var parent = null;
      try { parent = parentOfRecord(bm, recordId); } catch (e) { parent = null; }
      if (!parent) { failed.push({ blockId: blockId, message: '找不到父记录' }); return; }
      try {
        bm.applyTransaction('page-format-prune', function (tx) {
          var children = tx.get(parent).get('children');
          tx.replace(parent, ['children'], children.filter(function (id) { return id !== recordId; }));
        });
        removed.push(blockId);
      } catch (e) {
        failed.push({ blockId: blockId, message: String((e && e.message) || e) });
      }
    });
    var out = report(failed.length === 0, failed.length ? 'EDITOR_REJECTED' : 'APPLIED', null, { removed: removed, failed: failed });
    if (failed.length) out.message = '部分块没有删掉：' + failed[0].message;
    return out;
  }

  window.__dshPageFormat = function (spec) {
    try {
      if (!spec || typeof spec !== 'object') return report(false, 'EDITOR_REJECTED', '缺少格式化参数。');
      if (spec.op === 'highlight' || spec.op === 'color') return applyInlineColour(spec);
      if (spec.op === 'autoNumber') return applyAutoNumber(spec);
      if (spec.op === 'callout') return applyCallout(spec);
      if (spec.op === 'removeBlocks') return removeBlocks(spec);
      return report(false, 'EDITOR_REJECTED', '不认识的格式化操作：' + spec.op);
    } catch (error) {
      return report(false, 'EDITOR_REJECTED', String((error && error.message) || error));
    }
  };
})();