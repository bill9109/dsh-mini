const DEFAULT_ENDPOINT = 'http://127.0.0.1:18765';
const MAX_REPLACEMENT = 20000;
const pending = new Map();
// Append-only records shaped like dsh's own events. A service worker can be stopped at any moment,
// so the ring travels with every posted result instead of living only in memory.
const BG_RING = (() => { try { return (self.__dshBgLog = self.__dshBgLog || []); } catch (e) { return []; } })();
function bgLog(event, data, level) {
  try {
    const d = new Date();
    const pad = (v, n = 2) => String(v).padStart(n, '0');
    BG_RING.push({ t: pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' + pad(d.getMilliseconds(), 3),
      level: level || (/fail|error|retry/.test(String(event)) ? 'error' : 'info'), event: String(event), data: data || {} });
    while (BG_RING.length > 200) BG_RING.shift();
  } catch (e) {}
}
function bgRecent() { try { return BG_RING.slice(-40); } catch (e) { return []; } }
const busyDocuments = new Set();
const pageTasks = new Map();
function rememberTask(sender, message) {
  const p = message.pageSession;
  if (!p || p.version !== 2 || p.taskId !== message.requestId || p.selectionId !== message.selectionId || p.url !== message.url || !Number.isInteger(sender?.tab?.id) || typeof p.token !== 'string' || p.token.length < 16 || new URL(sender.url).origin !== new URL(p.url).origin) throw Error('Invalid page task identity');
  for (const [id, t] of pageTasks) if (t.expires < Date.now() && !t.active) pageTasks.delete(id);
  if (pageTasks.has(p.taskId) || pageTasks.size >= 1000) throw Error('Task ID reused or task capacity exceeded');
  const task = { page: { ...p }, tabId: sender.tab.id, frameId: sender.frameId || 0, browserDocumentId: sender.documentId || null, url: sender.url, active: true, ready: false, started: new Map(), expires: Date.now() + 600000 };
  pageTasks.set(p.taskId, task);
  bgLog('task/authorized', { taskId: p.taskId, tab: sender.tab.id, frame: task.frameId, doc: String(sender.documentId || '').slice(-8) });
  return task;
}
function taskFor(sender, message) {
  const p = message.pageSession, t = pageTasks.get(p?.taskId);
  if (!t || t.expires < Date.now() || p.token !== t.page.token || p.documentId !== t.page.documentId || p.url !== t.page.url || t.tabId !== sender.tab?.id || t.frameId !== (sender.frameId || 0) || (t.browserDocumentId && t.browserDocumentId !== sender.documentId) || t.url !== sender.url) throw Error('Page task ownership mismatch');
  return t;
}
function taskIdentity(t) { return { taskId: t.page.taskId, documentId: t.page.documentId, token: t.page.token }; }

/**
 * Per-task duplex channel to the Host (`/v2/page/socket`).
 *
 * The Host pushes commands as soon as the model issues them, so the page's claim is answered from
 * a local queue instead of an HTTP poll, and the socket's liveness is how the Host knows the page
 * is still there. Human interactions (approvals, ask_user_question) arrive on it too. The HTTP
 * routes stay as the fallback: when the socket is not open, claim/start/result go over HTTP as
 * before. Traffic every few seconds also keeps this worker alive while a task runs.
 */
const SOCKET_PING_MS = 5000;
function openPageSocket(task, endpoint, pairingToken, onFrame) {
  const url = new URL('/v2/page/socket', endpoint); url.protocol = 'ws:';
  const state = { open: false, closed: false, queue: [], waiters: new Map(), rid: 0, ws: null, timer: 0, retries: 0 };
  const connect = () => {
    if (state.closed || typeof WebSocket !== 'function') return;
    let ws;
    try { ws = new WebSocket(url.href); } catch { return; }
    state.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello', ...taskIdentity(task), pairing: pairingToken }));
      clearInterval(state.timer);
      state.timer = setInterval(() => { try { ws.send('{"type":"ping"}'); } catch { /* reconnect handles it */ } }, SOCKET_PING_MS);
    };
    ws.onmessage = event => {
      let frame; try { frame = JSON.parse(event.data); } catch { return; }
      if (frame.type === 'ready') { state.open = true; state.retries = 0; bgLog('socket/ready', { taskId: String(task.page.taskId).slice(-8) }); return; }
      if (frame.type === 'command') { if (frame.command && !state.queue.some(c => c.commandId === frame.command.commandId)) state.queue.push(frame.command); onFrame({ type: 'wake' }); return; }
      if (frame.type === 'reply') { const w = state.waiters.get(frame.rid); if (w) { state.waiters.delete(frame.rid); w(frame); } return; }
      if (frame.type === 'pong') return;
      if (frame.type === 'bye' && frame.code === 'TASK_ENDED') state.ended = true;
      onFrame(frame);
    };
    ws.onclose = event => {
      state.open = false; clearInterval(state.timer);
      for (const w of state.waiters.values()) w(null);
      state.waiters.clear();
      bgLog('socket/closed', { taskId: String(task.page.taskId).slice(-8), code: event.code }, event.code === 1000 ? 'info' : 'warn');
      // Auth failures and a task the Host ended (4410) are final; anything else reconnects while the task runs.
      const final = state.closed || state.ended || !task.active || event.code === 4401 || event.code === 4403 || event.code === 4410 || state.retries >= 5;
      if (final) { if (!state.closed) onFrame({ type: 'closed', code: event.code, ended: state.ended || event.code === 4410 }); return; }
      state.retries++;
      setTimeout(connect, Math.min(200 * 2 ** state.retries, 2000));
    };
    ws.onerror = () => { /* onclose follows */ };
  };
  connect();
  return {
    get open() { return state.open; },
    /** Next pushed command, if any; the page's claim loop calls this instead of polling HTTP. */
    take() { return state.queue.shift() || null; },
    /** Request/response over the socket; resolves null when the socket is not usable. */
    rpc(frame, timeoutMs = 10000) {
      if (!state.open || state.ws?.readyState !== 1) return Promise.resolve(null);
      const rid = ++state.rid;
      return new Promise(resolve => {
        const timer = setTimeout(() => { state.waiters.delete(rid); resolve(null); }, timeoutMs);
        state.waiters.set(rid, value => { clearTimeout(timer); resolve(value); });
        try { state.ws.send(JSON.stringify({ ...frame, rid })); } catch { state.waiters.delete(rid); clearTimeout(timer); resolve(null); }
      });
    },
    send(frame) { if (!state.open || state.ws?.readyState !== 1) return false; try { state.ws.send(JSON.stringify(frame)); return true; } catch { return false; } },
    close() { state.closed = true; state.open = false; clearInterval(state.timer); try { state.ws?.close(1000, 'task finished'); } catch { /* already closed */ } },
  };
}

