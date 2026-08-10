# Image Provider Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce Image Generator to five maintained providers and ingest bounded multi-reference assets from Story Studio without changing queue, Fleet Hub, or save-back guarantees.

**Architecture:** A data-only provider registry owns maintained-provider metadata and capabilities. Explicit provider handlers remain in the worker. Pure settings, queue-migration, and reference-resolution helpers are covered with Node's built-in test runner; browser adapters receive resolved reference arrays.

**Tech Stack:** Chrome Manifest V3, browser ES modules, Node.js `node:test`, no third-party dependencies.

## Global Constraints

- Keep only `flow`, `aistudio`, `qwen`, `leonardo`, and `chatgpt`.
- Remove `grok`, `perchance`, `freegen`, `pollinations`, and `piclumen` completely.
- Never route an unknown or removed provider to another provider.
- Preserve sequential persistent queueing, pacing, cooldowns, Fleet Hub reporting, Story Studio ingestion, and standalone downloads.
- Queue items store reference descriptors, never base64 payloads.
- Flow, AI Studio, and ChatGPT support bounded reference arrays; Qwen remains capped at one; Leonardo remains provider-page managed.
- Add no runtime dependency, plugin framework, remote provider configuration, or runtime manifest generation.
- Bump `manifest.json`, update `CHANGELOG.md`, commit verified work, and push `main`.

---

### Task 1: Provider Registry And Settings Migration

**Files:**
- Create: `package.json`
- Create: `src/lib/providers.js`
- Create: `test/providers.test.js`
- Create: `test/config.test.js`
- Modify: `src/lib/config.js`

**Interfaces:**
- Produces: `PROVIDERS`, `PROVIDER_IDS`, `DEFAULT_PROVIDER_ID`, `getProvider(id)`, `isMaintainedProvider(id)`, and `normalizeSelectedProvider(id)`.
- Produces: exported pure `normalizeSettings(settings)` used by storage-backed `getSettings()` and `saveSettings()`.
- Provider entries expose `id`, `label`, `workspace`, `scripts`, `contextMessage`, `downloadHosts`, `settings`, and `capabilities` including `characterReferences`, `storyStudioReferences`, `maxReferences`, `cooldown`, `visibleTab`, and `modelDiscovery`.

- [ ] **Step 1: Add the failing provider-registry tests**

Assert the exact ordered IDs `['flow', 'aistudio', 'qwen', 'leonardo', 'chatgpt']`, uniqueness, Flow fallback, Leonardo-only model discovery, and reference caps: Flow `4`, AI Studio `4`, Qwen `1`, Leonardo `0`, ChatGPT `4`.

- [ ] **Step 2: Add the failing settings tests**

Import `normalizeSettings` and assert that a removed provider normalizes to `flow`, maintained provider values survive, obsolete provider cooldowns disappear, and maintained cooldown values remain clamped.

- [ ] **Step 3: Run tests and verify RED**

Run: `node --test test/providers.test.js test/config.test.js`

Expected: failure because the registry and exported normalizer do not exist.

- [ ] **Step 4: Implement the minimal registry and settings normalization**

Add `package.json` with only `{ "type": "module", "scripts": { "test": "node --test" } }`. Remove retired provider defaults and Pollinations token migration/storage. Rename `characterRefEnabled` to `storyStudioReferencesEnabled`, migrating an explicitly false legacy value to false and otherwise defaulting true.

- [ ] **Step 5: Run tests and commit**

Run: `npm test`

Commit: `refactor: centralize maintained image providers`

### Task 2: Retired Provider Removal And Queue Safety

**Files:**
- Create: `src/lib/queue-migration.js`
- Create: `test/queue-migration.test.js`
- Create: `test/manifest.test.js`
- Modify: `manifest.json`
- Modify: `src/background.js`
- Modify: `src/popup/popup.html`
- Modify: `src/popup/popup.js`
- Delete: `src/content/grok-main.js`
- Delete: `src/content/grok.js`
- Delete: `src/content/perchance-main.js`
- Delete: `src/content/perchance.js`
- Delete: `src/content/freegen-main.js`
- Delete: `src/content/freegen.js`
- Delete: `src/content/piclumen-main.js`
- Delete: `src/content/piclumen.js`

**Interfaces:**
- Consumes: provider registry from Task 1.
- Produces: `migrateQueue(queue, now)` and `canRetryItem(item)`.
- `migrateQueue` preserves `done` and existing `failed` history; pending/running retired items become failed with `failure.code = 'provider-removed'`, `fleetRetrySafe = false`, and timestamps. It is idempotent.

- [ ] **Step 1: Add failing queue migration tests**

Cover retired pending/running failures, maintained running preservation for startup recovery, completed/history preservation, legacy item provider preservation, retry rejection, and idempotence.

- [ ] **Step 2: Add failing manifest tests**

Read `manifest.json`; assert removed hosts/scripts are absent, every declared content-script file exists, and maintained registry workspace hosts are represented by manifest permissions where required.

- [ ] **Step 3: Run tests and verify RED**

Run: `node --test test/queue-migration.test.js test/manifest.test.js`

