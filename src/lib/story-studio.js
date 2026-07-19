// Companion-mode client for the Story Studio KH local server.
//
// Story Studio runs an Express API. Two flavours, same routes:
//   - Desktop app:  http://localhost:8000   (no auth)
//   - Server mode:  http://localhost:8766   (session-cookie auth)
// All routes are mounted under /api. Auth is a single POST /api/auth/login that
// sets an HttpOnly `ssk_session` cookie; localhost loopback bypasses auth, so a
// local studio needs no login at all. We keep this a thin REST wrapper.
//
// Scene endpoints used here (verified against the real routes):
//   GET  /projects                                     -> [{ name, slug, ... }]
//   GET  /projects/:slug/episodes                      -> [{ episode_code, title, status:{ scene_plan, images, ... } }]
//   GET  /projects/:slug/scene-review/:code            -> { scene_plan, scenes:[{ id, scene_index, visual_prompt,
//                                                            image_filename, approved, stale }], stats }
//   POST /projects/:slug/scene-review/:code/upload-image/:sceneId  { data_base64 }
//          -> writes {sceneId}.png into the "05 Scene Images" folder and updates
//             scene_plan.json (image_path, approved=false). THIS is the save-back.

function abToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

export class StudioClient {
  constructor(baseUrl) {
    this.base = (baseUrl || '').replace(/\/+$/, '');
  }

