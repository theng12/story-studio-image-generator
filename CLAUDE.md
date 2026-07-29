# Story Studio Image Generator (`story-studio-image-generator`)

MV3 image-only extension: generates Story Studio KH scene images and thumbnails
through supported image providers, including **Google Flow** and **Grok
Imagine**, then saves them back into the episode. Video generation
lives in the sibling `../story-studio-video-generator` extension. Sibling to
`story-studio-audio-generator` — same architecture (see parent `../CLAUDE.md`). Full
writeup in `README.md`.

## Flow automation — how it actually works (verified live 2026-06-27)

Fully API-driven from a logged-in `labs.google/fx` tab:

- **Auth:** `Authorization: Bearer <access_token>`, token from the page's own
  NextAuth session — `GET /fx/api/auth/session` → `{ user, expires, access_token }`.
  A logged-in tab must stay open: the session lives there *and* the call must run
  same-origin from the content script.
- **reCAPTCHA is ENFORCED** (server-side, blanking it → `403 reCAPTCHA evaluation
  failed`). It is minted on the Flow page by the narrowly scoped
  `src/lib/flow-exec.js` execution helper; do not move this work into the
  background worker.
- Generation goes through `flowMedia:batch…`; assets come back as a `fifeUrl` CDN
  link, fetched same-origin.
- **Creating a project** (for auto-rollover) is a *different* API — a same-origin
  Next.js tRPC call on labs.google, cookie-auth, no aisandbox token / reCAPTCHA
  (verified live 2026-07-09): `POST /fx/api/trpc/project.createProject`
  `{ json: { projectTitle, toolName: 'PINHOLE' } }` →
  `result.data.json.result.projectId`. Navigating to an *un-created* `/project/<uuid>`
  just shows "Something went wrong" — you must create it first. The Flow
  execution helper creates the project before `background.startNewFlowProject`
  navigates there.

## Scene plan & save-back (companion mode)

- Read: `GET /api/projects/:slug/scene-review/:code` → scenes with `visual_prompt`,
  `image_filename`, `approved`, `stale`. Missing scenes are pre-selected in the panel.
- Save: `POST /api/projects/:slug/scene-review/:code/upload-image/:sceneId`
  `{ data_base64 }` → Story Studio writes `{sceneId}.png` into the **"05 Scene
  Images"** folder and updates `scene_plan.json`. No Story Studio code changes
  needed — that route already existed.

## Running unattended (tab visibility)

The extension works through a live provider tab, so that tab is subject to
Chrome's background-tab throttling + Memory-Saver freezing. The provider tab must
stay **`visible`** — the active tab in its window, window **not minimized**. It
does **not** need OS focus: verified live 2026-07-01 that a tab reads
`visibilityState:'visible'` while its window is unfocused (`hasFocus:false`). So
the tab can sit in a window parked *behind* your work — just don't minimize it or
cover it with another tab in the same window. A dedicated Chrome window/profile
(or a second monitor / macOS Space) with the provider tab active is the reliable
"leave it running" setup. Hidden tabs get timers clamped (~1s, then ~1/min after
5 min) and can be frozen, which stalls the queue. This is inherent to driving a
web session — it can't be made fully headless.

## Key files

- `src/background.js` — the resumable queue (chrome.storage + chrome.alarms, dedupe).
- `src/lib/flow-exec.js` — narrowly scoped Flow image operations, executed in
  the logged-in Flow tab.
- `src/content/{grok,grok-main}.js` — Grok Imagine pair.
- `src/lib/{config,story-studio}.js` — shared with the sibling extension.
- `src/popup/` side panel, `src/options/` settings.

## Gotchas

- Keep the dedupe in the queue — a double-click must not double-spend Flow credits.
- Flow reCAPTCHA minting is load-bearing; keep it constrained to the Flow tab
  through the execution helper.
