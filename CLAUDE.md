# Story Studio Image Generator (`story-studio-image-generator`)

MV3 image-only extension: generates Story Studio KH scene images and thumbnails
through Google Flow, Google AI Studio, Qwen Studio, Leonardo AI, and ChatGPT,
then saves them back into the episode. Video generation lives in the sibling
`../story-studio-video-generator` extension. Sibling to
`story-studio-audio-generator` — same architecture (see parent `../CLAUDE.md`). Full
writeup in `README.md`.

## Flow automation — how it actually works (verified live 2026-09-07)

Google moved Flow from `labs.google/fx/tools/flow` to **`flow.google.com`** and
rebuilt it as a Google "boq" Angular app. The address is a setting
(`flowWorkspaceUrl`, Settings → Google Flow) so the next move is a paste, not a
release. Everything runs from a signed-in Flow *project* tab
(`/project/<uuid>`), executed in the page by `src/lib/flow-exec.js`:

- **Transport:** every call is a same-origin, cookie-authenticated POST to
  `/_/AiSandboxAngularFrontend/data/batchexecute` with one RPC id, a positional
  array payload in `f.req`, and the page's anti-forgery token (`at`, from
  `WIZ_global_data.SNlM0e`; `f.sid` and `bl` come from the same object). The
  old NextAuth session endpoint and the `aisandbox-pa.googleapis.com` bearer
  API are dead (401 even with a fresh token).
- **reCAPTCHA is still ENFORCED**, same site key, minted in the page with action
  `IMAGE_GENERATION` (generate) or `UPLOAD_IMAGE` (reference upload). Keep this
  work in the page helper, never in the background worker.
- **Generate** = RPC `ogiZ0b`. Answers synchronously with a signed
  `flow-content.google/image/<mediaId>` URL, fetched same-origin. Measured free
  images at 16:9: Nano Banana Pro ~21 s, Nano Banana 2 ~26 s, Nano Banana 2 Lite ~14 s.
- **Reference upload** = RPC `maseQ` (base64 PNG in the payload) → media id,
  cited in the generate payload's image-inputs slot.
- **Models:** the app has no page-side manifest; the helper lists the three the
  picker shows (`GEM_PIX_2` Pro, `NARWHAL` 2, `HARBOR_SEAL` 2 Lite).
- **Not yet captured on the new app:** create-project (auto-rollover fails soft
  and keeps the current project) and aspect ratios other than 16:9.

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
- `src/lib/providers.js` — maintained provider registry and capability limits.
- `src/lib/reference-assets.js` — lazy Story Studio reference descriptors.
- `src/content/{aistudio,qwen,leonardo,chatgpt}-main.js` — web-provider UI
  adapters; AI Studio and ChatGPT verify bounded multi-reference attachments,
  Qwen retains one-reference safety, and Leonardo references stay page-managed.
- `src/lib/{config,story-studio}.js` — shared with the sibling extension.
- `src/popup/` side panel, `src/options/` settings.

## Gotchas

- Keep the dedupe in the queue — a double-click must not double-spend Flow credits.
- Flow reCAPTCHA minting is load-bearing; keep it constrained to the Flow tab
  through the execution helper.
