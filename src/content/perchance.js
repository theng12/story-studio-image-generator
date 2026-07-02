// Isolated-world bridge for the Perchance generator subframe. This script is
// intentionally inactive in the top shell and ad frames so tabs.sendMessage
// receives exactly one response from the real generator document.

(() => {
  const isGeneratorFrame =
    location.hostname !== 'perchance.org' &&
    location.hostname.endsWith('.perchance.org') &&
    location.pathname.startsWith('/ai-text-to-image-generator');
  if (!isGeneratorFrame) return;

  const REQ = 'STUDIO_PERCHANCE_REQ';
  const RES = 'STUDIO_PERCHANCE_RES';
  let seq = 0;
  const pending = new Map();

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.kind !== RES) return;
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    event.data.ok ? request.resolve(event.data.result) : request.reject(new Error(event.data.error || 'Perchance error.'));
  });

  function callMain(op, payload = {}, timeoutMs = 240000) {
    const id = `${Date.now()}-${seq++}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      window.postMessage({ kind: REQ, id, op, payload }, '*');
      setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(`Perchance "${op}" timed out.`));
      }, timeoutMs);
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'perchance:generateImage' && message?.type !== 'perchance:getContext') return false;
    const op = message.type === 'perchance:generateImage' ? 'generateImage' : 'getContext';
    callMain(op, message.params || {})
      .then((result) => sendResponse({ ok: true, ...result, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  });
})();
