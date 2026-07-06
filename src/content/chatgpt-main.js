// MAIN-world driver for ChatGPT (chatgpt.com) image generation.
//
// ChatGPT image generation is a chat interaction (like the AI Studio and Qwen
// providers), so we DRIVE THE UI rather than replay /backend-api/conversation —
// that endpoint needs a per-request proof-of-work "sentinel" token behind
// Cloudflare and forging it is fragile + ban-prone. Here we type an explicit
// "Create a <ratio> image of <prompt>" instruction into the composer, send, and
// read the returned image out of the assistant turn, letting ChatGPT's own app
// handle auth/challenges. Free-tier image quota is small; a limit message is
// surfaced as error.limit = true so the queue pauses.
//
// NOTE: selectors are seeded from ChatGPT's known DOM and may need refinement —
// ChatGPT's markup changes often. Kept resilient (data-testids + fallbacks).

(() => {
  const REQ = 'STUDIO_CHATGPT_REQ';
  const RES = 'STUDIO_CHATGPT_RES';
  const TIMEOUT_MS = 240000;

  const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => {
    if (!el) return false;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  };

  // Natural-language ratio, reinforced in the prompt (no reliable UI control).
  const RATIO_PHRASE = {
    '16:9': '16:9 landscape',
    '9:16': '9:16 vertical portrait',
    '1:1': '1:1 square',
    '4:3': '4:3 landscape',
    '3:4': '3:4 vertical portrait',
  };

  const composer = () =>
    document.querySelector('#prompt-textarea') ||
    [...document.querySelectorAll('div[contenteditable="true"], textarea')].find(visible);
  const sendButton = () =>
    document.querySelector('button[data-testid="send-button"]') ||
    [...document.querySelectorAll('button')].find((b) => visible(b) && /send/i.test(b.getAttribute('aria-label') || ''));
  // Only the generation stop button — NOT the voice/dictation "stop" control,
  // which would otherwise look like "still streaming" forever.
  const stopButton = () =>
    document.querySelector('button[data-testid="stop-button"], button[data-testid="composer-stop-button"]') ||
    [...document.querySelectorAll('button')].find((b) => /stop generating|stop streaming/i.test(b.getAttribute('aria-label') || ''));
  const assistantTurns = () => [...document.querySelectorAll('[data-message-author-role="assistant"]')];

  // A generated image is hosted on OpenAI's content hosts (or a blob:/data: URL).
  // Prefer images inside assistant turns, but fall back to scanning the page
  // (excluding the user turn) in case the assistant-turn markup shifts. Exclude
  // tiny UI icons/avatars.
  function candidateImage(img) {
    const src = img.currentSrc || img.src || '';
    if (!src || /oaistatic|avatar|icon|emoji/i.test(src)) return '';
    const big = (img.naturalWidth || 0) >= 256 || (img.width || 0) >= 256;
    const looksGenerated = /oaiusercontent|\/backend-api\/|\/files\/|blob:|^data:image/i.test(src);
    return big || looksGenerated ? src : '';
  }

  function assistantImageSrcs() {
    const turns = assistantTurns();
    const scope = turns.length ? turns : [document.body];
    const out = [];
    for (const turn of scope) {
      for (const img of turn.querySelectorAll('img')) {
        if (turn === document.body && img.closest('[data-message-author-role="user"]')) continue;
        const src = candidateImage(img);
        if (src) out.push(src);
      }
    }
    return out;
  }

  function newAssistantText(beforeCount) {
    return assistantTurns()
      .slice(beforeCount)
      .map((t) => norm(t.innerText || t.textContent))
      .filter(Boolean)
      .join(' ');
  }

  function classifyText(text) {
    if (!text) return null;
    if (/(image generation|images?).{0,40}(limit|quota|cap)|reached your (?:daily )?limit|hit the (?:free|daily).{0,20}limit|upgrade to (?:chatgpt )?(?:plus|go|pro)|isn'?t available right now|come back (?:later|tomorrow)|try again (?:later|tomorrow|after)/i.test(text)) {
      const e = new Error(`ChatGPT image limit reached — ${text.slice(0, 160)}`);
      e.limit = true;
      return e;
    }
    if (/can(?:'|no)?t (?:create|generate|help create)|content policy|against our (?:usage|content) polic|not able to (?:create|generate)|won'?t be able to/i.test(text))
      return new Error(`ChatGPT declined this prompt: ${text.slice(0, 180)}`);
    return null;
  }

  // Set text on the contenteditable composer (ProseMirror) reliably: focus,
  // select all, then insertText so the editor's own input handling fires.
  function setComposer(el, text) {
    el.focus();
    try {
      const sel = window.getSelection();
      sel.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.addRange(range);
      document.execCommand('insertText', false, text);
    } catch (e) {
      /* fall through */
    }
    // Fallback if execCommand did nothing (e.g. plain textarea).
    if (norm(el.innerText || el.value) !== norm(text)) {
      if ('value' in el && el.tagName === 'TEXTAREA') {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set.call(el, text);
      } else {
        el.textContent = text;
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    }
  }

  async function clickSendWhenReady() {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const b = sendButton();
      if (b && visible(b) && !b.disabled && b.getAttribute('aria-disabled') !== 'true') {
        b.click();
        return;
      }
      await sleep(300);
    }
    // Fallback: press Enter in the composer.
    const el = composer();
    if (el) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }

  // Turn a rendered image (blob:/data:/https) into a payload. Prefer in-page
  // bytes (re-encoded to PNG, since scenes save as .png); if a cross-origin
  // https URL blocks reading, hand the URL to the worker, which fetches it with
  // host permissions (no CORS limit) — same as the Qwen provider.
  async function toPayload(src) {
    try {
      const res = await fetch(src);
      const bitmap = await createImageBitmap(await res.blob());
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      const dataUrl = canvas.toDataURL('image/png');
      const m = dataUrl.match(/^data:(image\/png);base64,(.+)$/s);
      if (m) return { mime: m[1], base64: m[2] };
    } catch (e) {
      /* fall back to URL for the worker */
    }
    if (/^https?:/i.test(src)) return { imageUrl: src };
    throw new Error('ChatGPT image could not be read from the page.');
  }

  function waitForImage(beforeImages, beforeCount) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const started = Date.now();
      const finish = (fn, v) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearInterval(poll);
        clearTimeout(deadline);
        fn(v);
      };
      let lastSrc = '';
      let stableSince = 0;
      const check = async () => {
        // While ChatGPT is actively generating, its stop button is present — do
        // NOT accept anything yet. This is what keeps the queue from firing the
        // next prompt before this image is finished and saved.
        const streaming = !!stopButton();
        const fresh = assistantImageSrcs().find((s) => !beforeImages.has(s));
        if (fresh) {
          if (fresh !== lastSrc) {
            lastSrc = fresh;
            stableSince = Date.now();
          }
          const stableMs = Date.now() - stableSince;
          // Normal path: streaming has stopped and the final image URL settled.
          // Safety net: if the stop button can't be detected, accept only once
          // the URL has been rock-stable for a long window (a still-generating
          // image keeps changing, so it won't look stable that long).
          if ((!streaming && stableMs >= 2500) || stableMs >= 12000) {
            try {
              finish(resolve, await toPayload(fresh));
            } catch (e) {
              finish(reject, e);
            }
            return;
          }
        }
        // Ignore any limit/refusal text while still streaming (partial text).
        if (!streaming) {
          const err = classifyText(newAssistantText(beforeCount));
          if (err) return finish(reject, err);
        }
      };
      const observer = new MutationObserver(check);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
      const poll = setInterval(check, 1200);
      const deadline = setTimeout(
        () => finish(reject, new Error('ChatGPT did not return a new image before the timeout. Keep the tab visible and check for a limit/verification message.')),
        TIMEOUT_MS
      );
      check();
    });
  }

  function getContext() {
    const el = composer();
    const bodyText = norm(document.body.innerText).slice(0, 300);
    const m = /\/c\/([0-9a-f-]+)/i.exec(location.pathname);
    return {
      provider: 'chatgpt',
      ready: !!el,
      signedIn: !!el && !/^\s*(log in|sign up|welcome back)\b/i.test(bodyText),
      conversationId: m ? m[1] : '',
      url: location.href,
    };
  }

  async function generateImage(params) {
    const prompt = String(params.prompt || '').trim();
    if (!prompt) throw new Error('Empty image prompt.');
    const el = composer();
    if (!el) throw new Error('ChatGPT composer was not found. Open chatgpt.com, sign in, and start a chat.');

    const ratio = String(params.aspectRatio || '16:9');
    const phrase = RATIO_PHRASE[ratio] || `${ratio} aspect ratio`;
    // Don't double-wrap if the prompt already begins with a generate verb.
    const instruction = /^(generate|create|make|draw|render|design)\b/i.test(prompt)
      ? `${prompt} (as a ${phrase} image)`
      : `Create a ${phrase} image of ${prompt}`;

    const beforeImages = new Set(assistantImageSrcs());
    const beforeCount = assistantTurns().length;
    setComposer(el, instruction);
    await sleep(200);
    await clickSendWhenReady();
    return waitForImage(beforeImages, beforeCount);
  }

  const handlers = { getContext, generateImage };
  const handleMessage = async (event) => {
    if (event.source !== window || event.data?.kind !== REQ) return;
    const { id, op, payload } = event.data;
    try {
      if (!handlers[op]) throw new Error(`Unknown ChatGPT operation: ${op}`);
      const result = await handlers[op](payload || {});
      window.postMessage({ kind: RES, id, ok: true, result }, '*');
    } catch (error) {
      window.postMessage({ kind: RES, id, ok: false, error: String(error.message || error), limit: !!error.limit }, '*');
    }
  };

  if (window.__STORY_STUDIO_CHATGPT_MAIN_HANDLER__)
    window.removeEventListener('message', window.__STORY_STUDIO_CHATGPT_MAIN_HANDLER__);
  window.__STORY_STUDIO_CHATGPT_MAIN_HANDLER__ = handleMessage;
  window.addEventListener('message', handleMessage);
})();