// Executed results are durable until the Host acknowledges them. A report that only lived in the
// worker's memory disappeared on the next restart, and the edit it described was already applied -
// so the page could neither confirm nor safely repeat it.
const RESULT_PREFIX = 'page-result:';
const resultKey = record => RESULT_PREFIX + record.taskId + ':' + record.commandId;
async function storeResult(record) {
  // Attach the worker's own records so a stopped worker cannot erase the trace of what it did.
  await chrome.storage.session.set({ [resultKey(record)]: { ...record, bgRecent: bgRecent() } });
  bgLog(record && record.ok === false ? 'result/store/failed' : 'result/store', { taskId: String(record && record.taskId || '').slice(-8), commandId: String(record && record.commandId || '').slice(-8), code: record && record.code || null, ok: !!(record && record.ok) }, record && record.ok === false ? 'error' : 'info');
}
async function dropResult(record) { await chrome.storage.session.remove(resultKey(record)); }
async function pendingResults() {
  const stored = await chrome.storage.session.get(null).catch(() => ({}));
  return Object.entries(stored).filter(([key]) => key.startsWith(RESULT_PREFIX)).map(([, value]) => value);
}
/** Re-deliver results the Host never acknowledged; runs on every worker wake-up. */
async function flushPendingResults() {
  const records = await pendingResults();
  if (!records.length) return;
  bgLog('result/flush', { pending: records.length, taskIds: records.map(r => String(r && r.taskId || '').slice(-6)).slice(0, 6) });
  const config = await loadConfig().catch(() => null);
  if (!config) return;
  const request = createRequest(config.endpoint, config.pairingToken, new AbortController());
  for (const record of records) {
    try {
      await request('/v2/page/result', record);
      await dropResult(record);
    } catch {
      // Still pending: a later wake-up retries. Never dropped without an acknowledgement.
    }
  }
}
void flushPendingResults();
async function modelCall(sender, spec) {
  if (!Number.isInteger(sender.tab?.id) || !spec || spec.url !== sender.url) throw Error('Page URL mismatch');
  const target = { tabId: sender.tab.id, frameIds: [sender.frameId || 0] };
  // Code editors on any site go to their own engine; everything else is the Feishu editor model.
  if (spec.engine === 'code') {
    await chrome.scripting.executeScript({ target, world: 'MAIN', files: ['src/code-engine.js'] });
    const results = await chrome.scripting.executeScript({ target, world: 'MAIN', func: async spec => globalThis.DSHCodeV1.run(spec), args: [spec] });
    return results?.[0]?.result;
  }
  if (!/(^|\.)(feishu\.cn|larksuite\.com)$/.test(new URL(sender.url).hostname)) return { ok: false, code: 'UNSUPPORTED_EDITOR', modification: 'not-modified', verification: 'none', retryable: false };
  await chrome.scripting.executeScript({ target, world: 'MAIN', files: ['src/feishu-engine.js'] });
  const results = await chrome.scripting.executeScript({ target, world: 'MAIN', func: async spec => globalThis.DSHFeishuV2.run(spec), args: [spec] });
  return results?.[0]?.result;
}
const fail = (code, message) => ({ ok: false, error: { code, message } });
const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;
const IMAGE_MAX = 8 * 1024 * 1024;
// The extension can reach hosts the page cannot (it holds <all_urls>), so it never fetches what only
// a private network would answer: an edit must not become a way to probe the user's intranet.
function publicImageUrl(raw) {
  let u; try { u = new URL(raw); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return null;
  const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.') && !h.includes(':')) return null;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(h)) return null;
  if (h === '::1' || /^(fc|fd|fe80)/.test(h)) return null;
  return u;
}
async function fetchImage(src) {
  const u = publicImageUrl(src);
  if (!u) return { ok: false, code: 'IMAGE_URL_REFUSED', message: 'Only public http(s) image URLs can be fetched.' };
  const response = await fetch(u, { credentials: 'omit', redirect: 'follow', signal: AbortSignal.timeout(15000) });
  if (!response.ok) return { ok: false, code: 'IMAGE_UNAVAILABLE', message: 'Image request failed with HTTP ' + response.status };
  if (response.redirected && !publicImageUrl(response.url)) return { ok: false, code: 'IMAGE_URL_REFUSED', message: 'The image redirected to a non-public address.' };
  const type = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!IMAGE_TYPES.test(type)) return { ok: false, code: 'IMAGE_TYPE_REFUSED', message: 'Not a png, jpeg, gif or webp image (' + (type || 'no type') + ').' };
  const buf = await response.arrayBuffer();
  if (buf.byteLength > IMAGE_MAX) return { ok: false, code: 'IMAGE_TOO_LARGE', message: 'Images are limited to 8 MB.' };
  let binary = ''; const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  const name = (u.pathname.split('/').pop() || 'image').slice(0, 80);
  return { ok: true, type, name, base64: btoa(binary) };
}
const types = ['rewrite', 'cancel', 'desktop-open', 'desktop-result', 'page-claim', 'page-start', 'page-result', 'page-model', 'page-inspect', 'page-image', 'health', 'options', 'session-state', 'session-list', 'session-new', 'session-bind', 'session-detach', 'open-panel', 'panel-state', 'panel-close'];
chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
chrome.storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
const digest = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(n => n.toString(16).padStart(2, '0')).join('');

