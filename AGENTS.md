# Story Studio Image Generator extension

This file supplements the monorepo-level `../AGENTS.md`. Follow both when
working in this extension.

## Purpose

This Manifest V3 Chrome extension reads scene and thumbnail prompts from Story
Studio KH, generates assets through web providers, and saves them back to the
episode with canonical filenames.

Supported providers:

- Google Flow: image only; uses the logged-in Flow web session.
- Qwen Studio: image only; drives the signed-in conversational image workflow.
- Grok Imagine: image only; capture-and-replay adapter.
- Perchance: image only; drives the visible generator controls.
- FreeGen: image only; drives the visible generator controls.
- Leonardo AI: image only; drives the logged-in website and spends web tokens.

Video generation belongs in the sibling `story-studio-video-generator`
extension. Do not add Veo, clip, or video queue paths back to Image Generator.

## Architecture

- `manifest.json`: permissions, provider hosts, content-script pairs, version.
- `src/background.js`: persistent queue, provider tabs, generation dispatch,
  retry policy, and Story Studio ingestion.
- `src/popup/`: side-panel project/episode selection and queue controls.
- `src/options/`: Story Studio, image-provider, and model settings.
- `src/lib/config.js`: settings defaults and storage boundary.
- `src/lib/story-studio.js`: Story Studio REST client.
- `src/lib/flow-exec.js`: one-shot Flow MAIN-world image commands.
- `src/content/grok-main.js` + `grok.js`: Grok MAIN/isolated-world pair.
- `src/content/qwen-main.js` + `qwen.js`: Qwen Studio conversational image
  pair using the prompt, send, assistant-response, and qwen-image contracts.
- `src/content/perchance-main.js` + `perchance.js`: Perchance generator-frame
  pair with explicit style, shape, and quantity controls.
- `src/content/freegen-main.js` + `freegen.js`: FreeGen-specific visible-UI
  pair using its stable prompt, aspect-ratio, result, and error contracts.
- `src/content/leonardo-main.js` + `leonardo.js`: Leonardo-specific visible-UI
  pair with explicit model, style, mode, ratio, size, and background-safe
  MutationObserver result-card handling.

MAIN-world scripts may access page JavaScript, auth state, and controls. Their
isolated-world partner is the only layer that talks to `chrome.runtime`. Keep
that boundary when adding or changing providers.

## Queue guarantees

Long-running work belongs in the background queue, never in the side panel.
The queue must remain:

- Persistent through side-panel closure and service-worker termination.
- Strictly sequential so providers are not flooded.
- Deduplicated by provider and scene identity.
- Resumable for operations known to be safe to repeat.
- Human-paced using the persisted, user-configured min/max delay; worker death
  must not bypass the next allowed provider-request timestamp.
- Flow image reCAPTCHA uses a configurable total of 1–10 fresh-token attempts
  (default 4). Exhaustion re-pends the current item and uses the persisted,
  configurable cooldown timestamp before automatic alarm-driven resume. Manual
  Resume may clear that cooldown early.

Leonardo image jobs interrupted after submission must ask the user to inspect
the provider tab before retrying.

## Provider adapters

Websites change without notice. Provider failures should be explicit and
actionable: identify missing controls, sign-in/browser verification, quota
limits, download failures, and unknown outcomes. Do not silently fall back to a
different provider or private endpoint.

For visible-UI adapters:

- Operate the site's real prompt, aspect-ratio, and Generate controls.
- Capture the set of existing outputs before clicking Generate.
- Return only a newly rendered result.
- Keep selectors specific where verified and provide careful semantic fallbacks.
- Treat quota signals as a pause, not a failed batch.

Grok uses capture-and-replay because its requests are signed. Never persist
captured request headers; session-bound headers stay in page memory only.

## Story Studio contract

Default server URLs are `http://localhost:8000` for desktop and
`http://localhost:8766` for server mode. Remote mode uses the session cookie and
runtime-granted host permission.

Do not casually change filenames or ingest routes. Story Studio depends on the
scene and thumbnail naming scheme. Keep generated credentials, request
templates, and API keys in local Chrome storage only.

## Development and verification

There is no build step. Edit source files, reload the unpacked extension at
`chrome://extensions`, then reload open provider tabs so content scripts update.

Before handing off changes:

1. Run `node --check` on every JavaScript file when Node is available.
2. Parse `manifest.json` and confirm every declared content script exists.
3. Run `git diff --check`.
4. Test the changed provider in Chrome with one image before a batch.
5. Verify Story Studio ingestion when save behavior changes.
6. Bump `manifest.json` for user-facing changes.
7. Commit verified work and push it to the tracked GitHub branch unless the
   user explicitly asks to keep the changes local or separate the commit.

Do not commit generated assets, captured requests, cookies, credentials, or API
keys. Preserve unrelated local changes and the user's active queue data.
