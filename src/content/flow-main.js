// MAIN-world script injected into labs.google/fx (Google Flow).
//
// Why MAIN world: Flow's generate API lives on aisandbox-pa.googleapis.com and
// is gated by reCAPTCHA Enterprise that is ENFORCED server-side. Running here —
// same page, same logged-in Google session — lets us:
//   1. read the access token from the page's own NextAuth session, and
//   2. mint a *passing* reCAPTCHA token with the page's own grecaptcha.
// A background fetch could never do either. This script owns the Flow API calls;
// the isolated `flow.js` bridges it to the extension via window.postMessage
// (this world has the page's JS objects but no chrome.* APIs).
//
// Everything here was verified live against the logged-in studio (2026-06-27):
//   - Auth:      GET  /fx/api/auth/session  ->  { access_token }
//   - reCAPTCHA: grecaptcha.enterprise.execute(SITEKEY, { action })   <- self-mint
//                Blanking the token returns 403 "reCAPTCHA evaluation failed";
//                a self-minted token returns 200. So the token is REQUIRED but
//                we can produce a valid one ourselves — no captcha service.
//   - Image:     POST /v1/projects/{projectId}/flowMedia:batchGenerateImages
//                -> SYNCHRONOUS, free (Nano Banana 2 = 0 credits),
//                   media[0].image.generatedImage.fifeUrl (Google FIFE CDN).
//   - Video:     async; submit -> poll video:batchCheckAsyncVideoGenerationStatus
//                (Veo, credit-costed). Phase 2 — stubbed below.