// Session storage survives worker suspension and page reload, not browser restart.
// Include tab/frame and the complete document URL: equal URLs in different tabs
// must not implicitly share history. Configuration changes cannot reuse bindings.
async function documentKey(sender, message, endpoint, token) {
  if (!Number.isInteger(sender.tab?.id)) throw new Error('此操作需要在网页中使用。');
  const url = new URL(message.url || sender.url);
  if (sender.url && url.origin !== new URL(sender.url).origin) throw new Error('网页来源不匹配。');
  return 'selection-binding:' + sender.tab.id + ':' + (sender.frameId ?? 0) + ':' + await digest(endpoint + '\n' + token + '\n' + url.href);
}

/** Resolve and validate the loopback endpoint and pairing token. */
async function loadConfig() {
  const cfg = await chrome.storage.local.get({ endpoint: DEFAULT_ENDPOINT, pairingToken: '' });
  const endpoint = new URL(cfg.endpoint);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) throw new Error('连接地址必须是 http://127.0.0.1:端口');
  if (!cfg.pairingToken || cfg.pairingToken.length < 24) throw new Error('尚未配对：请在连接设置中填写本机 DSH 配对码。');
  return { endpoint, pairingToken: cfg.pairingToken };
}

function createRequest(endpoint, pairingToken, controller) {
  return async (path, body) => {
    controller.signal.throwIfAborted();
    const response = await fetch(new URL(path, endpoint), {
      method: body ? 'POST' : 'GET', redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + pairingToken },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    const data = await response.json();
    if (!response.ok) throw new Error('DSH HTTP ' + response.status + ': ' + (data.error || '请求失败'));
    return data;
  };
}

/**
 * Pairing heartbeat: one authenticated health call at startup, every minute and whenever the
 * connection settings change, so the DSH settings page can show whether this extension is paired
 * (the Host records the last accepted and the last refused call). Failures are silent: an unpaired
 * extension is a normal state, and the options page reports details on demand.
 */
const HEARTBEAT_ALARM = 'dsh-mini-heartbeat';
async function heartbeat() {
  try {
    const { endpoint, pairingToken } = await loadConfig();
    await fetch(new URL('/v1/health', endpoint), { redirect: 'error', headers: { authorization: 'Bearer ' + pairingToken }, signal: AbortSignal.timeout(5000) });
  } catch { /* not paired or Host not running */ }
}
// Each hook is optional: a browser (or test host) without one still runs everything else.
chrome.alarms?.create(HEARTBEAT_ALARM, { periodInMinutes: 1 });
chrome.alarms?.onAlarm.addListener(alarm => { if (alarm.name === HEARTBEAT_ALARM) void heartbeat(); });
chrome.runtime.onStartup?.addListener(() => { void heartbeat(); });
chrome.runtime.onInstalled?.addListener(() => { void heartbeat(); });
chrome.storage.onChanged?.addListener((changes, area) => { if (area === 'local' && (changes.pairingToken || changes.endpoint)) void heartbeat(); });
if (chrome.alarms) void heartbeat();

/** Claim this document for one operation, so session mutations and rewrites serialise. */
async function withDocument(sender, message) {
  const { endpoint, pairingToken } = await loadConfig();
  const key = await documentKey(sender, message, endpoint.href, pairingToken);
  if (busyDocuments.has(key)) throw new Error('当前网页有会话操作或改写正在执行，请稍后重试。');
  busyDocuments.add(key);
  return { endpoint, pairingToken, key, release: () => busyDocuments.delete(key) };
}

/** Reuse the document's bound session, creating and persisting one when absent. */
async function boundSession(key, request, message) {
  let binding = (await chrome.storage.session.get(key))[key] || null;
  if (!binding) {
    const data = await request('/v1/sessions/new', { title: message.title || 'Browser selection' });
    if (typeof data.sessionId !== 'string') throw new Error('Host 不支持会话绑定，请升级 mini-panel。');
    binding = { sessionId: data.sessionId };
    await chrome.storage.session.set({ [key]: binding });
  }
  return binding;
}

/** Parse one SSE body, reporting each named event as it arrives. */
/** The Host bounds a whole run (10 min); the browser only detects a stream that went silent. */
const REQUEST_TIMEOUT_MS = 600000;
const IDLE_TIMEOUT_MS = 90000;
/** Abort when nothing arrives for `ms`; paused while a question waits for the user. */
function idleWatch(ms) {
  const controller = new AbortController();
  let timer = null, holds = 0, stopped = false;
  // Once stopped, late socket frames or chunks must not re-arm it (that would leak a timer).
  const arm = () => { clearTimeout(timer); timer = holds || stopped ? null : setTimeout(() => { const reason = new Error('idle'); reason.name = 'TimeoutError'; controller.abort(reason); }, ms); };
  arm();
  return { signal: controller.signal, touch: arm,
    hold() { holds++; arm(); }, release() { holds = Math.max(0, holds - 1); arm(); },
    stop() { stopped = true; clearTimeout(timer); timer = null; } };
}

async function readEvents(response, onEvent, onChunk) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    onChunk?.();
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf('\n\n');
    while (index >= 0) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      let event = '', data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data = line.slice(6);
      }
      if (event) onEvent(event, data ? JSON.parse(data) : {});
      index = buffer.indexOf('\n\n');
    }
  }
}

