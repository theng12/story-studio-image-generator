# Story Studio Bulk Asset

A Chrome (Manifest V3) extension that generates **scene images** (and, later,
scene video) on **Google Flow** from your **Story Studio KH** scene plan — using
the **web credits from your Google AI subscription** (not the metered
Vertex/Gemini Veo API) — and saves each asset back into the episode with the
correct name.

Sibling to `fish-tts-extension`; same proven architecture (side panel, persistent
resumable queue, MAIN-world content script, Story Studio companion client).

```
┌────────────┐ scene prompts ┌───────────┐  image (same-origin) ┌────────────┐
│ Story      │ ─────────────▶│ Extension │ ────────────────────▶│ Google Flow│
│ Studio KH  │  scene-review │ (panel +  │  flowMedia:batch…    │ (Veo/Imagen│
│ local API  │               │  worker)  │  + self-minted       │  web plan) │
└─────▲──────┘               └─────┬─────┘    reCAPTCHA          └─────┬──────┘
      │   upload-image (PNG)       │                                  │
      └────────────────────────────┘◀─────────── fifeUrl (CDN) ───────┘
```

## How it works

1. The side panel reads the episode's **scene plan** from the running Story
   Studio server: `GET /api/projects/:slug/scene-review/:code` returns each
   scene's `visual_prompt` and whether an image already exists.
2. You pick scenes (missing ones are pre-selected), confirm, and the background
   **queue** generates them on Flow one at a time — survives panel close and
   service-worker death (chrome.storage + chrome.alarms), with dedupe so a
   double-click can't double-spend.
3. Each generated image is saved back via
   `POST /api/projects/:slug/scene-review/:code/upload-image/:sceneId`
   `{ data_base64 }` — Story Studio writes `{sceneId}.png` into the real
   **"05 Scene Images"** folder and updates `scene_plan.json`. (Or to Downloads.)

### Two save targets

- **Story Studio scene folder** (companion mode): POSTs the PNG to the existing
  `upload-image` endpoint. No Story Studio code changes were needed — that route
  already writes the file and updates the plan.
- **Downloads folder** (always available): per-project / per-episode subfolder
  with the scene-derived filename.

## Google Flow automation — how it actually works (verified live 2026-06-27)

Recon against the logged-in studio settled the design. It's **fully API-driven**.

- **Auth.** `Authorization: Bearer <access_token>`, where the token comes from
  the page's own NextAuth session: `GET /fx/api/auth/session` →
  `{ user, expires, access_token }`. A logged-in `labs.google/fx` tab must be
  open because that's where the session lives *and* because the call runs
  same-origin from a content script.

- **reCAPTCHA is ENFORCED** — and we beat it for free. Flow's generate endpoint
  validates a reCAPTCHA Enterprise token server-side (blanking it →
  `403 "reCAPTCHA evaluation failed"`). Unlike fish.audio, you can't skip it.
  **But** it's the invisible/score-based flavour, so the extension mints its own
  passing token in-page with the site's own grecaptcha:

  ```js
  grecaptcha.enterprise.execute('6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV',
                                { action: 'IMAGE_GENERATION' })
  ```

  Verified live: a self-minted token returns `200` + the image. This works
  because the MAIN-world content script runs in **your real Chrome, on the real
  Flow page, with your real Google session and residential IP** — exactly the
  context that already scores well. No paid captcha service (unlike datacenter
  wrappers like useapi.net). This is the make-or-break finding for the project.

- **Image generation** (Nano Banana 2 — internal name `NARWHAL`):
  `POST https://aisandbox-pa.googleapis.com/v1/projects/{projectId}/flowMedia:batchGenerateImages`.
  **Synchronous and free** (0 credits). Request:

  ```jsonc
  {
    "clientContext": {
      "recaptchaContext": { "token": "<self-minted>", "applicationType": "RECAPTCHA_APPLICATION_TYPE_WEB" },
      "projectId": "<uuid>", "tool": "PINHOLE", "sessionId": ";<epoch-ms>"
    },
    "mediaGenerationContext": { "batchId": "<uuid>" },
    "useNewMedia": true,
    "requests": [{
      "clientContext": { /* same */ },
      "imageModelName": "NARWHAL",
      "imageAspectRatio": "IMAGE_ASPECT_RATIO_LANDSCAPE",
      "structuredPrompt": { "parts": [{ "text": "<prompt>" }] },
      "seed": 287428,
      "imageInputs": []   // image-to-image / character refs go here
    }]
  }
  ```

  Response: `media[0].image.generatedImage.fifeUrl` — a Google FIFE CDN URL. We
  fetch it (bounded to `=s2048`) and base64 it for the save-back.

