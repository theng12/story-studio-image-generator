// MAIN-world driver for Leonardo AI's visible image generator. Model, style,
// mode, ratio, and size are selected explicitly before every queued request.

(() => {
  const REQ = 'STUDIO_LEONARDO_REQ';
  const RES = 'STUDIO_LEONARDO_RES';
  const PROMPT_SELECTOR = '#prompt-textarea';
  const MODEL_TRIGGER_SELECTOR = '[data-testid="model-selector-trigger"]';
  const STYLE_TRIGGER_SELECTOR = '[role="combobox"][aria-label="Style options"]';
  const GENERATE_SELECTOR = 'button[data-tour-id="gen-tour-generate-button"]';
  const RESULT_LINK_SELECTOR = 'a[href^="/generation/image/"]';

  function visible(element) {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitFor(find, timeoutMs = 5000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const result = find();
      if (result) return result;
      await sleep(100);
    }
    return null;
  }

  function setValue(element, value) {
    element.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function chooseModel(model) {
    if (!/^[a-z0-9.-]+$/i.test(model || '')) throw new Error('Leonardo model setting is invalid.');
    const trigger = document.querySelector(MODEL_TRIGGER_SELECTOR);
    if (!visible(trigger)) throw new Error('Leonardo model selector was not found. Open the AI Creation image page and retry.');
    trigger.click();
    const option = await waitFor(() => {
      const candidate = document.querySelector(`[data-testid="${model}"]`);
      return visible(candidate) ? candidate : null;
    });
    if (!visible(option)) {
      document.querySelector('[role="dialog"] button[aria-label="Close"]')?.click();
      throw new Error(`Leonardo model "${model}" is not available for this account.`);
    }
    option.click();
    const ready = await waitFor(() => {
      const style = document.querySelector(STYLE_TRIGGER_SELECTOR);
      return !document.querySelector('[role="dialog"]') && visible(style) ? style : null;
    });
    if (!ready) throw new Error('Leonardo did not finish switching models. Reload the AI Creation page and retry.');
  }

  async function chooseStyle(style) {
    if (!style) return;
    const trigger = document.querySelector(STYLE_TRIGGER_SELECTOR);
    if (!visible(trigger)) throw new Error('Leonardo style selector was not found for the selected model.');
    trigger.click();
    const option = await waitFor(() =>
      [...document.querySelectorAll('[role="option"]')].find(
        (entry) => visible(entry) && entry.textContent.trim() === style
      )
    );
    if (!option) {
      trigger.click();
      throw new Error(`Leonardo style "${style}" is not available for the selected model.`);
    }
    option.click();
    const closed = await waitFor(() => trigger.getAttribute('aria-expanded') === 'false');
    if (!closed) throw new Error('Leonardo did not finish applying the selected style.');
  }

  function chooseRadio(value, label) {
    if (!/^[A-Z0-9:]+$/.test(value || '')) throw new Error(`Leonardo ${label} setting is invalid.`);
    const option = document.querySelector(`[role="radio"][value="${value}"]`);
    if (!visible(option)) throw new Error(`Leonardo ${label} "${value}" is not available for the selected model.`);
    if (option.getAttribute('aria-checked') !== 'true') option.click();
  }

  // Generation mode (Fast/Quality/Ultra) is model-specific — FLUX models omit the
  // control entirely. Apply it only when the radio group is actually on the page;
  // otherwise skip it rather than failing the whole generation.
  function chooseGenerationMode(mode) {
    const present = ['FAST', 'QUALITY', 'ULTRA'].some((m) => visible(document.querySelector(`[role="radio"][value="${m}"]`)));
    if (present) chooseRadio(mode, 'generation mode');
  }

  function leonardoRatio(ratio) {
    if (ratio === '1:1') return '1:1';
    if (ratio === '9:16' || ratio === '3:4' || ratio === '2:3') return '2:3';
    return '16:9';
  }

  function resultLinks() {
    return [...document.querySelectorAll(RESULT_LINK_SELECTOR)].map((link) => link.getAttribute('href')).filter(Boolean);
  }

  function imageForLink(link) {
    let parent = link;
    for (let level = 0; parent && level < 5; level++, parent = parent.parentElement) {
      const images = [...parent.querySelectorAll('img')]
        .filter((image) => image.naturalWidth >= 256 && image.naturalHeight >= 256)
        .sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight);
      if (images.length) return images[0];
    }
    return null;
  }

  function pageError() {
    return [...document.querySelectorAll('[role="alert"], [data-sonner-toast], .toast, [class*="notification"]')]
      .filter(visible)
      .map((element) => element.textContent.trim())
      .filter(Boolean)
      .join('\n');
  }

  async function waitForResult(before, timeoutMs = 240000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const message = pageError();
      if (/not enough (?:token|credit)|insufficient (?:token|credit)|upgrade to continue|limit reached|too many requests/i.test(message)) {
        const error = new Error(message || 'Leonardo AI generation limit reached.');
        error.limit = true;
        throw error;
      }
      const freshLink = [...document.querySelectorAll(RESULT_LINK_SELECTOR)].find(
        (link) => !before.has(link.getAttribute('href'))
      );
      const image = freshLink && imageForLink(freshLink);
      if (image) return image;
      await sleep(1000);
    }
    throw new Error('Leonardo AI did not render a new image. Check the tab for a verification, token, or moderation message.');
  }

  function imageSource(image) {
    return image.currentSrc || image.src || image.getAttribute('src') || '';
  }

  async function imagePayload(image) {
    const imageUrl = imageSource(image);
    if (!imageUrl) throw new Error('Leonardo AI rendered an image without a downloadable URL.');
    try {
      const response = await fetch(imageUrl, { credentials: 'include' });
      if (!response.ok) throw new Error(String(response.status));
      const blob = await response.blob();
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
      return { base64, mime: blob.type || 'image/jpeg' };
    } catch {
      return { imageUrl };
    }
  }

  function selectedRadio(values) {
    return values.find((value) => document.querySelector(`[role="radio"][value="${value}"][aria-checked="true"]`)) || '';
  }

  function getContext() {
    const prompt = document.querySelector(PROMPT_SELECTOR);
    const model = document.querySelector(MODEL_TRIGGER_SELECTOR);
    const style = document.querySelector(STYLE_TRIGGER_SELECTOR);
    const button = document.querySelector(GENERATE_SELECTOR);
    return {
      provider: 'leonardo',
      ready: visible(prompt) && visible(model) && visible(style) && !!button,
      hasPrompt: visible(prompt),
      hasModel: visible(model),
      hasStyle: visible(style),
      hasGenerate: !!button,
      selectedModel: new URL(location.href).searchParams.get('model') || '',
      selectedStyle: style?.textContent.trim().replace(/^Style\s*/, '') || '',
      selectedMode: selectedRadio(['FAST', 'QUALITY', 'ULTRA']),
      selectedSize: selectedRadio(['SMALL', 'MEDIUM', 'LARGE']),
      url: location.href,
    };
  }

  async function generateImage(params) {
    const promptText = params.prompt?.trim();
    if (!promptText) throw new Error('Empty image prompt.');
    const prompt = document.querySelector(PROMPT_SELECTOR);
    if (!visible(prompt)) throw new Error('Leonardo AI prompt control was not found. Open the AI Creation image page and retry.');

    await chooseModel(params.model || 'phoenix-v1.0');
    await chooseStyle(params.style || 'Dynamic');
    chooseGenerationMode(params.mode || 'FAST');
    chooseRadio(leonardoRatio(params.aspectRatio || '16:9'), 'aspect ratio');
    chooseRadio(params.size || 'SMALL', 'image size');

    const before = new Set(resultLinks());
    setValue(prompt, promptText);
    await sleep(200);
    const button = document.querySelector(GENERATE_SELECTOR);
    if (!button || button.disabled) throw new Error('Leonardo AI Generate button is unavailable. Check the prompt, token balance, and selected settings.');
    button.click();
    return imagePayload(await waitForResult(before));
  }

  // Read the model picker live so new Leonardo models appear without a code
  // change. Each model entry in the picker carries data-testid = the model id
  // (the same id chooseModel selects by). We diff the data-testids present
  // before vs. after opening the picker, which naturally scopes the scan to the
  // freshly-rendered options and filters out the rest of the page chrome.
  const CONTROL_TESTID = /(selector|trigger|close|search|input|button|tab|scroll|overlay|backdrop|dialog|header|footer|menu|tooltip|icon|placeholder|toggle)/i;

  function collectModelOptions(before) {
    const out = new Map();
    for (const el of document.querySelectorAll('[data-testid]')) {
      const id = el.getAttribute('data-testid');
      if (!id || out.has(id) || before.has(id)) continue;
      if (!/^[a-z0-9][a-z0-9.-]*$/i.test(id) || CONTROL_TESTID.test(id)) continue;
      if (!visible(el)) continue;
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 60) continue;
      const badge = /unlimited/i.test(text) ? 'Unlimited' : /token/i.test(text) ? 'uses tokens' : '';
      const label = text.replace(/\s*(?:—\s*)?(?:Unlimited|uses tokens|tokens)\s*$/i, '').trim() || id;
      out.set(id, { id, label, badge });
    }
    return [...out.values()];
  }

  async function listModels() {
    const trigger = document.querySelector(MODEL_TRIGGER_SELECTOR);
    if (!visible(trigger)) throw new Error('Leonardo model selector was not found. Open the AI Creation image page and retry.');
    const before = new Set([...document.querySelectorAll('[data-testid]')].map((el) => el.getAttribute('data-testid')));
    trigger.click();
    await waitFor(() => (collectModelOptions(before).length ? true : null), 6000);
    const models = collectModelOptions(before);
    // Close the picker without changing the current selection.
    document.querySelector('[role="dialog"] button[aria-label="Close"]')?.click();
    await sleep(150);
    if (document.querySelector('[role="dialog"]'))
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    if (!models.length) throw new Error('No models were found in the Leonardo picker. Open the AI Creation image page and retry.');
    return { models };
  }

  const handlers = { getContext, generateImage, listModels };
  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.data?.kind !== REQ) return;
    const { id, op, payload } = event.data;
    try {
      if (!handlers[op]) throw new Error(`Unknown Leonardo operation: ${op}`);
      const result = await handlers[op](payload || {});
      window.postMessage({ kind: RES, id, ok: true, result }, '*');
    } catch (error) {
      window.postMessage({ kind: RES, id, ok: false, error: String(error.message || error), limit: !!error.limit }, '*');
    }
  });
})();