// The toolbar button carries the DSH mark only as a shortcut to the settings
// page: this extension has no popup, so a click would otherwise do nothing.
chrome.action?.onClicked.addListener(() => { void chrome.runtime.openOptionsPage(); });

/**
 * Side panel. The capsule hands its conversation to Chrome's native side panel, which shows the
 * real DSH client (served by the Host) for the same session; the panel can hand it back.
 *
 * `sidePanel.open()` needs a live user gesture, so the handler below calls it synchronously, before
 * any await. The panel page then asks for its own state (ticket + session) once it exists.
 */
const panelTabs = new Map(); // tabId -> { sessionId }, kept only while the panel is open for that tab
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false });
async function panelState(tabId) {
  const { endpoint, pairingToken } = await loadConfig();
  const request = createRequest(endpoint, pairingToken, new AbortController());
  const entry = panelTabs.get(tabId);
  await entry?.ready;
  const sessionId = panelTabs.get(tabId)?.sessionId;
  const ticket = await request('/v1/panel/ticket', sessionId ? { sessionId } : {});
  return { url: ticket.url, sessionId: sessionId || null };
}
chrome.tabs.onRemoved.addListener(tabId => { panelTabs.delete(tabId); });
chrome.tabs.onRemoved.addListener(async tabId => {
  const data = await chrome.storage.session.get(null);
  const keys = Object.keys(data).filter(key => key.startsWith('selection-binding:' + tabId + ':'));
  if (keys.length) await chrome.storage.session.remove(keys);
});

/** Tell the Host who shows this task's approvals and questions; socket first, HTTP as fallback. */
async function setSurface(task, surface) {
  try {
    const viaSocket = await task.socket?.rpc({ type: 'surface', surface });
    if (viaSocket?.ok) { bgLog('task/surface', { taskId: String(task.page.taskId).slice(-8), surface }); return; }
    const { endpoint, pairingToken } = await loadConfig();
    await createRequest(endpoint, pairingToken, new AbortController())('/v2/page/surface', { ...taskIdentity(task), surface });
    bgLog('task/surface', { taskId: String(task.page.taskId).slice(-8), surface, via: 'http' });
  } catch (error) {
    bgLog('task/surface-failed', { surface, message: String(error?.message || error).slice(0, 80) }, 'warn');
  }
}

/**
 * Side-panel lease. While the panel shows a tab's conversation, the content script holds one
 * `dsh-lease` port. The worker binds the page to that session on the Host for as long as the port
 * lives, so a turn started from the panel can still read and edit the page the capsule was handed
 * over from. Approvals and questions for it are answered in the panel (the GUI). The port closing
 * (panel closed, tab closed, page navigated, extension reloaded) releases the lease; the Host also
 * expires a lease whose page stopped answering.
 */
