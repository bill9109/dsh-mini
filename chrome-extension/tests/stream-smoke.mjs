// Real-host smoke: confirm the streaming route forwards live frames.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
const endpoint = process.env.DSH_MINI_PANEL_ENDPOINT || 'http://127.0.0.1:18765'
const token = (await readFile(process.env.DSH_MINI_PANEL_TOKEN_FILE || join(process.env.HOME, '.dsh/mini-panel/token'), 'utf8')).trim()
const response = await fetch(endpoint + '/v1/rewrite/stream', {
  method: 'POST',
  headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
  body: JSON.stringify({ requestId: 'stream-smoke', selectionId: 'stream-smoke', text: '这个方案需要进一步优化。', instruction: '改得更专业一些', url: 'https://example.test/doc', title: 'Stream smoke' }),
  signal: AbortSignal.timeout(120000),
})
if (response.status !== 200) throw new Error('host returned ' + response.status + ': ' + await response.text())
let buffer = ''
const seen = []
const started = Date.now()
for await (const chunk of response.body) {
  buffer += new TextDecoder().decode(chunk, { stream: true })
  let index = buffer.indexOf('\n\n')
  while (index >= 0) {
    const block = buffer.slice(0, index)
    buffer = buffer.slice(index + 2)
    const event = block.match(/^event: (.+)$/m)?.[1]
    const data = JSON.parse(block.match(/^data: (.+)$/m)?.[1] || '{}')
    if (event) { seen.push({ event, data, at: Date.now() - started }); console.log(String(Date.now() - started).padStart(6) + 'ms  ' + event.padEnd(9) + ' ' + JSON.stringify(event === 'done' ? { ...data, replacement: data.replacement?.slice(0, 40) } : data).slice(0, 120)) }
    index = buffer.indexOf('\n\n')
  }
}
const kinds = [...new Set(seen.map(item => item.event))]
const text = seen.filter(item => item.event === 'text').map(item => item.data.text).join('')
const thinking = seen.filter(item => item.event === 'thinking').map(item => item.data.text).join('')
const done = seen.find(item => item.event === 'done')?.data
console.log('EVENTS ' + kinds.join(','))
console.log('TEXT DELTAS ' + seen.filter(item => item.event === 'text').length + ' → ' + JSON.stringify(text.slice(0, 60)))
console.log('THINKING DELTAS ' + seen.filter(item => item.event === 'thinking').length + ' → ' + JSON.stringify(thinking.slice(0, 60)))
if (!done) throw new Error('no done event')
if (!done.replacement) throw new Error('empty replacement')
if (seen.filter(item => item.event === 'text').length < 2) throw new Error('answer did not stream in more than one delta')
console.log('ALL STREAM CHECKS PASSED')

// Phase 2: run the real service worker against the real Host and assert it
// forwards deltas over its port, so the two halves are proven together.
const { webcrypto } = await import('node:crypto')
const vm = (await import('node:vm')).default
const source = await readFile(new URL('../src/background.js', import.meta.url), 'utf8')
let connect, count = 0
const chrome = {
  storage: {
    local: { setAccessLevel() {}, get: async () => ({ endpoint, pairingToken: token }) },
    session: { setAccessLevel() {}, get: async () => ({}), set: async () => {}, remove: async () => {} },
  },
  tabs: { onRemoved: { addListener() {} } },
  runtime: { id: 'smoke', onMessage: { addListener() {} }, onConnect: { addListener(fn) { connect = fn } }, openOptionsPage: async () => {} },
}
vm.runInNewContext(source, { chrome, crypto: webcrypto, URL, TextEncoder, TextDecoder, AbortController, AbortSignal, fetch })
const messages = []
let onMessage
connect({ name: 'dsh-stream', sender: { id: 'smoke', tab: { id: 1 }, frameId: 0, url: 'https://example.test/doc' },
  postMessage: message => messages.push(message), onMessage: { addListener: fn => { onMessage = fn } }, onDisconnect: { addListener() {} } })
onMessage({ type: 'rewrite', requestId: 'worker-smoke', selectionId: 'worker-smoke', text: '这个方案需要进一步优化。', instruction: '改得更短', mode: 'rewrite', url: 'https://example.test/doc' })
const deadline = Date.now() + 120000
while (Date.now() < deadline && !messages.some(message => message.type === 'done' || message.type === 'error')) await new Promise(resolve => setTimeout(resolve, 50))
const workerText = messages.filter(message => message.type === 'text').map(message => message.text).join('')
const workerDone = messages.find(message => message.type === 'done')
console.log('WORKER MESSAGES ' + messages.map(message => message.type).join(','))
console.log('WORKER TEXT → ' + JSON.stringify(workerText.slice(0, 60)))
if (!workerDone) throw new Error('worker never settled: ' + JSON.stringify(messages.slice(0, 3)))
if (messages.filter(message => message.type === 'text').length < 2) throw new Error('worker did not forward incremental deltas')
if (workerDone.replacement !== workerText) throw new Error('worker done text differs from the streamed draft')
if (typeof workerDone.binding?.sessionId !== 'string') throw new Error('worker did not report the bound session')
console.log('ALL WORKER STREAM CHECKS PASSED')
