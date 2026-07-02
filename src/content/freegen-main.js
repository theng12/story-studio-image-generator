// MAIN-world driver for FreeGen's visible image generator. Keep this adapter
// tied to FreeGen's explicit DOM contract so ads and unrelated page images can
// never be mistaken for a completed generation.

(() => {
  const REQ = 'STUDIO_FREEGEN_REQ';
  const RES = 'STUDIO_FREEGEN_RES';
  const PROMPT_SELECTOR = '#prompt';
  const RATIO_SELECTOR = '#aspectRatioSelect';
  const GENERATE_SELECTOR = '#generateBtn';
  const ERROR_SELECTOR = '#errorContainer';
  const RESULT_SELECTOR = '#imageContainer img[alt="Generated Image"]';
  const DOWNLOAD_SELECTOR = '#imageContainer a[href^="data:image/"]';

  function visible(element) {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  }

  function setValue(element, value) {
    element.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function chooseAspectRatio(ratio) {
    const select = document.querySelector(RATIO_SELECTOR);
    if (!select || !visible(select)) throw new Error('FreeGen aspect-ratio control was not found. Reload the FreeGen tab and retry.');
    const option = [...select.options].find((entry) => entry.value === ratio);
    if (!option) throw new Error(`FreeGen does not offer the ${ratio} aspect ratio.`);
    select.value = option.value;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function resultSource() {
    const image = document.querySelector(RESULT_SELECTOR);
    const link = document.querySelector(DOWNLOAD_SELECTOR);
    const src = link?.href || image?.currentSrc || image?.src || '';
    return src.startsWith('data:image/') ? src : '';
  }

  function pageError() {
    return (document.querySelector(ERROR_SELECTOR)?.textContent || '').trim();
  }

  function throwPageError(message) {
    const error = new Error(message || 'FreeGen could not generate the image.');
    error.limit = /limit|quota|too many requests|try again later|temporarily unavailable/i.test(message || '');
    throw error;
  }

  async function waitForResult(before, timeoutMs = 210000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const error = pageError();
      if (error) throwPageError(error);
      const source = resultSource();
      const button = document.querySelector(GENERATE_SELECTOR);
      if (source && source !== before && button && !button.disabled) return source;
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    throw new Error('FreeGen did not render a new image. Keep its tab open, complete any browser check, and retry.');
  }

  function dataUrlPayload(source) {
    const match = source.match(/^data:([^;,]+);base64,(.+)$/s);
    if (!match) throw new Error('FreeGen returned an unreadable image payload.');
    return { mime: match[1], base64: match[2] };
  }

  function getContext() {
    const prompt = document.querySelector(PROMPT_SELECTOR);
    const ratio = document.querySelector(RATIO_SELECTOR);
    const button = document.querySelector(GENERATE_SELECTOR);
    return {
      provider: 'freegen',
      ready: visible(prompt) && visible(ratio) && visible(button),
      hasPrompt: visible(prompt),
      hasAspectRatio: visible(ratio),
      hasGenerate: visible(button),
      url: location.href,
    };
  }

  async function generateImage(params) {
    const promptText = params.prompt?.trim();
    if (!promptText) throw new Error('Empty image prompt.');
    const prompt = document.querySelector(PROMPT_SELECTOR);
    const button = document.querySelector(GENERATE_SELECTOR);
    if (!prompt || !visible(prompt)) throw new Error('FreeGen prompt control was not found. Open freegen.app and retry.');
    if (!button || !visible(button)) throw new Error('FreeGen Generate button was not found. Open freegen.app and retry.');
    if (button.disabled) throw new Error('FreeGen is already generating an image. Wait for it to finish, then retry.');

    const before = resultSource();
    setValue(prompt, promptText);
    chooseAspectRatio(params.aspectRatio || '16:9');
    await new Promise((resolve) => setTimeout(resolve, 150));
    button.click();
    return dataUrlPayload(await waitForResult(before));
  }

  const handlers = { getContext, generateImage };
  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.data?.kind !== REQ) return;
    const { id, op, payload } = event.data;
    try {
      if (!handlers[op]) throw new Error(`Unknown FreeGen operation: ${op}`);
      const result = await handlers[op](payload || {});
      window.postMessage({ kind: RES, id, ok: true, result }, '*');
    } catch (error) {
      window.postMessage({ kind: RES, id, ok: false, error: String(error.message || error), limit: !!error.limit }, '*');
    }
  });
})();
