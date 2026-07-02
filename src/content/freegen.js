// Isolated-world bridge for the dedicated FreeGen MAIN-world adapter.

const REQ = 'STUDIO_FREEGEN_REQ';
const RES = 'STUDIO_FREEGEN_RES';
let seq = 0;
const pending = new Map();

window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.kind !== RES) return;
  const request = pending.get(event.data.id);
  if (!request) return;
  pending.delete(event.data.id);
  event.data.ok
    ? request.resolve(event.data.result)
    : request.reject(Object.assign(new Error(event.data.error || 'FreeGen error.'), { limit: !!event.data.limit }));
});

function callMain(op, payload = {}, timeoutMs = 240000) {
  const id = `${Date.now()}-${seq++}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    window.postMessage({ kind: REQ, id, op, payload }, '*');
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error(`FreeGen "${op}" timed out.`));
    }, timeoutMs);
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'freegen:generateImage' && message?.type !== 'freegen:getContext') return false;
  const op = message.type === 'freegen:generateImage' ? 'generateImage' : 'getContext';
  callMain(op, message.params || {})
    .then((result) => sendResponse({ ok: true, ...result, result }))
    .catch((error) => sendResponse({ ok: false, error: String(error.message || error), limit: !!error.limit }));
  return true;
});
