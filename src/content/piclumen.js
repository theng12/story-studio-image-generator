// Isolated-world bridge for the dedicated PicLumen MAIN-world adapter.

// Guarded so re-injection (auto-heal of a stale tab) can't redeclare and crash.
if (!globalThis.__STORY_STUDIO_PICLUMEN_BRIDGE__) {
  globalThis.__STORY_STUDIO_PICLUMEN_BRIDGE__ = true;

  const REQ = 'STUDIO_PICLUMEN_REQ';
  const RES = 'STUDIO_PICLUMEN_RES';
  let seq = 0;
  const pending = new Map();

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.kind !== RES) return;
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    event.data.ok
      ? request.resolve(event.data.result)
      : request.reject(Object.assign(new Error(event.data.error || 'PicLumen error.'), { limit: !!event.data.limit }));
  });

  const callMain = (op, payload = {}, timeoutMs = 240000) => {
    const id = `${Date.now()}-${seq++}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      window.postMessage({ kind: REQ, id, op, payload }, '*');
      setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(`PicLumen "${op}" timed out.`));
      }, timeoutMs);
    });
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'piclumen:generateImage' && message?.type !== 'piclumen:getContext') return false;
    const op = message.type === 'piclumen:generateImage' ? 'generateImage' : 'getContext';
    callMain(op, message.params || {})
      .then((result) => sendResponse({ ok: true, ...result, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error), limit: !!error.limit }));
    return true;
  });
}