Expected: failure because retired registrations remain and migration helpers do not exist.

- [ ] **Step 4: Delete retired adapters and remove every retired registration**

Generate the provider select from `PROVIDERS`. Delete retired UI cards, listeners, settings population, context checks, cooldown entries, worker generators, host allowlists, script reinjection entries, and message cases.

- [ ] **Step 5: Replace unsafe dispatch fallthrough and wire queue migration**

Use an explicit handler map for the five providers. Unknown providers throw a provider-removed error. Run `migrateQueue` at the queue read/startup boundary and use `canRetryItem` for local and Fleet retries.

- [ ] **Step 6: Run tests and commit**

Run: `npm test`

Commit: `refactor: remove retired image providers`

### Task 3: Story Studio Multi-Reference Resolution

**Files:**
- Create: `src/lib/reference-assets.js`
- Create: `test/reference-assets.test.js`
- Modify: `src/lib/story-studio.js`
- Modify: `src/lib/queue-migration.js`
- Modify: `src/background.js`

**Interfaces:**
- Produces: `normalizeReferenceContext({ continuity, listing, characters })`.
- Produces: `resolveReferenceDescriptors({ kind, sceneKey, prompt, context, maxReferences })` returning ordered unique `{ source, label, url, characterId?, filename? }` descriptors.
- Adds `StudioClient.continuity(slug, code)`, `StudioClient.referenceAssets(slug, code, title)`, and `StudioClient.referenceAssetBase64(descriptor)`.
- Queue items carry `referenceDescriptors`; legacy `characterRef` becomes one character descriptor during migration.

- [ ] **Step 1: Add failing resolver tests**

Cover thumbnail-only resolution; master, matching scene, matching/anchor character images, composition, and style ordering; continuity toggles; character-name boundary matching; URL de-duplication; provider cap truncation; malformed/missing optional response fields; and legacy `characterRef` conversion.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test test/reference-assets.test.js test/queue-migration.test.js`

Expected: failure because reference helpers and client methods do not exist.

- [ ] **Step 3: Implement pure response normalization and descriptor resolution**

Use Story Studio's existing continuity, img2img-reference listing, character listing, character-file, and episode-file routes. Do not store bytes in queue items. Treat an advertised asset download failure as actionable; skip absent optional descriptors.

- [ ] **Step 4: Resolve descriptors at enqueue and bytes lazily at execution**

Fetch one episode reference context per enqueue call, attach bounded descriptors per scene, fetch bytes through a worker cache keyed by descriptor URL, and preserve scene-type/reference gating only where the Story Studio continuity data calls for it.

- [ ] **Step 5: Run tests and commit**

Run: `npm test`

Commit: `feat: ingest Story Studio reference assets`

### Task 4: Provider Adapters, Panel Copy, And Release

**Files:**
- Create: `test/reference-attachments.test.js`
- Modify: `src/content/aistudio-main.js`
- Modify: `src/content/chatgpt-main.js`
- Modify: `src/content/qwen-main.js`
- Modify: `src/lib/flow-exec.js`
- Modify: `src/background.js`
- Modify: `src/popup/popup.html`
- Modify: `src/popup/popup.js`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `AGENTS.md`
- Modify: `manifest.json`

**Interfaces:**
- Provider requests receive `references: Array<{ base64, mime, name, label }>`.
- Flow maps every reference to `IMAGE_INPUT_TYPE_REFERENCE`.
- AI Studio and ChatGPT clear prior attachments, paste each reference sequentially, and verify the final attachment count.
- Qwen accepts the first reference only and preserves its verified one-chip safety behavior.
- Leonardo continues detecting provider-page references and clearly reports that Story Studio auto-ingest is unavailable for that adapter.

- [ ] **Step 1: Add failing adapter contract tests**

Use source-contract tests for Flow's mapping and exported/pure attachment planning where DOM execution cannot run under Node. Assert provider cap enforcement before adapters receive bytes.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test test/reference-attachments.test.js`

Expected: failure because adapters still accept one `reference`.

- [ ] **Step 3: Implement bounded adapter arrays and panel behavior**

Replace the character dropdown with one `Use Story Studio references` checkbox and a concise source summary. Show unsupported auto-ingest copy for Leonardo. Preserve existing layout and accessibility labels.

- [ ] **Step 4: Update release metadata and docs**

Bump `manifest.json` from `0.48.0` to `0.49.0`. Add a changelog entry covering the five-provider catalog, removed-provider queue migration, central registry, Story Studio reference ingestion, and provider reference caps. Update provider lists in README and AGENTS.

- [ ] **Step 5: Run full verification**

Run: `npm test`

Run: `find src -type f -name '*.js' -print0 | xargs -0 -n1 node --check`

Run a manifest declared-file existence check and `git diff --check`.

Run: `graphify update .`

Inspect Graphify for references to removed providers outside changelog/history and verify no deleted adapter is reachable.

Smoke-test one maintained provider in Chrome when browser control is available; otherwise record that live provider verification remains manual.

- [ ] **Step 6: Commit and push**

Commit: `feat: simplify image providers and references`

Push verified `main` to `origin`.
