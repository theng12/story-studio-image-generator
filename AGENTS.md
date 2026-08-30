# Story Studio Image Generator extension

Repository instructions supplement the global Codex and development-workstation safety rules.

## Purpose

This Manifest V3 Chrome extension reads scene and thumbnail prompts from Story
Studio KH, generates assets through web providers, and saves them back to the
episode with canonical filenames.

Supported providers:

- Google Flow: image only; uses the logged-in Flow web session.
- Google AI Studio: image only; drives the signed-in image-mode UI.
- Qwen Studio: image only; drives the signed-in conversational image workflow.
- Leonardo AI: image only; drives the logged-in website and spends web tokens.
- ChatGPT: image only; drives the signed-in conversational image workflow.

Video generation belongs in the sibling `story-studio-video-generator`
extension. Do not add Veo, clip, or video queue paths back to Image Generator.

## Architecture

- `manifest.json`: permissions, provider hosts, content-script pairs, version.
- `src/background.js`: persistent queue, provider tabs, generation dispatch,
  retry policy, and Story Studio ingestion.
- `src/popup/`: side-panel project/episode selection and queue controls.
- `src/options/`: Story Studio, image-provider, and model settings.
- `src/lib/config.js`: settings defaults and storage boundary.
- `src/lib/providers.js`: maintained provider registry and capabilities.
- `src/lib/reference-assets.js`: Story Studio reference normalization and
  descriptor resolution.
- `src/lib/story-studio.js`: Story Studio REST client.
- `src/lib/flow-exec.js`: one-shot Flow MAIN-world image commands.
- `src/content/aistudio-main.js` + `aistudio.js`: AI Studio conversational
  image pair using prompt, attachment, run, and output contracts.
- `src/content/qwen-main.js` + `qwen.js`: Qwen Studio conversational image
  pair using the prompt, send, assistant-response, and qwen-image contracts.
- `src/content/leonardo-main.js` + `leonardo.js`: Leonardo-specific visible-UI
  pair with explicit model, style, mode, ratio, size, and background-safe
  MutationObserver result-card handling.
- `src/content/chatgpt-main.js` + `chatgpt.js`: ChatGPT conversational image
  pair using a fresh chat, verified attachments, and output contracts.

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

Story Studio references are descriptor-only queue data. Bound reference bytes
before adapters receive them: Flow, AI Studio, and ChatGPT support at most four;
Qwen supports one; Leonardo is provider-page-managed and never auto-ingests
Story Studio references. AI Studio and ChatGPT must clear old attachments, paste
each bounded reference sequentially, and verify the final count. Qwen must keep
its one-chip safety check.

The provider registry is released with the extension; new providers need a code
and manifest update. Leonardo model discovery is intentionally live from the
signed-in page, so its newly available models appear after a model refresh.

## Story Studio contract

Default server URLs are `http://localhost:8000` for desktop and
`http://localhost:8766` for server mode. Remote mode uses the session cookie and
runtime-granted host permission.

Do not casually change filenames or ingest routes. Story Studio depends on the
scene and thumbnail naming scheme. Keep generated credentials, request
templates, and API keys in local Chrome storage only.

Project scene images require `source: 'plan'` and stable Scene Review IDs, and
must save through the Scene Review upload route. Image Prompts ingestion is
thumbnail-only; only an explicit `target: 'download'` bypasses project-scene
safety. Never spend provider work for non-plan project scene jobs.

When references are enabled, resolve Story Studio's episode, matching scene,
character, composition, and style assets into bounded descriptors at enqueue,
then fetch bytes lazily in the worker. Do not store base64 payloads in queue
storage.

## Development and verification

There is no build step. Edit source files, reload the unpacked extension at
`chrome://extensions`, then reload open provider tabs so content scripts update.

Before handing off changes:

1. Run `node --check` on every JavaScript file when Node is available.
2. Parse `manifest.json` and confirm every declared content script exists.
3. Run `git diff --check`.
4. Verify Story Studio ingestion when save behavior changes.
5. Bump `manifest.json` for user-facing changes.

Do not commit generated assets, captured requests, cookies, credentials, or API
keys. Preserve unrelated local changes and the user's active queue data.
