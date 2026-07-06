// MAIN-world driver for PicLumen (piclumen.com) image generation.
//
// PicLumen is API-driven: the SPA POSTs to api.piclumen.com. We replay those
// calls same-origin from the page, authenticating with the site's own authToken
// cookie sent as the Authorization header — cookie-only requests 401; the token
// must be an explicit header (verified live 2026-07-06). Async task model:
//   POST /api/gen/create                        -> { markId, fastHour }
//   POST /api/task/batch-process-task  [markId]  -> poll until status "success"
//   GET  img_urls[0].imgUrl (webp)               -> re-encode to PNG (scenes save as .png)
// Free tier: ~10 "Lumens"/day (1 per image). When the fast quota is gone the
// queue should PAUSE (auto-resume is left off by the user), so fastHour:false
// or a lumen/limit error is surfaced as error.limit = true.

(() => {
  const REQ = 'STUDIO_PICLUMEN_REQ';
  const RES = 'STUDIO_PICLUMEN_RES';
  const API = 'https://api.piclumen.com';
  const DEFAULT_MODEL = '23887bba-507e-4249-a0e3-6951e4027f2b'; // PicLumen Art V1

  // Width/height per aspect ratio (SDXL buckets; 16:9 = 1344x768 confirmed live).
  const RESOLUTION = {
    '1:1': { width: 1024, height: 1024 },
    '16:9': { width: 1344, height: 768 },
    '9:16': { width: 768, height: 1344 },
    '4:3': { width: 1152, height: 896 },
    '3:4': { width: 896, height: 1152 },
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isLumenLimit = (message) => /lumen|insufficient|not enough|quota|limit|credit|balance|too many/i.test(String(message || ''));

  function authToken() {
    const c = document.cookie.split(';').map((s) => s.trim()).find((s) => s.startsWith('authToken='));
    return c ? c.slice('authToken='.length) : '';
  }

  // PicLumen auth is an explicit Authorization header (the authToken cookie
  // value, no "Bearer" prefix); the cookie alone is not accepted.
  async function api(path, { method = 'GET', body } = {}) {
    const token = authToken();
    if (!token) throw new Error('Not signed in to PicLumen — open piclumen.com and sign in.');
    const res = await fetch(API + path, {
      method,
      credentials: 'omit',
      headers: { Authorization: token, ...(body != null ? { 'Content-Type': 'application/json' } : {}) },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 || res.status === 403) throw new Error(`PicLumen rejected the session (${res.status}). Re-sign in on piclumen.com.`);
    if (res.status === 402 || res.status === 429) {
      const e = new Error(`PicLumen limit reached (${res.status}).`);
      e.limit = true;
      throw e;
    }
    let json = null;
    try {
      json = await res.json();
    } catch (e) {
      /* handled below */
    }
    if (!json) throw new Error(`PicLumen ${path} returned an unreadable response (${res.status}).`);
    return json;
  }

  async function submit(params) {
    const ratio = params.aspectRatio || '16:9';
    const resolution = { ...(RESOLUTION[ratio] || RESOLUTION['16:9']), batch_size: 1 };
    const body = {
      type: 'image',
      prompt: params.prompt,
      model_id: params.model || DEFAULT_MODEL,
      negative_prompt: '',
      steps: 6,
      cfg: 1,
      seed: Math.floor(Math.random() * 2 ** 31),
      autoTranslate: false,
      resolution,
      multi_img2img_info: { style_list: [] },
      img_control_info: { style_list: [] },
      mainCategory: '',
      subCategory: '',
      denoise: 1,
      sampler_name: 'euler',
      scheduler: 'normal',
      hiresFixDenoise: 0.5,
    };
    const json = await api('/api/gen/create', { method: 'POST', body });
    if (json.status !== 0 || !json.data || !json.data.markId) {
      const e = new Error(`PicLumen did not accept the job: ${json.message || 'unknown error'}.`);
      e.limit = isLumenLimit(json.message);
      throw e;
    }
    // Fast free quota gone — don't silently fall back to the slow relaxed queue;
    // pause so the operator can rotate to the next provider.
    if (json.data.fastHour === false) {
      const e = new Error('PicLumen fast free quota (Lumens) is exhausted for now.');
      e.limit = true;
      throw e;
    }
    return json.data.markId;
  }

  async function poll(markId, timeoutMs = 210000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const json = await api('/api/task/batch-process-task', { method: 'POST', body: [markId] });
      const list = json.data || [];
      const task = list.find((t) => t.markId === markId) || list[0];
      const status = task && task.status;
      if (status === 'success') {
        const url = task.img_urls && task.img_urls[0] && task.img_urls[0].imgUrl;
        if (!url) throw new Error('PicLumen finished but returned no image URL.');
        return url;
      }
      if (status === 'failed' || status === 'error') {
        const detail = task.info || task.code || 'unknown';
        const e = new Error(`PicLumen generation failed: ${detail}.`);
        e.limit = isLumenLimit(detail);
        throw e;
      }
      await sleep(2000);
    }
    throw new Error('PicLumen did not finish the image before the timeout.');
  }

  // Result is a webp CDN URL; scenes save as {sceneId}.png, so re-encode to PNG.
  // Decoding from a fetched blob (not a cross-origin <img>) keeps the canvas
  // untainted, so toDataURL works.
  async function toPngBase64(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`PicLumen image download failed (${res.status}).`);
    const bitmap = await createImageBitmap(await res.blob());
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    const dataUrl = canvas.toDataURL('image/png');
    const m = dataUrl.match(/^data:(image\/png);base64,(.+)$/s);
    if (!m) throw new Error('PicLumen image could not be re-encoded to PNG.');
    return { mime: m[1], base64: m[2] };
  }

  async function generateImage(params) {
    if (!params.prompt || !params.prompt.trim()) throw new Error('Empty image prompt.');
    const markId = await submit(params);
    const url = await poll(markId);
    return toPngBase64(url);
  }

  async function getContext() {
    if (!authToken()) return { provider: 'piclumen', ready: false, signedIn: false, url: location.href };
    try {
      const json = await api('/api/user/user-current-lumen');
      return {
        provider: 'piclumen',
        signedIn: true,
        ready: true,
        remainingLumen: json && json.data ? json.data.remainingAvailableLumen : null,
        url: location.href,
      };
    } catch (e) {
      return { provider: 'piclumen', signedIn: false, ready: false, url: location.href };
    }
  }

  const handlers = { getContext, generateImage };
  const handleMessage = async (event) => {
    if (event.source !== window || event.data?.kind !== REQ) return;
    const { id, op, payload } = event.data;
    try {
      if (!handlers[op]) throw new Error(`Unknown PicLumen operation: ${op}`);
      const result = await handlers[op](payload || {});
      window.postMessage({ kind: RES, id, ok: true, result }, '*');
    } catch (error) {
      window.postMessage({ kind: RES, id, ok: false, error: String(error.message || error), limit: !!error.limit }, '*');
    }
  };
  // Replace any prior handler so re-injection doesn't stack listeners.
  if (window.__STORY_STUDIO_PICLUMEN_MAIN_HANDLER__)
    window.removeEventListener('message', window.__STORY_STUDIO_PICLUMEN_MAIN_HANDLER__);
  window.__STORY_STUDIO_PICLUMEN_MAIN_HANDLER__ = handleMessage;
  window.addEventListener('message', handleMessage);
})();
