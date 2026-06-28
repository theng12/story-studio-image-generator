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

  // Save a generated image for the SCENE PROMPTS source as
  // {CODE}_Scene{NN}_v1.png in "05 Scene Images". Mirrors upload-image but keyed
  // by scene number. (Endpoint added to story-studio-kh — needs an app rebuild.)
  uploadScenePromptImage(slug, code, sceneNumber, base64, title = '') {
    return this._json(
      `/projects/${encodeURIComponent(slug)}/episodes/${encodeURIComponent(code)}/scene-image-ingest`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scene_number: sceneNumber, data_base64: base64, title }),
      }
    );
  }
}
