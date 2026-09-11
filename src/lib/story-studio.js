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

function referenceFileName(image) {
  if (typeof image === 'string') return image;
  return image?.filename || image?.name || '';
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

  // Episode rows include top-level scene_images and thumbnail_images aggregates:
  // { total, present, complete }. Completion follows files on disk, not workflow
  // flags; Scene Review approval remains independent.
  listEpisodes(slug) {
    return this._json(`/projects/${encodeURIComponent(slug)}/episodes`);
  }

  episodeStatus(slug, code) {
    return this._json(
      `/projects/${encodeURIComponent(slug)}/episodes/${encodeURIComponent(code)}/status?invalidate=1`
    );
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

  // ── character references (for Flow imageInputs / character consistency) ─────
  // List the project's characters. Each: { id, name, references:{ images:[<filename>] }, ... }.
  listCharacters(slug) {
    return this._json(`/projects/${encodeURIComponent(slug)}/characters`);
  }

  continuity(slug, code) {
    return this._json(`/projects/${encodeURIComponent(slug)}/continuity/${encodeURIComponent(code)}`);
  }

  // Fetch the complete reference context once per enqueue operation. Character
  // image URLs are attached here; the bytes stay out of the persistent queue.
  async referenceAssets(slug, code, title = '') {
    const query = title ? `?title=${encodeURIComponent(title)}` : '';
    const path = `/projects/${encodeURIComponent(slug)}/episodes/${encodeURIComponent(code)}/img2img-references${query}`;
    const [continuity, listing, characterResponse] = await Promise.all([
      this.continuity(slug, code),
      this._json(path),
      this.listCharacters(slug),
    ]);
    const rawCharacters = Array.isArray(characterResponse)
      ? characterResponse
      : Array.isArray(characterResponse?.characters)
        ? characterResponse.characters
        : [];
    const characters = rawCharacters.map((character) => {
      const rawImages = Array.isArray(character?.references?.images)
        ? character.references.images
        : Array.isArray(character?.reference_images)
          ? character.reference_images
          : [];
      const images = rawImages.map((image) => {
        const filename = referenceFileName(image);
        return filename
          ? {
              filename,
              url: `/api/projects/${encodeURIComponent(slug)}/characters/${encodeURIComponent(character.id)}/reference-image/${encodeURIComponent(filename)}`,
            }
          : null;
      }).filter(Boolean);
      return { ...character, references: { ...(character?.references || {}), images } };
    });
    return { continuity, listing, characters };
  }

  async referenceAssetBase64(descriptor) {
    const label = descriptor?.label || 'reference asset';
    const rawUrl = typeof descriptor?.url === 'string' ? descriptor.url : '';
    if (!rawUrl) throw new Error(`Story Studio reference ${label} has no download URL.`);
    let assetUrl;
    try {
      assetUrl = new URL(rawUrl, `${this.base}/`);
      if (assetUrl.origin !== new URL(this.base).origin || !assetUrl.pathname.startsWith('/api/projects/')) {
        throw new Error('not a Story Studio project asset');
      }
    } catch {
      throw new Error(`Story Studio reference ${label} has an invalid download URL.`);
    }
    const res = await fetch(assetUrl.href, { credentials: 'include' });
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = body?.detail ? ` ${body.detail}` : '';
      } catch {
        /* non-JSON error body */
      }
      throw new Error(`Story Studio could not serve ${label} (${res.status}).${detail} Open the reference in Story Studio or restore the advertised asset before retrying.`);
    }
    const contentType = res.headers.get('content-type') || 'image/png';
    if (!contentType.startsWith('image/')) throw new Error(`Story Studio returned a non-image response for ${label}.`);
    const buf = await res.arrayBuffer();
    if (!buf.byteLength) throw new Error(`Story Studio reference ${label} is empty.`);
    return { base64: abToBase64(buf), mime: contentType };
  }

  // The raw scene plan → { scene_plan: { scenes: [{ id, scene_type, ... }] }, ... }.
  // Used to read each scene's `scene_type` (character/environment/event/…), which
  // scene-review does NOT expose — so the reference only lands on character scenes.
  scenePlan(slug, code) {
    return this._json(
      `/projects/${encodeURIComponent(slug)}/scene-plan/${encodeURIComponent(code)}`
    );
  }

}
