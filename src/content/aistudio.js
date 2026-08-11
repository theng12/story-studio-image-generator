(() => {
  globalThis.__STORY_STUDIO_AISTUDIO_CHECKPOINT__ = async (token) => {
    const response = await chrome.runtime.sendMessage({ type: 'providerSubmissionCheckpoint', token });
    if (!response?.ok) throw new Error(response?.error || 'AI Studio submission checkpoint failed.');
  };

  const callAdapter = (op, payload = {}, timeoutMs = 240000) => {
    const adapter = globalThis.__STORY_STUDIO_AISTUDIO_CALL__;
    if (typeof adapter !== 'function') return Promise.reject(new Error('AI Studio adapter is not ready.'));
    return Promise.race([
      Promise.resolve().then(() => adapter(op, payload)),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`AI Studio "${op}" timed out.`)), timeoutMs)
      ),
    ]);
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'aistudio:generateImage' && message?.type !== 'aistudio:getContext') return false;
    const op = message.type === 'aistudio:generateImage' ? 'generateImage' : 'getContext';
    callAdapter(op, message.params || {})
      .then((result) => sendResponse({ ok: true, ...result, result }))
      .catch((error) =>
        sendResponse({ ok: false, error: String(error.message || error), limit: !!error.limit })
      );
    return true;
  });
})();
