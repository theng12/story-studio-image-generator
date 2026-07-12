// Isolated-world bridge for the dedicated ChatGPT MAIN-world adapter.

// Guarded so re-injection (auto-heal of a stale tab) can't redeclare and crash.
if (!globalThis.__STORY_STUDIO_CHATGPT_BRIDGE__) {
  globalThis.__STORY_STUDIO_CHATGPT_BRIDGE__ = true;

  const REQ = 'STUDIO_CHATGPT_REQ';
  const RES = 'STUDIO_CHATGPT_RES';
  const PROGRESS = 'STUDIO_CHATGPT_PROGRESS';
  let seq = 0;
  const pending = new Map();

  // Live sub-phase notes (e.g. "uploading reference" → "generating") from the
  // MAIN-world driver, surfaced in the panel status line.
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.kind !== PROGRESS) return;
    chrome.runtime.sendMessage({ type: 'chatgpt:progress', phase: event.data.phase }).catch(() => {});
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.kind !== RES) return;
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    event.data.ok
      ? request.resolve(event.data.result)
      : request.reject(Object.assign(new Error(event.data.error || 'ChatGPT error.'), { limit: !!event.data.limit }));
  });

  const callMain = (op, payload = {}, timeoutMs = 240000) => {
    const id = `${Date.now()}-${seq++}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      window.postMessage({ kind: REQ, id, op, payload }, '*');
      setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(`ChatGPT "${op}" timed out.`));
      }, timeoutMs);
    });
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'chatgpt:generateImage' && message?.type !== 'chatgpt:getContext') return false;
    const op = message.type === 'chatgpt:generateImage' ? 'generateImage' : 'getContext';
    callMain(op, message.params || {})
      .then((result) => sendResponse({ ok: true, ...result, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error), limit: !!error.limit }));
    return true;
  });
}
