'use strict'

const DEFAULT_ENDPOINT = 'http://127.0.0.1:18765'
const MIN_TOKEN_LENGTH = 24
const HEALTH_TIMEOUT_MS = 8000

const $ = id => document.getElementById(id)
const endpointInput = $('endpoint')
const tokenInput = $('token')
const feedbackNode = $('feedback')
const saveButton = $('save')
const testButton = $('test')
const revealButton = $('reveal')
const behaviorFeedback = $('behavior-feedback')

let saved = { endpoint: DEFAULT_ENDPOINT, pairingToken: '' }
let busy = false

const normalizeEndpoint = value => value.trim().replace(/\/+$/, '')

/**
 * Mirrors the service worker's acceptance rule, so the page can neither save a
 * value the worker would reject nor block one it accepts.
 * @param value - candidate endpoint.
 * @returns an error message, or an empty string when acceptable.
 */
function endpointProblem(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    return '地址无效：需要形如 http://127.0.0.1:18765 的本机地址。'
  }
  const local = url.protocol === 'http:' && url.hostname === '127.0.0.1'
  const bare = !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash
  return local && bare ? '' : '只接受 http://127.0.0.1:<端口>，其他地址会被扩展拒绝。'
}

/**
 * @param value - candidate pairing token.
 * @returns a warning for an empty token, an error for one the Host would refuse.
 */
function tokenProblem(value) {
  if (!value) return { level: 'warn', message: '尚未填写配对码，扩展还不会向 Host 发送请求。' }
  if (value.length < MIN_TOKEN_LENGTH) return { level: 'error', message: '配对码长度不足 24 字符，请粘贴 token 文件的完整内容。' }
  return null
}

function showFeedback(message, kind = '') {
  feedbackNode.textContent = message
  feedbackNode.dataset.kind = kind
  feedbackNode.hidden = !message
}

/** Connection dot and chip; one call keeps both surfaces in step. */
function setConnection(state, label) {
  const dot = $('dot')
  dot.dataset.state = state
  dot.setAttribute('aria-label', '连接状态：' + label)
  $('state-chip').textContent = label
  $('state-chip').hidden = false
}

function renderFacts() {
  $('fact-endpoint').textContent = saved.endpoint || '—'
  $('fact-token').textContent = saved.pairingToken ? '已配置 · ' + saved.pairingToken.length + ' 字符' : '未配置'
}

function setBusy(value) {
  busy = value
  saveButton.disabled = value
  testButton.disabled = value
}

const isPristine = () => normalizeEndpoint(endpointInput.value) === saved.endpoint && tokenInput.value === saved.pairingToken

async function load() {
  try {
    const stored = await chrome.storage.local.get({ endpoint: DEFAULT_ENDPOINT, pairingToken: '' })
    saved = { endpoint: normalizeEndpoint(stored.endpoint), pairingToken: stored.pairingToken }
  } catch (error) {
    showFeedback('读取已保存的设置失败：' + (error?.message || error), 'error')
    return
  }
  endpointInput.value = saved.endpoint
  tokenInput.value = saved.pairingToken
  renderFacts()
  $('fact-protocol').textContent = '未探测'
  if (saved.pairingToken) {
    setConnection('unknown', '未探测')
    showFeedback('')
  } else {
    setConnection('unknown', '未配置配对码')
    showFeedback('尚未配置配对码：请粘贴 ~/.dsh/mini-panel/token 的内容。', 'warn')
  }
}

async function save() {
  if (busy) return
  const endpoint = normalizeEndpoint(endpointInput.value)
  const invalid = endpointProblem(endpoint)
  if (invalid) {
    showFeedback(invalid, 'error')
    return
  }
  const issue = tokenProblem(tokenInput.value)
  if (issue && issue.level === 'error') {
    showFeedback(issue.message, 'error')
    return
  }
  setBusy(true)
  try {
    await chrome.storage.local.set({ endpoint, pairingToken: tokenInput.value })
    saved = { endpoint, pairingToken: tokenInput.value }
    endpointInput.value = endpoint
    renderFacts()
    $('fact-protocol').textContent = '未探测'
    setConnection('unknown', '未探测')
    showFeedback(issue ? issue.message + ' 已保存其余设置。' : '已保存，扩展会立即使用新的连接设置。', issue ? 'warn' : 'ok')
  } catch (error) {
    showFeedback('保存失败：' + (error?.message || error), 'error')
  } finally {
    setBusy(false)
  }
}

async function test() {
  if (busy) return
  const endpoint = normalizeEndpoint(endpointInput.value)
  const invalid = endpointProblem(endpoint)
  if (invalid) {
    showFeedback(invalid, 'error')
    return
  }
  const issue = tokenProblem(tokenInput.value)
  if (issue) {
    showFeedback(issue.message, 'error')
    return
  }
  setBusy(true)
  showFeedback('正在测试连接…', '')
  try {
    const response = await fetch(endpoint + '/v1/health', {
      headers: { authorization: 'Bearer ' + tokenInput.value },
      cache: 'no-store',
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    })
    if (response.status === 401) {
      setConnection('error', '配对码无效')
      showFeedback('Host 返回 401：配对码不正确，请重新复制 token 文件的内容。', 'error')
      return
    }
    if (!response.ok) {
      setConnection('error', '连接异常')
      showFeedback('Host 返回 ' + response.status + '，请查看 Host 日志。', 'error')
      return
    }
    const body = await response.json().catch(() => null)
    if (!body || body.ok !== true) {
      setConnection('error', '响应异常')
      showFeedback('Host 响应不是预期的 health 结果。', 'error')
      return
    }
    const version = 'v' + String(body.protocolVersion ?? 1)
    $('fact-protocol').textContent = version
    setConnection('ok', '已连接')
    showFeedback('连接正常 · 协议 ' + version + '。', 'ok')
  } catch (error) {
    setConnection('error', '无法连接')
    const reason = error?.name === 'TimeoutError' ? '请求超时。' : '请确认 Host 已启动，并核对地址与端口。'
    showFeedback('无法连接 Host：' + reason, 'error')
  } finally {
    setBusy(false)
  }
}

revealButton.addEventListener('click', () => {
  const shown = tokenInput.type === 'text'
  tokenInput.type = shown ? 'password' : 'text'
  revealButton.textContent = shown ? '显示' : '隐藏'
  revealButton.setAttribute('aria-pressed', String(!shown))
})

saveButton.addEventListener('click', () => void save())
testButton.addEventListener('click', () => void test())

for (const input of [endpointInput, tokenInput]) {
  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    void (input === endpointInput ? save() : test())
  })
  input.addEventListener('input', () => {
    if (feedbackNode.dataset.kind === 'error') showFeedback('')
  })
}

// Another surface (or the extension's own options button) may rewrite the
// config; only pick it up while this form has no unsaved edits.
chrome.storage.onChanged?.addListener((changes, area) => {
  if (area !== 'local') return
  if (!changes.endpoint && !changes.pairingToken) return
  if (isPristine()) void load()
})

void load()
