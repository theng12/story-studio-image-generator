// Isolated content script on labs.google/fx.
//
// Bridges the extension (background/panel) to the MAIN-world `flow-main.js`,
// which owns the Flow API calls (it needs the page's grecaptcha + NextAuth
// session). This world has chrome.* but not the page's JS objects; the main
// world has the page objects but not chrome.*. They talk over postMessage.

const REQ = 'FLOWEXT_REQ';
const RES = 'FLOWEXT_RES';
let seq = 0;
const pending = new Map();

window.addEventListener('message', (ev) => {
  if (ev.source !== window) return;
  const d = ev.data;
  if (!d || d.kind !== RES) return;
  const p = pending.get(d.id);
  if (!p) return;
  pending.delete(d.id);
  d.ok ? p.resolve(d.result) : p.reject(new Error(d.error || 'main-world error'));
});

function callMain(op, payload, timeoutMs = 180000) {
  const id = `${Date.now()}-${seq++}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    window.postMessage({ kind: REQ, id, op, payload }, '*');
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Flow "${op}" timed out.`));
      }
    }, timeoutMs);
  });
}

// When this page is a Flow project, tell the background so the panel can offer
// it as the working project without the user copying a UUID.
(function reportProject() {
  const m = location.pathname.match(/\/project\/([0-9a-f-]{36})/i);
  if (!m) return;
  // Guard against a reloaded-extension orphan: chrome.runtime.sendMessage throws
  // synchronously when the context is invalidated, so .catch() alone won't do.
  try {
    if (chrome.runtime?.id) chrome.runtime.sendMessage({ type: 'flow:projectSeen', projectId: m[1] }).catch(() => {});
  } catch {
    /* extension context invalidated — reload the tab to re-inject */
  }
})();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const ops = {
    'flow:generateImage': () => callMain('generateImage', msg.params),
    'flow:submitVideo': () => callMain('submitVideo', msg.params),
    'flow:submitVideoStartImage': () => callMain('submitVideoStartImage', msg.params),
    'flow:uploadImage': () => callMain('uploadImage', msg.params, 60000),
    'flow:checkVideo': () => callMain('checkVideo', msg.params, 30000),
    'flow:getContext': () => callMain('getContext', {}),
  };
  const run = ops[msg?.type];
  if (!run) return false;
  run()
    .then((r) => sendResponse({ ok: true, ...r, result: r }))
    .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
  return true;
});
