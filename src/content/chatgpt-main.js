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
  // ChatGPT wraps each turn in a <section>/<article data-testid="conversation-turn-N">.
  // As of late-2026 the assistant's generated image lives HERE, no longer inside the
  // [data-message-author-role="assistant"] node — so we key off the turn wrapper and
  // fall back to the old role selector only if the testid ever disappears.
  const conversationTurns = () => [...document.querySelectorAll('[data-testid^="conversation-turn"]')];
  const isUserTurn = (t) => !!t.querySelector('[data-message-author-role="user"]');
  const assistantTurns = () => {
    const turns = conversationTurns().filter((t) => !isUserTurn(t));
    return turns.length ? turns : [...document.querySelectorAll('[data-message-author-role="assistant"]')];
  };

  // A finished generated image carries a stable alt marker ("Generated image: …")
  // and is served from ChatGPT's content backend. Two things make visibility an
  // unreliable signal: it sits OUTSIDE the assistant-role node, and once the turn
  // finishes the UI collapses it under a "Worked for Ns" toggle — the <img> stays
  // in the DOM but goes offsetParent:null. So detection here must NOT require the
  // element to be visible; the alt marker is what we trust. Exclude UI chrome.
  function candidateImage(img) {
    const src = img.currentSrc || img.src || '';
    if (!src) return '';
    if (/oaistatic|\/avatars?\/|\bavatar\b|favicon|sprite|emoji/i.test(src)) return '';
    if (/^generated image\b/i.test(img.alt || '')) return src; // definitive marker
    const looksGenerated = /oaiusercontent|\/backend-api\/(?:estuary\/)?content|\/backend-api\/files|\/files\/|blob:|^data:image/i.test(src);
    const big = (img.naturalWidth || 0) >= 256 || (img.width || 0) >= 256;
    return looksGenerated && big ? src : '';
  }

  // Collect generated-image URLs. Primary signal is the alt marker (survives the
  // post-generation collapse and the move out of the assistant-role node); a scan
  // of the assistant conversation turns is a fallback if the marker ever changes.
  function assistantImageSrcs() {
    const out = [];
    const seen = new Set();
    const push = (src) => {
      if (src && !seen.has(src)) {
        seen.add(src);
        out.push(src);
      }
    };
    for (const img of document.querySelectorAll('img[alt^="Generated image" i]')) {
      if (img.closest('[data-message-author-role="user"]')) continue;
      push(candidateImage(img));
    }
    for (const turn of assistantTurns()) {
      if (isUserTurn(turn)) continue;
      for (const img of turn.querySelectorAll('img')) push(candidateImage(img));
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
      const finish = (fn, v) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearInterval(poll);
        clearTimeout(deadline);
        fn(v);
      };
      // Remembered from the first sighting so we can still fetch after the element
      // unmounts — ChatGPT collapses the turn and drops the <img> within ~1–2s.
      let seenSrc = '';
      let seenSince = 0;
      const check = async () => {
        const streaming = !!stopButton();
        // Newly-appeared generated image src (live element, or the src list).
        const el = [...document.querySelectorAll('img[alt^="Generated image" i]')].find((i) => {
          const s = i.currentSrc || i.src;
          return s && !beforeImages.has(s);
        });
        const fresh = (el && (el.currentSrc || el.src)) || assistantImageSrcs().find((s) => !beforeImages.has(s)) || '';
        if (fresh && fresh !== seenSrc) {
          seenSrc = fresh;
          seenSince = Date.now();
        }
        if (seenSrc) {
          // Capture EAGERLY: as soon as the final image is loaded, not after
          // streaming stops. ChatGPT now collapses the turn and UNMOUNTS the <img>
          // within ~1–2s of finishing, so the old "wait 2.5s after the stop button
          // disappears" gate raced the image out of the DOM. The "Generated image:"
          // alt marks the finished asset; once we've recorded its src we hold onto
          // it and fetch by that remembered URL (a signed, minutes-long link that
          // stays valid) even after the DOM drops the element.
          const liveEl = [...document.querySelectorAll('img')].find((i) => (i.currentSrc || i.src) === seenSrc);
          const loaded = liveEl ? liveEl.complete && (liveEl.naturalWidth || 0) >= 256 : true;
          if (loaded && Date.now() - seenSince >= 700) {
            try {
              finish(resolve, await toPayload(seenSrc));
            } catch (e) {
              finish(reject, e);
            }
            return;
          }
        }
        // Refusal/limit text only counts once nothing is generating and no image
        // has shown up (partial mid-stream text would false-positive otherwise).
        if (!streaming && !seenSrc) {
          const err = classifyText(newAssistantText(beforeCount));
          if (err) return finish(reject, err);
        }
      };
      const observer = new MutationObserver(check);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'alt'] });
      const poll = setInterval(check, 700);
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
