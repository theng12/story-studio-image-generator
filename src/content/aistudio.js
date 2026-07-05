// Isolated-world bridge for Google AI Studio. Relays the queue's messages to the
// MAIN-world driver (which owns the DOM automation) and back.

(() => {
  const REQ = 'STUDIO_AISTUDIO_REQ';
  const RES = 'STUDIO_AISTUDIO_RES';
  let seq = 0;
  const pending = new Map();

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.kind !== RES) return;
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    if (event.data.ok) request.resolve(event.data.result);
    else request.reject(Object.assign(new Error(event.data.error || 'AI Studio error.'), { limit: event.data.limit }));
  });

  function callMain(op, payload = {}, timeoutMs = 240000) {
    const id = `${Date.now()}-${seq++}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      window.postMessage({ kind: REQ, id, op, payload }, '*');
      setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(`AI Studio "${op}" timed out.`));
      }, timeoutMs);
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'aistudio:generateImage' && message?.type !== 'aistudio:getContext') return false;
    const op = message.type === 'aistudio:generateImage' ? 'generateImage' : 'getContext';
    callMain(op, message.params || {})
      .then((result) => sendResponse({ ok: true, ...result, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error), limit: !!error.limit }));
    return true;
  });
})();
