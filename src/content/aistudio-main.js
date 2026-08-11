// MAIN-world driver for Google AI Studio (aistudio.google.com) image generation.
//
// AI Studio's image API (MakerSuiteService/GenerateContent) uses SAPISIDHASH
// cookie auth + a protojson positional-array body and runs on a transport that
// bypasses fetch/XHR hooks — impractical to replay. So we drive the UI, like the
// The conversational providers reuse the current image chat and phrase the prompt as an
// instruction ("Generate an image of …" — a BARE description 403s / returns text),
// click Run, and read the resulting inline data: image out of the DOM. This uses
// AI Studio's free daily image quota. Verified live 2026-07-05.

(() => {
  // Bare descriptions get refused; an explicit instruction triggers generation,
  // and the ratio is reinforced in words (AI Studio has no ratio control here).
  const RATIO_PHRASE = {
    '16:9': '16:9 landscape',
    '9:16': '9:16 vertical portrait',
    '1:1': '1:1 square',
    '4:3': '4:3 landscape',
    '3:4': '3:4 vertical portrait',
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const vis = (el) => {
    if (!el) return false;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  };

  const promptInput = () =>
    document.querySelector('textarea[aria-label="Enter a prompt"]') || [...document.querySelectorAll('textarea')].filter(vis).pop();
  const runButton = () => [...document.querySelectorAll('button')].filter(vis).find((b) => /^run\b/i.test(norm(b.textContent)));

  function setTextarea(ta, val) {
    // Angular-bound textarea — go through the native setter so the model updates.
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set.call(ta, val);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const dataImages = () =>
    [...document.images].filter((i) => i.src.startsWith('data:image/') && i.naturalWidth >= 256).map((i) => i.src);

  // Character reference (img2img): AI Studio accepts pasted image files in the
  // prompt composer. The generated output is captured after attachment, so the
  // uploaded reference preview is never mistaken for the generated image.
  const refChips = () =>
    [...document.querySelectorAll('button, [role="button"]')].filter((el) =>
      vis(el) && /^(remove|delete|clear)\b.*\b(file|image|attachment)\b/i.test(el.getAttribute('aria-label') || norm(el.textContent))
    );

  async function clearReferences() {
    for (let guard = 0; guard < 10 && refChips().length; guard++) {
      refChips()[0].click();
      await sleep(350);
    }
  }

  async function attachReference(ref, expectedCount) {
    if (!ref || !ref.base64) return;
    const ta = promptInput();
    if (!ta) throw new Error('AI Studio prompt box not found before reference upload.');
    const bin = atob(ref.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const pasteFile = () => {
      const target = promptInput();
      if (!target) return;
      target.focus();
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], ref.name || 'reference.png', { type: ref.mime || 'image/png' }));
      const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: dt });
      target.dispatchEvent(event);
    };
    const waitForAttachment = async (ms, beforeText, beforeImages) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const text = norm(document.body.innerText);
        if (refChips().length >= expectedCount) return true;
        if (dataImages().length > beforeImages) return true;
        if (text !== beforeText && /\b(upload|attached|remove|image|file)\b/i.test(text)) return true;
        await sleep(300);
      }
      return false;
    };
    const beforeText = norm(document.body.innerText);
    const beforeImages = dataImages().length;
    pasteFile();
    let attached = await waitForAttachment(20000, beforeText, beforeImages);
    if (!attached) {
      await sleep(500);
      const retryText = norm(document.body.innerText);
      const retryImages = dataImages().length;
      pasteFile();
      attached = await waitForAttachment(20000, retryText, retryImages);
    }
    if (!attached) throw new Error('AI Studio did not accept a Story Studio reference image.');
    await sleep(1200);
  }

  async function attachReferences(references) {
    const valid = Array.isArray(references) ? references.filter((reference) => reference?.base64) : [];
    await clearReferences();
    if (refChips().length) throw new Error('AI Studio could not clear previous attachments. Remove them in the tab, then retry.');
    for (const reference of valid) {
      await attachReference(reference, refChips().length + 1);
    }
    if (refChips().length !== valid.length) {
      throw new Error(`AI Studio attachment count mismatch: expected ${valid.length}, found ${refChips().length}.`);
    }
  }

  function providerErrorEntries({ visibleOnly = true } = {}) {
    // AI Studio surfaces failures in the model turn or an alert. Never scan the
    // user turn: ordinary prompt text such as "safety" would look like an error.
    return [...document.querySelectorAll('.chat-turn-container.model, [class*="error"], [role="alert"]')]
      .filter((el) => (!visibleOnly || vis(el)) && !el.closest('.chat-turn-container.user'))
      .map((element) => ({ element, text: norm(element.textContent) }))
      .filter(({ text }) => text);
  }

  const providerErrorSnapshot = () => new Map(
    providerErrorEntries({ visibleOnly: false }).map(({ element, text }) => [element, text])
  );

  function currentAttemptErrorText(beforeErrors) {
    return providerErrorEntries()
      .filter(({ element, text }) => beforeErrors.get(element) !== text)
      .map(({ text }) => text)
      .join(' ');
  }

  async function waitForImage(before, beforeErrors, timeoutMs = 180000) {
    const started = Date.now();
    let lastSrc = '';
    let stableSince = 0;
    while (Date.now() - started < timeoutMs) {
      const fresh = dataImages().find((s) => !before.has(s));
      // Don't accept the instant an image appears — wait for it to stop changing
      // (~2s stable) so a mid-generation frame isn't mistaken for the final image
      // and the next queue item isn't started early.
      if (fresh) {
        if (fresh !== lastSrc) {
          lastSrc = fresh;
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= 2000) {
          return fresh;
        }
      }
      const err = currentAttemptErrorText(beforeErrors);
      if (/quota|exceeded|resource[_ ]?exhausted|rate limit|too many requests|limit reached/i.test(err)) {
        const e = new Error('AI Studio free quota reached.');
        e.limit = true;
        e.providerRejectedBeforeGeneration = true;
        throw e;
      }
      if (/blocked|safety|not allowed|violat|prohibited/i.test(err)) throw new Error(`AI Studio blocked the prompt: ${err.slice(0, 120)}`);
      if (/internal error has occurred/i.test(err)) throw new Error('AI Studio internal error (model/project access — confirm image generation works in the AI Studio tab).');
      await sleep(1000);
    }
    throw new Error('AI Studio did not return an image before the timeout.');
  }

  function imagePayload(dataUrl) {
    const m = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/s);
    if (!m) throw new Error('AI Studio returned an invalid image payload.');
    return { mime: m[1], base64: m[2] };
  }

  function selectedModelIdentity() {
    const selector = '[data-model-id], [data-model], [data-testid^="model-"], button[aria-haspopup][aria-label*="model" i], [role="button"][aria-haspopup][aria-label*="model" i], [role="combobox"][aria-label*="model" i]';
    const control = [...document.querySelectorAll(selector)].find(vis);
    if (!control) return { id: '', label: '', stable: false };
    const testId = control.getAttribute('data-testid') || '';
    const testIdModel = /^model-(?!selector|switcher|trigger|button|menu|dropdown)/i.test(testId) ? testId : '';
    const id = norm(control.getAttribute('data-model-id') || control.getAttribute('data-model') || testIdModel);
    const visibleLabel = norm(control.textContent) || norm(control.getAttribute('aria-label'));
    const label = new Set(['Model', 'Select model', 'Choose model']).has(visibleLabel) ? '' : visibleLabel;
    return { id, label, stable: Boolean(id || label) };
  }

  function assertExpectedModel(expected, current = selectedModelIdentity()) {
    if (!expected) throw new Error('AI Studio queued model identity is missing. Refresh and re-queue this item.');
    if (expected.modelSource === 'provider-controlled') return;
    const matches = expected.modelSource === 'provider-label'
      ? expected.modelLabel === current.label
      : expected.modelId === current.id && (!expected.modelLabel || expected.modelLabel === current.label);
    if (!matches) throw new Error('AI Studio model selection changed. Refresh the signed-in page and re-queue this item.');
  }

  async function requestSubmissionCheckpoint(params) {
    const checkpoint = globalThis.__STORY_STUDIO_AISTUDIO_CHECKPOINT__;
    if (!params.submissionToken || typeof checkpoint !== 'function') {
      throw new Error('AI Studio submission checkpoint is unavailable. Reload the provider tab.');
    }
    await checkpoint(params.submissionToken);
  }

  function getContext() {
    return {
      provider: 'aistudio',
      ready: !!(promptInput() && runButton()),
      signedIn: !/^\s*(sign in|log in)\b/i.test((document.body.innerText || '').slice(0, 300)),
      modelIdentity: selectedModelIdentity(),
      url: location.href,
    };
  }

  async function generateImage(params) {
    if (!params.prompt || !params.prompt.trim()) throw new Error('Empty image prompt.');
    const ta = promptInput();
    if (!ta) throw new Error('AI Studio prompt box not found — open aistudio.google.com in image mode.');
    const references = Array.isArray(params.references) ? params.references : [];
    await attachReferences(references);
    const before = new Set(dataImages());
    // Wrap as an explicit generate instruction with the ratio in words; don't
    // double-wrap if the prompt already starts with a generate/create verb.
    const p = params.prompt.trim();
    const phrase = RATIO_PHRASE[String(params.aspectRatio || '16:9')] || `${params.aspectRatio} aspect ratio`;
    const base = /^(generate|create|make|draw|render|design)\b/i.test(p) ? p : `Create a ${phrase} image of ${p}`;
    const text = references.length
      ? `Use the attached Story Studio reference images for visual continuity, ${base.charAt(0).toLowerCase()}${base.slice(1)}`
      : base;
    setTextarea(ta, text);
    await sleep(250);
    const run = runButton();
    if (!run) throw new Error('AI Studio Run button not found.');
    assertExpectedModel(params.expectedModel);
    await requestSubmissionCheckpoint(params);
    const beforeErrors = providerErrorSnapshot();
    assertExpectedModel(params.expectedModel);
    run.click();
    return imagePayload(await waitForImage(before, beforeErrors));
  }

  const handlers = { getContext, generateImage };
  globalThis.__STORY_STUDIO_AISTUDIO_CALL__ = async (op, payload = {}) => {
    if (!handlers[op]) throw new Error(`Unknown AI Studio operation: ${op}`);
    return handlers[op](payload);
  };
})();
