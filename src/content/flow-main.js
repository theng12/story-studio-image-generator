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

  // Internal image-model enums (the `imageModelName` field). Read live from
  // Flow's own model catalog (`usages[].key` in the picker's state), 2026-07-02:
  //   Nano Banana 2      == "NARWHAL"     (free)
  //   Nano Banana 2 Lite == "HARBOR_SEAL" (free; lighter/faster than NARWHAL)
  //   Nano Banana Pro    == "GEM_PIX_2"   (premium)
  // Other image codenames seen in the bundle (not exposed as separate picks):
  //   GEM_PIX, GEM_PIX_2_UPSAMPLE_2K, GEM_PIX_2_UPSAMPLE_4K.
  const IMAGE_MODELS = {
    'nano-banana-2': 'NARWHAL',
    'nano-banana-2-lite': 'HARBOR_SEAL',
    'nano-banana-pro': 'GEM_PIX_2',
    NARWHAL: 'NARWHAL',
    HARBOR_SEAL: 'HARBOR_SEAL',
    GEM_PIX_2: 'GEM_PIX_2',
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

  function normalizeProjectId(value) {
    const raw = String(value || '').trim();
    const m = raw.match(/(?:\/project\/)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i);
    return m ? m[1].toLowerCase() : raw;
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

  // The generatedImage.fifeUrl points at flow-content.google and serves the
  // native-resolution image. Verified live: a page-context fetch with
  // credentials:'omit' returns the bytes (200); a credentialed fetch is
  // CORS-blocked, and appending a FIFE "=s<N>" size suffix breaks these URLs —
  // so fetch the raw URL as-is, no credentials, no size munging.
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
    const projectId = normalizeProjectId(p.projectId || currentProjectId());
    if (!projectId)
      throw new Error('No Flow project selected. Open a Flow project (or set one in the panel) first.');
    if (!p.prompt || !p.prompt.trim()) throw new Error('Empty image prompt.');

    const model = IMAGE_MODELS[p.model] || 'NARWHAL';
    const aspect = IMAGE_ASPECT[p.aspectRatio] || 'IMAGE_ASPECT_RATIO_LANDSCAPE';
    const seed = Number.isFinite(p.seed) ? p.seed : randomSeed();
    const recaptchaMaxAttempts = Math.min(10, Math.max(1, Math.round(Number(p.recaptchaMaxAttempts) || 4)));

    // reCAPTCHA Enterprise is score-based, so a self-minted token is sometimes
    // rejected (403 "reCAPTCHA evaluation failed") — most often when the tab is
    // hidden or during rapid bursts. The rejection happens BEFORE any image is
    // generated (nothing is spent; images are free anyway), so re-mint a fresh
    // token and retry rather than failing the scene.
    let j = null;
    for (let attempt = 1; ; attempt++) {
      const token = await mintToken('IMAGE_GENERATION');
      const clientContext = {
        recaptchaContext: recaptchaContext(token),
        projectId,
        tool: 'PINHOLE',
        sessionId: sessionId(),
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
      if (r.ok) {
        j = await r.json();
        break;
      }
      let detail = `${r.status}`;
      try {
        const e = await r.json();
        if (e?.error?.message) detail = e.error.message;
      } catch {
        /* non-JSON */
      }
      const recaptchaReject = r.status === 403 || /recaptcha|captcha|evaluation failed/i.test(detail);
      if (recaptchaReject && attempt < recaptchaMaxAttempts) {
        await new Promise((res) => setTimeout(res, 1200 * attempt));
        continue;
      }
      if (recaptchaReject) throw new Error(`Flow reCAPTCHA failed after ${attempt} fresh-token attempts (${r.status}): ${detail}`);
      throw new Error(`Flow image generation failed (${r.status}): ${detail}`);
    }
    const gen = j?.media?.[0]?.image?.generatedImage;
    const fifeUrl = gen?.fifeUrl;
    if (!fifeUrl) throw new Error('Flow returned no image URL.');
    const { base64, mime } = await downloadAsBase64(fifeUrl);
    return {
      base64,
      mime,
      mediaId: gen.mediaId || j.media[0].name,
      seed: gen.seed ?? seed,
      width: j.media[0]?.image?.dimensions?.width,
      height: j.media[0]?.image?.dimensions?.height,
    };
  }

  // ── video generation (Veo) — async ────────────────────────────────────────
  // Two phases, orchestrated by the background worker so no single message is
  // held open for minutes:
  //   submitVideo() -> { mediaId, workflowId }   (returns immediately)
  //   checkVideo()  -> { status, done, failed }   (polled by the worker)
  // The worker then downloads the finished mp4 from the media redirect itself
  // (cross-origin, so it must run in the background with host permissions).
  //
  // Contract captured live 2026-06-28. The reCAPTCHA action for video wasn't
  // captured; 'VIDEO_GENERATION' is the assumption (verify on first run). The
  // image-to-video variant (endpoint :batchAsyncGenerateVideoImage, imageInput)
  // is inferred — text-to-video is the verified path.
  // Text-to-video model keys (the `videoModelKey` field). Verified live:
  // veo_3_1_t2v_fast. The request key is base + mode infix (t2v / i2v); the
  // bundle confirms the i2v counterparts (e.g. veo_3_1_i2v_fast) for the future
  // image-to-video path. Omni Flash's base key is "abra" (from models/statuses);
  // its exact request key is unverified.
  const VIDEO_MODELS = {
    'omni-flash': 'abra',
    'veo-3.1-lite': 'veo_3_1_t2v_lite',
    'veo-3.1-fast': 'veo_3_1_t2v_fast',
    'veo-3.1-quality': 'veo_3_1_t2v_quality',
    veo_3_1_t2v_fast: 'veo_3_1_t2v_fast',
  };
  const VIDEO_ASPECT = {
    '16:9': 'VIDEO_ASPECT_RATIO_LANDSCAPE',
    '9:16': 'VIDEO_ASPECT_RATIO_PORTRAIT',
  };

  async function submitVideo(p) {
    const projectId = normalizeProjectId(p.projectId || currentProjectId());
    if (!projectId) throw new Error('No Flow project selected.');
    if (!p.prompt || !p.prompt.trim()) throw new Error('Empty video prompt.');
    const model = VIDEO_MODELS[p.model] || 'veo_3_1_t2v_fast';
    const aspect = VIDEO_ASPECT[p.aspectRatio] || 'VIDEO_ASPECT_RATIO_LANDSCAPE';
    const seed = Number.isFinite(p.seed) ? p.seed : randomSeed();

    const token = await mintToken('VIDEO_GENERATION');
    const clientContext = {
      projectId,
      tool: 'PINHOLE',
      sessionId: sessionId(),
      recaptchaContext: recaptchaContext(token),
    };
    const body = {
      mediaGenerationContext: { batchId: uuid(), audioFailurePreference: 'BLOCK_SILENCED_VIDEOS' },
      clientContext,
      requests: [
        {
          aspectRatio: aspect,
          textInput: { structuredPrompt: { parts: [{ text: p.prompt }] } },
          videoModelKey: model,
          seed,
          metadata: {},
        },
      ],
      useV2ModelConfig: true,
    };
    const r = await fetch(`${API}/video:batchAsyncGenerateVideoText`, {
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
      throw new Error(`Flow video submit failed (${r.status}): ${detail}`);
    }
    const j = await r.json();
    const media = j?.media?.[0];
    const mediaId = media?.name;
    if (!mediaId) throw new Error('Flow video submit returned no media id.');
    return {
      mediaId,
      workflowId: j?.workflows?.[0]?.name || null,
      remainingCredits: j?.remainingCredits,
    };
  }

  async function checkVideo(p) {
    const projectId = normalizeProjectId(p.projectId || currentProjectId());
    if (!p.mediaId) throw new Error('checkVideo needs a mediaId.');
    const r = await fetch(`${API}/video:batchCheckAsyncVideoGenerationStatus`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ media: [{ name: p.mediaId, projectId }] }),
    });
    if (!r.ok) throw new Error(`Flow video status check failed (${r.status}).`);
    const j = await r.json();
    const m = j?.media?.[0];
    const status = m?.mediaMetadata?.mediaStatus?.mediaGenerationStatus || 'UNKNOWN';
    return {
      status,
      done: status === 'MEDIA_GENERATION_STATUS_SUCCESSFUL',
      failed: /FAILED|ERROR|CANCELL?ED/i.test(status),
      remainingCredits: j?.remainingCredits,
    };
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

  // ── image-to-video (Veo start-image) — verified live 2026-06-28 ────────────
  // Animate a still image with a motion prompt. Two ways to get the Flow media
  // id the model animates: upload an existing image (uploadImage), or reuse the
  // id returned when we generate one on Flow.
  const I2V_MODELS = {
    'veo-3.1-fast': 'veo_3_1_i2v_fast',
    'veo-3.1-lite': 'veo_3_1_i2v_lite',
    'veo-3.1-quality': 'veo_3_1_i2v_quality',
    'omni-flash': 'abra_i2v_4s',
  };
  // Pick the i2v model key, requesting a clip length ≈ the scene window. Omni
  // Flash encodes duration in the key (abra_i2v_{4,6,8,10}) — round UP (the
  // assembler trims longer clips but freeze-fills shorter ones). Veo i2v keys
  // carry no duration (strict proto validation rejects unknown fields, so we
  // don't append one) — clips come at the model default; the assembler fits them.
  function i2vModelKey(modelId, durationSec) {
    if (modelId === 'omni-flash') {
      const allowed = [4, 6, 8, 10];
      const d = Math.ceil(Number(durationSec) || 4);
      return `abra_i2v_${allowed.find((a) => a >= d) || 10}`;
    }
    return I2V_MODELS[modelId] || 'veo_3_1_i2v_fast';
  }

  // Upload an image to the Flow project; returns its media id (for startImage).
  // No reCAPTCHA needed for upload (verified). base64 = raw bytes, no data: prefix.
  async function uploadImage(p) {
    const projectId = normalizeProjectId(p.projectId || currentProjectId());
    if (!projectId) throw new Error('No Flow project selected.');
    if (!p.base64) throw new Error('uploadImage needs base64 image bytes.');
    const r = await fetch(`${API}/flow/uploadImage`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientContext: { projectId, tool: 'PINHOLE' },
        imageBytes: p.base64,
        isUserUploaded: true,
        isHidden: false,
        mimeType: p.mime || 'image/png',
        fileName: p.fileName || 'scene.png',
      }),
    });
    if (!r.ok) throw new Error(`Flow image upload failed (${r.status}).`);
    const j = await r.json();
    const mediaId = j?.media?.name;
    if (!mediaId) throw new Error('Flow upload returned no media id.');
    return { mediaId };
  }

  // Submit an image-to-video generation. params: { projectId, mediaId,
  // motionPrompt, model, aspectRatio, seed }. Returns { mediaId, workflowId }.
  async function submitVideoStartImage(p) {
    const projectId = normalizeProjectId(p.projectId || currentProjectId());
    if (!projectId) throw new Error('No Flow project selected.');
    if (!p.mediaId) throw new Error('submitVideoStartImage needs a startImage mediaId.');
    const model = i2vModelKey(p.model, p.durationSec);
    const aspect = VIDEO_ASPECT[p.aspectRatio] || 'VIDEO_ASPECT_RATIO_LANDSCAPE';
    const seed = Number.isFinite(p.seed) ? p.seed : randomSeed();
    const token = await mintToken('VIDEO_GENERATION');
    const clientContext = {
      projectId,
      tool: 'PINHOLE',
      sessionId: sessionId(),
      recaptchaContext: recaptchaContext(token),
    };
    const body = {
      mediaGenerationContext: { batchId: uuid(), audioFailurePreference: 'BLOCK_SILENCED_VIDEOS' },
      clientContext,
      requests: [
        {
          aspectRatio: aspect,
          textInput: { structuredPrompt: { parts: [{ text: p.motionPrompt || '' }] } },
          videoModelKey: model,
          seed,
          metadata: {},
          startImage: { mediaId: p.mediaId, cropCoordinates: { top: 0, left: 0, bottom: 1, right: 1 } },
        },
      ],
      useV2ModelConfig: true,
    };
    const r = await fetch(`${API}/video:batchAsyncGenerateVideoStartImage`, {
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
      throw new Error(`Flow image-to-video submit failed (${r.status}): ${detail}`);
    }
    const j = await r.json();
    const mediaId = j?.media?.[0]?.name;
    if (!mediaId) throw new Error('Flow i2v submit returned no media id.');
    return { mediaId, workflowId: j?.workflows?.[0]?.name || null, remainingCredits: j?.remainingCredits };
  }

  // ── create a fresh Flow project (for auto-rollover) ────────────────────────
  // Navigating to an un-created project UUID shows "Something went wrong" — Flow
  // won't lazily create one. The real create is this same-origin Next.js tRPC
  // call (cookie auth; no aisandbox token / reCAPTCHA). Verified live 2026-07-09.
  //   POST /fx/api/trpc/project.createProject
  //     { json: { projectTitle, toolName: 'PINHOLE' } }
  //   -> result.data.json.result.projectId
  async function createProject(p) {
    const title =
      (p && p.title) ||
      new Date().toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const r = await fetch('/fx/api/trpc/project.createProject', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ json: { projectTitle: title, toolName: 'PINHOLE' } }),
    });
    if (!r.ok) throw new Error(`Flow createProject failed (${r.status}).`);
    const j = await r.json();
    const projectId = j?.result?.data?.json?.result?.projectId;
    if (!projectId) throw new Error('Flow createProject returned no projectId.');
    return { projectId, title };
  }

  const handlers = { generateImage, submitVideo, checkVideo, uploadImage, submitVideoStartImage, getContext, createProject };

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