- **Video (Veo) — implemented, text-to-video, saves to Downloads.** Async, and
  credit-costed (~20/clip for Veo 3.1 Fast), so it's gated behind a confirm
  dialog and the queue is resumable (a submitted `mediaId` is persisted the
  instant it's returned, so a worker restart resumes polling instead of
  re-charging). Contract captured live:
  - **Submit:** `POST /v1/video:batchAsyncGenerateVideoText` →
    `{ remainingCredits, workflows:[{name}], media:[{name: mediaId}] }`. Body
    mirrors the image one: `mediaGenerationContext.{batchId, audioFailurePreference}`,
    `clientContext` (self-minted `recaptchaContext`), `requests:[{ aspectRatio,
    textInput.structuredPrompt.parts, videoModelKey:"veo_3_1_t2v_fast", seed }]`,
    `useV2ModelConfig:true`.
  - **Poll:** `POST /v1/video:batchCheckAsyncVideoGenerationStatus`
    `{ media:[{ name: mediaId, projectId }] }` until
    `media[0].mediaMetadata.mediaStatus.mediaGenerationStatus ===
    "MEDIA_GENERATION_STATUS_SUCCESSFUL"`.
  - **Download:** the **background worker** fetches
    `/fx/api/trpc/media.getMediaUrlRedirect?name=<mediaId>&mediaUrlType=MEDIA_URL_TYPE_FULL_MEDIA`
    → 302 → signed `flow-content.google` mp4. (Must be the background, not the
    page: the credentialed redirect's final hop is CORS-opaque to page fetch but
    readable from a background fetch with host permissions.)
  - **Unverified-on-first-run:** the reCAPTCHA action for video is assumed
    `VIDEO_GENERATION`, and image-to-video (`:batchAsyncGenerateVideoImage` +
    `imageInput`, `veo_3_1_i2v_*`) is inferred, not yet exercised. Text-to-video
    is the captured/verified path.
  - **Not yet:** saving video back into Story Studio's "10 Video Assembly Output"
    needs a new video-ingest endpoint there (none exists) + a scene→clip-number
    mapping — phase 2b.

## Grok Imagine — second provider (free image generation)

The panel has a **Provider** switch: **Google Flow** or **Grok Imagine** (xAI).
Grok's free Imagine tier generates images with a **daily limit**; the queue is
built around that — a 2–6 s human-like gap between every generation (both
providers), and when Grok's daily limit is hit the run **pauses and resumes**
later instead of failing the batch.

**How it's driven — capture-and-replay.** Grok signs its API calls
(`x-statsig-id`, and for anon users an `x-signature` derived from a localStorage
key) behind Cloudflare, and its JS bundle is fetch-protected, so it can't be
reverse-engineered the way Flow could. Instead the content script **captures the
page's own Imagine generate request once** (endpoint + headers + body) as a
template, persists it, and **replays it for each scene prompt** — swapping only
the prompt text, so Grok's own auth/signing rides along. That means a one-time
setup: **generate a single image at grok.com/imagine** (with the extension
loaded) so the template is learned; after that, batch from the panel. The panel
tells you when the template is captured.

> Status: the capture harness, replay, daily-limit pause, and multi-provider
> queue are implemented. The exact result-media shape and limit signal are
> finalised from the first captured generation — during development the account's
> free daily quota was exhausted, so the template is captured on the next
> successful Imagine generation. Flow remains the unlimited/free batch workhorse
> (Nano Banana 2); Grok is best for a few hero scenes given its daily cap.

## Install (unpacked)

1. `chrome://extensions` → enable Developer mode → **Load unpacked** → pick this
   folder.
2. Sign in to Google Flow in any tab (`labs.google/fx`).
3. Open the side panel (click the toolbar icon). In **Settings**, set the Story
   Studio URL (default `http://localhost:8766`). Open a Flow project once and
   click **Use current tab** to capture the project ID.
4. Pick a project → episode → **Load scenes** → select → **Queue selected**.

## Status

- **v0.1 — images** (free, synchronous). Verified end-to-end live against a real
  Story Studio scene: scene plan → Flow image → Story Studio scene folder.
- **v0.2–0.5 — video** (Veo, **image-to-video**). Each scene's image + its
  `motion_prompt` (from the Scene Plan) → Veo start-image clip → saved as
  `{scene_id}.mp4` in **"11 Video Assets"** via Story Studio's `upload-clip`
  endpoint (raw mp4), or to Downloads. Two image sources (chosen in Settings):
  *animate the existing `{scene_id}.png`* (uploaded to Flow via `flow/uploadImage`),
  or *generate a fresh image on Flow first*. Submit = `video:batchAsyncGenerateVideoStartImage`
  with `startImage.mediaId` + the motion prompt; poll → download. Credit-costed
  (Veo ~20, Omni Flash ~7), so it's behind the confirm dialog and the queue
  resumes safely. Also: scenes from both prompt sources + thumbnails (v0.3–0.4),
  Grok Imagine as a second provider (v0.3).

> ⚠️ Automating Flow may violate Google's ToS and risk account action. Use at
> your own risk — the project owner has accepted this.
