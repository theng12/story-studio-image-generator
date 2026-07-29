if (!globalThis.__STORY_STUDIO_CHATGPT_BRIDGE__) {
  globalThis.__STORY_STUDIO_CHATGPT_BRIDGE__ = true;
  globalThis.__STORY_STUDIO_CHATGPT_PROGRESS__ = (phase) => {
    chrome.runtime.sendMessage({ type: 'chatgpt:progress', phase }).catch(() => {});
  };

  const callAdapter = (op, payload = {}, timeoutMs = 1200000) => {
    const adapter = globalThis.__STORY_STUDIO_CHATGPT_CALL__;
    if (typeof adapter !== 'function') return Promise.reject(new Error('ChatGPT adapter is not ready.'));
    return Promise.race([
      Promise.resolve().then(() => adapter(op, payload)),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`ChatGPT "${op}" timed out.`)), timeoutMs)
      ),
    ]);
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'chatgpt:generateImage' && message?.type !== 'chatgpt:getContext') return false;
    const op = message.type === 'chatgpt:generateImage' ? 'generateImage' : 'getContext';
    callAdapter(op, message.params || {})
      .then((result) => sendResponse({ ok: true, ...result, result }))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error.message || error), limit: !!error.limit })
      );
    return true;
  });
}
