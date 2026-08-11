if (!globalThis.__STORY_STUDIO_LEONARDO_BRIDGE__) {
  globalThis.__STORY_STUDIO_LEONARDO_BRIDGE__ = true;
  globalThis.__STORY_STUDIO_LEONARDO_CHECKPOINT__ = async (token) => {
    const response = await chrome.runtime.sendMessage({ type: 'providerSubmissionCheckpoint', token });
    if (!response?.ok) throw new Error(response?.error || 'Leonardo AI submission checkpoint failed.');
  };

  const callAdapter = (op, payload = {}, timeoutMs = 270000) => {
    const adapter = globalThis.__STORY_STUDIO_LEONARDO_CALL__;
    if (typeof adapter !== 'function') return Promise.reject(new Error('Leonardo adapter is not ready.'));
    return Promise.race([
      Promise.resolve().then(() => adapter(op, payload)),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Leonardo AI "${op}" timed out.`)), timeoutMs)
      ),
    ]);
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const op = {
      'leonardo:generateImage': 'generateImage',
      'leonardo:getContext': 'getContext',
      'leonardo:listModels': 'listModels',
      'leonardo:modelControls': 'modelControls',
    }[message?.type];
    if (!op) return false;
    callAdapter(op, message.params || {})
      .then((result) => sendResponse({ ok: true, ...result, result }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: String(error.message || error),
          limit: !!error.limit,
          submitted: error.submitted === true ? true : error.submitted === false ? false : null,
        })
      );
    return true;
  });
}
