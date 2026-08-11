if (!globalThis.__STORY_STUDIO_QWEN_BRIDGE__) {
  globalThis.__STORY_STUDIO_QWEN_BRIDGE__ = true;
  globalThis.__STORY_STUDIO_QWEN_CHECKPOINT__ = async (token) => {
    const response = await chrome.runtime.sendMessage({ type: 'providerSubmissionCheckpoint', token });
    if (!response?.ok) throw new Error(response?.error || 'Qwen Studio submission checkpoint failed.');
  };
  globalThis.__STORY_STUDIO_QWEN_PROGRESS__ = (phase) => {
    try {
      chrome.runtime.sendMessage({ type: 'qwen:progress', phase }).catch(() => {});
    } catch {
      // Extension context was invalidated; reloading the tab restores it.
    }
  };

  const callAdapter = (op, payload = {}, timeoutMs = 300000) => {
    const adapter = globalThis.__STORY_STUDIO_QWEN_CALL__;
    if (typeof adapter !== 'function') return Promise.reject(new Error('Qwen Studio adapter is not ready.'));
    return Promise.race([
      Promise.resolve().then(() => adapter(op, payload)),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Qwen Studio "${op}" timed out.`)), timeoutMs)
      ),
    ]);
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const op = {
      'qwen:generateImage': 'generateImage',
      'qwen:getContext': 'getContext',
    }[message?.type];
    if (!op) return false;
    callAdapter(op, message.params || {})
      .then((result) => sendResponse({ ok: true, ...result, result }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: String(error.message || error),
          limit: !!error.limit,
          providerRejectedBeforeGeneration: error.providerRejectedBeforeGeneration === true,
        })
      );
    return true;
  });
}
