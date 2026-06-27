# Flow Scenes for Story Studio

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

- **Video (Veo) — phase 2, not yet enabled.** Async: submit → poll
  `POST /v1/video:batchCheckAsyncVideoGenerationStatus` until done → result
  `fifeUrl` (also reachable via the tRPC redirect
  `/fx/api/trpc/media.getMediaUrlRedirect`). Request fields (from the bundle):
  `videoModelKey` (Veo 3.1 Lite/Fast/Quality, or Omni Flash), `durationSeconds`
  (4/6/8/10), `aspectRatio`, `seed`, `videoPrompt`, `imageInput`/`lastFrame`
  (image-to-video), `sceneId`, plus the same self-minted `recaptchaContext`.
  Veo costs credits (~20/clip for 3.1 Fast 4s); the queue's resumability is what
  makes the slow async generations safe. The exact submit path
  (`video:batchAsyncGenerateVideo`) is inferred from the poll endpoint and must
  be confirmed on the first real run (it goes through a Web Worker, so watch the
  network panel, not just page fetch).

## Install (unpacked)

1. `chrome://extensions` → enable Developer mode → **Load unpacked** → pick this
   folder.
2. Sign in to Google Flow in any tab (`labs.google/fx`).
3. Open the side panel (click the toolbar icon). In **Settings**, set the Story
   Studio URL (default `http://localhost:8766`). Open a Flow project once and
   click **Use current tab** to capture the project ID.
4. Pick a project → episode → **Load scenes** → select → **Queue selected**.

## Status

- **v0.1 — images first** (free, synchronous). End-to-end: scene plan → Flow
  image → Story Studio scene folder.
- Video (Veo) is wired structurally but disabled pending an end-to-end test.

> ⚠️ Automating Flow may violate Google's ToS and risk account action. Use at
> your own risk — the project owner has accepted this.