const LEASE_BIND_RETRIES = 8;
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'dsh-lease') return;
  let task = null, ended = false;
  const post = payload => { try { port.postMessage(payload); } catch { /* the page went away */ } };
  const teardown = async (reason) => {
    if (ended) return;
    ended = true;
    if (!task) return;
    const owned = task;
    owned.active = false;
    owned.expires = Date.now(); // let rememberTask's sweep drop it
    owned.socket?.close();
    bgLog('lease/end', { taskId: String(owned.page.taskId).slice(-8), reason });
    try {
      const { endpoint, pairingToken } = await loadConfig();
      await createRequest(endpoint, pairingToken, new AbortController())('/v1/panel/lease/release', taskIdentity(owned));
    } catch { /* already released, expired, or the Host is gone: the Host's own sweep covers it */ }
  };
  port.onDisconnect.addListener(() => { void teardown('port'); });
  port.onMessage.addListener(message => {
    if (message?.type !== 'lease' || task || ended) return;
    const sender = port.sender;
    void (async () => {
      try {
        const tabId = sender?.tab?.id;
        if (!Number.isInteger(tabId)) throw new Error('此操作需要在网页中使用。');
        const { endpoint, pairingToken } = await loadConfig();
        const request = createRequest(endpoint, pairingToken, new AbortController());
        // The panel shows the session the capsule is bound to; wait until open-panel resolved it.
        const entry = panelTabs.get(tabId);
        await entry?.ready;
        const sessionId = panelTabs.get(tabId)?.sessionId
          || (await boundSession(await documentKey(sender, message, endpoint.href, pairingToken), request, message)).sessionId;
        const owned = rememberTask(sender, message);
        owned.lease = true;
        owned.expires = Infinity;
        task = owned;
        // A capsule run that just finished may not have released the session on the Host yet.
        for (let attempt = 0; ; attempt++) {
          if (ended) return;
          try {
            await request('/v1/panel/lease', { sessionId, taskId: message.requestId, selectionId: message.selectionId, url: message.url, pageSession: message.pageSession });
            break;
          } catch (error) {
            if (attempt >= LEASE_BIND_RETRIES || !/HTTP 409/.test(String(error?.message))) throw error;
            await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
          }
        }
        if (ended) return;
        owned.ready = true;
        owned.socket = openPageSocket(owned, endpoint, pairingToken, frame => {
          if (frame.type === 'wake') post({ type: 'wake' });
          else if (frame.type === 'closed') { post({ type: 'ended', code: frame.ended ? 'TASK_ENDED' : 'DISCONNECTED' }); try { port.disconnect(); } catch { /* gone */ } void teardown(frame.ended ? 'host-ended' : 'socket'); }
        });
        bgLog('lease/bound', { taskId: String(owned.page.taskId).slice(-8), sessionId });
        post({ type: 'ready', sessionId });
      } catch (error) {
        bgLog('lease/failed', { message: String(error?.message || error).slice(0, 120) }, 'error');
        post({ type: 'error', message: error?.message || '侧边栏无法连接网页。' });
        try { port.disconnect(); } catch { /* gone */ }
        void teardown('failed');
      }
    })();
  });
});

