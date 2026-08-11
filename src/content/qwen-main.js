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
  const TIMEOUT_MS = 240000;

  const norm = (text) => String(text || '').replace(/\s+/g, ' ').trim();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // Live sub-phase note surfaced in the panel status line (via the bridge).
  const postProgress = (phase) => globalThis.__STORY_STUDIO_QWEN_PROGRESS__?.(phase);
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
      .map((message) => norm(message.textContent))
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
      error.providerRejectedBeforeGeneration = true;
      return error;
    }
    if (/blocked|safety|policy|not allowed|prohibited|unable to (?:create|generate)|can(?:not|'t) (?:create|generate)/i.test(text))
      return new Error(`Qwen Studio did not generate this prompt: ${text.slice(0, 180)}`);
    return null;
  }

  function waitForImage(beforeImages, beforeMessageCount) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let checkQueued = false;
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
      const queueCheck = () => {
        if (settled || checkQueued) return;
        checkQueued = true;
        setTimeout(() => {
          checkQueued = false;
          check();
        }, 250);
      };
      const observer = new MutationObserver(queueCheck);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
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
    for (let guard = 0; guard < 12 && refChips().length; guard++) {
      refChips()[0].querySelector('.close-button')?.click();
      await sleep(400);
    }
    return refChips().length;
  }

  async function requireReferencesCleared(stage) {
    const remaining = await clearReferences();
    if (remaining !== 0) {
      throw new Error(`Qwen Studio could not clear stale reference attachments before ${stage} (${remaining} remain). Remove them in the tab, then retry.`);
    }
    return remaining;
  }

  // Wait for the post-paste chip count to settle. The verified-zero baseline
  // means one chip is the only safe accepted result; never guess which extra
  // chip is stale by deleting it.
  async function settleToOneChip(timeoutMs = 8000) {
    let last = -1;
    let stableSince = Date.now();
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const n = refChips().length;
      if (n !== last) {
        last = n;
        stableSince = Date.now();
      } else if (Date.now() - stableSince > 2000) {
        break; // count held steady for 2s
      }
      await sleep(300);
    }
    return refChips().length;
  }

  async function attachReference(ref) {
    if (!ref || !ref.base64) return;
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
    const waitForChip = async (ms, baseline) => {
      if (baseline !== 0) throw new Error('Qwen Studio reference upload requires a zero-attachment baseline.');
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (refChips().length > baseline) return true;
        await sleep(300);
      }
      return false;
    };
    // Finish any deliberate settling before the zero check. Once the baseline
    // is verified, paste synchronously so no stale chip can race in between.
    await sleep(500);
    const baseline = await requireReferencesCleared('pasting the reference');
    pasteFile();
    let attached = await waitForChip(25000, baseline);
    if (!attached) {
      await sleep(600);
      const retryBaseline = await requireReferencesCleared('retrying the reference upload');
      pasteFile();
      attached = await waitForChip(25000, retryBaseline);
    }
    if (!attached) throw new Error('Qwen Studio did not accept the reference image upload.');
    // Let the upload finish + any stray second chip appear, then trim to one.
    await sleep(1500);
    const count = await settleToOneChip();
    if (count !== 1) throw new Error(`Qwen Studio reference attachment count mismatch: expected 1, found ${count}. Remove stale attachments in the tab, then retry.`);
    await sleep(600);
  }

  function selectedModelIdentity() {
    const selector = '[data-model-id], [data-model], [data-testid^="model-"], button[aria-haspopup][aria-label*="model" i], [role="button"][aria-haspopup][aria-label*="model" i], [role="combobox"][aria-label*="model" i]';
    const control = [...document.querySelectorAll(selector)].find(visible);
    if (!control) return { id: '', label: '', stable: false };
    const testId = control.getAttribute('data-testid') || '';
    const testIdModel = /^model-(?!selector|switcher|trigger|button|menu|dropdown)/i.test(testId) ? testId : '';
    const id = norm(control.getAttribute('data-model-id') || control.getAttribute('data-model') || testIdModel);
    const visibleLabel = norm(control.textContent) || norm(control.getAttribute('aria-label'));
    const label = new Set(['Model', 'Select model', 'Choose model']).has(visibleLabel) ? '' : visibleLabel;
    return { id, label, stable: Boolean(id || label) };
  }

  function assertExpectedModel(expected, current = selectedModelIdentity()) {
    if (!expected) throw new Error('Qwen Studio queued model identity is missing. Refresh and re-queue this item.');
    if (expected.modelSource === 'provider-controlled') return;
    const matches = expected.modelSource === 'provider-label'
      ? expected.modelLabel === current.label
      : expected.modelId === current.id && (!expected.modelLabel || expected.modelLabel === current.label);
    if (!matches) throw new Error('Qwen Studio model selection changed. Refresh the signed-in page and re-queue this item.');
  }

  async function requestSubmissionCheckpoint(params) {
    const checkpoint = globalThis.__STORY_STUDIO_QWEN_CHECKPOINT__;
    if (!params.submissionToken || typeof checkpoint !== 'function') {
      throw new Error('Qwen Studio submission checkpoint is unavailable. Reload the provider tab.');
    }
    await checkpoint(params.submissionToken);
  }

  function getContext() {
    const textarea = promptInput();
    return {
      provider: 'qwen',
      ready: !!(textarea && sendButton()),
      signedIn: !!document.querySelector('.user-menu-btn') && !/^\s*(log in|sign in)\b/i.test(norm(document.body.innerText).slice(0, 300)),
      attachmentAvailable: !!document.querySelector('input[type="file"]'),
      modelIdentity: selectedModelIdentity(),
      url: location.href,
    };
  }

  async function generateImage(params) {
    const prompt = String(params.prompt || '').trim();
    if (!prompt) throw new Error('Empty image prompt.');
    const textarea = promptInput();
    if (!textarea) throw new Error('Qwen Studio prompt box was not found. Open chat.qwen.ai and sign in.');

    const reference = Array.isArray(params.references) ? params.references[0] : null;
    if (reference) {
      postProgress('uploading reference');
      await attachReference(reference);
      await sleep(1200); // leeway: let the upload fully settle before typing
    } else {
      await requireReferencesCleared('starting a no-reference generation');
    }

    const beforeImages = new Set(imageUrls());
    const beforeMessageCount = assistantMessages().length;
    const ratio = String(params.aspectRatio || '16:9');
    const ratioInstruction = RATIO_INSTRUCTIONS[ratio] || `Create an image with an exact ${ratio} aspect ratio`;
    setTextarea(textarea, `${ratioInstruction}. Compose all content inside that format. Image prompt: ${prompt}`);
    await sleep(800); // leeway: let the prompt register before sending

    // Wait for Send to actually be ready (present, visible, enabled) rather than
    // a one-shot check — after an attachment it can take a beat to enable.
    let send = null;
    const sendDeadline = Date.now() + 12000;
    while (Date.now() < sendDeadline) {
      const button = sendButton();
      if (button && visible(button) && !button.disabled && !button.classList.contains('disabled')) {
        send = button;
        break;
      }
      await sleep(300);
    }
    if (!send) throw new Error('Qwen Studio Send button did not become available. Check the tab for a sign-in or verification prompt.');
    await sleep(400); // small settle so the click lands after the composer is stable
    // A chip can appear while Send becomes ready. Make the exact-state check the
    // final operation before clicking so no stale attachment reaches Qwen.
    const expectedChipCount = reference ? 1 : 0;
    const finalChipCount = refChips().length;
    if (finalChipCount !== expectedChipCount) {
      throw new Error(`Qwen Studio reference attachment count mismatch: expected ${expectedChipCount}, found ${finalChipCount}. Remove stale attachments in the tab, then retry.`);
    }
    assertExpectedModel(params.expectedModel);
    await requestSubmissionCheckpoint(params);
    assertExpectedModel(params.expectedModel);
    send.click();
    postProgress('generating');
    const result = await waitForImage(beforeImages, beforeMessageCount);
    // Unblock the composer for the next scene if the A/B comparison appeared.
    await dismissPreference();
    return result;
  }

  const handlers = { getContext, generateImage };
  globalThis.__STORY_STUDIO_QWEN_CALL__ = async (op, payload = {}) => {
    if (!handlers[op]) throw new Error(`Unknown Qwen Studio operation: ${op}`);
    return handlers[op](payload);
  };
})();
