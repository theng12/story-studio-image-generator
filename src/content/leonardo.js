// Isolated-world bridge for the dedicated Leonardo AI MAIN-world adapter.

const REQ = 'STUDIO_LEONARDO_REQ';
const RES = 'STUDIO_LEONARDO_RES';
let seq = 0;
const pending = new Map();

window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.kind !== RES) return;
  const request = pending.get(event.data.id);
  if (!request) return;
  pending.delete(event.data.id);
  event.data.ok
    ? request.resolve(event.data.result)
    : request.reject(Object.assign(new Error(event.data.error || 'Leonardo AI error.'), { limit: !!event.data.limit }));
});

function callMain(op, payload = {}, timeoutMs = 270000) {
  const id = `${Date.now()}-${seq++}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    window.postMessage({ kind: REQ, id, op, payload }, '*');
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error(`Leonardo AI "${op}" timed out.`));
    }, timeoutMs);
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'leonardo:generateImage' && message?.type !== 'leonardo:getContext') return false;
  const op = message.type === 'leonardo:generateImage' ? 'generateImage' : 'getContext';
  callMain(op, message.params || {})
    .then((result) => sendResponse({ ok: true, ...result, result }))
    .catch((error) => sendResponse({ ok: false, error: String(error.message || error), limit: !!error.limit }));
  return true;
});
