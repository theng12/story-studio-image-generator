// MAIN-world driver for Google AI Studio (aistudio.google.com) image generation.
//
// AI Studio's image API (MakerSuiteService/GenerateContent) uses SAPISIDHASH
// cookie auth + a protojson positional-array body and runs on a transport that
// bypasses fetch/XHR hooks — impractical to replay. So we drive the UI, like the
// Perchance/Leonardo providers: open a fresh chat, phrase the prompt as an
// instruction ("Generate an image of …" — a BARE description 403s / returns text),
// click Run, and read the resulting inline data: image out of the DOM. This uses
// AI Studio's free daily image quota. Verified live 2026-07-05.

(() => {
  const REQ = 'STUDIO_AISTUDIO_REQ';
  const RES = 'STUDIO_AISTUDIO_RES';
  const PREFIX = 'Generate an image of ';

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
  const newChatButton = () => [...document.querySelectorAll('[aria-label="New chat"]')].find(vis);

  function setTextarea(ta, val) {
    // Angular-bound textarea — go through the native setter so the model updates.
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set.call(ta, val);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const dataImages = () =>
    [...document.images].filter((i) => i.src.startsWith('data:image/') && i.naturalWidth >= 256).map((i) => i.src);

  function currentErrorText() {
    // AI Studio surfaces failures as short model-turn messages.
    return [...document.querySelectorAll('.turn-content, [class*="error"], [role="alert"], ms-chat-turn')]
      .filter(vis)
      .map((e) => norm(e.textContent))
      .join(' ');
  }

  async function waitForImage(before, timeoutMs = 180000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const fresh = dataImages().find((s) => !before.has(s));
      if (fresh) return fresh;
      const err = currentErrorText();
      if (/quota|exceeded|resource[_ ]?exhausted|rate limit|too many requests|limit reached/i.test(err)) {
        const e = new Error('AI Studio free quota reached.');
        e.limit = true;
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

  function getContext() {
    return {
      provider: 'aistudio',
      ready: !!(promptInput() && runButton()),
      signedIn: !/^\s*(sign in|log in)\b/i.test((document.body.innerText || '').slice(0, 300)),
      url: location.href,
    };
  }

  async function generateImage(params) {
    if (!params.prompt || !params.prompt.trim()) throw new Error('Empty image prompt.');
    // Fresh chat so prior turns don't steer the model and the new image is
    // unambiguous.
    const nc = newChatButton();
    if (nc) {
      nc.click();
      await sleep(800);
    }
    const ta = promptInput();
    if (!ta) throw new Error('AI Studio prompt box not found — open aistudio.google.com in image mode.');
    const before = new Set(dataImages());
    // Bare descriptions get refused; an instruction triggers generation. Don't
    // double-prefix if the prompt already starts with a generate/create verb.
    const p = params.prompt.trim();
    const text = /^(generate|create|make|draw|render)\b/i.test(p) ? p : PREFIX + p;
    setTextarea(ta, text);
    await sleep(250);
    const run = runButton();
    if (!run) throw new Error('AI Studio Run button not found.');
    run.click();
    return imagePayload(await waitForImage(before));
  }

  const handlers = { getContext, generateImage };
  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.data?.kind !== REQ) return;
    const { id, op, payload } = event.data;
    try {
      if (!handlers[op]) throw new Error(`Unknown AI Studio operation: ${op}`);
      const result = await handlers[op](payload || {});
      window.postMessage({ kind: RES, id, ok: true, result }, '*');
    } catch (error) {
      window.postMessage({ kind: RES, id, ok: false, error: String(error.message || error), limit: !!error.limit }, '*');
    }
  });
})();