/**
 * Live rewrite channel. The content script owns one port per task and renders the
 * model's reasoning and answer while the turn runs; the settled replacement still
 * arrives as the authoritative `done` payload.
 */
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'dsh-stream') return;
  let controller, pageTask;
  const stop = () => { if (pageTask) { pageTask.active = false; pageTask.socket?.close(); } controller?.abort(); controller = undefined; };
  port.onDisconnect.addListener(stop);
  port.onMessage.addListener(message => {
    if (message?.type === 'answer') {
      // A human answer from the panel; only the task that owns this port may send one.
      if (pageTask?.active && typeof message.interactionId === 'string') pageTask.socket?.send({ type: 'answer', interactionId: message.interactionId, value: message.value ?? null });
      return;
    }
    if (message?.type === 'surface') {
      // The capsule was handed to the side panel (or back) while this run is in flight.
      if (pageTask?.active && (message.surface === 'page' || message.surface === 'gui')) void setSurface(pageTask, message.surface);
      return;
    }
    if (!message || message.type === 'cancel') { stop(); return; }
    if (message.type !== 'rewrite' || controller) return;
    const own = new AbortController();
    controller = own;
    const send = payload => {
      if (own.signal.aborted) return;
      try { port.postMessage(payload); } catch { /* the page went away */ }
    };
    const sender = port.sender;
    const requestKey = String(sender?.tab?.id ?? 'options') + ':' + String(sender?.frameId ?? 0) + ':' + String(message.requestId);
    if (pending.has(requestKey)) { send({ type: 'error', message: '请求正在执行。' }); controller = undefined; return; }
    pending.set(requestKey, own);
    void (async () => {
      let release, idle;
      try {
        const document = await withDocument(sender, message);
        release = document.release;
        const request = createRequest(document.endpoint, document.pairingToken, own);
        const binding = await boundSession(document.key, request, message);
        pageTask = rememberTask(sender, message);
        idle = idleWatch(IDLE_TIMEOUT_MS);
        const response = await fetch(new URL('/v1/rewrite/stream', document.endpoint), {
          method: 'POST', redirect: 'error',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + document.pairingToken },
          body: JSON.stringify({ requestId: message.requestId, selectionId: message.selectionId, sessionId: binding.sessionId,
            mode: message.mode || 'rewrite', text: message.text, instruction: message.instruction, url: message.url, title: message.title,
            pageContext: message.pageContext, pageSession: message.pageSession }),
          signal: AbortSignal.any([own.signal, idle.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        });
        if (!response.ok || !response.body) {
          const detail = await response.json().catch(() => null);
          throw new Error('DSH HTTP ' + response.status + ': ' + (detail?.error || '请求失败'));
        }
        let settled = false;
        await readEvents(response, (event, data) => {
          if (event === 'ready') { if (!pageTask.socket) pageTask.socket = openPageSocket(pageTask, document.endpoint, document.pairingToken, frame => { idle.touch(); if (frame.type === 'ask') idle.hold(); else if (frame.type === 'ask-done' || frame.type === 'ask-cancel') idle.release(); if (frame.type === 'wake') send({ type: 'wake' }); else if (frame.type === 'ask' || frame.type === 'ask-cancel' || frame.type === 'ask-invalid' || frame.type === 'ask-done') send({ type: frame.type, frame }); }); pageTask.ready = true; bgLog('sse/ready', { taskId: String(pageTask.page.taskId).slice(-8), sessionId: data.sessionId }); send({ type: 'ready', sessionId: data.sessionId }); return; }
          if (event === 'reset') { bgLog('sse/reset', { taskId: String(pageTask.page.taskId).slice(-8) }); send({ type: 'reset' }); return; }
          if (event === 'thinking') { send({ type: 'thinking', text: data.text }); return; }
          if (event === 'text') { send({ type: 'text', text: data.text }); return; }
          if (event === 'error') { settled = true; bgLog('sse/error', { status: data.status, message: String(data.message || '').slice(0, 80) }, 'error'); send({ type: 'error', status: data.status, message: data.message || '改写失败' }); return; }
          if (event !== 'done') return;
          settled = true;
          if (data.requestId !== message.requestId || data.selectionId !== message.selectionId || data.sessionId !== binding.sessionId
            || typeof data.replacement !== 'string' || data.replacement.length > MAX_REPLACEMENT) {
            send({ type: 'error', message: 'DSH 返回结果不匹配当前选区或绑定会话。' });
            return;
          }
          send({ type: 'done', replacement: data.replacement, sessionId: data.sessionId, binding });
        }, () => idle.touch());
        if (!settled && !own.signal.aborted) send({ type: 'error', message: '流式连接提前结束，请重试。' });
      } catch (error) {
        const cancelled = own.signal.aborted;
        const stalled = !cancelled && idle?.signal.aborted;
        const timedOut = !cancelled && error?.name === 'TimeoutError';
        send({ type: 'error', code: cancelled ? 'CANCELLED' : timedOut || stalled ? 'TIMEOUT' : 'BRIDGE_ERROR',
          message: cancelled ? '已取消。' : stalled ? 'DSH 超过 ' + IDLE_TIMEOUT_MS / 1000 + ' 秒没有响应，已停止等待，请重试。'
            : timedOut ? '任务超过 ' + REQUEST_TIMEOUT_MS / 60000 + ' 分钟仍未完成，已停止等待。' : (error.message || 'DSH 连接失败') });
      } finally {
        idle?.stop();
        if (pageTask) { pageTask.active = false; pageTask.socket?.close(); }
        if (pending.get(requestKey) === own) pending.delete(requestKey);
        release?.();
        if (controller === own) controller = undefined;
      }
    })();
  });
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !message || !types.includes(message.type)) {
    respond(fail('INVALID_MESSAGE', '不支持的扩展请求')); return false;
  }
  const requestKey = String(sender.tab?.id ?? 'options') + ':' + String(sender.frameId ?? 0) + ':' + String(message.requestId);
  if (message.type === 'cancel') {
    const t = pageTasks.get(message.requestId);
    if (t && t.tabId === sender.tab?.id && t.frameId === (sender.frameId || 0)) t.active = false;
    pending.get(requestKey)?.abort(); // 立即中止本地 fetch
    
    // 异步通知 Host 端中止（不阻塞响应）
    (async () => {
      try {
        const { endpoint, pairingToken } = await loadConfig();
        await fetch(new URL('/v1/rewrite/cancel', endpoint), {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + pairingToken },
          body: JSON.stringify({ requestId: message.requestId }),
          signal: AbortSignal.timeout(5000),
        });
        bgLog('cancel-sent', { requestId: message.requestId });
      } catch (err) {
        // 静默失败：本地已 abort，Host 端失败不影响 UI
        bgLog('cancel-failed', { requestId: message.requestId, error: String(err) }, 'warn');
      }
    })();
    
    respond({ ok: true });
    return false;
  }
  if (message.type === 'open-panel') {
    // sidePanel.open() is only allowed inside the click's user gesture, so it runs before any await.
    const tabId = sender.tab?.id;
    if (!Number.isInteger(tabId) || !chrome.sidePanel?.open) { respond(fail('NO_SIDE_PANEL', '当前浏览器不支持侧边栏。')); return false; }
    const entry = { sessionId: null, ready: null };
    panelTabs.set(tabId, entry);
    // The conversation the capsule is bound to (created now if there is none yet) is what the panel shows.
    entry.ready = (async () => {
      const { endpoint, pairingToken } = await loadConfig();
      const request = createRequest(endpoint, pairingToken, new AbortController());
      const key = await documentKey(sender, message, endpoint.href, pairingToken);
      entry.sessionId = (await boundSession(key, request, message)).sessionId;
    })().catch(error => { bgLog('panel/session-failed', { message: String(error?.message || error).slice(0, 80) }, 'error'); });
    chrome.sidePanel.setOptions({ tabId, path: 'src/sidepanel.html', enabled: true }).catch(() => {});
    chrome.sidePanel.open({ tabId }).then(() => respond({ ok: true }), error => { panelTabs.delete(tabId); respond(fail('NO_SIDE_PANEL', error?.message || '无法打开侧边栏。')); });
    return true;
  }
  if (message.type === 'panel-state') {
    // Only the extension's own panel page may ask: it mints a ticket that opens the real DSH client.
    // A content script's sender.url is always its web page, never a chrome-extension:// URL.
    if (!sender.url?.startsWith(chrome.runtime.getURL('src/sidepanel.html'))) { respond(fail('INVALID_MESSAGE', '不支持的扩展请求')); return false; }
    const tabId = Number.isInteger(message.tabId) ? message.tabId : null;
    if (tabId === null) { respond(fail('INVALID_MESSAGE', '缺少标签页')); return false; }
    panelState(tabId).then(state => respond({ ok: true, ...state }), error => respond(fail('BRIDGE_ERROR', error.message || 'DSH 连接失败')));
    return true;
  }
  if (message.type === 'panel-close') {
    const fromPanel = !sender.tab && sender.url?.startsWith(chrome.runtime.getURL('src/sidepanel.html'));
    const tabId = fromPanel ? (Number.isInteger(message.tabId) ? message.tabId : null) : sender.tab?.id;
    if (!Number.isInteger(tabId)) { respond(fail('INVALID_MESSAGE', '缺少标签页')); return false; }
    (async () => {
      const entry = panelTabs.get(tabId);
      await entry?.ready;                       // the session may still be resolving if the panel closed instantly
      const sessionId = entry?.sessionId || null;
      panelTabs.delete(tabId);
      chrome.sidePanel?.setOptions?.({ tabId, enabled: false }).catch(() => {});
      // Tell the page's capsule it can come back; it keeps its own binding, so nothing else moves.
      chrome.tabs.sendMessage(tabId, { type: 'panel-closed', sessionId }).catch(() => {});
      respond({ ok: true });
    })();
    return true;
  }
  if (message.type === 'options') { void chrome.runtime.openOptionsPage(); respond({ ok: true }); return false; }
  const controller = new AbortController();
  if (message.type === 'rewrite') {
    if (pending.has(requestKey)) { respond(fail('BUSY', '请求正在执行。')); return false; }
    pending.set(requestKey, controller);
  }
  (async () => {
    let release, pageTask;
    try {
      const { endpoint, pairingToken } = await loadConfig();
      const request = createRequest(endpoint, pairingToken, controller);
      if (message.type === 'health') { respond({ ok: true, result: await request('/v1/health') }); return; }
      if (message.type === 'session-list') { respond({ ok: true, sessions: (await request('/v1/sessions')).sessions }); return; }
      if (message.type === 'desktop-result') { respond({ ok: true, result: await request('/v1/desktop/result?selectionId=' + encodeURIComponent(message.selectionId)) }); return; }
      if (message.type === 'page-image') {
        // Only an authenticated page task, while it is executing a command, may ask for bytes.
        const t = taskFor(sender, message);
        if (!t.active || typeof message.src !== 'string' || !t.started.has(message.commandId)) { respond(fail('INVALID_MESSAGE', 'Image fetch outside a running page command')); return; }
        respond({ ok: true, result: await fetchImage(message.src) }); return;
      }
      if (message.type === 'page-inspect') {
        if (message.spec?.action !== 'read') { respond(fail('INVALID_MESSAGE', 'Inspection is read-only')); return; }
        // The MAIN-world bridge is reachable from this extension only, but the read itself must
        // still belong to an authenticated page task, exactly like every other page call.
        taskFor(sender, message);
        respond({ ok: true, result: await modelCall(sender, message.spec) }); return;
      }
      if (['page-claim', 'page-start', 'page-result', 'page-model'].includes(message.type)) {
        const t = taskFor(sender, message), identity = taskIdentity(t);
        if (message.type === 'page-claim') {
          if (!t.active || !t.ready) { respond({ ok: true, command: null }); return; }
          // With a live socket the Host pushes commands; answer from the local queue, no HTTP poll.
          if (t.socket?.open) { respond({ ok: true, command: t.socket.take(), pushed: true }); return; }
          respond({ ok: true, ...await request('/v2/page/claim', identity) }); return;
        }
        if (message.type === 'page-start') {
          if (!t.active) { respond({ ok: true, execute: false, code: 'CANCELLED' }); return; }
          const viaSocket = await t.socket?.rpc({ type: 'start', commandId: message.commandId, leaseId: message.leaseId });
          const data = viaSocket && viaSocket.ok !== false ? (({ type: _type, rid: _rid, ...rest }) => rest)(viaSocket) : await request('/v2/page/start', { ...identity, commandId: message.commandId, leaseId: message.leaseId });
          if (data.execute) t.started.set(message.commandId, { leaseId: message.leaseId, committed: false });
          respond({ ok: true, ...data }); return;
        }
        if (message.type === 'page-result') {
          const started = t.started.get(message.commandId);
          if (!started || started.leaseId !== message.leaseId) throw Error('Result has no owned execution lease');
          const record = { ...identity, commandId: message.commandId, leaseId: message.leaseId, outcome: message.outcome };
          // Persist BEFORE the request so a killed worker or a failed POST cannot lose an edit
          // that has already been applied to the page.
          await storeResult(record);
          try {
            const viaSocket = await t.socket?.rpc({ type: 'result', commandId: message.commandId, leaseId: message.leaseId, outcome: message.outcome });
            if (!viaSocket || viaSocket.ok !== true) await request('/v2/page/result', record);
            await dropResult(record);
            respond({ ok: true, acknowledged: true }); return;
          } catch (error) {
            // The page keeps its own copy and reports REPORT_PENDING; this one is retried here.
            respond({ ok: false, error: { message: error.message || '结果回报失败' } }); return;
          }
        }
        const started = t.started.get(message.commandId);
        if (!started || started.leaseId !== message.leaseId) throw Error('Editor request has no execution lease');
        if (message.spec?.action === 'edit') {
          if (!t.active) { respond({ ok: true, result: { ok: false, code: 'CANCELLED', modification: 'not-modified', verification: 'none', retryable: false } }); return; }
          if (started.committed) { respond({ ok: true, result: { ok: false, code: 'ALREADY_SUBMITTED', modification: 'unknown', verification: 'none', retryable: false } }); return; }
          started.committed = true;
        }
        respond({ ok: true, result: await modelCall(sender, message.spec) }); return;
      }
      const key = await documentKey(sender, message, endpoint.href, pairingToken);
      if (message.type !== 'session-state') {
        if (busyDocuments.has(key)) throw new Error('当前网页有会话操作或改写正在执行，请稍后重试。');
        busyDocuments.add(key); release = () => busyDocuments.delete(key);
      }
      let binding = (await chrome.storage.session.get(key))[key] || null;
      const storeBinding = async value => { binding = value; await chrome.storage.session.set({ [key]: value }); };
      if (message.type === 'session-state') { respond({ ok: true, binding }); return; }
      if (message.type === 'session-detach') {
        await chrome.storage.session.remove(key); respond({ ok: true, binding: null }); return;
      }
      if (message.type === 'session-bind') {
        const data = await request('/v1/sessions/bind', { sessionId: message.sessionId });
        await storeBinding({ sessionId: data.sessionId }); respond({ ok: true, binding }); return;
      }
      if (message.type === 'session-new' || !binding) {
        const data = await request('/v1/sessions/new', { title: message.title || 'Browser selection' });
        if (typeof data.sessionId !== 'string') throw new Error('Host 不支持会话绑定，请升级 mini-panel。');
        await storeBinding({ sessionId: data.sessionId });
      }
      if (message.type === 'session-new') { respond({ ok: true, binding }); return; }
      if (message.type === 'desktop-open') {
        const data = await request('/v1/desktop/open', { selectionId: message.selectionId, sessionId: binding.sessionId, text: message.text, url: message.url, title: message.title });
        respond({ ok: true, binding, result: data }); return;
      }
      pageTask = rememberTask(sender, message);
      pageTask.ready = true;
      const data = await request('/v1/rewrite', { requestId: message.requestId, selectionId: message.selectionId,
        sessionId: binding.sessionId, mode: message.mode || 'rewrite', text: message.text, instruction: message.instruction, url: message.url, title: message.title,
        pageContext: message.pageContext, pageSession: message.pageSession });
      if (data.requestId !== message.requestId || data.selectionId !== message.selectionId || data.sessionId !== binding.sessionId || typeof data.replacement !== 'string' || data.replacement.length > MAX_REPLACEMENT) throw new Error('DSH 返回结果不匹配当前选区或绑定会话。');
      respond({ ok: true, ...data, binding });
    } catch (error) { respond(fail(controller.signal.aborted ? 'CANCELLED' : 'BRIDGE_ERROR', error.message || 'DSH 连接失败')); }
    finally {
      if (pageTask) pageTask.active = false;
      if (pending.get(requestKey) === controller) pending.delete(requestKey);
      release?.();
    }
  })(); return true;
});
