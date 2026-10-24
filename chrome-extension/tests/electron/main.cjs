const { app, BrowserWindow, ipcMain } = require('electron')
const { readFile } = require('node:fs/promises')
const { join } = require('node:path')

const here = __dirname
const endpoint = process.env.DSH_MINI_PANEL_ENDPOINT || 'http://127.0.0.1:18765'
const tokenFile = process.env.DSH_MINI_PANEL_TOKEN_FILE || join(process.env.HOME || '', '.dsh/mini-panel/token')
const TEXTAREA_FLOW = "(async () => {\n  const host = [...document.documentElement.children].find(el => el.shadowRoot)\n  const el = id => host.shadowRoot.getElementById(id)\n  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))\n  const until = async predicate => {\n    for (let i = 0; i < 900; i += 1) { if (predicate()) return true; await wait(100) }\n    return predicate()\n  }\n  const out = {}\n  const box = document.getElementById('doc')\n  box.focus()\n  box.setSelectionRange(0, 8)\n  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))\n  await wait(250)\n  out.markerVisible = !el('marker').hidden\n  if (!out.markerVisible) return out\n  el('marker').click()\n  await wait(80)\n  out.panelOpen = host.shadowRoot.querySelector('section').dataset.state === 'input'\n  out.line = el('instruction').value\n  el('instruction').value = '改得更专业一些'\n  el('instruction').dispatchEvent(new Event('input', { bubbles: true }))\n  el('generate').click()\n  out.previewShown = await until(() => !el('preview').hidden)\n  out.status = el('status').textContent\n  out.replacement = el('result').value\n  if (out.previewShown) { el('replace').click(); await wait(600) }\n  out.docValue = box.value\n  out.finalStatus = el('status').textContent\n  el('close').click()\n  await wait(200)\n  return out\n})()"
const EDITABLE_FLOW = "(async () => {\n  const host = [...document.documentElement.children].find(el => el.shadowRoot)\n  const el = id => host.shadowRoot.getElementById(id)\n  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))\n  const until = async predicate => {\n    for (let i = 0; i < 900; i += 1) { if (predicate()) return true; await wait(100) }\n    return predicate()\n  }\n  const out = {}\n  const target = document.getElementById('editable')\n  if (document.activeElement === host) host.blur()\n  target.focus()\n  const range = document.createRange()\n  range.setStart(target.firstChild, 0)\n  range.setEnd(target.firstChild, 7)\n  const selection = getSelection()\n  selection.removeAllRanges()\n  selection.addRange(range)\n  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))\n  await wait(250)\n  out.markerVisible = !el('marker').hidden\n  if (!out.markerVisible) return out\n  el('marker').click()\n  await wait(80)\n  el('instruction').value = '改成更短的表达'\n  el('instruction').dispatchEvent(new Event('input', { bubbles: true }))\n  el('generate').click()\n  out.previewShown = await until(() => !el('preview').hidden)\n  out.replacement = el('result').value\n  out.replaceEnabled = !el('replace').disabled\n  if (out.replaceEnabled) { el('replace').click(); await wait(600) }\n  out.editableText = target.textContent\n  out.finalStatus = el('status').textContent\n  return out\n})()"

const INSERTION_FLOW = `(async () => {
  const root = document.getElementById('dsh-mini-panel').shadowRoot;
  const el = id => root.getElementById(id);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  el('close').click();
  const box = document.getElementById('doc');
  box.value = '前文。后文。'; box.focus(); box.setSelectionRange(3, 3);
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  await wait(150);
  const offered = !el('marker').hidden && el('marker').dataset.mode === 'insert';
  if (!offered) return { offered };
  el('marker').click();
  el('instruction').value = '写一句简短的欢迎新同事加入团队的话，只输出这句话';
  el('instruction').dispatchEvent(new Event('input', { bubbles: true }));
  el('generate').click();
  for (let i = 0; i < 900 && el('preview').hidden; i++) await wait(100);
  const replacement = el('result').value;
  const action = el('replace').textContent;
  if (!el('preview').hidden) { el('replace').click(); await wait(500); }
  return { offered, replacement, action, value: box.value, status: el('status').textContent };
})()`

const failures = []
const check = (name, ok, detail) => {
  if (ok) console.log('PASS ' + name)
  else { failures.push(name); console.log('FAIL ' + name + (detail === undefined ? '' : ' - ' + detail)) }
}

