/**
 * 设置 → DSH Mini. Laid out like the shell's own 模型 page so it reads as part of DSH: an H2 title
 * and intro per section, one row card per item (name, status dot, tags, then 编辑 / 删除 on the
 * right), an inline editor that opens inside the card, and a dashed "+ 添加…" button.
 *
 * The shell's styles are hashed CSS modules, so this file restates the same rules against the
 * same --dsw-* tokens instead of borrowing class names that change between builds.
 */
import { createElement as h, useCallback, useEffect, useMemo, useRef, useState } from 'react'

type Node = ReturnType<typeof h>
const PAIRING = '/dsh-mini-panel/api/v1/pairing'
const LIST = '/dsh-mini-panel/api/v1/sites'
const ACTION = '/dsh-mini-panel/api/v1/sites/action'

export const SETTINGS_PAGE_CSS = [
  '.dshm-page{display:flex;flex-direction:column;gap:28px;max-width:720px;color:var(--dsw-alias-label-primary)}',
  '.dshm-section{display:flex;flex-direction:column;gap:12px}',
  '.dshm-title{margin:0;font-size:16px;font-weight:500;line-height:24px;color:var(--dsw-alias-label-primary)}',
  '.dshm-intro{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-tertiary)}',
  '.dshm-intro code,.dshm-hint code{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:.92em}',
  '.dshm-rows{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}',
  '.dshm-card{display:flex;flex-direction:column;gap:12px;padding:12px 14px;border:.5px solid var(--dsw-alias-settings-card-stroke);background:var(--dsw-alias-settings-card-fill);border-radius:var(--dsw-radius-xl)}',
  '.dshm-head{display:flex;align-items:center;gap:10px;min-height:28px}',
  '.dshm-identity{display:inline-flex;align-items:center;gap:6px;min-width:0}',
  '.dshm-name{font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.dshm-off .dshm-name{color:var(--dsw-alias-label-tertiary)}',
  '.dshm-tag{flex:0 0 auto;padding:1px 6px;font-size:11px;line-height:16px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-label-secondary)}',
  '.dshm-dot{box-sizing:border-box;flex:0 0 auto;width:8px;height:8px;border-radius:50%;display:inline-block;background:var(--dsw-alias-label-dimmed)}',
  '.dshm-dot-ok{background:var(--dsw-alias-state-success-primary)}',
  '.dshm-dot-bad{background:var(--dsw-alias-state-error-primary)}',
  '.dshm-sub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin-top:-6px;word-break:break-all}',
  '.dshm-actions{display:inline-flex;align-items:center;gap:4px;margin-left:auto}',
  // Buttons: the 模型 page's secondary (outlined), danger (text) and dashed add button.
  '.dshm-btn,.dshm-danger,.dshm-primary{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 10px;border-radius:var(--dsw-radius-sm);font:inherit;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap}',
  '.dshm-btn{border:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-primary)}',
  '.dshm-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid,var(--dsw-alias-interactive-bg-hover))}',
  '.dshm-danger{border:0;background:transparent;color:var(--dsw-alias-state-error-primary)}',
  '.dshm-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}',
  '.dshm-primary{border:0;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
  '.dshm-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
  '.dshm-add{box-sizing:border-box;display:flex;align-items:center;justify-content:center;gap:6px;width:100%;height:44px;padding:0 14px;border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;cursor:pointer}',
  '.dshm-add:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
  '.dshm-btn:disabled,.dshm-danger:disabled,.dshm-primary:disabled,.dshm-add:disabled{opacity:.4;cursor:default}',
  '.dshm-btn:focus-visible,.dshm-danger:focus-visible,.dshm-primary:focus-visible,.dshm-add:focus-visible,.dshm-input:focus-visible,.dshm-code:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary)}',
  // Inline editor inside a card, like the provider editor.
  '.dshm-editor{display:flex;flex-direction:column;gap:14px}',
  '.dshm-field{display:flex;flex-direction:column;gap:6px}',
  '.dshm-label{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}',
  '.dshm-input{box-sizing:border-box;width:100%;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}',
  '.dshm-input:focus{border-color:var(--dsw-alias-state-business-primary);outline:none}',
  '.dshm-input[readonly]{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12.5px}',
  '.dshm-code{box-sizing:border-box;width:100%;min-height:300px;resize:vertical;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12.5px;line-height:1.6;tab-size:2}',
  '.dshm-code:focus{border-color:var(--dsw-alias-state-business-primary);outline:none}',
  '.dshm-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
  '.dshm-err{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);word-break:break-word}',
  '.dshm-ok{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary)}',
  '.dshm-footer{display:flex;align-items:center;gap:8px}',
  '.dshm-grow{flex:1;min-width:0}',
  '.dshm-switch{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}',
  '.dshm-pre{margin:0;max-height:240px;overflow:auto;white-space:pre-wrap;word-break:break-word;padding:10px 12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12px;line-height:1.55}',
  '.dshm-test{display:flex;gap:8px;align-items:center}',
].join('')

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined
    ? { headers: { accept: 'application/json' } }
    : { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) })
  const value = await response.json().catch(() => ({})) as T & { message?: string }
  if (!response.ok) throw new Error(value.message || ('HTTP ' + String(response.status)))
  return value
}
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

