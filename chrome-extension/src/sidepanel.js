/* Side panel page: the real DSH client in a frame, served by the Host, plus one control to hand back. */
(() => {
  const frame = document.getElementById('frame');
  const status = document.getElementById('status');
  const back = document.getElementById('back');
  let tabId = null;
  let loaded = null;   // origin of the frame's current document
  let session = null;

  const say = (text, error = false, retry = false) => {
    status.hidden = false; frame.hidden = true;
    status.textContent = text; status.dataset.error = String(error);
    if (retry) { const b = document.createElement('button'); b.type = 'button'; b.textContent = '重试'; b.addEventListener('click', () => void load()); status.append(b); }
  };
  const ask = message => chrome.runtime.sendMessage({ ...message, tabId }).catch(error => ({ ok: false, error: { message: error?.message } }));

  async function load() {
    say('正在连接 DSH…');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id ?? null;
    const reply = await ask({ type: 'panel-state' });
    if (!reply?.ok) { say(reply?.error?.message || '无法连接 DSH，请确认 DSH 正在运行并已配对。', true, true); return; }
    session = reply.sessionId;
    loaded = new URL(reply.url).origin;
    frame.src = reply.url;
    frame.hidden = false; status.hidden = true;
  }

  // A different bound session for this tab (rebind in the capsule): one message, no reload.
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type !== 'panel-session' || message.tabId !== tabId || typeof message.sessionId !== 'string') return;
    session = message.sessionId;
    if (loaded) frame.contentWindow?.postMessage({ type: 'dsh-panel/open-session', sessionId: session }, loaded);
  });

  back.addEventListener('click', async () => {
    await ask({ type: 'panel-close' });
    window.close();
  });

  void load();
})();
