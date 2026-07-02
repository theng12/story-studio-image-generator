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

const OPS = {
  'leonardo:generateImage': 'generateImage',
  'leonardo:getContext': 'getContext',
  'leonardo:listModels': 'listModels',
  'leonardo:modelControls': 'modelControls',
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const op = OPS[message?.type];
  if (!op) return false;
  callMain(op, message.params || {})
    .then((result) => sendResponse({ ok: true, ...result, result }))
    .catch((error) => sendResponse({ ok: false, error: String(error.message || error), limit: !!error.limit }));
  return true;
});
