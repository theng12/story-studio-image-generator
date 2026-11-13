# Story Studio Image Generator extension

Repository instructions supplement the global Codex and development-workstation
safety rules.

## Purpose

A Manifest V3 Chrome extension that generates images from pasted prompts through
web providers and saves them to Downloads. Gateway Studio mode can claim image
jobs from a Gateway server.

Maintained providers, all image-only and driven through the signed-in web session:
Google Flow, Google AI Studio, Qwen Studio, Leonardo AI, ChatGPT.

Video generation belongs in the sibling `story-studio-video-generator`. Do not add
Veo, clip or video queue paths here.

## Architecture

- `manifest.json`: permissions, provider hosts, content-script pairs, version.
- `src/background.js`: persistent queue, provider tabs, dispatch, retry policy, Downloads/Gateway delivery.
- `src/popup/`: side-panel mode, prompts, provider settings, Gateway controls, queue.
- `src/options/`: working mode, Flow RPC fallback ids and Gateway worker settings.
- `src/lib/config.js`: settings defaults and storage boundary.
- `src/lib/providers.js`: provider registry and capabilities.
- `src/lib/model-identity.js`: model snapshots, inventory provenance, generation params.
- `src/lib/flow-exec.js`: one-shot Flow MAIN-world image commands (generate, upload, account/credits, inventory).
- `src/lib/gateway-*.js`: worker transport, job→queue mapping, account/quote, durable bytes.
- `src/content/<provider>-main.js` + `<provider>.js`: MAIN-world and isolated pairs per provider.

MAIN-world scripts may touch page JavaScript, auth state and controls; only the
isolated partner talks to `chrome.runtime`. Keep that boundary.

## Queue guarantees

Long-running work lives in the background queue, never the side panel. The queue
must stay:

- Persistent through side-panel closure and service-worker termination.
- Strictly sequential, so no provider is flooded.
- Deduplicated by provider and prompt identity.
- Resumable only for operations known safe to repeat.
- Human-paced with the persisted user min/max delay; worker death must not bypass
  the next allowed provider-request timestamp.
- Flow reCAPTCHA: 1–10 fresh-token attempts (default 4). Exhaustion re-pends the
  item and uses the persisted cooldown before alarm-driven resume; manual Resume
  may clear that cooldown early.

Leonardo jobs interrupted after submission must ask the user to inspect the
provider tab before retrying.

## Provider adapters

Website changes are expected. Failures must be explicit and actionable — missing
controls, sign-in/browser checks, quota, download failures, unknown outcomes — and
never silently fall back to another provider or private endpoint.

For visible-UI adapters: operate the real prompt, ratio and Generate controls;
capture existing outputs before clicking Generate; return only a newly rendered
result; keep verified selectors with careful semantic fallbacks; treat quota
signals as a pause, not a failed batch.

Gateway reference bytes are bounded before an adapter sees them: Flow at most
four. AI Studio and ChatGPT clear old attachments, paste each reference in order
and verify the final count; Qwen keeps its one-chip check. Leonardo is
provider-page managed and never auto-ingests.

The registry ships with the extension, so new providers need code and manifest
changes. Existing providers refresh their model listings as new models appear,
using exact provider-owned IDs and labels from a verified capture. A known or
bundled model, an observed capture, an authenticated current listing, a supported
request schema and generation eligibility are five separate facts — one proves
none of the others. Missing capture support is an explicit parity gap, never
permission to relabel fallback records as live. Leonardo discovery is live from
the signed-in page by design.

## Gateway worker mode

A second mode beside Standalone (the default).
Gateway items are the only ones carrying `gatewayJobId`. Outbound only: the
extension never listens for inbound requests.

- The account observation is the opaque Flow identity and credits read from the
  signed-in page in the same claim request. Never derive identity from a profile,
  cookie, email or session id, and never invent a balance.
- Executable claims require that fresh same-request account, a matching quote and
  the current control revision. A cached observation or a server-returned account
  binding cannot substitute.
- Flow images are free: an unset price quotes 0 credits and 0 is a real price,
  never "unknown". Settings only overrides it, and the UI states which is in force.
- Unknown outcomes are held, never replayed: unexpected executable offers,
  ambiguous paid submissions and claims we did not quote stay for review, and
  retained bytes can be delivered again without generating.
- Dispatch stops and pacing are persisted before being acknowledged; an invalid or
  unknown control stops dispatch without acknowledging it, and local Resume cannot
  override the manager stop. A close request never kills Chrome, erases a hold or
  clears an unknown outcome.

## Development and verification

No build step: edit source, reload the unpacked extension at `chrome://extensions`,
then reload open provider tabs.

Before handing off changes:

1. `node --check` every JavaScript file, parse `manifest.json`, confirm each
   declared content script exists, and run `git diff --check`.
2. Run the Node test suite (`npm test`). It is fixture-level: it never proves live
   provider behaviour.
3. Bump `manifest.json` for user-facing changes and add a CHANGELOG entry.
4. Verify Downloads and Gateway delivery when save behaviour changes.
5. For discovery or control changes, check refreshed listings against real
   provider captures and trace each supported value through selection, queue
   snapshot, provider request and the Gateway caller. Preserve the caller's
   verified fields; `durationMs` is queue time, not scene duration.
6. Keep the exact source binding, commands, focused check output and exit codes.
   Add authenticated live evidence for each mode and model before calling it
   accepted. Carry unresolved capture and counterpart gaps forward with owner and
   next action; a blocked field does not stop independent source work.

Do not commit generated assets, captured requests, cookies, credentials or API
keys. Preserve unrelated local changes and the user's active queue data.