(() => {
  const REQ = 'FLOWEXT_REQ';
  const RES = 'FLOWEXT_RES';
  const API = 'https://aisandbox-pa.googleapis.com/v1';
  // reCAPTCHA Enterprise site key, read from Flow's own enterprise.js?render=...
  const SITEKEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';

  // Internal model enums (verified: Nano Banana 2 == "NARWHAL").
  const IMAGE_MODELS = {
    'nano-banana-2': 'NARWHAL',
    NARWHAL: 'NARWHAL',
  };
  const IMAGE_ASPECT = {
    '16:9': 'IMAGE_ASPECT_RATIO_LANDSCAPE',
    '9:16': 'IMAGE_ASPECT_RATIO_PORTRAIT',
    '1:1': 'IMAGE_ASPECT_RATIO_SQUARE',
    '4:3': 'IMAGE_ASPECT_RATIO_FULL',
    '3:4': 'IMAGE_ASPECT_RATIO_PORTRAIT_FULL',
  };

  // ── auth ────────────────────────────────────────────────────────────────
  // The page authenticates to aisandbox with `Authorization: Bearer <token>`,
  // where the token is the NextAuth session's access_token. Same-origin GET,
  // the session cookie rides along automatically.
  let _tokenCache = { token: '', exp: 0 };
  async function accessToken() {
    const now = Date.now();
    if (_tokenCache.token && now < _tokenCache.exp - 30000) return _tokenCache.token;
    const r = await fetch('/fx/api/auth/session', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!r.ok) throw new Error(`Not signed in to Flow (session ${r.status}). Open labs.google/fx and sign in.`);
    const j = await r.json();
    const tok = j && j.access_token;
    if (!tok) throw new Error('Flow session has no access_token — sign in again at labs.google/fx.');
    // expires is an ISO string; cache until then.
    _tokenCache = { token: tok, exp: j.expires ? Date.parse(j.expires) : now + 5 * 60000 };
    return tok;
  }

  // ── reCAPTCHA (self-minted, the crux of the whole thing) ─────────────────
  function grecap() {
    const g = window.grecaptcha && window.grecaptcha.enterprise;
    if (!g || !g.execute) throw new Error('grecaptcha not loaded yet — reload the Flow tab.');
    return g;
  }
  function mintToken(action) {
    // execute() returns a Promise<string>. Wrap in grecaptcha.ready for safety.
    const g = grecap();
    return new Promise((resolve, reject) => {
      try {
        g.ready(() => {
          g.execute(SITEKEY, { action }).then(resolve, reject);
        });
      } catch (e) {
        reject(e);
      }
    });
  }
  function recaptchaContext(token) {
    return { token, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' };
  }

  // ── small helpers ─────────────────────────────────────────────────────────
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
  function sessionId() {
    // The app sends sessionId as ";<epoch-ms>". Mirror that shape.
    return `;${Date.now()}`;
  }
  function randomSeed() {
    return Math.floor(Math.random() * 1_000_000);
  }
  // Current Flow project id from the URL, if we're on a project page.
  function currentProjectId() {
    const m = location.pathname.match(/\/project\/([0-9a-f-]{36})/i);
    return m ? m[1] : '';
  }

  function bufToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  // FIFE URLs serve a default (often small) size; request a larger render but
  // keep the longest edge bounded (2048px) so the PNG stays comfortably under
  // Story Studio's 10 MB upload body limit while still being crisp enough to
  // drive video. "=s<N>" sets the longest edge.
  const FIFE_SIZE = 2048;
  function fullSizeUrl(fifeUrl) {
    if (!fifeUrl) return fifeUrl;
    if (/=[swhd-]/.test(fifeUrl)) return fifeUrl.replace(/=[^/?]+$/, `=s${FIFE_SIZE}`);
    return fifeUrl + `=s${FIFE_SIZE}`;
  }

  async function downloadAsBase64(url) {
    const r = await fetch(url, { credentials: 'omit' });
    if (!r.ok) throw new Error(`Asset download failed (${r.status}).`);
    const buf = await r.arrayBuffer();
    if (!buf.byteLength) throw new Error('Downloaded asset was empty.');
    const mime = r.headers.get('content-type') || 'image/png';
    return { base64: bufToBase64(buf), mime };
  }

  // ── image generation (verified live) ──────────────────────────────────────
  async function generateImage(p) {
    const projectId = p.projectId || currentProjectId();
    if (!projectId)
      throw new Error('No Flow project selected. Open a Flow project (or set one in the panel) first.');
    if (!p.prompt || !p.prompt.trim()) throw new Error('Empty image prompt.');

    const model = IMAGE_MODELS[p.model] || 'NARWHAL';
    const aspect = IMAGE_ASPECT[p.aspectRatio] || 'IMAGE_ASPECT_RATIO_LANDSCAPE';
    const seed = Number.isFinite(p.seed) ? p.seed : randomSeed();

    const token = await mintToken('IMAGE_GENERATION');
    const sid = sessionId();
    const clientContext = {
      recaptchaContext: recaptchaContext(token),
      projectId,
      tool: 'PINHOLE',
      sessionId: sid,
    };
    const body = {
      clientContext,
      mediaGenerationContext: { batchId: uuid() },
      useNewMedia: true,
      requests: [
        {
          clientContext,
          imageModelName: model,
          imageAspectRatio: aspect,
          structuredPrompt: { parts: [{ text: p.prompt }] },
          seed,
          imageInputs: Array.isArray(p.imageInputs) ? p.imageInputs : [],
        },
      ],
    };

    const r = await fetch(`${API}/projects/${encodeURIComponent(projectId)}/flowMedia:batchGenerateImages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      let detail = `${r.status}`;
      try {
        const j = await r.json();
        if (j?.error?.message) detail = j.error.message;
      } catch {
        /* non-JSON */
      }
      throw new Error(`Flow image generation failed: ${detail}`);
    }
    const j = await r.json();
    const gen = j?.media?.[0]?.image?.generatedImage;
    const fifeUrl = gen?.fifeUrl;
    if (!fifeUrl) throw new Error('Flow returned no image URL.');
    const { base64, mime } = await downloadAsBase64(fullSizeUrl(fifeUrl));
    return {
      base64,
      mime,
      mediaId: gen.mediaId || j.media[0].name,
      seed: gen.seed ?? seed,
      width: j.media[0]?.image?.dimensions?.width,
      height: j.media[0]?.image?.dimensions?.height,
    };
  }

  // ── video generation (Veo) — PHASE 2, async ───────────────────────────────
  // Submit -> poll /v1/video:batchCheckAsyncVideoGenerationStatus until done ->
  // resolve the result fifeUrl. Endpoint/body field names captured in recon
  // (videoModelKey, durationSeconds, aspectRatio, seed, videoPrompt,
  // imageInput/lastFrame, sceneId). Wired up but not yet verified end-to-end —
  // do the first run with the network panel open to confirm exact paths.
  async function generateVideo() {
    throw new Error('Video generation is not enabled yet (phase 2).');
  }

  // ── context probe (lets the panel capture/confirm the project id) ──────────
  async function getContext() {
    let signedIn = false;
    try {
      await accessToken();
      signedIn = true;
    } catch {
      /* not signed in */
    }
    return { projectId: currentProjectId(), signedIn, url: location.href };
  }

  const handlers = { generateImage, generateVideo, getContext };

  window.addEventListener('message', async (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.kind !== REQ) return;
    const { id, op, payload } = d;
    try {
      const fn = handlers[op];
      if (!fn) throw new Error(`Unknown op: ${op}`);
      const result = await fn(payload || {});
      window.postMessage({ kind: RES, id, ok: true, result }, '*');
    } catch (e) {
      window.postMessage({ kind: RES, id, ok: false, error: String(e.message || e) }, '*');
    }
  });
})();
