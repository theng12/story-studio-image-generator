// Isolated content script on grok.com.
//
// Bridges the extension (background) to the MAIN-world grok-main.js, and
// persists the captured generate-request TEMPLATE to chrome.storage so it
// survives reloads and is reused on later visits (capture once, replay forever
// until Grok changes its API).

const REQ = 'GROKEXT_REQ';
const RES = 'GROKEXT_RES';
const TEMPLATE_KEY = 'grokTemplate';
let seq = 0;
const pending = new Map();

function persistableTemplate(template) {
  if (!template?.url || !template?.body) return null;
  return {
    url: template.url,
    method: template.method || 'POST',
    body: template.body,
  };
}

window.addEventListener('message', (ev) => {
  if (ev.source !== window) return;
  const d = ev.data;
  if (d && d.kind === RES) {
    const p = pending.get(d.id);
    if (!p) return;
    pending.delete(d.id);
    d.ok ? p.resolve(d) : p.reject(Object.assign(new Error(d.error || 'grok error'), { limit: d.limit }));
    return;
  }
  // Persist a freshly captured template.
  if (d && d.kind === 'GROKEXT_EVENT' && d.event === 'grok:templateCaptured') {
    const safe = persistableTemplate(d.payload.template);
    if (safe) chrome.storage.local.set({ [TEMPLATE_KEY]: safe }).catch(() => {});
  }
});

function callMain(op, payload, timeoutMs = 180000) {
  const id = `${Date.now()}-${seq++}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    window.postMessage({ kind: REQ, id, op, payload }, '*');
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Grok "${op}" timed out.`));
      }
    }, timeoutMs);
  });
}

// On load, push any persisted template into the main world so replay works
// without re-capturing.
(async () => {
  try {
    const { [TEMPLATE_KEY]: t } = await chrome.storage.local.get(TEMPLATE_KEY);
    const safe = persistableTemplate(t);
    if (safe) {
      // Scrub headers captured by older releases before using the template.
      await chrome.storage.local.set({ [TEMPLATE_KEY]: safe });
      // wait a tick for grok-main to install its listener
      setTimeout(() => callMain('loadTemplate', safe).catch(() => {}), 800);
    }
  } catch {
    /* ignore */
  }
})();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const ops = {
    'grok:generateImage': () => callMain('generateImage', msg.params),
    'grok:getContext': () => callMain('getContext', {}),
    'grok:getCapture': () => callMain('getCapture', {}),
  };
  const run = ops[msg?.type];
  if (!run) return false;
  run()
    .then((r) => sendResponse({ ok: true, ...(r.result || r), result: r.result }))
    .catch((e) => sendResponse({ ok: false, error: String(e.message || e), limit: !!e.limit }));
  return true;
});
