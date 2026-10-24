// Visual audit: screenshots every panel state, including the approval/question cards, at two widths.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(process.env.DSH_MONOREPO ?? process.env.DSH_CHECKOUT ?? join(homedir(), '.dsh/source/current'), 'apps/web/package.json'));
const { chromium } = require('playwright');
const server = createServer(async (req, res) => {
  const url = (req.url ?? '').split('?')[0];
  const file = url.startsWith('/src/') ? url.slice(1) : 'tests/ui.html';
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8');
  res.end(await readFile(join(root, file)));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const out = join(root, 'artifacts', 'audit'); await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const report = [];
for (const width of [900, 420]) {
  const page = await (await browser.newContext({ viewport: { width, height: 760 }, deviceScaleFactor: 2 })).newPage();
  page.setDefaultTimeout(8000);
  await page.goto('http://127.0.0.1:' + server.address().port + '/tests/ui.html');
  const ui = page.locator('#dsh-mini-panel'); const el = id => ui.locator('#' + id);
  await page.evaluate(() => {
    window.listeners = [];
    chrome.runtime.sendMessage = async () => ({ ok: true });
    chrome.runtime.connect = () => ({ name: 'dsh-stream', onMessage: { addListener: f => window.listeners.push(f) }, onDisconnect: { addListener() {} }, disconnect() {}, postMessage: m => { (window.posted ||= []).push(m); } });
  });
  const push = m => page.evaluate(m => window.listeners.forEach(f => f(m)), m);
  const shot = async name => {
    await page.waitForTimeout(300);
    const geo = await ui.evaluate(host => {
      const r = host.shadowRoot, vw = innerWidth, vh = innerHeight;
      const vis = [...r.querySelectorAll('section,#task,#ask,.ask,#menu,#collapse,#marker,#status,.ask-head,.ask-body,.ask-foot,#task-actions,#preview,#rendered,#complete,#task-summary,.ask-actions button')].filter(n => n.getClientRects().length && !n.closest('[hidden]'));
      const boxes = vis.map(n => { const b = n.getBoundingClientRect(); return { id: n.id || n.className, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), offscreen: b.left < 0 || b.top < 0 || b.right > vw || b.bottom > vh }; });
      const ask = r.getElementById('ask');
      const clipped = ask && !ask.hidden ? { scroll: ask.scrollHeight, client: ask.clientHeight } : null;
      const overflowX = [...r.querySelectorAll('#ask *,#task *')].filter(n => n.getClientRects().length && n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).overflowX === 'visible').map(n => n.tagName + '#' + (n.id||'') + '.' + (n.className||''));
      const rd = r.getElementById('rendered');
      const probe = rd ? { mr: getComputedStyle(rd).marginRight, exp: r.getElementById('task').dataset.expanded } : null;
      const bt = r.querySelector('.ask-actions .primary');
      const cs = bt && getComputedStyle(bt);
      const btn = cs ? { lh: cs.lineHeight, fs: cs.fontSize, ff: cs.fontFamily.slice(0, 80), pt: cs.paddingTop, h: cs.height } : null;
      return { boxes, clipped, probe, btn, overflowX: overflowX.slice(0, 8) };
    });
    report.push({ width, name, ...geo });
    await page.screenshot({ path: join(out, width + '-' + name + '.png') });
  };
  await page.locator('#doc').evaluate(b => { b.focus(); b.setSelectionRange(0, 8); document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
  await el('marker').waitFor({ state: 'visible' }); await el('marker').click();
  await el('instruction').fill('改得更专业一些'); await el('generate').click();
  await page.waitForFunction(() => document.getElementById('dsh-mini-panel').shadowRoot.querySelector('section').dataset.state !== 'input');
  await push({ type: 'ready', sessionId: 's' }); await push({ type: 'thinking', text: '先读一下选区所在段落，再判断需要调整的语气和用词。' });
  await shot('a-thinking');
  await push({ type: 'ask', frame: { kind: 'approval', interactionId: 'i1', toolName: 'bash', reason: '这条命令会在工作区写文件，需要你确认。', arguments: JSON.stringify({ command: 'python3 scripts/very_long_script_name_for_testing_overflow.py --input /Users/someone/Documents/a/very/deep/path/to/file.txt --output /tmp/out.json --verbose' }, null, 2) } });
  await shot('b-approval');
  await push({ type: 'ask-done', frame: { interactionId: 'i1' } });
  await push({ type: 'ask', frame: { kind: 'question', interactionId: 'i2', questions: [
    { id: 'tone', header: '语气', question: '改写成哪种语气？', options: [{ label: '正式', description: '适合对外文档' }, { label: '口语', description: '适合内部沟通' }, { label: '简洁' }], multiSelect: false },
    { id: 'keep', question: '需要保留哪些内容？', options: [{ label: '数字' }, { label: '专有名词' }, { label: '原有结构' }], multiSelect: true },
  ] } });
  await shot('c-question');
  await ui.locator('#ask-0-1').check({ force: true });
  await ui.locator('#ask-1-0').check({ force: true });
  await ui.locator('#ask-1-2').check({ force: true });
  await shot('c2-question-selected');
  await ui.evaluate(h => { h.shadowRoot.querySelector('.ask-body').scrollTop = 0; });
  await page.mouse.move(0, 0);
  await shot('c3-question-top');
  await ui.locator('#ask button.primary').click();
  await shot('d-question-error');
  await push({ type: 'ask-cancel', frame: { interactionId: 'i2' } });
  await push({ type: 'done', sessionId: 's', replacement: '建议进一步完善此方案，明确实施路径与验收标准。' });
  await shot('e-complete');
  await page.close();
}
await browser.close(); server.close();
console.log(JSON.stringify(report, null, 1));
