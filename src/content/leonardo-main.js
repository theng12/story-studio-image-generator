// MAIN-world driver for Leonardo AI's visible image generator. Model, style,
// mode, ratio, and size are selected explicitly before every queued request.

(() => {
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

  // Every control below is ADAPTIVE: Leonardo's sidebar is model-specific
  // (verified live 2026-07-01 — Phoenix has mode+size+ratio radios; FLUX has
  // size+ratio but no mode; Nano Banana 2/Lite has only ratio). Forcing a
  // control a model doesn't render was failing whole generations, so each
  // setter applies its value only when the control exists and never throws
  // over a missing one.

  const QTY_COMBO_SELECTOR = '[role="combobox"][aria-label="Select quantity"]';

  // Skip silently when the style combobox or the requested style is missing
  // for this model — a wrong style must not sink the generation.
  async function chooseStyle(style) {
    if (!style) return;
    const trigger = document.querySelector(STYLE_TRIGGER_SELECTOR);
    if (!visible(trigger)) return;
    trigger.click();
    const option = await waitFor(() =>
      [...document.querySelectorAll('[role="option"]')].find(
        (entry) => visible(entry) && entry.textContent.trim() === style
      ), 3000
    );
    if (!option) {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return;
    }
    option.click();
    await waitFor(() => trigger.getAttribute('aria-expanded') === 'false', 3000);
  }

  function chooseRadioIfPresent(value) {
    if (!/^[A-Z0-9:]+$/.test(value || '')) return false;
    const option = document.querySelector(`[role="radio"][value="${value}"]`);
    if (!visible(option)) return false;
    if (option.getAttribute('aria-checked') !== 'true') option.click();
    return true;
  }

  // Number of images per generation: numeric pill buttons for 1–4 plus a
  // "Select quantity" combobox for 5–8 (paid plans; free locks the group).
  async function chooseImageCount(count) {
    const n = Math.max(1, Math.min(8, Math.round(Number(count) || 1)));
    const pill = [...document.querySelectorAll('button')].find(
      (el) => visible(el) && (el.textContent || '').trim() === String(n)
    );
    if (pill) {
      if (pill.getAttribute('aria-pressed') !== 'true') pill.click();
      return;
    }
    const combo = document.querySelector(QTY_COMBO_SELECTOR);
    if (!visible(combo)) return; // locked plan — leave the default
    combo.click();
    const option = await waitFor(() =>
      [...document.querySelectorAll('[role="option"]')].find(
        (entry) => visible(entry) && (entry.textContent || '').trim() === String(n)
      ), 3000
    );
    if (option) option.click();
    else document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }

  // ── Image reference (style/character consistency) ─────────────────────────
  // A reference attached in the Leonardo tab persists across the whole batch
  // (imageGuidance stays in the SPA state; the extension reuses one tab), so we
  // do NOT drive Leonardo's flaky "Select Media" upload dialog — that risks
  // attaching the wrong image and wasting credits. We only DETECT the reference
  // so the panel can report it: the active ref shows as a chip under the prompt
  // with an aria-label'd Remove button, and the "Add reference" button only
  // exists on models that support references.

  const ADD_REF_LABEL = 'Add reference to generation';
  const refAddButton = () => [...document.querySelectorAll('button')].find((el) => el.getAttribute('aria-label') === ADD_REF_LABEL);
  const referenceAttached = () => [...document.querySelectorAll('button')].some((el) => /^Remove Image Reference/i.test(el.getAttribute('aria-label') || ''));

  // What the CURRENT model actually offers, read from the live sidebar. The
  // panel uses this to show only real choices for the selected model.
  async function availableControls() {
    const radioValues = [...document.querySelectorAll('[role="radio"]')].filter(visible).map((el) => el.getAttribute('value'));
    const modes = ['FAST', 'QUALITY', 'ULTRA'].filter((v) => radioValues.includes(v));
    const sizes = ['SMALL', 'MEDIUM', 'LARGE'].filter((v) => radioValues.includes(v));
    const ratios = radioValues.filter((v) => /^\d+:\d+$/.test(v || ''));
    const pills = [...document.querySelectorAll('button')]
      .filter((el) => visible(el) && /^[1-8]$/.test((el.textContent || '').trim()))
      .map((el) => Number(el.textContent.trim()));
    const maxCount = visible(document.querySelector(QTY_COMBO_SELECTOR)) ? 8 : pills.length ? Math.max(...pills) : 1;
    let styles = [];
    const styleTrigger = document.querySelector(STYLE_TRIGGER_SELECTOR);
    if (visible(styleTrigger)) {
      styleTrigger.click();
      await waitFor(() => document.querySelector('[role="option"]'), 3000);
      styles = [...document.querySelectorAll('[role="option"]')].filter(visible).map((el) => (el.textContent || '').trim()).filter(Boolean);
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(150);
    }
    const model = new URL(location.href).searchParams.get('model') || '';
    return {
      model,
      modes,
      sizes,
      ratios,
      maxCount,
      styles,
      supportsReference: !!visible(refAddButton()),
      referenceAttached: referenceAttached(),
    };
  }

  // Select a model (optional), then report its real control set.
  async function modelControls(params) {
    if (params.model) await chooseModel(params.model);
    return await availableControls();
  }

  function leonardoRatio(ratio) {
    if (ratio === '1:1') return '1:1';
    if (ratio === '9:16' || ratio === '3:4' || ratio === '2:3') return '2:3';
    return '16:9';
  }

  function resultLinks() {
    return [...document.querySelectorAll(RESULT_LINK_SELECTOR)].map((link) => link.getAttribute('href')).filter(Boolean);
  }

  function imageSource(image) {
    if (!image) return '';
    const direct = [image.currentSrc, image.getAttribute('src'), image.src].filter(Boolean);
    const responsive = (image.getAttribute('srcset') || '')
      .split(',')
      .map((entry) => entry.trim().split(/\s+/)[0])
      .filter(Boolean);
    const candidates = [...direct, ...responsive];
    return (
      candidates.find((source) => /^(?:https?:)?\/\/cdn\.leonardo\.ai\//i.test(source)) ||
      candidates.find((source) => !source.startsWith('data:image/gif')) ||
      ''
    );
  }

  function imageForLink(link) {
    let parent = link;
    for (let level = 0; parent && level < 5; level++, parent = parent.parentElement) {
      const images = [...parent.querySelectorAll('img')]
        // Hidden tabs may not decode lazy images, leaving naturalWidth at zero.
        // Leonardo still assigns the CDN URL, which is all the worker needs.
        .filter((image) => /^(?:https?:)?\/\/cdn\.leonardo\.ai\//i.test(imageSource(image)))
        .sort((a, b) => {
          const pixels = (image) => image.naturalWidth * image.naturalHeight;
          return pixels(b) - pixels(a) || imageSource(b).length - imageSource(a).length;
        });
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
    // MutationObserver is not subject to Chrome's background-tab timer budget.
    // Polling with setTimeout made Leonardo appear to require the active tab,
    // especially once its gallery also deferred thumbnail decoding.
    return new Promise((resolve, reject) => {
      let settled = false;
      let observer;
      let watchdog;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        observer?.disconnect();
        clearTimeout(watchdog);
        callback(value);
      };
      const inspect = () => {
        if (settled) return;
        const message = pageError();
        if (/not enough (?:token|credit)|insufficient (?:token|credit)|upgrade to continue|limit reached|too many requests/i.test(message)) {
          const error = new Error(message || 'Leonardo AI generation limit reached.');
          error.limit = true;
          finish(reject, error);
          return;
        }
        const freshLink = [...document.querySelectorAll(RESULT_LINK_SELECTOR)].find(
          (link) => !before.has(link.getAttribute('href'))
        );
        const image = freshLink && imageForLink(freshLink);
        if (image) finish(resolve, image);
      };
      observer = new MutationObserver(inspect);
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['href', 'src', 'srcset'],
      });
      watchdog = setTimeout(
        () => finish(reject, new Error('Leonardo AI did not render a new image. Check the tab for a verification, token, or moderation message.')),
        timeoutMs
      );
      inspect();
    });
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
    chooseRadioIfPresent(params.mode || 'FAST');
    chooseRadioIfPresent(leonardoRatio(params.aspectRatio || '16:9'));
    chooseRadioIfPresent(params.size || 'SMALL');
    await chooseImageCount(params.count || 1);
    // Reference image (if any) is attached manually in the tab and persists
    // across the batch — nothing to do here; we never touch the ref state.

    const before = new Set(resultLinks());
    setValue(prompt, promptText);
    // The button can be transiently disabled (cold tab, cost re-estimate after a
    // model/style change, previous run settling), so wait rather than fail on a
    // one-shot check. But a PERSISTENT disable is meaningful: verified live that
    // when a premium/metered model hits its plan or daily cap, Leonardo silently
    // disables Generate with no toast (Unlimited models still enable instantly).
    // So if it never enables, treat it as a limit and PAUSE the batch instead of
    // failing every remaining scene one by one.
    const started = Date.now();
    let button = null;
    while (Date.now() - started < 20000) {
      const message = pageError();
      if (/not enough (?:token|credit)|insufficient (?:token|credit)|upgrade to continue|limit reached|too many requests/i.test(message)) {
        const error = new Error(message);
        error.limit = true;
        throw error;
      }
      if (/safety|responsible ai|policy|blocked prompt|prohibited|moderation/i.test(message)) {
        throw new Error(`Leonardo rejected this prompt: ${message}`);
      }
      const b = document.querySelector(GENERATE_SELECTOR);
      if (b && !b.disabled) {
        button = b;
        break;
      }
      await sleep(300);
    }
    if (!button) {
      const model = new URL(location.href).searchParams.get('model') || 'this model';
      const error = new Error(
        `Leonardo kept Generate disabled for "${model}" — its plan or daily cap for this premium model is likely reached (Unlimited models such as Phoenix, Lucid and FLUX still work). Paused: switch model or resume after it resets.`
      );
      error.limit = true; // pause the batch rather than fail all remaining scenes
      throw error;
    }
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
      // Verified live: each picker entry is a <button data-testid="<model-id>">
      // with an <h3> title and an "Unlimited" badge in its text when applicable.
      const label = (el.querySelector('h3, p')?.textContent || '').replace(/\s+/g, ' ').trim();
      if (!label || label.length > 60) continue;
      const badge = /unlimited/i.test(el.textContent || '') ? 'Unlimited' : 'uses tokens';
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

  const handlers = { getContext, generateImage, listModels, modelControls };
  globalThis.__STORY_STUDIO_LEONARDO_CALL__ = async (op, payload = {}) => {
    if (!handlers[op]) throw new Error(`Unknown Leonardo operation: ${op}`);
    return handlers[op](payload);
  };
})();