const PlusIcon = (): Node => h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
  h('path', { d: 'M8 2V14', stroke: 'currentColor' }), h('path', { d: 'M2 8H14', stroke: 'currentColor' }))

// ── Pairing ─────────────────────────────────────────────────────────────────────────────

type PairingState = 'connected' | 'stale-code' | 'idle' | 'never'
interface Pairing { endpoint: string; tokenPath: string; token: string; status?: { state: PairingState; lastSeen?: number } }

const STATUS: Record<PairingState, { dot: string; label: string }> = {
  connected: { dot: 'dshm-dot dshm-dot-ok', label: '扩展已连接' },
  'stale-code': { dot: 'dshm-dot dshm-dot-bad', label: '扩展的配对码已失效，请重新粘贴' },
  idle: { dot: 'dshm-dot', label: '扩展最近没有连接' },
  never: { dot: 'dshm-dot dshm-dot-bad', label: '尚未配对' },
}
function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return '刚刚'
  if (s < 3600) return String(Math.floor(s / 60)) + ' 分钟前'
  return String(Math.floor(s / 3600)) + ' 小时前'
}

function PairingSection(): Node {
  const [info, setInfo] = useState<Pairing | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [shown, setShown] = useState(false)
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    try { setInfo(await api<Pairing>(PAIRING)); setError('') } catch (e) { setError(message(e)) }
  }, [])
  // The extension beats once a minute; re-read often enough that a fresh pairing turns green soon.
  useEffect(() => { void load(); const t = setInterval(() => { void load() }, 10_000); return () => clearInterval(t) }, [load])

  const rotate = async (): Promise<void> => {
    if (!window.confirm('生成新配对码后，旧码立即失效，扩展需要重新粘贴。继续吗？')) return
    setBusy(true); setNote('')
    try { setInfo(await api<Pairing>(PAIRING + '/rotate', {})); setNote('已生成新配对码；把它粘进扩展的连接设置。'); setShown(true) }
    catch (e) { setNote(message(e)) } finally { setBusy(false) }
  }
  const copy = async (): Promise<void> => {
    if (!info?.token) return
    try { await navigator.clipboard.writeText(info.token); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { setShown(true) }
  }

  const state: PairingState = info?.status?.state ?? 'never'
  const s = STATUS[state]
  const seen = info?.status?.lastSeen !== undefined ? '，' + ago(info.status.lastSeen) : ''

  const field = (label: string, value: string, extra?: Node): Node => h('div', { className: 'dshm-field' },
    h('label', { className: 'dshm-label' }, label),
    h('div', { className: 'dshm-test' }, h('input', { className: 'dshm-input', readOnly: true, value, 'aria-label': label }), extra ?? null))

  return h('section', { className: 'dshm-section', 'aria-labelledby': 'dshm-pairing-title' },
    h('h2', { className: 'dshm-title', id: 'dshm-pairing-title' }, 'Chrome 扩展'),
    h('p', { className: 'dshm-intro' }, '把下面的接口地址和配对码填进扩展的连接设置。'),
    error ? h('p', { className: 'dshm-err', role: 'alert' }, '加载失败：' + error) : null,
    h('ul', { className: 'dshm-rows' }, h('li', { className: 'dshm-card' },
      h('div', { className: 'dshm-head' },
        h('span', { className: 'dshm-identity' },
          h('span', { className: 'dshm-name' }, 'Mini Panel'),
          h('span', { className: s.dot, role: 'img', 'aria-label': s.label + seen, title: s.label + seen })),
        h('span', { className: 'dshm-actions' },
          h('button', { type: 'button', className: 'dshm-btn', onClick: () => setOpen(v => !v), 'aria-expanded': open }, open ? '收起' : '编辑'))),
      h('div', { className: 'dshm-sub', 'aria-live': 'polite' }, s.label + seen),
      open ? h('div', { className: 'dshm-editor' },
        field('接口地址', info?.endpoint ?? ''),
        field('配对码', info?.token ? (shown ? info.token : '•'.repeat(Math.min(43, info.token.length))) : '（尚未生成）',
          h('span', { className: 'dshm-actions' },
            h('button', { type: 'button', className: 'dshm-btn', onClick: () => setShown(v => !v), disabled: !info?.token }, shown ? '隐藏' : '显示'),
            h('button', { type: 'button', className: 'dshm-btn', onClick: () => { void copy() }, disabled: !info?.token }, copied ? '已复制' : '复制'))),
        field('配对码文件', info?.tokenPath ?? ''),
        note ? h('p', { className: 'dshm-hint', role: 'status' }, note) : null,
        h('div', { className: 'dshm-footer' },
          h('span', { className: 'dshm-grow' }),
          h('button', { type: 'button', className: 'dshm-danger', onClick: () => { void rotate() }, disabled: busy }, busy ? '生成中…' : '生成新配对码')))
        : null)))
}