  async _json(path, opts = {}) {
    const res = await fetch(`${this.base}/api${path}`, {
      credentials: 'include',
      headers: { Accept: 'application/json', ...(opts.headers || {}) },
      ...opts,
    });
    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`;
      try {
        const body = await res.json();
        if (body?.detail) detail = body.detail;
      } catch {
        /* non-JSON error body */
      }
      const err = new Error(detail);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  // Returns { username, mode }. Throws 401 in server mode when not logged in.
  whoami() {
    return this._json('/auth/me');
  }

  // Server mode only. Sets the session cookie as a side effect.
  login(username, password) {
    return this._json('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
  }

  listProjects() {
    return this._json('/projects');
  }

  // Episode rows: { episode_code, title, status: { scene_plan, scene_review,
  // images, video, ... } }. scene_plan = a scene_plan.json exists; images =
  // every expected scene image is on disk.
  listEpisodes(slug) {
    return this._json(`/projects/${encodeURIComponent(slug)}/episodes`);
  }

  // The authoritative per-scene list for an episode, including the per-scene
  // image prompt (`visual_prompt`), whether an image already exists
  // (`image_filename`), approval and staleness. Resolves by episode CODE — no
  // title query needed (unlike the script endpoints).
  sceneReview(slug, code) {
    return this._json(
      `/projects/${encodeURIComponent(slug)}/scene-review/${encodeURIComponent(code)}`
    );
  }

  // Save a generated image back into the episode's real "05 Scene Images"
  // folder as {sceneId}.png and update scene_plan.json. base64 is the raw image
  // bytes (no data: prefix). SCENE PLAN source.
  uploadSceneImage(slug, code, sceneId, base64) {
    return this._json(
      `/projects/${encodeURIComponent(slug)}/scene-review/${encodeURIComponent(
        code
      )}/upload-image/${encodeURIComponent(sceneId)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data_base64: base64 }),
      }
    );
  }

  // ── SCENE PROMPTS source ("03 Scene Prompts" / {CODE}_Scene_Prompts.md) ─────
  // Per-scene image prompts from the Image Prompts Generator. NOTE: needs the
  // episode title to resolve the on-disk folder (like the script endpoints).
  // Returns { scenes: [{ number, title, prompt }], thumbnails: [...] }.
  imagePrompts(slug, code, title = '') {
    const q = title ? `?title=${encodeURIComponent(title)}` : '';
    return this._json(
      `/projects/${encodeURIComponent(slug)}/episodes/${encodeURIComponent(code)}/image-prompts${q}`
    );
  }

  // Which numbered scene images already exist on disk for a scene-prompts
  // episode → { scenes: { total, present, missing: [n...] }, dir: {...} }.
  imageStatus(slug, code) {
    return this._json(
      `/projects/${encodeURIComponent(slug)}/episodes/${encodeURIComponent(code)}/image-status`
    );
  }

  // Save a generated image for the PROMPTS source as the native generator's
  // name/dir:  kind 'scene' → {CODE}_Scene{NN}_v1.png in "05 Scene Images";
  // kind 'thumbnail' → {CODE}_Thumb{NN}_v1.png in "06 Thumbnail Images".
  // (Endpoint added to story-studio-kh — needs an app rebuild.)
  ingestImage(slug, code, kind, number, base64, title = '') {
    return this._json(
      `/projects/${encodeURIComponent(slug)}/episodes/${encodeURIComponent(code)}/image-ingest`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, number, data_base64: base64, title }),
      }
    );
  }

  // ── image-to-video (scene_plan source) ─────────────────────────────────────
  // Read a scene's existing {scene_id}.png so it can be uploaded to Flow and
  // animated. Returns { base64, mime }.
  async sceneImageBase64(slug, code, sceneId) {
    const res = await fetch(
      `${this.base}/api/projects/${encodeURIComponent(slug)}/scene-review/${encodeURIComponent(
        code
      )}/image/${encodeURIComponent(sceneId)}`,
      { credentials: 'include' }
    );
    if (!res.ok) throw new Error(`Scene image not found (${res.status}).`);
    const buf = await res.arrayBuffer();
    if (!buf.byteLength) throw new Error('Scene image is empty on disk.');
    return { base64: abToBase64(buf), mime: res.headers.get('content-type') || 'image/png' };
  }

  // ── character references (for Flow imageInputs / character consistency) ─────
  // List the project's characters. Each: { id, name, references:{ images:[<filename>] }, ... }.
  listCharacters(slug) {
    return this._json(`/projects/${encodeURIComponent(slug)}/characters`);
  }

  // The raw scene plan → { scene_plan: { scenes: [{ id, scene_type, ... }] }, ... }.
  // Used to read each scene's `scene_type` (character/environment/event/…), which
  // scene-review does NOT expose — so the reference only lands on character scenes.
  scenePlan(slug, code) {
    return this._json(
      `/projects/${encodeURIComponent(slug)}/scene-plan/${encodeURIComponent(code)}`
    );
  }

  // Fetch a character's reference-image bytes as base64 (to upload to Flow).
  async characterReferenceImageBase64(slug, characterId, filename) {
    const res = await fetch(
      `${this.base}/api/projects/${encodeURIComponent(slug)}/characters/${encodeURIComponent(
        characterId
      )}/reference-image/${encodeURIComponent(filename)}`,
      { credentials: 'include' }
    );
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = body?.detail ? ` ${body.detail}` : '';
      } catch {
        /* non-JSON error body */
      }
      throw new Error(
        `Story Studio could not serve character reference "${filename}" for ${slug}/${characterId} (${res.status}).${detail} ` +
          'Open the same reference preview in Story Studio or restart/update Story Studio so its reference-image route is active.'
      );
    }
    const buf = await res.arrayBuffer();
    if (!buf.byteLength) throw new Error('Character reference image is empty.');
    return { base64: abToBase64(buf), mime: res.headers.get('content-type') || 'image/png' };
  }

  // Save an animated clip for a scene. mp4 is raw bytes (ArrayBuffer/Uint8Array)
  // POSTed as Content-Type video/mp4 — the upload-clip route takes raw binary
  // (256 MB cap), NOT base64 JSON. Writes {scene_id}.mp4 to "11 Video Assets".
  async uploadClip(slug, code, sceneId, mp4) {
    const res = await fetch(
      `${this.base}/api/projects/${encodeURIComponent(slug)}/scene-review/${encodeURIComponent(
        code
      )}/upload-clip/${encodeURIComponent(sceneId)}`,
      { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'video/mp4' }, body: mp4 }
    );
    if (!res.ok) {
      let detail = `${res.status}`;
      try {
        const j = await res.json();
        if (j?.detail) detail = j.detail;
      } catch {
        /* non-JSON */
      }
      throw new Error(`Story Studio rejected the clip: ${detail}`);
    }
    return res.json();
  }
}
