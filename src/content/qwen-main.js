// MAIN-world driver for Qwen Studio's conversational image generation.
//
// Qwen exposes no stable web API contract for the signed-in chat, so this
// adapter drives the verified textarea/send controls and returns only a newly
// rendered qwen-image CDN result. Ratio is prompt-guided: the site may still
// choose a different shape. A character reference (img2img) is uploaded into the
// composer before each generation (Qwen consumes it per generation), and the A/B
// "which response do you prefer" comparison is auto-dismissed so batches don't
// stall on it.

(() => {
  const REQ = 'STUDIO_QWEN_REQ';
  const RES = 'STUDIO_QWEN_RES';
  const TIMEOUT_MS = 240000;

  const norm = (text) => String(text || '').replace(/\s+/g, ' ').trim();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // Live sub-phase note surfaced in the panel status line (via the bridge).
  const postProgress = (phase) => window.postMessage({ kind: 'STUDIO_QWEN_PROGRESS', phase }, '*');
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
      // Keep the raw text — the worker parses any "wait N hours" from it to size
      // the auto-resume cooldown.
      const error = new Error(`Qwen Studio usage limit reached — ${text.slice(0, 160)}`);
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

  // After a generation Qwen often shows an A/B "Which response do you prefer?
  // Select one to continue." comparison that BLOCKS the composer until a choice
  // is made (verified live 2026-07-03). Any choice is fine — click the first
  // enabled "I prefer this response" so the next scene can send. No-op when
  // there's no comparison (single-response generation).
  async function dismissPreference() {
    const started = Date.now();
    const prefButtons = () =>
      [...document.querySelectorAll('button')].filter((b) => visible(b) && /prefer this response/i.test(b.textContent || ''));
    while (Date.now() - started < 20000) {
      const btns = prefButtons();
      if (btns.length) {
        const enabled = btns.find((b) => !b.disabled && !b.classList.contains('disabled'));
        if (enabled) {
          enabled.click();
          await sleep(600);
          return true;
        }
      } else if (Date.now() - started > 4000) {
        return false; // no comparison appeared — nothing to dismiss
      }
      await sleep(400);
    }
    return false;
  }

  // img2img: upload the character reference into the composer before generating.
  // Qwen consumes the image each generation, so this runs every scene. The
  // attachment shows as a `.vision-item-container` chip with a `.close-button`.
  // (A file-input set is ignored and a synthetic drag-drop is flaky; a paste
  // event attaches reliably — see attachReference.)
  const refChips = () => [...document.querySelectorAll('.vision-item-container')].filter(visible);

  async function clearReferences() {
    for (let guard = 0; guard < 8 && refChips().length; guard++) {
      refChips()[0].querySelector('.close-button')?.click();
      await sleep(400);
    }
  }

  async function attachReference(ref) {
    if (!ref || !ref.base64) return;
    await clearReferences(); // don't let attachments stack across scenes
    const bin = atob(ref.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    // Paste is the reliable attach path: verified live that a synthetic file-
    // input set is ignored and a synthetic drag-drop is flaky (worked on the
    // first scene, failed on later ones), but a paste event with the file in
    // clipboardData attaches every time (~600ms) and shows a .vision-item chip.
    const pasteFile = () => {
      const ta = promptInput();
      if (!ta) return;
      ta.focus();
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], ref.name || 'reference.png', { type: ref.mime || 'image/png' }));
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: dt });
      ta.dispatchEvent(event);
    };
    const started = Date.now();
    let nextAttemptAt = 0;
    while (Date.now() - started < 20000) {
      if (refChips().length) {
        // trim any duplicate from a retry, then let it settle before typing
        while (refChips().length > 1) {
          refChips()[refChips().length - 1].querySelector('.close-button')?.click();
          await sleep(300);
        }
        await sleep(500);
        return;
      }
      if (Date.now() >= nextAttemptAt) {
        pasteFile();
        nextAttemptAt = Date.now() + 4000; // retry every 4s if it hasn't landed
      }
      await sleep(400);
    }
    throw new Error('Qwen Studio did not accept the reference image upload within 20s.');
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

    if (params.reference) {
      postProgress('uploading reference');
      await attachReference(params.reference);
    }

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
    postProgress('generating');
    const result = await waitForImage(beforeImages, beforeMessageCount);
    // Unblock the composer for the next scene if the A/B comparison appeared.
    await dismissPreference();
    return result;
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
