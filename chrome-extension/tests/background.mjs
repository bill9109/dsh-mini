import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { test } from 'node:test';
const source = await readFile(new URL('../src/background.js', import.meta.url), 'utf8');

/** In-memory stand-in for the browser WebSocket; the test plays the Host side. */
function socketFactory() {
  const sockets = [];
  class FakeSocket {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close(code = 1000) { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({ code }); }
    /** Host -> worker frame. */
    push(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  }
  return { FakeSocket, sockets };
}

function harness(WebSocketImpl, script = source) {
  const sidePanel = { options: [], opened: [], sent: [] };
  const data = {}, calls = [];
  const config = { endpoint: 'http://127.0.0.1:18765', pairingToken: 'test-pairing-token-long-enough' };
  let listener, removed, connect, count = 0, delay = false, entered, release, stream;
  const started = () => new Promise(resolve => { entered = resolve; delay = true; });
  const encoder = new TextEncoder();
  const chrome = {
    storage: {
      local: { setAccessLevel() {}, get: async () => ({ ...config }) },
      session: { setAccessLevel() {}, get: async key => key === null ? { ...data } : { [key]: data[key] },
        set: async values => { Object.assign(data, structuredClone(values)); },
        remove: async keys => { for (const key of [].concat(keys)) delete data[key]; } },
    },
    tabs: { onRemoved: { addListener(fn) { removed = fn; } } },
    runtime: { id: 'test-extension', onMessage: { addListener(fn) { listener = fn; } },
      onConnect: { addListener(fn) { connect = fn; } }, openOptionsPage: async () => {}, getURL: path => 'chrome-extension://test-extension/' + path },
    sidePanel: { setPanelBehavior() {}, setOptions: async options => { sidePanel.options.push(options); }, open: async options => { if (sidePanel.refuse) throw new Error('not allowed'); sidePanel.opened.push(options); } },
  };
  chrome.tabs.sendMessage = async (tabId, message) => { sidePanel.sent.push({ tabId, message }); };
  const fetch = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path: url.pathname, body });
    if (url.pathname === '/v1/sessions/new') return Response.json({ sessionId: 'session-' + ++count });
    if (url.pathname === '/v1/sessions/bind') {
      if (body.sessionId === 'missing') return Response.json({ error: 'not found' }, { status: 404 });
      return Response.json({ sessionId: body.sessionId });
    }
    if (url.pathname === '/v1/rewrite/stream') {
      // A live SSE body the test drives event by event.
      let push, abortStream
      const body = new ReadableStream({ start(controller) {
        push = chunk => controller.enqueue(encoder.encode(chunk))
        abortStream = error => controller.error(error)
      } })
      stream = {
        push,
        close: () => { try { push; } finally { /* closed below */ } },
        emit: (event, data) => push('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'),
        finish: () => undefined,
      }
      // Mirror real fetch: aborting the request errors the body so a pending read rejects.
      options.signal.addEventListener('abort', () => { try { abortStream(new Error('aborted')) } catch { /* already closed */ } }, { once: true })
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    }
    if (url.pathname === '/v1/rewrite') {
      if (delay) {
        delay = false; entered();
        await new Promise((resolve, reject) => {
          release = resolve;
          options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      return Response.json({ ...body, replacement: 'result' });
    }
    return Response.json({ ok: true });
  };
  const restart = () => vm.runInNewContext(script, { chrome, crypto: webcrypto, URL, TextEncoder, TextDecoder, AbortController, AbortSignal, fetch, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, ...(WebSocketImpl ? { WebSocket: WebSocketImpl } : {}) });
  restart();
  const send = (message, tabId = 1) => new Promise(resolve => {
    listener(message, { id: 'test-extension', tab: { id: tabId }, frameId: 0, url: message.url || 'https://example.test/doc' }, resolve);
  });
  const rewrite = (requestId, url = 'https://example.test/doc') => ({ type: 'rewrite', requestId, selectionId: requestId, text: 'source', instruction: 'shorter', mode: 'rewrite', url, pageSession: { version: 2, taskId: requestId, selectionId: requestId, documentId: 'test-document', url, token: 'task-secret-' + requestId + '-abcdefghijklmnop' } });
  /** Open the content script's live channel and collect what the worker posts back. */
  const openPort = (tabId = 1) => {
    const messages = [];
    let onMessage, onDisconnect;
    const port = { name: 'dsh-stream', sender: { id: 'test-extension', tab: { id: tabId }, frameId: 0, url: 'https://example.test/doc' },
      postMessage: message => messages.push(message),
      onMessage: { addListener: fn => { onMessage = fn } }, onDisconnect: { addListener: fn => { onDisconnect = fn } } };
    connect(port);
    return { messages, send: message => onMessage(message), disconnect: () => onDisconnect(),
      get stream() { return stream },
      async waitFor(type) { for (let i = 0; i < 200 && !messages.some(m => m.type === type); i++) await new Promise(resolve => setTimeout(resolve, 5)); return messages; } };
  };
  const waitForCall = async (path, times = 1) => {
    const seen = () => calls.filter(call => call.path === path).length;
    for (let i = 0; i < 200 && seen() < times; i++) await new Promise(resolve => setTimeout(resolve, 5));
  };
  /** A message from an extension page (the panel) rather than a content script. */
  const sendFromPanel = (message) => new Promise(resolve => {
    listener(message, { id: 'test-extension', url: 'chrome-extension://test-extension/src/sidepanel.html' }, resolve);
  });
  return { sidePanel, sendFromPanel, data, calls, config, send, rewrite, restart, started, release: () => release(), remove: id => removed(id), openPort, waitForCall };
}

test('bindings survive worker restarts; isolated by tab, document and endpoint', async () => {
  const h = harness();
  const a = await h.send(h.rewrite('one'));
  assert.equal(a.sessionId, 'session-1');
  h.restart();
  assert.equal((await h.send({ type: 'session-state' })).binding.sessionId, a.sessionId);
  assert.equal((await h.send(h.rewrite('two'))).sessionId, a.sessionId);
  assert.notEqual((await h.send(h.rewrite('three'), 2)).sessionId, a.sessionId);
  assert.notEqual((await h.send(h.rewrite('four', 'https://example.test/doc#other'))).sessionId, a.sessionId);
  h.config.endpoint = 'http://127.0.0.1:18766';
  assert.equal((await h.send({ type: 'session-state' })).binding, null);
  await h.remove(1);
  assert.ok(Object.keys(h.data).every(key => !key.startsWith('selection-binding:1:')));
});

test('new, bind and detach are explicit, failed bind preserves old session', async () => {
  const h = harness();
  await h.send(h.rewrite('one'));
  const next = await h.send({ type: 'session-new' });
  assert.equal(next.binding.sessionId, 'session-2');
  assert.equal((await h.send({ type: 'session-bind', sessionId: 'existing' })).binding.sessionId, 'existing');
  assert.equal((await h.send({ type: 'session-bind', sessionId: 'missing' })).ok, false);
  assert.equal((await h.send({ type: 'session-state' })).binding.sessionId, 'existing');
  assert.equal((await h.send(h.rewrite('two'))).sessionId, 'existing');
  await h.send({ type: 'session-detach' });
  assert.equal((await h.send({ type: 'session-state' })).binding, null);
  assert.equal((await h.send(h.rewrite('three'))).sessionId, 'session-3');
  assert.ok(!h.calls.some(call => /delete/.test(call.path)));
});

test('cancelled turns preserve binding and prohibit concurrent mutation', async () => {
  const h = harness();
  const started = h.started();
  const job = h.send(h.rewrite('one'));
  await started;
  assert.equal((await h.send({ type: 'session-new' })).ok, false);
  assert.equal((await h.send(h.rewrite('two'))).ok, false);
  await h.send({ type: 'cancel', requestId: 'one' });
  assert.equal((await job).error.code, 'CANCELLED');
  assert.equal((await h.send({ type: 'session-state' })).binding.sessionId, 'session-1');
  assert.equal((await h.send(h.rewrite('retry'))).sessionId, 'session-1');
});


test('streams live deltas over the port and settles with the authoritative replacement', async () => {
  const h = harness();
  const port = h.openPort();
  port.send(h.rewrite('stream-one'));
  await h.waitForCall('/v1/rewrite/stream');
  port.stream.emit('ready', { sessionId: 'session-1' });
  const call = h.calls.find(c => c.path === '/v1/rewrite/stream');
  assert.equal(call.body.sessionId, 'session-1');
  assert.equal(call.body.instruction, 'shorter');
  port.stream.emit('reset', {});
  port.stream.emit('thinking', { text: '先看语义' });
  port.stream.emit('text', { text: '结' });
  port.stream.emit('text', { text: '果' });
  port.stream.emit('done', { requestId: 'stream-one', selectionId: 'stream-one', sessionId: 'session-1', replacement: '结果' });
  await port.waitFor('done');
  assert.equal(port.messages.find(m => m.type === 'thinking').text, '先看语义');
  assert.equal(port.messages.filter(m => m.type === 'text').map(m => m.text).join(''), '结果');
  assert.equal(port.messages.find(m => m.type === 'done').binding.sessionId, 'session-1');
  assert.equal((await h.send({ type: 'session-state' })).binding.sessionId, 'session-1');
});

test('rejects a mismatched settlement, reports in-band errors and aborts on disconnect', async () => {
  const h = harness();
  // Separate tabs: a stream that never settles keeps its own document locked.
  const first = h.openPort(2);
  first.send(h.rewrite('stream-bad'));
  await h.waitForCall('/v1/rewrite/stream');
  first.stream.emit('done', { requestId: 'other', selectionId: 'stream-bad', sessionId: 'session-1', replacement: 'x' });
  await first.waitFor('error');
  assert.match(first.messages.find(m => m.type === 'error').message, /不匹配/);
  const second = h.openPort(3);
  second.send(h.rewrite('stream-error'));
  await h.waitForCall('/v1/rewrite/stream', 2);
  second.stream.emit('error', { status: 502, message: 'turn failed' });
  await second.waitFor('error');
  assert.equal(second.messages.find(m => m.type === 'error').message, 'turn failed');
  // Disconnecting aborts the turn and releases the document instead of leaking it.
  const third = h.openPort(4);
  third.send(h.rewrite('stream-cancel'));
  await h.waitForCall('/v1/rewrite/stream', 3);
  third.disconnect();
  assert.ok(!third.messages.some(m => m.type === 'done'));
  await new Promise(resolve => setTimeout(resolve, 30));
  const retry = h.openPort(4);
  retry.send(h.rewrite('stream-retry'));
  await h.waitForCall('/v1/rewrite/stream', 4);
  retry.stream.emit('done', { requestId: 'stream-retry', selectionId: 'stream-retry', sessionId: 'session-3', replacement: 'R' });
  await retry.waitFor('done');
  assert.equal(retry.messages.find(m => m.type === 'done').replacement, 'R');
});
test('empty insertion and desktop handoff carry binding without altering human query', async () => {
  const h = harness();
  const result = await h.send({ ...h.rewrite('insert'), text: '', mode: 'insert', instruction: 'write a paragraph' });
  const call = h.calls.find(call => call.path === '/v1/rewrite');
  assert.equal(call.body.text, '');
  assert.equal(call.body.instruction, 'write a paragraph');
  await h.send({ type: 'desktop-open', selectionId: 'sel', text: 'text' });
  assert.equal(h.calls.at(-1).body.sessionId, result.sessionId);
});

const until = async (check, label) => { for (let i = 0; i < 200; i++) { const v = check(); if (v) return v; await new Promise(r => setTimeout(r, 5)); } throw new Error('timed out: ' + label); };

test('page socket: pushed commands are claimed locally and start/result travel over the socket', async () => {
  const { FakeSocket, sockets } = socketFactory();
  const h = harness(FakeSocket);
  const port = h.openPort();
  const msg = h.rewrite('ws-one');
  port.send(msg);
  await h.waitForCall('/v1/rewrite/stream');
  port.stream.emit('ready', { sessionId: 'session-1' });
  const ws = await until(() => sockets[0], 'socket');
  assert.equal(ws.url, 'ws://127.0.0.1:18765/v2/page/socket');
  const hello = await until(() => ws.sent.find(f => f.type === 'hello'), 'hello');
  assert.deepEqual(hello, { type: 'hello', taskId: 'ws-one', documentId: 'test-document', token: msg.pageSession.token, pairing: h.config.pairingToken });
  ws.push({ type: 'ready' });
  const command = { version: 2, commandId: 'cmd-1', taskId: 'ws-one', documentId: 'test-document', kind: 'read', args: {}, leaseId: 'lease-1' };
  ws.push({ type: 'command', command });
  await port.waitFor('wake');
  const claimed = await h.send({ type: 'page-claim', pageSession: msg.pageSession, url: msg.url });
  assert.equal(claimed.command.commandId, 'cmd-1');
  assert.equal((await h.send({ type: 'page-claim', pageSession: msg.pageSession, url: msg.url })).command, null);
  const starting = h.send({ type: 'page-start', pageSession: msg.pageSession, url: msg.url, commandId: 'cmd-1', leaseId: 'lease-1' });
  const start = await until(() => ws.sent.find(f => f.type === 'start'), 'start');
  ws.push({ type: 'reply', rid: start.rid, ok: true, execute: true, code: 'EXECUTE' });
  assert.equal((await starting).execute, true);
  const reporting = h.send({ type: 'page-result', pageSession: msg.pageSession, url: msg.url, commandId: 'cmd-1', leaseId: 'lease-1', outcome: { ok: true, code: 'READ' } });
  const result = await until(() => ws.sent.find(f => f.type === 'result'), 'result');
  ws.push({ type: 'reply', rid: result.rid, ok: true, commandId: 'cmd-1' });
  assert.equal((await reporting).acknowledged, true);
  // No HTTP claim/start/result: the socket carried all of it.
  assert.ok(!h.calls.some(c => c.path.startsWith('/v2/page/')));
  assert.ok(!Object.keys(h.data).some(k => k.startsWith('page-result:')));
});

test('page socket: asks reach the panel, answers go back, and the socket closes with the task', async () => {
  const { FakeSocket, sockets } = socketFactory();
  const h = harness(FakeSocket);
  const port = h.openPort();
  const msg = h.rewrite('ws-two');
  port.send(msg);
  await h.waitForCall('/v1/rewrite/stream');
  port.stream.emit('ready', { sessionId: 'session-1' });
  const ws = await until(() => sockets[0], 'socket');
  ws.push({ type: 'ready' });
  ws.push({ type: 'ask', kind: 'approval', interactionId: 'i-1', toolName: 'bash' });
  await port.waitFor('ask');
  assert.equal(port.messages.find(m => m.type === 'ask').frame.toolName, 'bash');
  port.send({ type: 'answer', interactionId: 'i-1', value: { decision: 'allow' } });
  assert.deepEqual(ws.sent.find(f => f.type === 'answer'), { type: 'answer', interactionId: 'i-1', value: { decision: 'allow' } });
  ws.push({ type: 'ask-done', interactionId: 'i-1' });
  await port.waitFor('ask-done');
  port.stream.emit('done', { requestId: 'ws-two', selectionId: 'ws-two', sessionId: 'session-1', replacement: 'R' });
  await port.waitFor('done');
  port.disconnect();
  await until(() => ws.readyState === 3, 'closed');
});

test('page socket: without an open socket the claim falls back to HTTP', async () => {
  const h = harness();
  const port = h.openPort();
  const msg = h.rewrite('ws-three');
  port.send(msg);
  await h.waitForCall('/v1/rewrite/stream');
  port.stream.emit('ready', { sessionId: 'session-1' });
  await port.waitFor('ready');
  await h.send({ type: 'page-claim', pageSession: msg.pageSession, url: msg.url });
  assert.ok(h.calls.some(c => c.path === '/v2/page/claim'));
});

test('side panel: opens synchronously for the tab and shows the bound conversation', async () => {
  const h = harness();
  await h.send(h.rewrite('seed'));                       // creates and stores session-1 for this document
  const opened = h.send({ type: 'open-panel', url: 'https://example.test/doc', title: 'Doc' });
  // The call to Chrome happens before any await, so it is already recorded when send() has only been invoked.
  assert.equal(JSON.stringify(h.sidePanel.opened), JSON.stringify([{ tabId: 1 }]));
  assert.equal((await opened).ok, true);
  assert.equal(JSON.stringify(h.sidePanel.options[0]), JSON.stringify({ tabId: 1, path: 'src/sidepanel.html', enabled: true }));
  h.calls.length = 0;
  const state = await h.sendFromPanel({ type: 'panel-state', tabId: 1 });
  assert.equal(state.ok, true);
  assert.equal(state.sessionId, 'session-1');
  const ticket = h.calls.find(c => c.path === '/v1/panel/ticket');
  assert.equal(JSON.stringify(ticket.body), JSON.stringify({ sessionId: 'session-1' }));
});

test('side panel: a content script cannot mint a panel ticket', async () => {
  const h = harness();
  const reply = await h.send({ type: 'panel-state', tabId: 1 });
  assert.equal(reply.ok, false);
  assert.equal(reply.error.code, 'INVALID_MESSAGE');
  assert.ok(!h.calls.some(c => c.path === '/v1/panel/ticket'));
});

test('side panel: handing back disables the panel for the tab and tells the page', async () => {
  const h = harness();
  await h.send(h.rewrite('seed'));
  await h.send({ type: 'open-panel', url: 'https://example.test/doc', title: 'Doc' });
  const reply = await h.sendFromPanel({ type: 'panel-close', tabId: 1 });
  assert.equal(reply.ok, true);
  assert.equal(JSON.stringify(h.sidePanel.options.at(-1)), JSON.stringify({ tabId: 1, enabled: false }));
  assert.equal(JSON.stringify(h.sidePanel.sent), JSON.stringify([{ tabId: 1, message: { type: 'panel-closed', sessionId: 'session-1' } }]));
  // Closed means closed: a late state request finds no panel to serve.
  const late = await h.sendFromPanel({ type: 'panel-state', tabId: 1 });
  assert.equal(late.sessionId, null);
});

test('side panel: a refused open reports the error and forgets the tab', async () => {
  const h = harness();
  await h.send(h.rewrite('seed'));
  h.sidePanel.refuse = true;
  const reply = await h.send({ type: 'open-panel', url: 'https://example.test/doc' });
  assert.equal(reply.ok, false);
  assert.equal(reply.error.code, 'NO_SIDE_PANEL');
  const late = await h.sendFromPanel({ type: 'panel-state', tabId: 1 });
  assert.equal(late.sessionId, null);
});

// A short idle window so the timing tests run in milliseconds instead of 90 seconds.
const fastIdle = source.replace('const IDLE_TIMEOUT_MS = 90000;', 'const IDLE_TIMEOUT_MS = 60;');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('idle timeout: a run that keeps streaming outlives the idle window', async () => {
  assert.notEqual(fastIdle, source, 'the idle constant moved; update the test patch');
  const h = harness(undefined, fastIdle);
  const port = h.openPort();
  port.send(h.rewrite('long-run'));
  await h.waitForCall('/v1/rewrite/stream');
  port.stream.emit('ready', { sessionId: 'session-1' });
  // Five times the idle window in total, but never silent for longer than half of it.
  for (let i = 0; i < 10; i++) { await sleep(30); port.stream.emit('thinking', { text: '.' }); }
  port.stream.emit('done', { requestId: 'long-run', selectionId: 'long-run', sessionId: 'session-1', replacement: 'ok' });
  await port.waitFor('done');
  assert.ok(!port.messages.some(m => m.type === 'error'), JSON.stringify(port.messages.filter(m => m.type === 'error')));
});

test('idle timeout: a silent stream stops with a readable message, not the raw browser error', async () => {
  const h = harness(undefined, fastIdle);
  const port = h.openPort();
  port.send(h.rewrite('silent'));
  await h.waitForCall('/v1/rewrite/stream');
  port.stream.emit('ready', { sessionId: 'session-1' });
  const error = (await port.waitFor('error')).find(m => m.type === 'error');
  assert.ok(error, 'expected an error message');
  assert.equal(error.code, 'TIMEOUT');
  assert.match(error.message, /秒没有响应/);
  assert.doesNotMatch(error.message, /signal timed out/i);
});

test('idle timeout: a question waiting for the user pauses the watch, and the answer resumes it', async () => {
  const { FakeSocket, sockets } = socketFactory();
  const h = harness(FakeSocket, fastIdle);
  const port = h.openPort();
  port.send(h.rewrite('asking'));
  await h.waitForCall('/v1/rewrite/stream');
  port.stream.emit('ready', { sessionId: 'session-1' });
  const ws = await until(() => sockets[0], 'socket');
  ws.push({ type: 'ready' });
  ws.push({ type: 'ask', kind: 'question', interactionId: 'q-1' });
  await port.waitFor('ask');
  // The user takes several idle windows to answer; nothing may time out meanwhile.
  await sleep(250);
  assert.ok(!port.messages.some(m => m.type === 'error'), 'timed out while the user was answering');
  ws.push({ type: 'ask-done', interactionId: 'q-1' });
  // After the answer the watch runs again: a stream that then goes silent is stopped.
  const error = (await port.waitFor('error')).find(m => m.type === 'error');
  assert.equal(error?.code, 'TIMEOUT');
});
