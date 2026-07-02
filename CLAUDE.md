# Story Studio Bulk Asset (`google-flow-extension`)

MV3 extension: generates scene images (and, later, video) on **Google Flow** from
a Story Studio KH scene plan, using your **web-subscription credits** (not the
metered Vertex/Gemini Veo API), and saves each asset back into the episode. Also
generates images on **Grok Imagine**. Sibling to `fish-tts-extension` — same
architecture (see parent `../CLAUDE.md`). Full writeup in `README.md`.

## Flow automation — how it actually works (verified live 2026-06-27)

Fully API-driven from a logged-in `labs.google/fx` tab:

- **Auth:** `Authorization: Bearer <access_token>`, token from the page's own
  NextAuth session — `GET /fx/api/auth/session` → `{ user, expires, access_token }`.
  A logged-in tab must stay open: the session lives there *and* the call must run
  same-origin from the content script.
- **reCAPTCHA is ENFORCED** (server-side, blanking it → `403 reCAPTCHA evaluation
  failed`). It's the invisible/score-based kind, so the extension **mints its own
  passing token in-page using the site's own `grecaptcha`** — this is why the
  `flow-main.js` MAIN-world script exists. Don't break this path.
- Generation goes through `flowMedia:batch…`; assets come back as a `fifeUrl` CDN
  link, fetched same-origin.

## Scene plan & save-back (companion mode)

- Read: `GET /api/projects/:slug/scene-review/:code` → scenes with `visual_prompt`,
  `image_filename`, `approved`, `stale`. Missing scenes are pre-selected in the panel.
- Save: `POST /api/projects/:slug/scene-review/:code/upload-image/:sceneId`
  `{ data_base64 }` → Story Studio writes `{sceneId}.png` into the **"05 Scene
  Images"** folder and updates `scene_plan.json`. No Story Studio code changes
  needed — that route already existed.
- Alternative save target: Downloads (per-project/episode subfolder, scene-derived name).

## Key files

- `src/background.js` — the resumable queue (chrome.storage + chrome.alarms, dedupe).
- `src/content/{flow,flow-main}.js` — Flow automation pair (MAIN world mints reCAPTCHA).
- `src/content/{grok,grok-main}.js` — Grok Imagine pair.
- `src/lib/{naming,config,story-studio}.js` — shared with the sibling extension.
- `src/popup/` side panel, `src/options/` settings.

## Gotchas

- Keep the dedupe in the queue — a double-click must not double-spend Flow credits.
- The MAIN-world reCAPTCHA minting is load-bearing; the isolated-world script alone
  cannot reach the site's `grecaptcha`.
