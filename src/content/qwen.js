// Isolated-world bridge for the dedicated Qwen Studio MAIN-world adapter.

if (!globalThis.__STORY_STUDIO_QWEN_BRIDGE__) {
  globalThis.__STORY_STUDIO_QWEN_BRIDGE__ = true;

  const REQ = 'STUDIO_QWEN_REQ';
  const RES = 'STUDIO_QWEN_RES';
  const PROGRESS = 'STUDIO_QWEN_PROGRESS';
  let seq = 0;
  const pending = new Map();

  // Relay sub-phase notes (upload vs generate) from the MAIN world to the worker.
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.kind !== PROGRESS) return;
    // After the extension is reloaded, this orphaned content script's
    // chrome.runtime is invalidated and sendMessage throws SYNCHRONOUSLY (so a
    // .catch() alone doesn't help). Guard on runtime.id and swallow the throw.
    try {
      if (!chrome.runtime?.id) return;
      chrome.runtime.sendMessage({ type: 'qwen:progress', phase: event.data.phase }).catch(() => {});
    } catch {
      /* extension context invalidated — reload the Qwen tab to re-inject */
    }
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.kind !== RES) return;
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    event.data.ok
      ? request.resolve(event.data.result)
      : request.reject(Object.assign(new Error(event.data.error || 'Qwen Studio error.'), { limit: !!event.data.limit }));
  });

  function callMain(op, payload = {}, timeoutMs = 300000) {
    const id = `${Date.now()}-${seq++}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      window.postMessage({ kind: REQ, id, op, payload }, '*');
      setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(`Qwen Studio "${op}" timed out.`));
      }, timeoutMs);
    });
  }

  const OPS = {
    'qwen:generateImage': 'generateImage',
    'qwen:getContext': 'getContext',
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const op = OPS[message?.type];
    if (!op) return false;
    callMain(op, message.params || {})
      .then((result) => sendResponse({ ok: true, ...result, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error), limit: !!error.limit }));
    return true;
  });
}