// ── Site preferences ────────────────────────────────────────────────────────────────────

interface Meta { name: string; version: string; description?: string; author?: string; match: string[]; exclude: string[] }
interface FileRow { id: string; enabled: boolean; meta: Meta; text: string }
interface Broken { id: string; message: string; text: string }
interface Listing { directory: string; files: FileRow[]; invalid: Broken[]; template: string }
type Editing = { kind: 'file' | 'broken'; id: string } | { kind: 'new' } | null

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url; a.download = name; a.rel = 'noopener'
  document.body.append(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function SiteEditor(props: { initial: string; isNew: boolean; onSave(text: string): Promise<string | undefined>; onCancel(): void; onExport?(text: string): void }): Node {
  const [text, setText] = useState(props.initial)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const dirty = text !== props.initial
  const save = async (): Promise<void> => {
    setBusy(true); setStatus(null)
    const failure = await props.onSave(text)
    setBusy(false)
    if (failure) setStatus({ ok: false, text: failure })
  }
  const cancel = (): void => { if (!dirty || window.confirm('放弃未保存的修改？')) props.onCancel() }
  return h('div', { className: 'dshm-editor' },
    h('div', { className: 'dshm-field' },
      h('label', { className: 'dshm-label', htmlFor: 'dshm-site-text' }, '文件内容'),
      h('textarea', { id: 'dshm-site-text', className: 'dshm-code', value: text, spellCheck: false, onChange: (e: { target: { value: string } }) => { setText(e.target.value); setStatus(null) } }),
      h('p', { className: 'dshm-hint' }, '文件头写在 ', h('code', null, '// ==DshSite=='), ' 和 ', h('code', null, '// ==/DshSite=='),
        ' 之间：必填 ', h('code', null, '@name'), '、', h('code', null, '@version'), '、至少一条 ', h('code', null, '@match'),
        '（同油猴，如 ', h('code', null, '*://*.feishu.cn/*'), '）；可选 ', h('code', null, '@exclude'), '、', h('code', null, '@description'),
        '、', h('code', null, '@author'), '。文件头之后是给模型的正文，最多 32 KB。')),
    status ? h('p', { className: status.ok ? 'dshm-ok' : 'dshm-err', role: status.ok ? 'status' : 'alert' }, status.text) : null,
    h('div', { className: 'dshm-footer' },
      props.onExport ? h('button', { type: 'button', className: 'dshm-btn', onClick: () => props.onExport!(text), disabled: busy }, '导出') : null,
      h('span', { className: 'dshm-grow' }),
      h('button', { type: 'button', className: 'dshm-btn', onClick: cancel, disabled: busy }, '取消'),
      h('button', { type: 'button', className: 'dshm-primary', onClick: () => { void save() }, disabled: busy || (!dirty && !props.isNew) }, busy ? '保存中…' : '保存')))
}

function SitesSection(): Node {
  const [listing, setListing] = useState<Listing | null>(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Editing>(null)
  const [draftFromImport, setDraftFromImport] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [testUrl, setTestUrl] = useState('')
  const [test, setTest] = useState<{ matched: string[]; prompt: string } | null>(null)
  const [notice, setNotice] = useState('')
  const editorKey = useRef(0)

  const load = useCallback(async () => {
    try { setListing(await api<Listing>(LIST)); setError('') } catch (e) { setError(message(e)) }
  }, [])
  useEffect(() => { void load() }, [load])

  const open = (next: Editing, imported: string | null = null): void => { editorKey.current++; setDraftFromImport(imported); setEditing(next); setNotice('') }

  const save = async (text: string, id?: string): Promise<string | undefined> => {
    try {
      const out = await api<{ ok: boolean; id?: string; message?: string }>(ACTION, { action: 'save', text, ...(id ? { id } : {}) })
      if (!out.ok) return out.message ?? '保存失败'
      await load(); setEditing(null); setNotice('已保存，下一轮对话生效。')
      return undefined
    } catch (e) { return message(e) }
  }
  const act = async (body: Record<string, unknown>): Promise<void> => {
    setBusy(true)
    try { await api(ACTION, body); await load() } catch (e) { setNotice(message(e)) } finally { setBusy(false) }
  }
  const remove = (row: { id: string; name: string }): void => {
    if (!window.confirm('删除站点偏好「' + row.name + '」？此操作不可撤销。')) return
    if (editing && editing.kind !== 'new' && editing.id === row.id) setEditing(null)
    void act({ action: 'delete', id: row.id })
  }
  const importFile = (): void => {
    const input = document.createElement('input')
    input.type = 'file'; input.accept = '.txt,.js,.md,text/plain'
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) return
      if (file.size > 32 * 1024) { setNotice('文件超过 32 KB。'); return }
      void file.text().then(text => open({ kind: 'new' }, text))
    }
    input.click()
  }
  const runTest = async (): Promise<void> => {
    const url = testUrl.trim()
    if (!url) return
    try { setTest(await api<{ matched: string[]; prompt: string }>(ACTION, { action: 'test', url })) } catch (e) { setNotice(message(e)) }
  }

  const names = useMemo(() => new Map((listing?.files ?? []).map(f => [f.id, f.meta.name])), [listing])

  const fileCard = (f: FileRow): Node => {
    const isOpen = editing?.kind === 'file' && editing.id === f.id
    return h('li', { key: f.id, className: 'dshm-card' + (f.enabled ? '' : ' dshm-off') },
      h('div', { className: 'dshm-head' },
        h('span', { className: 'dshm-identity' },
          h('span', { className: 'dshm-name' }, f.meta.name),
          h('span', { className: 'dshm-tag' }, 'v' + f.meta.version),
          f.enabled ? null : h('span', { className: 'dshm-tag' }, '已停用')),
        h('span', { className: 'dshm-actions' },
          h('label', { className: 'dshm-switch' },
            h('input', { type: 'checkbox', checked: f.enabled, disabled: busy, onChange: () => { void act({ action: 'enable', id: f.id, enabled: !f.enabled }) } }), '启用'),
          isOpen ? null : h('button', { type: 'button', className: 'dshm-btn', onClick: () => open({ kind: 'file', id: f.id }), 'aria-label': '编辑 ' + f.meta.name }, '编辑'),
          h('button', { type: 'button', className: 'dshm-danger', onClick: () => remove({ id: f.id, name: f.meta.name }), disabled: busy, 'aria-label': '删除 ' + f.meta.name }, '删除'))),
      h('div', { className: 'dshm-sub' }, (f.meta.description ? f.meta.description + '  ·  ' : '') + f.meta.match.join('  ·  ')),
      isOpen ? h<Parameters<typeof SiteEditor>[0]>(SiteEditor, {
        key: 'e' + String(editorKey.current), initial: f.text, isNew: false,
        onSave: text => save(text, f.id), onCancel: () => setEditing(null), onExport: text => download(f.id + '.dshsite.txt', text),
      }) : null)
  }
  const brokenCard = (b: Broken): Node => {
    const isOpen = editing?.kind === 'broken' && editing.id === b.id
    return h('li', { key: 'bad-' + b.id, className: 'dshm-card' },
      h('div', { className: 'dshm-head' },
        h('span', { className: 'dshm-identity' },
          h('span', { className: 'dshm-name' }, b.id),
          h('span', { className: 'dshm-dot dshm-dot-bad', role: 'img', 'aria-label': '无法解析', title: '无法解析' })),
        h('span', { className: 'dshm-actions' },
          isOpen ? null : h('button', { type: 'button', className: 'dshm-btn', onClick: () => open({ kind: 'broken', id: b.id }) }, '编辑'),
          h('button', { type: 'button', className: 'dshm-danger', onClick: () => remove({ id: b.id, name: b.id }), disabled: busy }, '删除'))),
      h('p', { className: 'dshm-err' }, '无法解析，不会生效：' + b.message),
      isOpen ? h<Parameters<typeof SiteEditor>[0]>(SiteEditor, { key: 'e' + String(editorKey.current), initial: b.text, isNew: false, onSave: text => save(text, b.id), onCancel: () => setEditing(null) }) : null)
  }

  return h('section', { className: 'dshm-section', 'aria-labelledby': 'dshm-sites-title' },
    h('h2', { className: 'dshm-title', id: 'dshm-sites-title' }, '站点偏好'),
    h('p', { className: 'dshm-intro' }, '写给模型的、针对某类网站的偏好（比如飞书文档的格式要求）。Mini 面板绑定的页面命中 ', h('code', null, '@match'),
      ' 时，正文才会进入这次对话。文件格式沿用油猴脚本，带版本号，可以导出分享。'),
    error ? h('p', { className: 'dshm-err', role: 'alert' }, '加载失败：' + error) : null,
    notice ? h('p', { className: 'dshm-hint', role: 'status' }, notice) : null,
    h('ul', { className: 'dshm-rows', 'aria-label': '站点偏好文件' },
      ...(listing?.files ?? []).map(fileCard),
      ...(listing?.invalid ?? []).map(brokenCard),
      editing?.kind === 'new' ? h('li', { key: 'new', className: 'dshm-card' },
        h('div', { className: 'dshm-head' }, h('span', { className: 'dshm-name' }, draftFromImport !== null ? '导入的文件' : '新站点偏好')),
        h<Parameters<typeof SiteEditor>[0]>(SiteEditor, {
          key: 'e' + String(editorKey.current), initial: draftFromImport ?? listing?.template ?? '', isNew: true,
          onSave: text => save(text), onCancel: () => setEditing(null),
        })) : null),
    editing?.kind === 'new' ? null : h('div', { className: 'dshm-test' },
      h('button', { type: 'button', className: 'dshm-add', onClick: () => open({ kind: 'new' }), disabled: !listing }, h(PlusIcon, null), '添加站点偏好'),
      h('button', { type: 'button', className: 'dshm-btn', onClick: importFile, disabled: !listing, style: { height: 44, borderRadius: 'var(--dsw-radius-lg)', padding: '0 16px', fontSize: 14 } }, '导入文件')),
    listing ? h('p', { className: 'dshm-hint' }, '文件存放在 ', h('code', null, listing.directory)) : null,

    h('div', { className: 'dshm-card' },
      h('div', { className: 'dshm-head' }, h('span', { className: 'dshm-name' }, '测试匹配')),
      h('div', { className: 'dshm-test' },
        h('input', { className: 'dshm-input', type: 'url', placeholder: 'https://xxx.feishu.cn/docx/…', value: testUrl, 'aria-label': '测试网址',
          onChange: (e: { target: { value: string } }) => setTestUrl(e.target.value), onKeyDown: (e: { key: string }) => { if (e.key === 'Enter') void runTest() } }),
        h('button', { type: 'button', className: 'dshm-btn', onClick: () => { void runTest() }, disabled: !testUrl.trim() }, '测试')),
      test ? (test.matched.length
        ? h('div', { className: 'dshm-editor' },
          h('p', { className: 'dshm-hint' }, '命中：' + test.matched.map(id => names.get(id) ?? id).join('、') + '。模型会看到：'),
          h('pre', { className: 'dshm-pre' }, test.prompt))
        : h('p', { className: 'dshm-hint' }, '没有启用的站点偏好命中这个网址。')) : null))
}

export function SettingsPage(): Node {
  return h('div', { className: 'dshm-page' }, h(PairingSection, null), h(SitesSection, null))
}
