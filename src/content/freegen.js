const callFreeGen = (op, payload = {}, timeoutMs = 240000) => {
  const adapter = globalThis.__STORY_STUDIO_FREEGEN_CALL__;
  if (typeof adapter !== 'function') return Promise.reject(new Error('FreeGen adapter is not ready.'));
  return Promise.race([
    Promise.resolve().then(() => adapter(op, payload)),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`FreeGen "${op}" timed out.`)), timeoutMs)
    ),
  ]);
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'freegen:generateImage' && message?.type !== 'freegen:getContext') return false;
  const op = message.type === 'freegen:generateImage' ? 'generateImage' : 'getContext';
  callFreeGen(op, message.params || {})
    .then((result) => sendResponse({ ok: true, ...result, result }))
    .catch((error) =>
      sendResponse({ ok: false, error: String(error.message || error), limit: !!error.limit })
    );
  return true;
});
