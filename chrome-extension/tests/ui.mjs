// Deterministic Chromium regression tests: real content script, controlled transport.
import assert from 'node:assert/strict';
import { verifyContour } from './contour.mjs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Discover the checkout instead of pinning one machine's staging directory: those rotate.
const monorepo = process.env.DSH_MONOREPO ?? process.env.DSH_CHECKOUT ?? [join(homedir(), '.dsh/source/current'), join(homedir(), '.dsh/source')].find(c => existsSync(join(c, 'apps/web/package.json'))) ?? homedir();
const require = createRequire(join(monorepo, 'apps/web/package.json'));
const { chromium } = require('playwright');
const server = createServer(async (req, res) => {
  const url = (req.url ?? '').split('?')[0];
  const file = url.startsWith('/src/') ? url.slice(1) : 'tests/ui.html';
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8');
  res.end(await readFile(join(root, file)));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ channel: process.env.DSH_UI_CHANNEL ?? 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 900, height: 760 }, deviceScaleFactor: 2, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/tests/ui.html`);
  const ui = page.locator('#dsh-mini-panel');
  const el = id => ui.locator('#' + id);
  const section = ui.locator('section');
  // SVG retains full path precision; CSSOM serializes clip-path with rounded coordinates.
  const outline = locator => locator.locator(':scope > .contour path').getAttribute('d');
  const passes = [];
  const check = (name, value) => { assert.ok(value, name); passes.push(name); console.log('PASS ' + name); };
  const state = async expected => { await page.waitForFunction(value => document.getElementById('dsh-mini-panel').shadowRoot.querySelector('section').dataset.state === value, expected); };
  const screenshot = async name => {
    await page.waitForTimeout(350);
    const surfaces = await ui.evaluate(host => {
      const root = host.shadowRoot;
      const panel = root.querySelector('section');
      const marker = root.getElementById('marker');
      const owner = panel.hidden ? marker : panel;
      const selectors = panel.hidden ? '#marker' : '.ask,#collapse,#task,#menu,#status';
      const visible = [...root.querySelectorAll(selectors)].filter(node => node.getClientRects().length);
      return {
        filter: getComputedStyle(owner).filter,
        shadowCount: root.querySelectorAll('#shadow-surfaces .surface-shadow').length,
        blurs: [...root.querySelectorAll('#dsh-soft-shadow feGaussianBlur')].map(node => node.getAttribute('stdDeviation')).join(','),
        legacyShadow: visible.some(node => getComputedStyle(node).boxShadow !== 'none'),
        boxes: visible.map(node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }),
        // Stroke audit: what paints each hairline and whether the surface clips it.
        strokes: visible.map(node => {
          const r = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          const kind = node.id === 'marker' || node.id === 'collapse' ? 'circle' : node.id === 'task' || node.classList.contains('ask') ? 'capsule' : 'rounded';
          const border = style.borderTopColor.match(/[\d.]+/g).map(Number);
          const alpha = border.length > 3 ? border[3] : 1;
          // Who actually paints this surface's hairline: the SVG contour, a CSS
          // border, or nothing (a transparent overlay relying on a neighbour).
          const mechanism = node.querySelector(':scope > .contour') ? 'contour'
            : parseFloat(style.borderTopWidth) >= 0.5 && alpha > 0 ? 'border' : 'none';
          return { name: node.id || 'ask', kind, mechanism, stroked: mechanism !== 'none', overflow: style.overflow,
            cssBorder: parseFloat(style.borderTopWidth), borderAlpha: alpha,
            radius: kind === 'rounded' ? parseFloat(style.borderTopLeftRadius) : kind === 'capsule' ? (node.id === 'task' ? 28 : 20) : Math.min(r.width, r.height) / 2,
            x: r.x, y: r.y, width: r.width, height: r.height };
        }),
      };
    });
    check(name + ' shares DSH soft elevation without stacked box shadows',
      surfaces.filter === 'none' && surfaces.shadowCount > 0 && surfaces.blurs === '8,12' && !surfaces.legacyShadow);
    const shadowed = await page.screenshot({ path: join(root, 'artifacts', name + '.png') });
    await ui.evaluate(host => { host.shadowRoot.getElementById('elevation').style.visibility = 'hidden'; });
    let unshadowed;
    try { unshadowed = await page.screenshot(); }
    finally { await ui.evaluate(host => { host.shadowRoot.getElementById('elevation').style.removeProperty('visibility'); }); }
    const measured = await page.evaluate(async ({ on, off, boxes, strokes }) => {
      const decode = async data => {
        const bitmap = await createImageBitmap(await (await fetch('data:image/png;base64,' + data)).blob());
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close();
        return { width: canvas.width, height: canvas.height, data: ctx.getImageData(0, 0, canvas.width, canvas.height).data };
      };
      const a = await decode(on), b = await decode(off);
      const scale = devicePixelRatio;
      let darker = 0;
      for (const box of boxes) {
        // Sample outside painted bounds, including outside the scrolling section.
        for (const x of [box.x - 4, box.x + box.width + 4]) {
          for (let y = box.y + 8; y < box.y + box.height - 8; y += 2) {
            if (boxes.some(r => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height)) continue;
            const px = Math.round(x * scale), py = Math.round(y * scale);
            if (px < 0 || py < 0 || px >= a.width || py >= a.height) continue;
            const i = (py * a.width + px) * 4;
            if (a.data[i] + a.data[i + 1] + a.data[i + 2] < b.data[i] + b.data[i + 1] + b.data[i + 2]) darker++;
          }
        }
      }
      // Stroke audit runs on the shadow-free frame and only samples strictly inside
      // the boundary, so the page background can never masquerade as a hairline.
      const at = (x, y) => {
        const px = Math.round(x * scale), py = Math.round(y * scale);
        if (px < 0 || py < 0 || px >= b.width || py >= b.height) return null;
        const i = (py * b.width + px) * 4;
        return (b.data[i] + b.data[i + 1] + b.data[i + 2]) / 3;
      };
      const audit = [];
      for (const s of strokes) {
        const r = Math.max(1, Math.min(s.radius, s.width / 2, s.height / 2));
        // Walk inward from a boundary point: the darkest inside sample is the hairline.
        const probe = (ox, oy, dx, dy, from, to, fillFrom, fillTo) => {
          let darkest = 255, darkestAt = 0, fill = 0;
          for (let t = from; t <= to; t += 0.25) {
            const value = at(ox + dx * t, oy + dy * t);
            if (value === null) return null;
            if (value < darkest) { darkest = value; darkestAt = t }
          }
          for (let t = fillFrom; t <= fillTo; t += 0.25) fill = Math.max(fill, at(ox + dx * t, oy + dy * t) ?? 0);
          return { dip: fill - darkest, at: darkestAt, r };
        };
        const edges = [];
        const add = (label, points, dx, dy) => {
          const dips = points.map(([x, y]) => probe(x, y, dx, dy, 0.25, 2.5, 2.25, 5)).filter(Boolean);
          if (!dips.length) return;
          // Exactly one dark run at the mid-span proves a single, not doubled, hairline.
          const [mx, my] = points[Math.floor(points.length / 2)];
          const profile = [];
          for (let t = 0.25; t <= 4; t += 0.25) profile.push(at(mx + dx * t, my + dy * t) ?? 255);
          const fill = Math.max(...profile);
          let runs = 0, inRun = false;
          for (const value of profile) { const dark = value <= fill - 12; if (dark && !inRun) runs++; inRun = dark }
          edges.push({ label, worst: Math.min(...dips.map(d => d.dip)), samples: dips.length, runs });
        };
        const range = (from, by, to, step) => { const list = []; for (let v = from; v <= to; v += step) list.push(v); return to - from < step ? [...list, to] : list };
        if (s.kind !== 'circle') {
          const straightX = Math.max(2, s.width / 2 - r - 3), straightY = Math.max(2, s.height / 2 - r - 3);
          if (s.width > 2 * r + 6) add('top', range(s.x + r + 3, 0, s.x + s.width - r - 3, 3).map(x => [x, s.y]), 0, 1);
          if (s.width > 2 * r + 6) add('bottom', range(s.x + r + 3, 0, s.x + s.width - r - 3, 3).map(x => [x, s.y + s.height]), 0, -1);
          if (s.height > 2 * r + 6) add('left', range(s.y + r + 3, 0, s.y + s.height - r - 3, 3).map(y => [s.x, y]), 1, 0);
          if (s.height > 2 * r + 6) add('right', range(s.y + r + 3, 0, s.y + s.height - r - 3, 3).map(y => [s.x + s.width, y]), -1, 0);
        }
        // End caps / corners: cast rays from the arc centre and require the hairline
        // to sit in the outer 1.5px, which also covers the racetrack ends.
        const rays = [];
        const cast = (label, cx, cy, ux, uy) => {
          const result = probe(cx, cy, ux, uy, r - 2.5, r - 0.25, r - 5, r - 2.5);
          if (result) rays.push({ label, dip: result.dip, depth: r - result.at, r });
        };
        const radians = angle => angle * Math.PI / 180;
        if (s.kind === 'circle') {
          const cx = s.x + s.width / 2, cy = s.y + s.height / 2;
          for (const angle of [0, 45, 90, 135, 180, 225, 270, 315]) cast(String(angle), cx, cy, Math.cos(radians(angle)), Math.sin(radians(angle)));
        } else if (s.kind === 'capsule') {
          // Capsule ends are corner arcs centred at the rounded corners: above 2r the
          // end also has a straight edge, so a mid-height cap centre would miss them.
          // The arc spans 25-65 degrees off the vertical; 70 degrees stays on its blend.
          for (const ax of [-1, 1]) for (const ay of [-1, 1]) {
            const cx = s.x + (ax < 0 ? r : s.width - r), cy = s.y + (ay < 0 ? r : s.height - r);
            for (const angle of [25, 40, 55, 70]) cast(ax + ',' + ay + ':' + angle, cx, cy, ax * Math.sin(radians(angle)), ay * Math.cos(radians(angle)));
          }
        } else {
          const d = Math.SQRT1_2;
          for (const [ox, oy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) cast(ox + ',' + oy, s.x + (ox < 0 ? r : s.width - r), s.y + (oy < 0 ? r : s.height - r), ox * d, oy * d);
        }
        audit.push({ name: s.name, kind: s.kind, stroked: s.stroked, overflow: s.overflow, mechanism: s.mechanism, cssBorder: s.cssBorder, borderAlpha: s.borderAlpha,
          edges, rays, worstEdge: edges.length ? Math.min(...edges.map(e => e.worst)) : -1,
          maxRuns: edges.length ? Math.max(...edges.map(e => e.runs)) : 0,
          worstRay: rays.length ? Math.min(...rays.map(x => x.dip)) : -1,
          shallowRay: rays.length ? Math.min(...rays.map(x => x.depth)) : -1, r });
      }
      return { darker, audit };
    }, { on: shadowed.toString('base64'), off: unshadowed.toString('base64'), boxes: surfaces.boxes, strokes: surfaces.strokes });
    check(name + ' shadow renders outside surface bounds', measured.darker > 4);
    // Every painted hairline must be complete, single and unclipped; the tip surface
    // must stay stroke-free so no surface gains an extra line.
    for (const surface of measured.audit) {
      const label = name + ' stroke ' + surface.name;
      if (!surface.stroked) {
        // The tip surface is never stroked; overlay layers leaning on a neighbour
        // are skipped because that neighbour's hairline runs along their edge.
        if (surface.name === 'status') check(label + ' adds no extra hairline', surface.worstEdge <= 12 && surface.worstRay <= 12);
        continue;
      }
      if (surface.edges.length) {
        check(label + ' is continuous on every sampled edge', surface.worstEdge >= 12);
        check(label + ' paints exactly one hairline', surface.maxRuns === 1);
      }
      check(label + ' covers its arcs along the outer ' + surface.r + 'px', surface.worstRay >= 12 && surface.shallowRay <= 1.5);
      check(label + ' is not clipped by its own surface', surface.overflow !== 'hidden');
      check(label + ' does not stack two stroke mechanisms',
        surface.mechanism === 'contour' ? surface.borderAlpha === 0 : surface.borderAlpha > 0 && surface.cssBorder >= 0.5);
    }
    if (await section.isVisible()) await section.screenshot({ path: join(root, 'artifacts', name + '-panel.png') });
  };
  const fresh = async () => {
    await page.reload();
    await page.evaluate(() => {
      window.uiMessages = [];
      window.pendingUI = [];
      window.chrome.runtime.sendMessage = message => {
        window.uiMessages.push(message);
        if (message.type === 'desktop-open' || message.type === 'desktop-result') {
          return new Promise(resolve => window.pendingUI.push({ message, resolve }));
        }
        return Promise.resolve({ ok: true });
      };
      // The rewrite travels on a port, so the harness must speak the stream protocol too.
      window.pendingStream = null;
      window.chrome.runtime.connect = () => {
        const listeners = [];
        return {
          name: 'dsh-stream',
          onMessage: { addListener: fn => listeners.push(fn) },
          onDisconnect: { addListener: () => {} },
          disconnect: () => {},
          postMessage: message => { window.uiMessages.push({ type: 'stream', message }); window.pendingStream = { message, listeners }; },
        };
      };
    });
  };
  const select = async (id = 'doc') => {
    await page.locator('#' + id).evaluate(box => {
      box.focus();
      if (box instanceof HTMLTextAreaElement) box.setSelectionRange(0, 8);
      else { const range = document.createRange(); range.setStart(box.firstChild, 0); range.setEnd(box.firstChild, 7); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); }
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await el('marker').waitFor({ state: 'visible' });
  };
  const start = async () => { await select(); await el('marker').click(); };
  const submit = async (text = '改得更专业一些') => { await el('instruction').fill(text); await el('generate').click(); await state('starting'); };
  const resolve = async (reply = { ok: true, replacement: '建议完善此方案。' }, type = 'rewrite') => {
    await page.evaluate(({ reply, type }) => {
      const index = window.pendingUI.findIndex(p => p.message.type === type);
      if (index < 0) throw new Error('No pending ' + type);
      window.pendingUI.splice(index, 1)[0].resolve(reply);
    }, { reply, type });
  };
  const count = type => page.evaluate(type => window.uiMessages.filter(m => m.type === type).length, type);
  const resolveStream = async (reply = { ok: true, replacement: '建议完善此方案。' }) => {
    await page.evaluate(reply => {
      const pending = window.pendingStream;
      if (!pending) throw new Error('No pending stream');
      for (const listener of pending.listeners) listener({ type: 'ready', sessionId: 'ui-session' });
      for (const listener of pending.listeners) listener({ type: 'done', sessionId: 'ui-session', ...reply });
      window.pendingStream = null;
    }, reply);
  };
  await mkdir(join(root, 'artifacts'), { recursive: true });
  // Editors often blur themselves in a document capture listener before the
  // extension button's mousedown/click handlers can preserve the insertion point.
  for (const selected of [false, true]) {
    await fresh();
    await page.evaluate(() => {
      document.addEventListener('pointerdown', () => {
        const active = document.activeElement;
        if (active?.id === 'doc') active.blur();
      }, true);
    });
    await page.locator('#doc').evaluate((box, selected) => {
      box.focus(); box.setSelectionRange(2, selected ? 8 : 2);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    }, selected);
    await el('marker').waitFor({ state: 'visible' });
    const markerBounds = await el('marker').boundingBox();
    await page.mouse.click(markerBounds.x + markerBounds.width / 2, markerBounds.y + markerBounds.height / 2);
    await page.waitForTimeout(120);
    check('entry opens despite editor blur during pointerdown (' + (selected ? 'selection' : 'caret') + ')',
      await section.isVisible() && await el('instruction').evaluate(input => input.getRootNode().activeElement === input));
    await submit(); await resolveStream({ ok: true, replacement: '新内容' }); await state('complete');
    // The reply is display-only now: editing happens only through the page tools, so a reply must
    // never modify the document, and the panel keeps it as the preview instead.
    check('entry click preserves original target and the reply never writes (' + (selected ? 'selection' : 'caret') + ')',
      await page.locator('#doc').inputValue() === '这个方案需要进一步优化。' && await el('result').inputValue() === '新内容');
  }
  await fresh(); await select(); await screenshot('01-entry'); await el('marker').click();
  check('editing icon replaces the star, no voice control', await el('marker').locator('svg').count() === 1 && await ui.locator('[aria-label*=语音]').count() === 0);
  check('initial capsule has plus, input and send only', !(await el('collapse').isVisible()) && !(await el('task').isVisible()) && await el('generate').isDisabled());
  await el('instruction').fill('改得更专业一些');
  await screenshot('02-input');
  check('input has true circular ends and G2 joins', verifyContour(await outline(ui.locator('.ask')), 19.5));
  await el('instruction').evaluate(input => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })));
  check('Chinese composition Enter does not submit', await count('stream') === 0);
  await el('instruction').press('Enter'); await state('starting');
  check('submit clears input and immediately shows task card', await el('instruction').inputValue() === '' && await el('task').isVisible() && await el('task-title').textContent() === '改得更专业一些');
  await screenshot('03-starting');
  await state('thinking');
  await el('instruction').press('Enter');
  check('busy Enter does not duplicate request', await count('stream') === 1);
  await screenshot('04-thinking');
  await el('collapse').click();
  check('collapse keeps in-flight request and task card', await section.getAttribute('data-compact') === 'true' && await el('task').isVisible() && await count('cancel') === 0);
  await screenshot('05-collapsed');
  await resolveStream(); await state('complete');
  check('collapsed completion shows green check, preserves result without opening details', await el('complete').isVisible() && !(await el('preview').isVisible()) && await el('result').inputValue() === '建议完善此方案。');
  check('the collapsed card shows the result as one clamped line',
    await el('rendered').isVisible() && (await el('rendered').textContent()).includes('建议完善此方案。')
    && await el('rendered').evaluate(node => getComputedStyle(node).webkitLineClamp) === '1'
    && await el('task-message').isHidden());
  const foldedResultTop = await el('rendered').evaluate(node => node.getBoundingClientRect().top);
  const foldedTitleTop = await el('task-title').evaluate(node => node.getBoundingClientRect().top);
  await screenshot('06-complete');
  check('compact capsule retains circular ends and G2 joins', verifyContour(await outline(ui.locator('.ask')), 19.5));
  check('task card retains circular ends and G2 joins', verifyContour(await outline(el('task')), 27.5));
  await el('collapse').click();
  check('chevron hides the task without clearing it', !(await el('task').isVisible()) && await el('result').inputValue() === '建议完善此方案。');
  await el('collapse').click();
  // Let the entrance animation settle before comparing positions.
  await page.waitForTimeout(320);
  const cardTopFolded = await el('task').evaluate(node => node.getBoundingClientRect().top);
  await el('task-summary').click();
  check('completed task expands its result', await el('preview').isVisible());
  check('expanding only grows downward: the card does not jump',
    Math.abs((await el('task').evaluate(node => node.getBoundingClientRect().top)) - cardTopFolded) < 1.5, cardTopFolded);
  check('the title and the result text keep their position when expanding',
    Math.abs((await el('task-title').evaluate(node => node.getBoundingClientRect().top)) - foldedTitleTop) < 1.5
    && Math.abs((await el('rendered').evaluate(node => node.getBoundingClientRect().top)) - foldedResultTop) < 1.5);
  check('the expanded body is the same text, not a second copy',
    await el('task-message').isHidden() && (await el('rendered').textContent()).includes('建议完善此方案。')
    && (await ui.locator('#rendered').count()) === 1
    && await el('rendered').evaluate(node => getComputedStyle(node).webkitLineClamp) === 'none');
  await screenshot('07-result');
  await el('rendered').click();
  const resultFocus = await el('result').evaluate(node => ({ outline: getComputedStyle(node).outlineStyle, shadow: getComputedStyle(node).boxShadow, border: getComputedStyle(node).borderTopWidth, color: getComputedStyle(node).borderTopColor, background: getComputedStyle(node).backgroundColor }));
  // Chrome reports a 3px outline-width even when the style is none; only the
  // style decides whether a ring is painted, and the body paints no chrome at all.
  check('the editable result shows no focus ring or divider',
    resultFocus.outline === 'none' && resultFocus.shadow === 'none'
    && parseFloat(resultFocus.border) === 0 && resultFocus.background === 'rgba(0, 0, 0, 0)', resultFocus);
  await screenshot('13-result-focus');
  await el('result').evaluate(node => node.blur());
  check('expanded task preserves G2 at all straight-to-circle joins', verifyContour(await outline(el('task')), 27.5, false));
  check('the panel exposes no manual apply or copy controls', await el('replace').count() === 0 && await el('copy').count() === 0);
  // The reply is display-only: the document is untouched and the result stays a preview.
  check('reply is previewed without writing to the document',
    await page.locator('#doc').inputValue() === '这个方案需要进一步优化。' && await el('result').inputValue() === '建议完善此方案。');
  await el('edit').click(); await submit('再短一点');
  check('continuation still carries the original selection text', await page.evaluate(() =>
    window.uiMessages.filter(m => m.type === 'stream').at(-1).message.text === '这个方案需要进一步优化。'.slice(0, 8)));
  await resolveStream({ ok: true, replacement: '完善方案。' }); await state('complete');
  check('a second reply replaces the preview only',
    await el('result').inputValue() === '完善方案。' && await page.locator('#doc').inputValue() === '这个方案需要进一步优化。');
  await el('add').click(); await el('settings').click();
  check('connection settings has an honest menu entry', await count('options') === 1);

  await fresh(); await start(); await submit(); await el('collapse').click(); await el('edit').click();
  check('expand while busy keeps request running', await section.getAttribute('data-compact') === 'false' && await count('stream') === 1);
  await resolveStream({ ok: false, error: { message: '连接失败，请重试。' } }); await state('error');
  check('failure has no success mark and offers retry', !(await el('complete').isVisible()) && await el('retry').isVisible());
  await screenshot('08-error');
  await el('retry').click(); await state('starting');
  check('retry preserves original instruction', await count('stream') === 2 && await el('task-title').textContent() === '改得更专业一些');
  await el('add').click(); await el('cancel-task').click(); await state('error');
  await resolveStream();
  check('cancel ignores late response', await section.getAttribute('data-state') === 'error' && await count('cancel') === 1);

  await fresh(); await start(); await submit(); await el('add').click(); await el('close').click(); await resolveStream();
  check('close aborts and never reopens on stale response', !(await section.isVisible()) && await count('cancel') === 1);

  await fresh(); await select('editable'); await el('marker').click(); await submit(); await resolveStream(); await state('complete');
  
  check('contenteditable reply is previewed without writing',
    await page.locator('#editable').textContent() === '第二段内容也可以直接编辑。' && await el('result').inputValue() === '建议完善此方案。');

  await fresh();
  await page.locator('#readonly').evaluate(box => {
    const range = document.createRange(); range.setStart(box.firstChild, 0); range.setEnd(box.firstChild, 7);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.waitForTimeout(150);
  // A non-editable target may still show the entry (copying is legitimate), but it must never
  // start a task or a write. The kernel refuses READ_ONLY; this asserts the page-level outcome.
  const readOnlyState = await section.getAttribute('data-state'), readOnlyStreams = await count('stream');
  check('read-only target starts no task and stays untouched (' + readOnlyState + '/' + readOnlyStreams + ')',
    readOnlyStreams === 0
    && await page.locator('#readonly').textContent() === '这是一段只能复制、不能直接替换的文本。');

  await fresh();
  await page.locator('#blocks').evaluate(box => {
    box.focus(); const range = document.createRange(); range.setStart(box.firstChild.firstChild, 0); range.setEnd(box.lastChild.firstChild, 3);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await el('marker').click(); await el('instruction').fill('改得更专业一些'); await el('generate').click();
  await page.waitForFunction(() => document.getElementById('dsh-mini-panel').shadowRoot.querySelector('section').dataset.state === 'error');
  check('cross-block selection is refused instead of widened', (await el('task-message').textContent()).length > 0);

  await fresh(); await start(); await submit(); await resolveStream(); await state('complete');
  await page.locator('#doc').evaluate(box => { box.value += '页面新增内容'; });
  check('a reply never overwrites a document changed after the request',
    (await page.locator('#doc').inputValue()).endsWith('页面新增内容'));

  await fresh(); await start(); await submit();
  await page.locator('h1').click();
  check('click outside collapses without cancelling', await section.getAttribute('data-compact') === 'true' && await count('cancel') === 0);
  await resolveStream(); await state('complete'); await select('editable'); await el('marker').click();
  check('a new selection starts a clean interaction after completion', await section.getAttribute('data-state') === 'input' && (await el('selection-context').textContent()).includes('第二段内容'));

  await fresh(); await start(); await el('add').click();
  // The desktop capsule is not part of the v2 target protocol, so the handoff entry stays hidden
  // rather than opening a route that could write without a task-bound target.
  check('desktop handoff is unavailable under the v2 target protocol',
    !(await el('desktop').isVisible()) && await count('desktop-open') === 0);

  await fresh(); await page.setViewportSize({ width: 360, height: 560 });
  await page.locator('#doc').evaluate(box => { box.style.position = 'fixed'; box.style.right = '8px'; box.style.bottom = '8px'; box.style.width = '150px'; });
  await start(); await submit('请将这段文字改写成专业、清晰、简洁并保留所有原意的版本');
  await resolveStream({ ok: true, replacement: '这是很长的结果。'.repeat(200) }); await state('complete');
  await page.waitForTimeout(400);
  const bounds = await section.boundingBox();
  check('long result stays within narrow viewport near bottom-right', bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 360 && bounds.y + bounds.height <= 560);
  await screenshot('09-narrow');
  await page.setViewportSize({ width: 320, height: 480 }); await page.waitForTimeout(400);
  const resized = await section.boundingBox();
  check('resize reclamps the actual panel bounds', resized.x >= 0 && resized.y >= 0 && resized.x + resized.width <= 320 && resized.y + resized.height <= 480);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  check('reduced motion disables task animation', await el('task').evaluate(node => getComputedStyle(node).animationName) === 'none');
  await fresh(); await start(); await submit();
  await page.addScriptTag({ content: await readFile(join(root, 'src/content.js'), 'utf8') });
  check('reinjection disposes prior UI and cancels its task', await page.locator('#dsh-mini-panel').count() === 1 && await count('cancel') === 1);
  await page.setViewportSize({ width: 900, height: 760 });
  const caret = async (id = 'doc', at = 2) => {
    await page.locator('#' + id).evaluate((box, at) => {
      box.focus();
      if (box instanceof HTMLTextAreaElement || box instanceof HTMLInputElement) box.setSelectionRange(at, at);
      else { const range = document.createRange(); range.setStart(box.firstChild || box, box.firstChild ? at : 0); range.collapse(true); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); }
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    }, at);
    await el('marker').waitFor({ state: 'visible' });
  };
  await fresh(); await caret();
  check('focused caret offers generation without selecting text', await el('marker').getAttribute('data-mode') === 'insert');
  await el('marker').waitFor({ state: 'hidden', timeout: 5000 });
  await page.evaluate(() => document.dispatchEvent(new Event('selectionchange'))); await page.waitForTimeout(100);
  check('caret hint expires after four seconds and stays dismissed on incidental events', !(await el('marker').isVisible()));
  await caret(); await page.locator('#doc').press('a'); await page.waitForTimeout(100);
  check('typing immediately hides the caret hint', !(await el('marker').isVisible()));
  await page.locator('#doc').press('ArrowLeft'); await page.waitForTimeout(100);
  check('cursor movement after typing does not nag with another hint', !(await el('marker').isVisible()));
  await select();
  check('explicit text selection after typing still offers rewrite', await el('marker').getAttribute('data-mode') === 'rewrite');
  await page.locator('h1').click(); await page.waitForTimeout(100);
  check('clicking blank page content removes a selection icon', !(await el('marker').isVisible()));

  await fresh(); await caret(); await page.locator('h1').click(); await page.waitForTimeout(100);
  check('losing input focus removes the caret icon without waiting for expiry', !(await el('marker').isVisible()));
  await caret(); await page.locator('#doc').evaluate(box => {
    box.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    box.setSelectionRange(0, 2); document.dispatchEvent(new Event('selectionchange'));
  }); await page.waitForTimeout(100);
  check('IME composition hides the icon even when provisional text is selected', !(await el('marker').isVisible()));
  await page.locator('#doc').evaluate(box => { box.setSelectionRange(2, 2); box.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); });
  await page.waitForTimeout(100);
  check('finishing IME input does not re-show the caret hint', !(await el('marker').isVisible()));

  await fresh(); await caret(); await el('marker').click();
  check('opening generation preserves the insertion point across editor blur', await section.getAttribute('data-mode') === 'insert' && (await el('selection-context').textContent()).includes('当前光标'));
  await submit('写一段欢迎新同事加入团队的话');
  check('generation request uses the instruction without sending surrounding editor text', await page.evaluate(() => {
    const message = window.uiMessages.find(m => m.type === 'rewrite');
    return message.instruction === '写一段欢迎新同事加入团队的话' && message.text === '' && message.mode === 'insert';
  }));
  await resolveStream({ ok: true, replacement: '欢迎加入团队！' }); await state('complete');
  check('generation mode is exposed on the send control', await el('generate').getAttribute('title') === '生成段落');
  
  check('generation reply is previewed without inserting',
    await page.locator('#doc').inputValue() === '这个方案需要进一步优化。' && await el('result').inputValue() === '欢迎加入团队！');

  await fresh(); await caret('editable', 3); await el('marker').click(); await submit('写一句欢迎语');
  await resolveStream({ ok: true, replacement: '欢迎！' }); await state('complete'); 
  check('contenteditable generation reply is previewed without inserting',
    await page.locator('#editable').textContent() === '第二段内容也可以直接编辑。' && await el('result').inputValue() === '欢迎！');
  await fresh(); await page.locator('#editable').evaluate(box => { box.textContent = ''; });
  await caret('editable', 0); await el('marker').click(); await submit('写一句开场白');
  await resolveStream({ ok: true, replacement: '大家好。' }); await state('complete'); 
  check('an empty contenteditable still shows the generated preview',
    await page.locator('#editable').textContent() === '' && await el('result').inputValue() === '大家好。');

  await fresh(); await caret(); await el('marker').click(); await submit();
  await page.locator('#doc').evaluate(box => { box.value += '用户新写的文字'; });
  await resolveStream(); await state('complete'); await page.waitForTimeout(100);
  check('a reply cannot overwrite text typed while generating', (await page.locator('#doc').inputValue()).endsWith('用户新写的文字'));

  await fresh(); await caret(); await el('marker').click(); await page.locator('h1').click(); await page.waitForTimeout(150);
  check('an unused composer leaves no compact icon after clicking blank space', !(await section.isVisible()) && !(await el('marker').isVisible()));
  await fresh(); await select('readonly');
  await page.evaluate(() => {
    const button = document.createElement('button'); button.id = 'other-control'; button.textContent = 'Other control'; document.body.appendChild(button); button.focus();
  }); await page.waitForTimeout(100);
  // Simulate pointer activation while preserving the browser's old DOM selection.
  await page.locator('#other-control').dispatchEvent('pointerdown'); await page.locator('#other-control').dispatchEvent('mouseup'); await page.waitForTimeout(100);
  check('retained DOM selection after clicking another control does not revive an icon', !(await el('marker').isVisible()));
  await fresh(); await page.locator('#doc').evaluate(box => { box.readOnly = true; box.focus(); box.setSelectionRange(2, 2); }); await page.waitForTimeout(100);
  check('read-only caret has no generation icon', !(await el('marker').isVisible()));
  await fresh(); await page.evaluate(() => {
    const input = document.createElement('input'); input.type = 'password'; document.body.appendChild(input); input.focus();
  }); await page.waitForTimeout(100);
  check('password field never offers a generation icon', !(await el('marker').isVisible()));
  await fresh(); await caret(); await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await page.waitForTimeout(100);
  check('window blur removes transient icon', !(await el('marker').isVisible()));

  await fresh();
  await page.evaluate(() => {
    const previous = window.chrome.runtime.sendMessage;
    let binding = { sessionId: 'existing-session' };
    window.chrome.runtime.sendMessage = async message => {
      if (message.type === 'session-state') return { ok: true, binding };
      if (message.type === 'session-new') { binding = { sessionId: 'new-session' }; return { ok: true, binding }; }
      if (message.type === 'session-list') return { ok: true, sessions: [{ sessionId: 'chosen-session', title: 'Existing document' }, { sessionId: 'busy-session', busy: true }] };
      if (message.type === 'session-bind') { binding = { sessionId: message.sessionId }; return { ok: true, binding }; }
      if (message.type === 'session-detach') { binding = null; return { ok: true, binding }; }
      return previous(message);
    };
  });
  await start(); await el('add').click();
  check('opening the menu shows restored session binding', (await el('session-label').textContent()).includes('existing-session'));
  await el('session-new').click();
  await page.waitForFunction(() => document.getElementById('dsh-mini-panel').shadowRoot.getElementById('session-label').textContent.includes('new-session'));
  check('explicit new session changes the binding', (await el('session-label').textContent()).includes('new-session'));
  await el('session-list').click(); await el('session-picker').waitFor({ state: 'visible' });
  await screenshot('10-session-menu');
  await page.setViewportSize({ width: 360, height: 640 });
  await screenshot('11-session-menu-narrow');
  check('session picker stays within narrow viewport', await section.evaluate(node => { const r = node.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; }));
  await page.setViewportSize({ width: 1000, height: 800 });
  check('occupied sessions cannot be selected', await el('session-select').locator('option[value="busy-session"]').isDisabled());
  await el('session-select').selectOption('chosen-session'); await el('session-bind').click();
  await el('session-picker').waitFor({ state: 'hidden' });
  check('binding an existing session updates the menu', (await el('session-label').textContent()).includes('chosen-session'));
  await el('session-detach').click(); await el('session-detach').waitFor({ state: 'hidden' });
  check('detaching does not delete the session', (await el('session-label').textContent()).includes('尚未绑定'));
  await el('add').click(); await submit(); await el('add').click();
  check('session mutation is disabled during a rewrite', await el('session-new').isDisabled() && await el('session-list').isDisabled());
  await resolveStream(); await state('complete');
  // Long result in a narrow viewport: the folded capsule must stay a clean pill.
  await fresh();
  await page.setViewportSize({ width: 360, height: 640 });
  await start(); await submit();
  await resolveStream({ ok: true, replacement: '档位说明：《季度规划》，没有选区文字，也没有任何表格数据；如果你把表格贴出来，我就能帮你写这段插入内容。样例：第一行是表头，第二行是数据。' });
  await state('complete');
  await el('task-summary').click(); await page.waitForTimeout(350);
  const foldedLong = await ui.evaluate(host => {
    const root = host.shadowRoot;
    const card = root.getElementById('task').getBoundingClientRect();
    const rendered = root.getElementById('rendered');
    const mark = root.getElementById('complete').getBoundingClientRect();
    return { height: Math.round(card.height), clamp: getComputedStyle(rendered).webkitLineClamp, markLeft: Math.round(mark.left), textRight: Math.round(rendered.getBoundingClientRect().right),
      lines: rendered.getBoundingClientRect().height, background: getComputedStyle(root.getElementById('task')).backgroundColor,
      overflow: rendered.scrollHeight - rendered.clientHeight };
  });
  check('a long result still folds to the 56px capsule with one clamped line',
    foldedLong.height === 56 && foldedLong.clamp === '1' && Math.round(foldedLong.lines) <= 26, foldedLong);
  check('the result card is opaque so the page cannot bleed through',
    foldedLong.background === 'rgb(255, 255, 255)', foldedLong);
  check('the clamped line stops before the completion mark',
    foldedLong.textRight <= foldedLong.markLeft + 1, foldedLong);
  await screenshot('16-narrow-long-folded');
  await page.setViewportSize({ width: 900, height: 760 });

  // Every way of collapsing must land on the initial capsule, text truncation
  // included: initial fold, fold after expanding, and fold after editing.
  await fresh(); await start(); await submit();
  await resolveStream({ ok: true, replacement: '档位说明：《季度规划》，没有选区文字，也没有任何表格数据。样例：第一行是表头。' });
  await state('complete');
  const capsuleState = () => ui.evaluate(host => {
    const root = host.shadowRoot;
    const card = root.getElementById('task').getBoundingClientRect();
    const rendered = root.getElementById('rendered');
    const style = getComputedStyle(rendered);
    const box = rendered.getBoundingClientRect();
    return [Math.round(card.height), rendered.hidden, root.getElementById('result').hidden, style.webkitLineClamp,
      style.overflow, style.margin, Math.round(box.height), rendered.clientHeight, rendered.scrollHeight,
      rendered.textContent.length, box.bottom <= card.bottom + 0.5 && box.top >= card.top - 0.5].join('|');
  });
  await el('task-summary').click(); await page.waitForTimeout(320);
  const initialFold = await capsuleState();
  await el('task-summary').click(); await page.waitForTimeout(200); await el('task-summary').click(); await page.waitForTimeout(320);
  const foldAfterExpand = await capsuleState();
  await el('task-summary').click(); await page.waitForTimeout(200); await el('rendered').click();
  check('the raw editor opens inside the expanded card', await el('result').isVisible() && await el('preview').isVisible());
  await el('task-summary').click(); await page.waitForTimeout(320);
  const foldAfterEdit = await capsuleState();
  check('folding from the editor returns to the same 56px capsule',
    initialFold.startsWith('56|false|true|1|hidden|'), initialFold);
  check('every collapse path reproduces the initial capsule exactly',
    foldAfterExpand === initialFold && foldAfterEdit === initialFold,
    { initialFold, foldAfterExpand, foldAfterEdit });
  await screenshot('17-fold-after-edit');

  // --- the completion mark: expanded folds the card, capsule closes the UI ---
  await fresh(); await start(); await submit();
  await resolveStream({ ok: true, replacement: '建议完善此方案。' }); await state('complete');
  const markBox = () => ui.evaluate(host => {
    const root = host.shadowRoot;
    const card = root.getElementById('task').getBoundingClientRect();
    const mark = root.getElementById('complete').getBoundingClientRect();
    return { bottom: card.bottom - mark.bottom, right: card.right - mark.right, top: mark.top - card.top, padding: parseFloat(getComputedStyle(root.getElementById('task-summary')).paddingRight) };
  });
  const expandedMark = await markBox();
  check('the completion mark moves to the card bottom-right when expanded',
    Math.abs(expandedMark.bottom) < 24 && Math.abs(expandedMark.right) < 24 && expandedMark.top > 40, expandedMark);
  check('the mark does not compete with the summary text', expandedMark.padding > 40, expandedMark);
  await screenshot('15-complete-expanded');
  await el('complete').click();
  check('clicking the mark folds the card back to its capsule form',
    await el('preview').isHidden() && await el('task').isVisible() && (await markBox()).top < 40);
  check('the folded card still offers the result', await el('result').inputValue() === '建议完善此方案。');
  await el('complete').click();
  check('clicking the mark from the capsule closes the plugin UI', await section.isHidden() && await ui.locator('#task').isHidden());
  // --- Markdown rendering, DSH's GFM subset, and the edit toggle ---
  const markdown =['# 标题','','**加粗**与`代码`和[链接](https://example.test/a)与~~删除~~。','','- 第一项','- [x] 已完成','','| 列 A | 列 B |','| --- | --- |','| 1 | 2 |','','```js','const a = 1','```','','<img src=x onerror=alert(1)>'].join('\n');
  await fresh(); await start(); await submit();
  await resolveStream({ ok: true, replacement: markdown }); await state('complete');
  const dom = await el('rendered').evaluate(node => ({
    heading: node.querySelector('h1')?.textContent,
    strong: node.querySelector('strong')?.textContent,
    inline: node.querySelector(':not(pre) > code')?.textContent,
    language: node.querySelector('.md-lang')?.textContent,
    block: node.querySelector('pre code')?.textContent,
    items: node.querySelectorAll('li').length,
    checked: node.querySelector('.md-task')?.textContent?.trim(),
    columns: node.querySelectorAll('th').length,
    cells: node.querySelectorAll('td').length,
    link: node.querySelector('a')?.getAttribute('href'),
    deleted: node.querySelector('del')?.textContent,
    images: node.querySelectorAll('img').length,
    text: node.textContent,
  }));
  check('markdown renders as elements instead of raw source',
    dom.heading === '标题' && dom.strong === '加粗' && dom.inline === '代码' && dom.deleted === '删除', dom);
  check('fenced code keeps its language banner', dom.language === 'js' && dom.block === 'const a = 1', dom);
  check('lists, task items and GFM tables render', dom.items === 2 && dom.checked === '☑ 已完成' && dom.columns === 2 && dom.cells === 2, dom);
  check('links become anchors with the source href', dom.link === 'https://example.test/a', dom);
  check('model HTML stays literal text', dom.images === 0 && dom.text.includes('<img src=x onerror=alert(1)>'), dom);
  await screenshot('14-markdown');
  const renderedInset = await ui.evaluate(host => {
    const root = host.shadowRoot;
    const card = root.getElementById('task').getBoundingClientRect();
    const rendered = root.getElementById('rendered').getBoundingClientRect();
    return { inset: Math.round(rendered.left - card.left), width: Math.round(rendered.width) };
  });
  await el('task-summary').hover();
  const summaryHover = await el('task-summary').evaluate(node => getComputedStyle(node).backgroundColor);
  check('the title row does not tint on hover', summaryHover === 'rgba(0, 0, 0, 0)', summaryHover);
  await el('rendered').click();
  const editorMetrics = await ui.evaluate(host => {
    const root = host.shadowRoot;
    const card = root.getElementById('task').getBoundingClientRect();
    const box = root.getElementById('result').getBoundingClientRect();
    const style = getComputedStyle(root.getElementById('result'));
    return { inset: Math.round(box.left - card.left), width: Math.round(box.width), line: style.lineHeight, size: style.fontSize };
  });
  check('editing keeps the rendered inset and rhythm',
    editorMetrics.inset === renderedInset.inset && editorMetrics.line === '20px' && editorMetrics.size === '13px',
    { renderedInset, editorMetrics });
  check('editing keeps the rendered width instead of shrinking the card',
    Math.abs(editorMetrics.width - renderedInset.width) <= 1, { renderedInset, editorMetrics });
  check('clicking the rendered result opens the raw editor',
    await el('result').isVisible() && (await el('result').inputValue()).includes('**加粗**') && await el('rendered').isHidden());
  await screenshot('18-edit-long-markdown');
  await el('result').press('Escape');
  check('leaving the editor renders again', await el('rendered').isVisible() && await el('result').isHidden());
  
  check('write-back uses the raw source, not the rendered DOM', (await page.locator('#doc').inputValue()).includes('**加粗**'));
  // --- live streaming over the worker port (opt-in stub) ---
  const streamTransport = async () => {
    await fresh();
    await page.evaluate(() => {
      window.streamPorts = [];
      window.chrome.runtime.connect = () => {
        const listeners = [], disconnects = [], messages = [];
        const port = { name: 'dsh-stream', messages, disconnected: false,
          postMessage: message => messages.push(message),
          onMessage: { addListener: fn => listeners.push(fn) },
          onDisconnect: { addListener: fn => disconnects.push(fn) },
          disconnect: () => { port.disconnected = true; for (const fn of disconnects) fn(); },
          emit: message => { for (const fn of listeners) fn(message); } };
        window.streamPorts.push(port);
        return port;
      };
    });
  };
  await streamTransport();
  await start();
  await submit();
  await page.waitForFunction(() => window.streamPorts.length === 1);
  check('the rewrite request travels over the live port', await page.evaluate(() => window.streamPorts[0].messages[0]?.instruction) === '改得更专业一些');
  const cardHeight = () => el('task').evaluate(node => node.getBoundingClientRect().height);
  const thinkingHeight = await cardHeight();
  await page.evaluate(() => window.streamPorts[0].emit({ type: 'ready', sessionId: 'live-session' }));
  await page.evaluate(() => { const port = window.streamPorts[0]; port.emit({ type: 'thinking', text: '先判断语义' }); port.emit({ type: 'thinking', text: '，再收紧措辞' }); });
  check('reasoning streams into the status line that said 正在思考', (await el('task-message').textContent()).includes('先判断语义，再收紧措辞'));
  check('the card never expands for streamed reasoning',
    thinkingHeight < 90 && (await cardHeight()) < 90 && await ui.locator('#stream').count() === 0);
  check('the composer keeps its own row while running', await el('instruction').isVisible());
  check('the live session becomes the bound session', (await el('session-label').textContent()).includes('live-session'));
  await screenshot('12-streaming');
  await page.evaluate(() => window.streamPorts[0].emit({ type: 'reset' }));
  check('a new attempt clears the streamed reasoning', !(await el('task-message').textContent()).includes('先判断语义'));
  await page.evaluate(() => window.streamPorts[0].emit({ type: 'text', text: '草稿内容' }));
  check('the answer is not previewed in the status line', !(await el('task-message').textContent()).includes('草稿内容'));
  await page.evaluate(() => window.streamPorts[0].emit({ type: 'thinking', text: '重试' }));
  const firstRequest = await page.evaluate(() => window.streamPorts[0].messages[0]);
  await page.evaluate(({ requestId, selectionId }) => window.streamPorts[0].emit({ type: 'done', requestId, selectionId, sessionId: 'live-session', replacement: '建议完善此方案。' }), { requestId: firstRequest.requestId, selectionId: firstRequest.selectionId });
  await state('complete');
  check('the settled replacement wins over the streamed draft', await el('result').inputValue() === '建议完善此方案。');
  check('no stream block duplicates the settled result', await ui.locator('#task .stream-block').count() === 0 && await ui.locator('#stream').count() === 0);
  check('the port closes once the turn settles', await page.evaluate(() => window.streamPorts[0].disconnected === true));
  
  check('applying a streamed result writes it back', (await page.locator('#doc').inputValue()).startsWith('建议完善此方案。'));

  await streamTransport();
  await start(); await submit();
  await page.waitForFunction(() => window.streamPorts.length === 1);
  await el('add').click();
  await el('close').click();
  check('closing the interaction disconnects the live channel', await page.evaluate(() => window.streamPorts[0].disconnected === true));

  await streamTransport();
  await start(); await submit();
  await page.waitForFunction(() => window.streamPorts.length === 1);
  await page.evaluate(() => window.streamPorts[0].emit({ type: 'error', message: '模型拒绝了这次改写。' }));
  await state('error');
  check('an in-band stream error reaches the task card', await el('task-message').textContent() === '模型拒绝了这次改写。');
  check('no uncaught browser errors', errors.length === 0);
  console.log(`ALL ${passes.length} UI CHECKS PASSED`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
