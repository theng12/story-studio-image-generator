// MAIN-world driver for Perchance's sandboxed generator subframe. Controls are
// anonymous, so they are identified by their option sets instead of DOM order.

(() => {
  const RESULT = 'STUDIO_PERCHANCE_RESULT';
  const isResultFrame = location.hostname === 'image-generation.perchance.org' && location.pathname === '/embed';
  if (isResultFrame) {
    let sent = false;
    const emitResult = () => {
      if (sent) return;
      const image = [...document.images].find((candidate) => candidate.src.startsWith('data:image/') && candidate.naturalWidth >= 256);
      if (!image) return;
      sent = true;
      let parentOrigin = '*';
      try {
        const referrerOrigin = new URL(document.referrer).origin;
        if (referrerOrigin.endsWith('.perchance.org')) parentOrigin = referrerOrigin;
      } catch {
        /* target remains restricted by the controller's source-window check */
      }
      window.parent.postMessage({ kind: RESULT, frameUrl: location.href, dataUrl: image.src }, parentOrigin);
    };
    new MutationObserver(emitResult).observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    window.addEventListener('load', emitResult, { once: true });
    emitResult();
    return;
  }

  const isGeneratorFrame =
    location.hostname !== 'perchance.org' &&
    location.hostname.endsWith('.perchance.org') &&
    location.pathname.startsWith('/ai-text-to-image-generator');
  if (!isGeneratorFrame) return;

  const REQ = 'STUDIO_PERCHANCE_REQ';
  const RES = 'STUDIO_PERCHANCE_RES';
  const resultQueue = [];

  window.addEventListener('message', (event) => {
    if (event.origin !== 'https://image-generation.perchance.org' || event.data?.kind !== RESULT) return;
    const knownFrame = [...document.querySelectorAll('iframe.text-to-image-plugin-image-iframe')].some(
      (frame) => frame.contentWindow === event.source
    );
    if (knownFrame) resultQueue.push(event.data);
  });

  const normalize = (value) => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();

  function visible(element) {
    if (!element || element.disabled) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  }

  function queryDeep(selector, root = document) {
    const results = [...root.querySelectorAll(selector)];
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) results.push(...queryDeep(selector, element.shadowRoot));
    }
    return results;
  }

  function optionNames(select) {
    return [...select.options].map((option) => normalize(option.textContent));
  }

  function controls() {
    const selects = queryDeep('select').filter(visible);
    const shape = selects.find((select) => ['Square', 'Portrait', 'Landscape'].every((name) => optionNames(select).includes(name)));
    const quantity = selects.find((select) => {
      const names = optionNames(select);
      return names.includes('2') && names.includes('32') && names.every((name) => /^\d+$/.test(name));
    });
    const style = selects.find((select) => {
      const names = optionNames(select);
      return names.length > 20 && names.some((name) => name.toLowerCase() === 'no style');
    });
    const textareas = queryDeep('textarea').filter(visible);
    const prompt =
      textareas.find((element) => /prompt|description|beautiful swedish/i.test(`${element.placeholder} ${element.getAttribute('aria-label')}`)) ||
      textareas[textareas.length - 1];
    const generate = queryDeep('button, [role="button"]')
      .filter(visible)
      .find((element) => normalize(element.textContent).replace(/^[^a-z]+/i, '').toLowerCase().startsWith('generate'));
    return { prompt, style, shape, quantity, generate };
  }

  function selectByText(select, wanted, label) {
    const normalizedWanted = normalize(wanted).toLowerCase();
    const option = [...select.options].find((candidate) => normalize(candidate.textContent).toLowerCase() === normalizedWanted);
    if (!option) throw new Error(`Perchance ${label} "${wanted}" is not available.`);
    select.value = option.value;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setPrompt(element, value) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function shapeForRatio(ratio) {
    if (ratio === '1:1') return 'Square';
    if (ratio === '9:16' || ratio === '3:4') return 'Portrait';
    return 'Landscape';
  }

  function resultFrameUrls() {
    return new Set(
      [...document.querySelectorAll('iframe.text-to-image-plugin-image-iframe')]
        .map((frame) => frame.src)
        .filter(Boolean)
    );
  }

  async function waitForResult(before, timeoutMs = 210000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const errorText = queryDeep('[role="alert"], .error, [class*="error"]')
        .filter(visible)
        .map((element) => normalize(element.textContent))
        .join('\n');
      if (/server|failed|error|unavailable|too many requests/i.test(errorText)) throw new Error(`Perchance generation failed: ${errorText}`);
      const index = resultQueue.findIndex((result) => result.dataUrl && !before.has(result.frameUrl));
      if (index >= 0) return resultQueue.splice(index, 1)[0].dataUrl;
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    throw new Error('Perchance did not render a new image before the timeout.');
  }

  function imagePayload(dataUrl) {
    const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/s);
    if (!match) throw new Error('Perchance returned an invalid image payload.');
    return { mime: match[1], base64: match[2] };
  }

  function getContext() {
    const found = controls();
    return {
      provider: 'perchance',
      ready: Object.values(found).every(Boolean),
      controls: Object.fromEntries(Object.entries(found).map(([key, value]) => [key, !!value])),
      selectedStyle: found.style ? normalize(found.style.selectedOptions[0]?.textContent) : '',
      selectedShape: found.shape ? normalize(found.shape.selectedOptions[0]?.textContent) : '',
      selectedQuantity: found.quantity ? normalize(found.quantity.selectedOptions[0]?.textContent) : '',
      url: location.href,
    };
  }

  async function generateImage(params) {
    if (!params.prompt?.trim()) throw new Error('Empty image prompt.');
    const found = controls();
    const missing = Object.entries(found).filter(([, value]) => !value).map(([key]) => key);
    if (missing.length) throw new Error(`Perchance controls not found: ${missing.join(', ')}.`);
    const before = resultFrameUrls();
    setPrompt(found.prompt, params.prompt.trim());
    selectByText(found.style, params.style || 'No style', 'style');
    selectByText(found.shape, shapeForRatio(params.aspectRatio || '16:9'), 'shape');
    selectByText(found.quantity, '2', 'quantity');
    await new Promise((resolve) => setTimeout(resolve, 150));
    found.generate.click();
    return imagePayload(await waitForResult(before));
  }

  const handlers = { getContext, generateImage };
  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.data?.kind !== REQ) return;
    const { id, op, payload } = event.data;
    try {
      if (!handlers[op]) throw new Error(`Unknown Perchance operation: ${op}`);
      const result = await handlers[op](payload || {});
      window.postMessage({ kind: RES, id, ok: true, result }, '*');
    } catch (error) {
      window.postMessage({ kind: RES, id, ok: false, error: String(error.message || error) }, '*');
    }
  });
})();
