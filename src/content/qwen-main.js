// MAIN-world driver for Qwen Studio's conversational image generation.
//
// Qwen exposes no stable web API contract for the signed-in chat, so this
// adapter drives the verified textarea/send controls and returns only a newly
// rendered qwen-image CDN result. Ratio is prompt-guided: the site may still
// choose a different shape. Reference uploads remain deliberately unsupported
// until their conversation/editing semantics are verified end to end.

(() => {
  const REQ = 'STUDIO_QWEN_REQ';
  const RES = 'STUDIO_QWEN_RES';
  const TIMEOUT_MS = 240000;

  const norm = (text) => String(text || '').replace(/\s+/g, ' ').trim();
  const visible = (element) => {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };

  const promptInput = () => {
    const primary = document.querySelector('textarea.message-input-textarea');
    return visible(primary)
      ? primary
      : [...document.querySelectorAll('textarea')].find((element) => visible(element) && /how can i help/i.test(element.placeholder || ''));
  };

  const sendButton = () => [...document.querySelectorAll('button.send-button')].find(visible);
  const assistantMessages = () => [...document.querySelectorAll('.qwen-chat-message-assistant')];
  const RATIO_INSTRUCTIONS = {
    '16:9': 'Create a 16:9 widescreen landscape image. Use a wide horizontal canvas',
    '9:16': 'Create a 9:16 vertical portrait image. Use a tall vertical canvas',
    '1:1': 'Create a 1:1 square image. Use an equal-width-and-height square canvas',
    '4:3': 'Create a 4:3 standard landscape image. Use a classic horizontal canvas',
    '3:4': 'Create a 3:4 vertical portrait image. Use a classic vertical canvas',
  };

  function setTextarea(textarea, value) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function originalImageUrl(source) {
    try {
      const url = new URL(source);
      url.searchParams.delete('x-oss-process');
      return url.href;
    } catch {
      return source;
    }
  }

  const imageUrls = () =>
    [...document.querySelectorAll('img.qwen-image')]
      .map((image) => originalImageUrl(image.currentSrc || image.src || ''))
      .filter((source) => /^https:\/\/cdn\.qwenlm\.ai\//i.test(source));

  function newAssistantText(beforeMessageCount) {
    return assistantMessages()
      .slice(beforeMessageCount)
      .map((message) => norm(message.innerText || message.textContent))
      .filter(Boolean)
      .join(' ');
  }

  function classifyResponseError(text) {
    if (!text) return null;
    if (/quota|usage limit|daily limit|limit reached|too many requests|rate.?limit|try again later|requests? (?:are )?too frequent|额度|限额|次数.*(?:用完|耗尽)|请求过于频繁|稍后再试/i.test(text)) {
      const error = new Error('Qwen Studio usage limit reached. Resume the queue after the account limit resets.');
      error.limit = true;
      return error;
    }
    if (/blocked|safety|policy|not allowed|prohibited|unable to (?:create|generate)|can(?:not|'t) (?:create|generate)/i.test(text))
      return new Error(`Qwen Studio did not generate this prompt: ${text.slice(0, 180)}`);
    return null;
  }

  function waitForImage(beforeImages, beforeMessageCount) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const started = Date.now();
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearInterval(poll);
        clearTimeout(deadline);
        fn(value);
      };
      const check = () => {
        const fresh = imageUrls().find((source) => !beforeImages.has(source));
        if (fresh) return finish(resolve, { imageUrl: fresh });

        const text = newAssistantText(beforeMessageCount);
        const responseError = classifyResponseError(text);
        if (responseError) return finish(reject, responseError);

        const running = !!document.querySelector('button.stop-button');
        if (text && !running && Date.now() - started > 2000)
          return finish(reject, new Error(`Qwen Studio returned text instead of a new image: ${text.slice(0, 180)}`));
      };
      const observer = new MutationObserver(check);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'class'] });
      const poll = setInterval(check, 1000);
      const deadline = setTimeout(
        () => finish(reject, new Error('Qwen Studio did not return a new image before the timeout. Check the tab for a limit or verification message.')),
        TIMEOUT_MS
      );
      check();
    });
  }

  function getContext() {
    const textarea = promptInput();
    return {
      provider: 'qwen',
      ready: !!(textarea && sendButton()),
      signedIn: !!document.querySelector('.user-menu-btn') && !/^\s*(log in|sign in)\b/i.test(norm(document.body.innerText).slice(0, 300)),
      attachmentAvailable: !!document.querySelector('input[type="file"]'),
      url: location.href,
    };
  }

  async function generateImage(params) {
    const prompt = String(params.prompt || '').trim();
    if (!prompt) throw new Error('Empty image prompt.');
    const textarea = promptInput();
    if (!textarea) throw new Error('Qwen Studio prompt box was not found. Open chat.qwen.ai and sign in.');

    const beforeImages = new Set(imageUrls());
    const beforeMessageCount = assistantMessages().length;
    const ratio = String(params.aspectRatio || '16:9');
    const ratioInstruction = RATIO_INSTRUCTIONS[ratio] || `Create an image with an exact ${ratio} aspect ratio`;
    setTextarea(textarea, `${ratioInstruction}. Compose all content inside that format. Image prompt: ${prompt}`);
    await new Promise((resolve) => setTimeout(resolve, 250));

    const send = sendButton();
    if (!visible(send) || send.disabled || send.classList.contains('disabled'))
      throw new Error('Qwen Studio Send button is unavailable. Check the tab for a sign-in or verification prompt.');
    send.click();
    return waitForImage(beforeImages, beforeMessageCount);
  }

  const handlers = { getContext, generateImage };
  const handleMessage = async (event) => {
    if (event.source !== window || event.data?.kind !== REQ) return;
    const { id, op, payload } = event.data;
    try {
      if (!handlers[op]) throw new Error(`Unknown Qwen Studio operation: ${op}`);
      const result = await handlers[op](payload || {});
      window.postMessage({ kind: RES, id, ok: true, result }, '*');
    } catch (error) {
      window.postMessage({ kind: RES, id, ok: false, error: String(error.message || error), limit: !!error.limit }, '*');
    }
  };

  if (window.__STORY_STUDIO_QWEN_MAIN_HANDLER__)
    window.removeEventListener('message', window.__STORY_STUDIO_QWEN_MAIN_HANDLER__);
  window.__STORY_STUDIO_QWEN_MAIN_HANDLER__ = handleMessage;
  window.addEventListener('message', handleMessage);
})();