let token = ''
const call = async (path, init) => {
  const headers = Object.assign({ authorization: 'Bearer ' + token, 'content-type': 'application/json' }, (init && init.headers) || {})
  const response = await fetch(new URL(path, endpoint), Object.assign({}, init, { headers }))
  const body = await response.json().catch(() => null)
  return { status: response.status, body }
}

ipcMain.handle('dsh-bridge', async (_event, message) => {
  try {
    if (!message || typeof message.type !== 'string') return { ok: false, error: { message: 'bad message' } }
    if (message.type === 'rewrite') {
      const reply = await call('/v1/rewrite', {
        method: 'POST',
        body: JSON.stringify({
          requestId: message.requestId,
          selectionId: message.selectionId,
          text: message.text,
          mode: message.mode,
          instruction: message.instruction,
          url: message.url,
          title: message.title,
        }),
      })
      if (reply.status !== 200) return { ok: false, error: { message: 'bridge returned ' + reply.status } }
      return { ok: true, replacement: reply.body.replacement }
    }
    if (message.type === 'cancel') return { ok: true }
    if (message.type === 'desktop-result') return { ok: true, result: null }
    if (message.type === 'desktop-open') return { ok: false, error: { message: 'desktop capsule is not part of this run' } }
    if (message.type === 'options') return { ok: true }
    return { ok: false, error: { message: 'unsupported message ' + message.type } }
  } catch (error) {
    return { ok: false, error: { message: String((error && error.message) || error) } }
  }
})

app.whenReady().then(async () => {
  try {
    token = (await readFile(tokenFile, 'utf8')).trim()
    const window = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { preload: join(here, 'preload.cjs') } })
    await window.loadFile(join(here, '..', 'fixture.html'))
    await window.webContents.executeJavaScript('globalThis.chrome = { runtime: { sendMessage: message => globalThis.dshBridge.send(message) } }; true', true)
    const source = await readFile(join(here, '..', '..', 'src', 'content.js'), 'utf8')
    await window.webContents.executeJavaScript(source, true)
    const mounted = await window.webContents.executeJavaScript('[...document.documentElement.children].some(el => el.shadowRoot)', true)
    check('content script mounts its shadow UI', mounted === true)

    const textarea = await window.webContents.executeJavaScript(TEXTAREA_FLOW, true)
    check('floating marker appears for a textarea selection', textarea.markerVisible === true)
    check('panel opens on the selected text', textarea.panelOpen === true)
    check('Host returned a rewrite', textarea.previewShown === true && (textarea.replacement || '').length > 0, JSON.stringify(textarea.replacement))
    check('textarea replaced the selection in place', (textarea.docValue || '').includes(textarea.replacement || '\u0000'), JSON.stringify(textarea.docValue))
    check('status confirms the replacement', (textarea.finalStatus || '').includes('已替换'), JSON.stringify(textarea.finalStatus))

    const editable = await window.webContents.executeJavaScript(EDITABLE_FLOW, true)
    check('marker appears for a contenteditable selection', editable.markerVisible === true)
    check('contenteditable is offered as editable', editable.replaceEnabled === true)
    check('Host returned a second rewrite', editable.previewShown === true && (editable.replacement || '').length > 0, JSON.stringify(editable.replacement))
    check('contenteditable replaced the selection in place', (editable.editableText || '').includes(editable.replacement || '\u0000'), JSON.stringify(editable.editableText))

    const insertion = await window.webContents.executeJavaScript(INSERTION_FLOW, true)
    check('unselected caret offers paragraph generation', insertion.offered === true)
    check('Host generated new paragraph text', (insertion.replacement || '').trim().length > 0)
    check('generation action is insertion', insertion.action === '插入')
    check('generated paragraph inserted without replacing either side', insertion.value === '前文。' + insertion.replacement + '后文。', JSON.stringify(insertion.value))
    check('status confirms insertion', (insertion.status || '').includes('已插入'))

  } catch (error) {
    failures.push('run failed')
    console.log('FAIL run failed - ' + String((error && error.stack) || error))
  }
  if (failures.length > 0) { console.log('FAILED: ' + failures.join(' | ')); app.exit(1); return }
  console.log('ALL BROWSER CHECKS PASSED')
  app.exit(0)
})
