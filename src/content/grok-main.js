// MAIN-world script injected into grok.com (xAI Grok — the "Imagine" image/video
// generator). Second provider alongside Google Flow.
//
// Design: CAPTURE-AND-REPLAY. Grok signs its API calls (x-statsig-id, and for
// anon users x-challenge/x-signature derived from a localStorage key) behind
// Cloudflare, so rather than reverse-engineer the signing we let the page make a
// real generation once, capture that exact request as a TEMPLATE (endpoint +
// headers + body), and then replay it for each new scene prompt — swapping only
// the prompt text. Replaying through the page's own window.fetch means any
// fetch-level signing the app installs is applied to our calls too, and the
// session cookie rides along automatically (same origin).
//
// Grok's free Imagine tier has a DAILY LIMIT; when it's hit, generation returns
// an upsell/limit signal instead of media. The worker treats that as "pause,
// resume later" rather than failing the whole batch.
//
// STATUS: the capture harness + replay are implemented; the exact result-media
// shape and the limit signal are finalized from the first captured generation
// (today's free quota was exhausted during recon, so the template is captured on
// the next successful generation — getCapture() exposes what's been seen).

(() => {
  const REQ = 'GROKEXT_REQ';
  const RES = 'GROKEXT_RES';

  // ── capture harness: learn the generate request + result-media shape ───────
  // The prompt lives under one of these keys; it's also the signal that a
  // captured request is actually a GENERATION (options/quota calls have none).
  const PROMPT_KEYS = new Set(['prompt', 'message', 'text']);
  const hasPromptField = (o) =>
    !!o &&
    typeof o === 'object' &&
    Object.keys(o).some((k) => (typeof o[k] === 'string' && o[k].trim() && PROMPT_KEYS.has(k)) || hasPromptField(o[k]));

  // Heuristic match for an image/video *generation* call. Note `/imagine/` also
  // appears in Grok's OPTIONS + quota endpoints (…/models/imagine/overrides,
  // …/media/imagine/quota_info), so exclude those by name — and, decisively,
  // only accept a body that carries a prompt field (see the capture block).
  const isGen = (url, method) =>
    method === 'POST' &&
    /\/rest\//.test(url) &&
    /(generat|imagine|image|video|media\/create|draft|responses)/i.test(url) &&
    !/\b(overrides|quota|quota_info|settings|preferences|history)\b|post\/list|feed|conversations\b/i.test(url);

  // The captured template, persisted via the bridge so it survives reloads.
  let template = null; // { url, method, headers:{}, bodyTemplate, promptPath }
  window.__GROK_CAP = { template: null, samples: [], mediaUrls: [] };

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    init = init || {};
    const method = (init.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
    const capture = isGen(url, method);
    let bodyStr = null;
    if (capture) {
      const b = init.body || (typeof input === 'object' ? input.body : null);
      if (typeof b === 'string') bodyStr = b;
    }
    const resp = await origFetch.apply(this, arguments);
    if (capture && bodyStr) {
      try {
        const headers = {};
        const collect = (h) => {
          if (!h) return;
          if (h instanceof Headers) for (const [k, v] of h.entries()) headers[k] = v;
          else if (Array.isArray(h)) for (const [k, v] of h) headers[k] = v;
          else for (const k of Object.keys(h)) headers[k] = h[k];
        };
        if (typeof input === 'object' && input.headers) collect(input.headers);
        collect(init.headers);
        const parsed = JSON.parse(bodyStr);
        const promptable = hasPromptField(parsed);
        window.__GROK_CAP.samples.push({ url: url.replace(location.origin, ''), status: resp.status, prompt: promptable });
        // Only a request that carries a prompt is a usable generate template —
        // this rejects the /overrides + /quota_info calls that also match isGen.
        if (promptable) {
          const t = { url: url.replace(location.origin, ''), method, headers, body: parsed };
          window.__GROK_CAP.template = t;
          template = t;
          // record result-media URL shape from the response (best-effort)
          try {
            const txt = await resp.clone().text();
            const urls = (txt.match(/https?:\/\/[^"'\s]+\.(?:png|jpg|jpeg|webp|mp4)/gi) || []).slice(0, 3);
            if (urls.length) window.__GROK_CAP.mediaUrls.push(...urls.map((u) => u.split('?')[0]));
          } catch {
            /* opaque */
          }
          // hand the template to the extension to persist
          post('grok:templateCaptured', { template: t });
        }
      } catch {
        /* not JSON / unexpected */
      }
    }
    return resp;
  };

  function post(kind, payload) {
    window.postMessage({ kind: 'GROKEXT_EVENT', event: kind, payload }, '*');
  }

  // ── auth/context ───────────────────────────────────────────────────────────
  async function getContext() {
    let signedIn = false;
    try {
      const r = await origFetch('/rest/app-chat/conversations?pageSize=1', { credentials: 'include' });
      signedIn = r.ok;
    } catch {
      /* ignore */
    }
    return { signedIn, hasTemplate: !!template, url: location.href };
  }

  function loadTemplate(t) {
    // Reject a persisted template with no prompt field — earlier builds captured
    // the prompt-less /overrides call, which then failed every replay. Ignoring
    // it here makes getContext report no template, so a fresh (correct) one is
    // captured on the next real generation.
    if (t && t.url && hasPromptField(t.body)) template = t;
    return { ok: true, hasTemplate: !!template };
  }
  function getCapture() {
    return JSON.parse(JSON.stringify(window.__GROK_CAP));
  }

  // ── generate via replay ────────────────────────────────────────────────────
  async function generateImage(p) {
    if (!template) {
      throw new Error(
        'Grok template not captured yet. Generate one image in grok.com/imagine while the extension is open (free daily quota), then retry.'
      );
    }
    if (!p.prompt || !p.prompt.trim()) throw new Error('Empty prompt.');
    // Clone the captured body and swap the prompt into the obvious field(s).
    const body = JSON.parse(JSON.stringify(template.body));
    let swapped = false;
    const walk = (o) => {
      if (o && typeof o === 'object') {
        for (const k of Object.keys(o)) {
          if (typeof o[k] === 'string' && PROMPT_KEYS.has(k)) {
            o[k] = p.prompt;
            swapped = true;
          } else walk(o[k]);
        }
      }
    };
    walk(body);
    if (!swapped) throw new Error('Could not locate the prompt field in the Grok request template.');

    const headers = { ...template.headers, 'Content-Type': 'application/json' };
    const r = await window.fetch(template.url, {
      method: template.method || 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify(body),
    });
    const txt = await r.text();
    if (!r.ok) {
      if (/limit|quota|upgrade|subscribe|payment|429/i.test(txt) || r.status === 429 || r.status === 402) {
        const e = new Error('Grok daily free limit reached.');
        e.limit = true;
        throw e;
      }
      throw new Error(`Grok generation failed (${r.status}).`);
    }
    // pull the result media URL out of the response
    const mediaUrl = (txt.match(/https?:\/\/[^"'\s]+\.(?:png|jpg|jpeg|webp)/i) || [])[0];
    if (!mediaUrl) {
      if (/limit|quota|upgrade|subscribe/i.test(txt)) {
        const e = new Error('Grok daily free limit reached.');
        e.limit = true;
        throw e;
      }
      throw new Error('Grok returned no image URL (response shape may differ — re-capture).');
    }
    const ir = await window.fetch(mediaUrl, { credentials: 'include' });
    const buf = await ir.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return { base64: btoa(bin), mime: ir.headers.get('content-type') || 'image/jpeg' };
  }

  const handlers = { getContext, getCapture, loadTemplate, generateImage };

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
      window.postMessage({ kind: RES, id, ok: false, error: String(e.message || e), limit: !!e.limit }, '*');
    }
  });
})();
