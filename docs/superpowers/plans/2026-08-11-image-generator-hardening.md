# Image Generator Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Image Generator queue mutations race-safe, prevent duplicate active standalone work, and make every queued model identity truthful before provider submission without replacing the released provider architecture.

**Architecture:** Keep `src/background.js` as the persistent sequential worker, but route every queue read, migration, deduplication, mutation, and write through one serialized `createQueueStore()` boundary. Use pure queue identity/operation helpers for concurrent-enqueue and standalone-history behavior, and use a pure model-identity contract to snapshot provider model data at enqueue and fail closed before execution when a verifiable selection is unknown or changed. Provider pages remain the source of truth for AI Studio, Qwen, ChatGPT, and Leonardo; Flow first uses a read-only signed-session inventory of exact provider-owned internal ID+label records and falls back to only its tested registry IDs when that inventory is unavailable.

**Tech Stack:** Chrome Manifest V3, browser ES modules, Node.js built-in `node:test`, `chrome.storage.local`, signed provider website sessions, no third-party dependencies, no build step.

## Global Constraints

- Keep the released provider set unchanged: Google Flow, Google AI Studio, Qwen Studio, Leonardo AI, and ChatGPT.
- Do not accept developer API keys or add separately billed developer API routes; signed provider web-app requests remain allowed.
- The existing provider registry remains the single metadata source; do not add a plugin framework, dependency, remote provider configuration, or generic form renderer.
- Keep Leonardo live model and control discovery from the signed-in page.
- Keep AI Studio, Qwen, and ChatGPT provider-page model selection; snapshot a stable selected-model label when readable, otherwise use `provider-controlled` without inventing an identity.
- Flow may use only exact provider-advertised internal model IDs and their provider-owned labels; discover them with a read-only signed-session inventory command, never infer an ID from display text, and use the small tested fallback catalog only when discovery returns no trustworthy records, marked as fallback data.
- Queue items snapshot the model ID and available label at enqueue; later settings changes must not alter already-approved paid work.
- An unknown or stale exact model ID, or a changed verifiable website selection, fails before provider submission with refresh-the-signed-provider-page guidance.
- Serialize the complete queue read, migration, deduplication, mutation, and write transaction; concurrent enqueue calls must not overwrite one another.
- Deduplicate active standalone work by provider, normalized prompt, asset kind, and generation settings; completed and terminal history must not block a deliberate new generation.
- Preserve project-scene identity, sequential processing, human pacing, cooldowns, recovery checkpoints, Leonardo ambiguity handling, aggregate episode progress, Scene Plan-only project scenes, thumbnail ingestion, bounded multi-reference resolution, standalone Downloads, Fleet authentication, and paid-work recovery guards.
- Do not move video behavior into this extension.
- Add dependency-free tests for concurrent queue mutation, active standalone deduplication, terminal-history requeue, exact model snapshotting, and fail-closed unknown-model behavior.
- Retain all existing provider, reference, migration, manifest, and episode-progress tests.
- Run the full Node test suite, `node --check` on every JavaScript file, manifest and declared-file validation, and `git diff --check`.
- Live-test one maintained provider and Story Studio save-back when a signed tab is available.
- Bump `manifest.json`, update `CHANGELOG.md` and `README.md`, create frequent local commits during implementation, and finish with the exact release push and remote-alignment check in Task 4 after verification.

---

## File Map Locked Before Tasks

This is the complete planned change surface. Do not add another abstraction or provider file unless a failing test proves this map cannot express the approved behavior.

**Create:**
- `src/lib/queue-store.js` — injectable serialized queue storage boundary with migration-aware reads and updates.
- `src/lib/queue-identity.js` — prompt normalization, generation-setting normalization, project identity, and active standalone keys.
- `src/lib/queue-operations.js` — pure enqueue/deduplication operation used by the worker and tests.
- `src/lib/model-identity.js` — exact Flow inventory normalization, fallback resolution, provider snapshots, generation-setting snapshots, and fail-closed verification.
- `test/queue-store.test.js` — concurrent mutation and migration/write serialization tests.
- `test/queue-operations.test.js` — active standalone deduplication, project identity, and terminal-history requeue tests.
- `test/model-identity.test.js` — exact Flow inventory/fallback IDs, live IDs/labels, provider-controlled identity, snapshot immutability, and failures.

**Modify:**
- `src/lib/providers.js` — exact three-entry Flow fallback metadata and lookup; no web-provider catalog.
- `src/lib/queue-migration.js` — legacy queue model state and safe failure normalization.
- `src/background.js` — queue-store integration, enqueue snapshots, pre-submit verification, and item-snapshot dispatch.
- `src/lib/flow-exec.js` — exact internal Flow ID validation before POST.
- `src/content/aistudio-main.js`, `src/content/qwen-main.js`, `src/content/chatgpt-main.js` — stable page model context or provider-controlled context.
- `src/content/leonardo-main.js` — live selected model ID and readable label in context.
- `src/popup/popup.js`, `src/popup/popup.html` — truthful queued-model diagnostics and copy.
- `test/queue-migration.test.js`, `test/integration-fixes.test.js`, `test/providers.test.js`, `test/manifest.test.js` — hardening and release assertions.
- `manifest.json` — version only, from `0.49.3` to `0.50.0`; preserve hosts/scripts/providers.
- `CHANGELOG.md`, `README.md` — release notes and user-facing model/queue documentation.

---

### Task 1: Model Identity Contracts And Flow Metadata

**Files:**
- Create: `src/lib/model-identity.js`
- Create: `test/model-identity.test.js`
- Modify: `src/lib/providers.js`
- Modify: `test/providers.test.js`

**Interfaces:**
- Consumes: a provider ID, Flow `configuredModel`, signed-page `liveModel: { id, label }`, or read-only Flow inventory entries `{ id, label }`.
- Produces: `FLOW_FALLBACK_MODELS`, `getFlowModel(id)`, `normalizeFlowInventory(entries)`, `flowInventoryResult(entries)`, `resolveFlowModel(modelId, inventory)`, `MODEL_SOURCES`, `snapshotProviderModel({ provider, configuredModel, liveModel, flowInventory })`, `generationSettingsFor(provider, settings, modelSnapshot)`, and `assertProviderModel({ provider, snapshot, current })`.
- A snapshot is `{ modelId: string|null, modelLabel: string, modelSource: 'fallback'|'live'|'provider-label'|'provider-controlled' }`.
- A normalized live record is `{ modelId: string, modelLabel: string }`; `modelId` is copied from a provider-owned internal-ID field and `modelLabel` from the matching provider-owned label field. No normalizer may derive either field by parsing display text.
- `flowInventoryResult(entries)` returns `{ source: 'live'|'fallback', models: Array<{ modelId, modelLabel }> }`; it returns `live` only when at least one exact provider-owned record survives normalization.
- `generationSettingsFor()` returns `{ modelId, modelLabel, modelSource, aspectRatio, style, mode, size, count, maxWaitSec }`.
- `assertProviderModel()` returns `undefined` on a match or throws `code: 'model-unknown'` or `code: 'model-selection-changed'` before submission.

- [ ] **Step 1: Write the failing identity tests**

Create `test/model-identity.test.js` with Node’s built-in runner:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { assertProviderModel, flowInventoryResult, generationSettingsFor, resolveFlowModel, snapshotProviderModel } from '../src/lib/model-identity.js';
import { FLOW_FALLBACK_MODELS, getFlowModel } from '../src/lib/providers.js';

test('Flow exposes only exact tested fallback IDs', () => {
  assert.deepEqual(FLOW_FALLBACK_MODELS, [
    { id: 'nano-banana-2', internalId: 'NARWHAL', label: 'Nano Banana 2', source: 'fallback' },
    { id: 'nano-banana-2-lite', internalId: 'HARBOR_SEAL', label: 'Nano Banana 2 Lite', source: 'fallback' },
    { id: 'nano-banana-pro', internalId: 'GEM_PIX_2', label: 'Nano Banana Pro', source: 'fallback' },
  ]);
  assert.deepEqual(getFlowModel('nano-banana-2'), FLOW_FALLBACK_MODELS[0]);
  assert.equal(getFlowModel('stale-model'), undefined);
});

test('Flow snapshots its exact internal ID as fallback data', () => {
  assert.deepEqual(snapshotProviderModel({ provider: 'flow', configuredModel: 'nano-banana-2' }), {
    modelId: 'NARWHAL', modelLabel: 'Nano Banana 2', modelSource: 'fallback',
  });
});

test('Flow accepts exact provider-owned live IDs and labels only', () => {
  const inventory = flowInventoryResult([
    { id: 'FLOW_NEW_01', label: 'Nano Banana Experimental' },
    { id: 'FLOW_NEW_01', label: 'duplicate' },
    { id: 'Nano Banana Experimental', label: 'display-derived ID' },
    { id: 'FLOW_BAD', label: '' },
  ]);
  assert.deepEqual(inventory, {
    source: 'live',
    models: [{ modelId: 'FLOW_NEW_01', modelLabel: 'Nano Banana Experimental' }],
  });
  assert.deepEqual(resolveFlowModel('FLOW_NEW_01', inventory), inventory.models[0]);
  assert.equal(resolveFlowModel('Nano Banana Experimental', inventory), undefined);
  assert.deepEqual(snapshotProviderModel({
    provider: 'flow', configuredModel: 'FLOW_NEW_01', flowInventory: inventory,
  }), {
    modelId: 'FLOW_NEW_01', modelLabel: 'Nano Banana Experimental', modelSource: 'live',
  });
});

test('removed live Flow IDs fail closed instead of falling back', () => {
  assert.throws(
    () => snapshotProviderModel({
      provider: 'flow', configuredModel: 'FLOW_REMOVED',
      flowInventory: { source: 'live', models: [{ modelId: 'FLOW_CURRENT', modelLabel: 'Current' }] },
    }),
    (error) => error.code === 'model-unknown' && /refresh the signed-in Flow page/i.test(error.message),
  );
});

test('Flow uses fallback provenance only when live discovery is empty', () => {
  assert.deepEqual(flowInventoryResult([]), {
    source: 'fallback',
    models: [
      { modelId: 'NARWHAL', modelLabel: 'Nano Banana 2' },
      { modelId: 'HARBOR_SEAL', modelLabel: 'Nano Banana 2 Lite' },
      { modelId: 'GEM_PIX_2', modelLabel: 'Nano Banana Pro' },
    ],
  });
});

test('stable web label is preserved without inventing an ID', () => {
  assert.deepEqual(snapshotProviderModel({ provider: 'aistudio', liveModel: { id: '', label: 'Nano Banana 2' } }), {
    modelId: null, modelLabel: 'Nano Banana 2', modelSource: 'provider-label',
  });
});

test('unreadable web identity is provider-controlled', () => {
  assert.deepEqual(snapshotProviderModel({ provider: 'chatgpt', liveModel: { id: '', label: '' } }), {
    modelId: null, modelLabel: '', modelSource: 'provider-controlled',
  });
});

test('generation settings are copied, not retained by reference', () => {
  const settings = { aspectRatio: '16:9', leonardoStyle: 'Dynamic', leonardoMode: 'FAST', leonardoSize: 'SMALL', leonardoCount: 1, chatgptMaxWaitSec: 480 };
  const snapshot = snapshotProviderModel({ provider: 'leonardo', liveModel: { id: 'phoenix-v1.0', label: 'Phoenix' } });
  const result = generationSettingsFor('leonardo', settings, snapshot);
  settings.leonardoStyle = 'Cinematic';
  assert.equal(result.style, 'Dynamic');
  assert.equal(result.modelId, 'phoenix-v1.0');
});

test('unknown and changed models fail closed with refresh guidance', () => {
  assert.throws(
    () => snapshotProviderModel({ provider: 'flow', configuredModel: 'stale-model' }),
    (error) => error.code === 'model-unknown' && /refresh the signed-in Flow page/i.test(error.message),
  );
  assert.throws(
    () => assertProviderModel({
      provider: 'leonardo',
      snapshot: { modelId: 'phoenix-v1.0', modelLabel: 'Phoenix', modelSource: 'live' },
      current: { id: 'flux-1', label: 'FLUX' },
    }),
    (error) => error.code === 'model-selection-changed' && /refresh the signed-in Leonardo page/i.test(error.message),
  );
});

test('provider-controlled identity does not claim a false match', () => {
  assert.doesNotThrow(() => assertProviderModel({
    provider: 'chatgpt',
    snapshot: { modelId: null, modelLabel: '', modelSource: 'provider-controlled' },
    current: { id: '', label: '' },
  }));
});
```

- [ ] **Step 2: Run RED**

Run: `node --test test/model-identity.test.js test/providers.test.js`

Expected: FAIL because the new exports and exact Flow metadata do not exist.

- [ ] **Step 3: Add registry-owned Flow fallback metadata**

In `src/lib/providers.js`, add:

```js
export const FLOW_FALLBACK_MODELS = Object.freeze([
  Object.freeze({ id: 'nano-banana-2', internalId: 'NARWHAL', label: 'Nano Banana 2', source: 'fallback' }),
  Object.freeze({ id: 'nano-banana-2-lite', internalId: 'HARBOR_SEAL', label: 'Nano Banana 2 Lite', source: 'fallback' }),
  Object.freeze({ id: 'nano-banana-pro', internalId: 'GEM_PIX_2', label: 'Nano Banana Pro', source: 'fallback' }),
]);

export function getFlowModel(id) {
  return FLOW_FALLBACK_MODELS.find((model) => model.id === id);
}
```

Add `models: FLOW_FALLBACK_MODELS` only to the Flow registry entry. Extend `test/providers.test.js` to assert the existing ordered IDs `['flow', 'aistudio', 'qwen', 'leonardo', 'chatgpt']`, Flow ownership, and absence of an extension-owned `models` property for AI Studio, Qwen, Leonardo, and ChatGPT.

- [ ] **Step 4: Implement the pure live/fallback contract**

Create `src/lib/model-identity.js` with these concrete helpers; import `FLOW_FALLBACK_MODELS` and `getFlowModel` from `./providers.js`. The conservative ID rule is intentionally applied to IDs supplied by provider-owned fields; it is not a way to manufacture IDs from labels:

```js
const FLOW_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,127}$/;

export function normalizeFlowInventory(entries) {
  const seen = new Set();
  return (Array.isArray(entries) ? entries : []).flatMap((entry) => {
    const modelId = String(entry?.id || '').trim();
    const modelLabel = String(entry?.label || '').replace(/\\s+/g, ' ').trim();
    if (!FLOW_ID.test(modelId) || !modelLabel || modelId === modelLabel || seen.has(modelId)) return [];
    seen.add(modelId);
    return [{ modelId, modelLabel }];
  });
}

export function flowInventoryResult(entries) {
  const models = normalizeFlowInventory(entries);
  if (models.length) return { source: 'live', models };
  return {
    source: 'fallback',
    models: FLOW_FALLBACK_MODELS.map(({ internalId, label }) => ({ modelId: internalId, modelLabel: label })),
  };
}

export function resolveFlowModel(modelId, inventory) {
  return inventory.models.find((model) => model.modelId === String(modelId || ''));
}
```

`normalizeFlowInventory()` must accept only exact `{ id, label }` records already extracted from provider-owned `imageModelConfigs` or `[role="option"][data-image-model-key]` fields. Do not scan arbitrary JSON, use generic transport keys, or derive a key from visible display text. Make `snapshotProviderModel()` resolve a new exact live ID from `flowInventory` with `modelSource: 'live'`; resolve the three friendly fallback settings through `getFlowModel()` with `modelSource: 'fallback'`; and throw `model-unknown` when neither exact match exists. Require a live ID for Leonardo and label it `live`. For AI Studio, Qwen, and ChatGPT, return `live` for a stable ID, `provider-label` for a stable label without an ID, and `provider-controlled` when neither is readable. Copy aspect ratio, Leonardo style/mode/size/count, and ChatGPT max wait into a new plain object. Compare live IDs exactly, compare label-only snapshots exactly, and allow only provider-controlled snapshots to skip comparison; every failure message must name the provider and instruct a signed-page refresh/re-queue.

- [ ] **Step 5: Run GREEN and checkpoint**

Run: `node --test test/model-identity.test.js test/providers.test.js`

Expected: PASS.

Commit: `test: define truthful provider model identity`

### Task 2: Serialized Queue Boundary And Standalone Identity

**Files:**
- Create: `src/lib/queue-store.js`
- Create: `src/lib/queue-identity.js`
- Create: `src/lib/queue-operations.js`
- Create: `test/queue-store.test.js`
- Create: `test/queue-operations.test.js`
- Modify: `src/background.js`

**Interfaces:**
- `createQueueStore({ load, save, normalize })` returns `read(): Promise<Array>` and `update(mutator): Promise<Array>`; the background instance is called as `queueStore.read()` and `queueStore.update(mutator)`.
- `update(mutator)` serializes load, normalization/migration, awaited mutation, and save; the mutator returns the complete next queue.
- `normalizePrompt(prompt)`, `generationSettingsKey(settings)`, `projectWorkKey(item)`, `standaloneWorkKey(item)`, and `activeWorkKey(item)` are pure.
- `enqueueItems(queue, items, now)` returns `{ queue, added, skipped }`; only pending/running items deduplicate.

- [ ] **Step 1: Write the failing concurrency test**

Create `test/queue-store.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { createQueueStore } from '../src/lib/queue-store.js';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('concurrent updates preserve both mutations', async () => {
  let stored = [{ id: 'seed', status: 'pending' }];
  let writes = 0;
  const store = createQueueStore({
    load: async () => { await pause(5); return structuredClone(stored); },
    save: async (queue) => { await pause(5); stored = structuredClone(queue); writes++; },
    normalize: (queue) => queue,
  });
  await Promise.all([
    store.update(async (queue) => { await pause(10); return [...queue, { id: 'panel', status: 'pending' }]; }),
    store.update(async (queue) => { await pause(1); return [...queue, { id: 'alarm', status: 'pending' }]; }),
  ]);
  assert.deepEqual(stored.map((item) => item.id), ['seed', 'panel', 'alarm']);
  assert.equal(writes, 2);
});

test('read persists normalization inside the serialized boundary', async () => {
  let stored = [{ id: 'legacy' }];
  const store = createQueueStore({
    load: async () => structuredClone(stored),
    save: async (queue) => { stored = structuredClone(queue); },
    normalize: (queue) => queue.map((item) => ({ ...item, migrated: true })),
  });
  assert.deepEqual(await store.read(), [{ id: 'legacy', migrated: true }]);
  assert.deepEqual(stored, [{ id: 'legacy', migrated: true }]);
});
```

- [ ] **Step 2: Run RED**

Run: `node --test test/queue-store.test.js`

Expected: FAIL because `src/lib/queue-store.js` does not exist.

- [ ] **Step 3: Implement the queue store**

Use a rejected-safe promise tail. Each operation must load the latest queue only after its predecessor completes. Normalize a cloned array, save normalized migration changes during `read()`, always save the mutator result during `update()`, and reject non-array mutator results.

```js
const sameQueue = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function createQueueStore({ load, save, normalize = (queue) => queue } = {}) {
  if (typeof load !== 'function' || typeof save !== 'function') throw new TypeError('Queue store needs load and save functions.');
  let tail = Promise.resolve();
  const serialized = (operation) => {
    const result = tail.then(operation);
    tail = result.catch(() => undefined);
    return result;
  };
  const current = async () => {
    const raw = await load();
    const stored = Array.isArray(raw) ? raw : [];
    return { stored, queue: normalize(structuredClone(stored)) };
  };
  return {
    read: () => serialized(async () => {
      const { stored, queue } = await current();
      if (!sameQueue(stored, queue)) await save(queue);
      return queue;
    }),
    update: (mutator) => {
      if (typeof mutator !== 'function') return Promise.reject(new TypeError('Queue update needs a mutator function.'));
      return serialized(async () => {
        const { queue } = await current();
        const next = await mutator(queue);
        if (!Array.isArray(next)) throw new TypeError('Queue mutator must return an array.');
        await save(next);
        return next;
      });
    },
  };
}
```

- [ ] **Step 4: Write failing standalone and terminal-history tests**

Create `test/queue-operations.test.js` with cases for normalized whitespace/case, same active standalone prompt plus settings producing `skipped: 1`, a changed model ID producing `added: 1`, done/failed history producing `added: 1`, and the existing project key `provider + episodeCode + kind + source + sceneKey` still deduplicating. Use this exact standalone fixture shape:

```js
const standalone = (overrides = {}) => ({
  id: overrides.id || 'new',
  source: 'standalone',
  kind: 'scene',
  provider: 'flow',
  prompt: '  A quiet cabin   at dusk  ',
  generationSettings: { modelId: 'NARWHAL', aspectRatio: '16:9', style: '', mode: '', size: '', count: 1 },
  ...overrides,
});
```

Assert `normalizePrompt('  A quiet cabin\\nAT dusk ')` equals `'a quiet cabin at dusk'`, active duplicate keys are equal, terminal entries do not participate in the active set, and a changed `generationSettings.modelId` does not deduplicate.

- [ ] **Step 5: Run RED, then implement pure queue identity/operations**

Run: `node --test test/queue-operations.test.js`

Expected: FAIL before the modules exist.

Implement `queue-identity.js` with `normalizePrompt` using whitespace collapse plus lowercase, `generationSettingsKey` using the ordered fields `modelId, aspectRatio, style, mode, size, count`, `projectWorkKey` using the existing scene identity, and `standaloneWorkKey` using provider, normalized prompt, kind, and settings key. `activeWorkKey` selects standalone versus project identity.

Implement `enqueueItems` with the existing behavior: empty input returns no changes; when no active work exists, retain only the last 100 failed entries; remove failed entries matching incoming keys; build the active set from pending/running only; append pending items with IDs and timestamps; return counts. Never compare incoming work with done/failed entries.

- [ ] **Step 6: Replace every background split mutation**

Instantiate `queueStore` in `src/background.js` with `load` reading `QUEUE_KEY`, `save` incrementing `FLEET_QUEUE_REVISION_KEY` and writing both keys, and `normalize` running `migrateQueue(storedQueue, Date.now())` plus existing failed-item diagnosis. Keep `getQueue = () => queueStore.read()`.

Refactor `enqueue`, `removeFromQueue`, `retryFailed`, `retryFleetSafeFailed`, `clearQueue`, `clearPendingFromFleet`, startup recovery, and Flow project rollover to mutate by ID or predicate inside `queueStore.update()`. Refactor every `processQueue()` status transition the same way: running, done, known-limit re-pend, Leonardo ambiguity, tab-reload retry, auto-retry, terminal failure, and attempt counters. Preserve alarm, cooldown, Fleet, pacing, recovery, save-back, and sequential behavior. Keep pause/resume revision snapshots as `queueStore.update((queue) => queue)`.

- [ ] **Step 7: Run regression tests and checkpoint**

Run: `node --test test/queue-store.test.js test/queue-operations.test.js test/queue-migration.test.js test/integration-fixes.test.js`

Expected: PASS, including existing migration, Leonardo ambiguity, Scene Plan, save-routing, and reference safety tests.

Run: `npm test`

Expected: PASS.

Commit: `fix: serialize queue mutations and standalone deduplication`

### Task 3: Enqueue Snapshots, Provider Context, And Fail-Closed Execution

**Files:**
- Modify: `src/background.js`
- Modify: `src/lib/queue-migration.js`
- Modify: `src/lib/flow-exec.js`
- Modify: `src/content/aistudio-main.js`
- Modify: `src/content/qwen-main.js`
- Modify: `src/content/chatgpt-main.js`
- Modify: `src/content/leonardo-main.js`
- Modify: `test/queue-migration.test.js`
- Modify: `test/integration-fixes.test.js`

**Interfaces:**
- Provider `getContext()` responses add `modelIdentity: { id: string, label: string, stable: boolean }`; provider-controlled is empty ID/label with `stable: false`.
- Flow content exposes a read-only `listImageModels()` operation returning `{ entries: Array<{ id: string, label: string }> }`; it reads only provider-owned `imageModelConfigs` records and `[role="option"][data-image-model-key]` records and never submits a generation request.
- The background runtime exposes `refreshFlowModels` returning `{ ok: true, source: 'live'|'fallback', models: Array<{ modelId: string, modelLabel: string }>, refreshedAt: number }` or `{ ok: false, code: 'flow-model-discovery-unavailable' }` without changing the queue.
- New queue items add `modelSnapshot` and `generationSettings`; existing `model` and `aspectRatio` remain for compatibility only.
- `snapshotProviderModelAtEnqueue(provider, settings, flowInventory)` returns `{ modelSnapshot, generationSettings }` with both values copied into new plain objects.
- `verifyQueuedModel(item, provider, tab: { id: number })` resolves only after the queued selection is verified or the snapshot is provider-controlled; for a live Flow snapshot it refreshes inventory and requires an exact current ID and label before any provider POST.

- [ ] **Step 1: Write failing migration and pre-submit-order tests**

Extend `test/queue-migration.test.js` with a legacy Leonardo pending item that becomes failed with `failure.code === 'model-unknown'`, `fleetRetrySafe === false`, and refresh/re-queue guidance. Cover a legacy Flow item retaining its prompt and friendly `model`.

Add to `test/integration-fixes.test.js`:

```js
test('worker verifies the queued model before provider-attempted and generation', () => {
  const background = source('src/background.js');
  const process = background.slice(background.indexOf('async function processQueue'), background.indexOf('// Drop everything not yet started'));
  assert.ok(process.indexOf('verifyQueuedModel') < process.indexOf('providerAttempted = true'));
  assert.ok(process.indexOf('verifyQueuedModel') < process.indexOf('generateAndSave(item'));
  assert.match(background, /modelSnapshot/);
  assert.match(background, /generationSettings/);
});

test('generation reads Leonardo snapshot settings, not mutable settings', () => {
  const background = source('src/background.js');
  const generate = background.slice(background.indexOf('async function generateAndSave'), background.indexOf('// ── status'));
  assert.match(generate, /model: item\.generationSettings\.modelId/);
  assert.match(generate, /style: item\.generationSettings\.style/);
  assert.doesNotMatch(generate, /model: settings\.leonardoModel/);
  assert.doesNotMatch(generate, /style: settings\.leonardoStyle/);
});
```

Also add these red tests to the same file:

```js
test('Flow discovery is read-only, provider-owned, and never display-text inferred', () => {
  const flow = source('src/lib/flow-exec.js');
  const list = flow.slice(flow.indexOf('const listImageModels'), flow.indexOf('const generateImage'));
  assert.match(list, /listImageModels/);
  assert.match(list, /imageModelConfigs/);
  assert.match(list, /data-image-model-key/);
  assert.doesNotMatch(list, /batchGenerateImages/);
  assert.doesNotMatch(list, /transportKey/);
  assert.doesNotMatch(list, /script\[type=.*application\/json/);
  assert.doesNotMatch(flow, /IMAGE_MODELS\[.*\]\s*\|\|/);
});

test('Flow queue execution rechecks the exact live snapshot before POST', () => {
  const background = source('src/background.js');
  assert.match(background, /refreshFlowModels/);
  assert.match(background, /flowModelSource/);
  assert.match(background, /modelSnapshot\.modelId/);
  assert.ok(background.indexOf('requireCurrentFlowModel') < background.indexOf('providerAttempted = true'));
  assert.ok(background.indexOf('requireCurrentFlowModel') < background.indexOf('generateAndSave(item'));
  assert.match(background, /model-selection-changed|model-unknown/);
});

```

In `test/queue-migration.test.js`, add this preservation case so the new gate cannot damage known work:

```js
test('migration preserves saved results and recovery checkpoints', () => {
  const input = [
    { id: 'done', provider: 'flow', status: 'done', savedAs: 'scene.png', mediaId: 'media-done' },
    { id: 'retry', provider: 'flow', status: 'running', providerAttempted: true, mediaId: 'media-retry' },
  ];
  const migrated = migrateQueue(input, NOW);
  assert.equal(migrated[0].savedAs, 'scene.png');
  assert.equal(migrated[0].mediaId, 'media-done');
  assert.equal(migrated[1].providerAttempted, true);
  assert.equal(migrated[1].mediaId, 'media-retry');
});
```

- [ ] **Step 2: Run RED**

Run: `node --test test/queue-migration.test.js test/integration-fixes.test.js`

Expected: FAIL because queue items have no model snapshot and the worker dispatch still reads mutable settings.

- [ ] **Step 3: Snapshot identity at both enqueue entry points**

Import `getLeonardoModels`, `snapshotProviderModel`, and `generationSettingsFor`. Add `snapshotProviderModelAtEnqueue(provider, settings, flowInventory)`: Flow resolves `settings.flowModelId || settings.imageModel` through `flowInventory` when live records exist, otherwise through the three registry fallback records; web providers ensure their existing tab/readiness, Leonardo first calls existing `leonardo:modelControls` with `settings.leonardoModel`, then all web providers call their existing context message. Leonardo may use the saved live label from `getLeonardoModels()`; never create a new catalog.

In `enqueueScenes()` and `enqueueStandalone()`, call the snapshot function after provider validation and before reference resolution. Add `modelSnapshot` and `generationSettings: generationSettingsFor(prov, settings, modelSnapshot)` to every item. Preserve project identity, references, target, filenames, and existing friendly Flow `model` field.

Use this exact return shape at both enqueue entry points:

```js
async function snapshotProviderModelAtEnqueue(provider, settings, flowInventory) {
  const context = provider === 'flow' ? null : await webGeneratorContext(provider);
  const liveModel = context?.modelIdentity
    ? { id: context.modelIdentity.id, label: context.modelIdentity.label }
    : undefined;
  const configuredModel = provider === 'flow' ? settings.flowModelId || settings.imageModel : undefined;
  const modelSnapshot = snapshotProviderModel({ provider, configuredModel, liveModel, flowInventory });
  return { modelSnapshot, generationSettings: generationSettingsFor(provider, settings, modelSnapshot) };
}
```

For Leonardo, keep the existing model-controls call before `webGeneratorContext('leonardo')` so its selected ID and label are read from the signed tab; for Flow, pass the latest `flowInventoryResult()` stored by `refreshFlowModels()` and never pass a display label as `configuredModel`.

For Flow, persist the exact selected live `modelId`, `modelLabel`, and `modelSource` in the item and in `settings.flowModelId`, `settings.flowModelLabel`, and `settings.flowModelSource`; a live refresh must never silently remap a queued ID to a fallback ID or to a label.

- [ ] **Step 4: Add the read-only Flow inventory operation**

In the existing Flow command bridge, add this operation without changing the generation command or adding a second provider transport:

```js
const listImageModels = async () => {
  const entries = [];
  const add = (id, label) => entries.push({ id: String(id || ''), label: String(label || '') });
  const nextData = window.__NEXT_DATA__ || (() => {
    try { return JSON.parse(document.querySelector('script#__NEXT_DATA__')?.textContent || 'null'); }
    catch { return null; }
  })();
  const configs = nextData?.props?.pageProps?.imageModelConfigs;
  for (const config of Array.isArray(configs) ? configs : []) add(config.imageModelKey, config.displayName);
  for (const element of document.querySelectorAll('[role="option"][data-image-model-key]')) {
    add(element.getAttribute('data-image-model-key'), element.textContent);
  }
  return { entries };
};
```

Register it as `listImageModels` in the existing Flow operation dispatcher. The command must not call `generateImage`, `batchGenerateImages`, or any POST path. The only accepted records are the exact provider-owned `imageModelKey` plus its matching `displayName`, or the exact `data-image-model-key` plus its option label. Do not inspect arbitrary scripts, generic transport fields, or labels as IDs. Add a focused test that an empty/invalid live response produces the three fallback records with `source: 'fallback'`, while one valid record produces `source: 'live'` and is returned unchanged.

- [ ] **Step 5: Refresh, snapshot, and fail closed before provider POST**

Add `const FLOW_MODEL_INVENTORY_KEY = 'flowImageModelInventory'` in `src/background.js` and add `refreshFlowModels(tabId)` there: send the existing Flow command `listImageModels`, pass `entries` to `flowInventoryResult()`, persist only the latest inventory/provenance under that key in the existing extension local storage area, and return exactly `{ ok: true, source, models, refreshedAt: Date.now() }`. Return `{ ok: false, code: 'flow-model-discovery-unavailable' }` for a signed-tab/bridge failure; do not mutate queue items during refresh. Register the `refreshFlowModels` runtime-message case and include `flow:listImageModels` in the read-only/reload-safe Flow command path. Make `verifyQueuedModel()` use this flow:

```js
const modelError = (code, message) => Object.assign(new Error(message), { code });

async function requireCurrentFlowModel(item, tabId) {
  const current = await refreshFlowModels(tabId);
  if (!current.ok) throw modelError('model-unknown', 'Flow model discovery is unavailable. Refresh the signed-in Flow page and re-queue this item.');
  if (item.modelSnapshot.modelSource === 'live') {
    const selected = current.models.find((model) => model.modelId === item.modelSnapshot.modelId);
    if (!selected || selected.modelLabel !== item.modelSnapshot.modelLabel) {
      throw modelError('model-selection-changed', 'The queued Flow model was removed or changed. Refresh the signed-in Flow page and re-queue this item.');
    }
  } else if (!current.models.some((model) => model.modelId === item.modelSnapshot.modelId)) {
    throw modelError('model-unknown', 'The queued Flow fallback model is unavailable. Refresh the signed-in Flow page and re-queue this item.');
  }
}
```

Call `requireCurrentFlowModel(item, tab.id)` after tab readiness but before `setNextProviderRun()`, `providerAttempted = true`, and `generateAndSave(item)`. Pass `item.modelSnapshot.modelId` as the only Flow generation ID. Preserve every existing known submitted/result and recovery branch ahead of this new pre-submit check: a completed item, a saved result/media checkpoint, or an existing tab-reload/provider-retry path must not be re-submitted or rejected merely because the current live inventory changed. Add regression coverage that migration and retry preserve those fields and that a removed/stale live ID causes zero generation POSTs.

- [ ] **Step 6: Add page model context without changing bridge architecture**

In AI Studio, Qwen, and ChatGPT MAIN-world files, add a local `selectedModelIdentity()` that reads only visible semantic model controls. Accept an ID only from `data-model-id`, `data-model`, or a `data-testid` beginning with `model-`; accept a label only when it is not exactly `Model`, `Select model`, or `Choose model`. Return `{ id, label, stable: Boolean(id || label) }`, or empty provider-controlled data. Add it to the existing `getContext()` result; retain all current ready, sign-in, attachment, conversation, and URL fields.

In Leonardo’s existing `getContext()`, add `modelIdentity: { id: selectedModel, label: normalized visible model-trigger text, stable: Boolean(selectedModel) }`. Keep `listModels()`, `modelControls()`, exact live `data-testid` discovery, all control probing, and submission-state reporting unchanged.

- [ ] **Step 7: Verify before submission and make Flow exact-ID only**

Add `verifyQueuedModel()` in `src/background.js`. Flow uses `requireCurrentFlowModel()` from Step 5; other providers send their existing context message and pass its `modelIdentity` to `assertProviderModel()`. Call it after tab readiness but before `setNextProviderRun()`, `providerAttempted = true`, and `generateAndSave()`. Map model failures in `diagnoseFailure()` to actionable settings failures and retain `fleetRetrySafe = false`.

In `src/lib/flow-exec.js`, replace `IMAGE_MODELS[payload.model] || 'NARWHAL'` with:

```js
const modelId = String(payload.modelId || '').trim();
if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{2,127}$/.test(modelId)) {
  throw new Error('Flow model ID is malformed. Refresh the signed-in Flow page and choose an advertised model before retrying.');
}
```

Use `modelId` as `imageModelName`; do not default it or validate it against a hardcoded three-ID list because the live inventory may advertise additional exact provider IDs. The background inventory check is the fail-closed gate before POST. In `generateAndSave()`, use only item snapshots for Flow model ID, Leonardo model/style/mode/size/count, all aspect ratios, and ChatGPT max wait. Keep Flow reference mapping, all provider adapters, ingestion routes, Downloads, cooldowns, and recovery branches.

- [ ] **Step 8: Normalize legacy queue state**

In `migrateQueue(queue, now)`, preserve caller immutability and current migrations. Leave legacy Flow `model` available for fallback resolution. For pending/running legacy Leonardo items with no `modelSnapshot`, create a terminal failed item with `model-unknown`, refresh/re-queue guidance, `fleetRetrySafe: false`, and current finish/duration timestamps. For other legacy web items, use explicit provider-controlled identity because no historical stable label exists; do not invent a model ID.

- [ ] **Step 9: Run focused tests and checkpoint**

Run: `node --test test/model-identity.test.js test/queue-migration.test.js test/integration-fixes.test.js test/reference-attachments.test.js`

Expected: PASS, including bounded references, Qwen stale-chip refusal, Leonardo ambiguity, Scene Plan safety, save routing, and pre-submit model guards.

Run: `npm test`

Expected: PASS.

Commit: `feat: snapshot and verify signed provider models`

### Task 4: Panel Diagnostics, Release Metadata, Documentation, And Verification

**Files:**
- Modify: `src/popup/popup.js`
- Modify: `src/popup/popup.html`
- Modify: `test/manifest.test.js`
- Modify: `test/integration-fixes.test.js`
- Modify: `manifest.json`
- Modify: `CHANGELOG.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: queue `modelSnapshot` and `generationSettings`, existing provider labels/registry, and active-batch rendering.
- Produces: active metadata from the item snapshot, showing fallback, stable live identity, or provider-controlled identity; never current mutable settings for queued work. Flow settings also expose a refresh action that reports live or fallback provenance without changing queued items.

- [ ] **Step 1: Write failing panel/release assertions**

Add source-contract tests:

```js
test('active metadata reads the queued snapshot', () => {
  const popup = source('src/popup/popup.js');
  const status = popup.slice(popup.indexOf('function updateGenStatus'), popup.indexOf('let lastQueueSig'));
  assert.match(status, /displayItem\.modelSnapshot/);
  assert.match(status, /provider-controlled|modelSource/);
  assert.doesNotMatch(status, /settings\?\.imageModel/);
});
```

Update `test/manifest.test.js` to expect `0.50.0` and `## 0.50.0 - Image Generator hardening`, while retaining all existing declared-file, provider-host, and retired-provider assertions.

- [ ] **Step 2: Run RED**

Run: `node --test test/integration-fixes.test.js test/manifest.test.js`

Expected: FAIL because active metadata reads current settings and the manifest remains `0.49.3`.

- [ ] **Step 3: Render truthful queued diagnostics and Flow refresh**

Add `queuedModelLabel(item)` in `src/popup/popup.js`: no snapshot returns `Legacy queue item`; `provider-controlled` returns `Provider-controlled model`; `fallback` returns `${modelLabel} (${modelId}, fallback)`; live ID/label returns `${modelLabel} (${modelId}, live)`. Make `updateGenStatus()` use `displayItem.modelSnapshot` and `displayItem.generationSettings.aspectRatio` with the old `aspectRatio` fallback. Do not add AI Studio, Qwen, or ChatGPT model options.

Replace Flow’s fixed select population with an async `refreshFlowModels()` call. Render each returned `modelId` as the option value and `modelLabel` as the option label, save the selected exact ID/label/source, and show `Live from this signed-in Flow workspace` when `source === 'live'` or `Tested fallback catalog; live discovery unavailable` when `source === 'fallback'`. Add a `Refresh Flow models` button that invokes the runtime message and preserves the current exact selection only if it still exists; a removed live selection becomes unselectable and cannot be queued. Update `src/popup/popup.html` copy: web providers choose models in their signed tabs; Flow discovery is live when exact provider-owned IDs are available and otherwise uses the three tested fallback records; changed/unknown verifiable selections require refresh and re-queue. Preserve Leonardo live sync and reference copy.

- [ ] **Step 4: Release metadata and docs**

Change only `manifest.json` version to `0.50.0`. Add this top changelog entry:

```markdown
## 0.50.0 - Image Generator hardening

- Serialized queue mutations so panel, alarm, recovery, and Fleet actions cannot overwrite one another.
- Deduplicated active standalone work by provider, normalized prompt, asset kind, and generation settings while allowing deliberate requeue after completed or terminal history.
- Snapshotted model IDs, labels, and generation settings at enqueue and failed closed before submission when a signed provider selection was unknown or changed.
- Discovered exact Flow model IDs and labels read-only from the signed workspace, reported live versus tested-fallback provenance, and rejected removed/stale live selections before submission.
- Kept Flow’s three tested fallback IDs and reported provider-controlled identity for web model pickers that expose no stable label.
```

Add a `Model Identity And Queue Safety` section to `README.md` stating that queued work snapshots identity/settings, Flow discovers exact provider-owned IDs and labels from the signed workspace and reports live provenance, falls back to three tested IDs only when discovery is unavailable, AI Studio/Qwen/ChatGPT remain website-controlled, Leonardo is live-discovered, and unknown/changed verifiable selections fail before submission. Do not document API keys, developer endpoints, new providers, video behavior, or private routes.

- [ ] **Step 5: Run focused and complete verification**

Run: `node --test test/integration-fixes.test.js test/manifest.test.js test/providers.test.js`

Expected: PASS with `0.50.0`, unchanged five-provider manifest coverage, truthful panel metadata, and no developer API route text.

Run: `npm test`

Expected: PASS with every current and hardening test.

Run: `find src -type f -name '*.js' -print0 | xargs -0 -n1 node --check`

Expected: exit code 0 for every JavaScript file.

Run:

```bash
node --input-type=module -e "import { existsSync, readFileSync } from 'node:fs'; import { resolve } from 'node:path'; const root = resolve('.'); const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8')); const files = [...manifest.content_scripts.flatMap((entry) => entry.js), manifest.background.service_worker, manifest.side_panel.default_path, manifest.options_page]; for (const file of files) { if (!existsSync(resolve(root, file))) throw new Error('Missing declared file: ' + file); } console.log('Manifest declared files exist:', files.length);"
git diff --check
git status --short --untracked-files=all
```

Expected: manifest validation succeeds, `git diff --check` reports no errors, and status shows only planned changes plus the pre-existing untracked `graphify-out/` tree. Do not stage, delete, or modify any `graphify-out/` path.

- [ ] **Step 6: Live-test one provider and Story Studio save-back**

Reload the unpacked extension at `chrome://extensions`, reload one signed maintained-provider tab, and generate exactly one image before any batch. Confirm active metadata uses the queued snapshot. If a stable selection is available, change it before execution and confirm failure occurs before submission with refresh/re-queue guidance; do not spend a second image for this check.

With a signed Story Studio session and one missing Scene Plan image, queue exactly one scene. Confirm one provider submission, the Scene Review upload route, the canonical scene filename, and queue status `done`. If using a thumbnail, verify thumbnail ingestion instead. Record the provider and route. If no signed provider or Studio session is available, record both checks as manual follow-up and do not claim them passed.

- [ ] **Step 7: Commit, push, and verify remote alignment**

Create the final local checkpoint only after verification:

```bash
git add src/lib/providers.js src/lib/model-identity.js src/lib/queue-store.js src/lib/queue-identity.js src/lib/queue-operations.js src/lib/queue-migration.js src/lib/flow-exec.js src/background.js src/content/aistudio-main.js src/content/qwen-main.js src/content/chatgpt-main.js src/content/leonardo-main.js src/popup/popup.js src/popup/popup.html test/model-identity.test.js test/providers.test.js test/queue-store.test.js test/queue-operations.test.js test/queue-migration.test.js test/integration-fixes.test.js test/manifest.test.js manifest.json CHANGELOG.md README.md
git commit -m "feat: harden image generator queue and model identity"
git push origin main
git fetch origin main
test "$(git rev-parse main)" = "$(git rev-parse origin/main)"
git status --short --branch
```

The `git add` path list must remain explicit and must not include `graphify-out/` or any other unplanned path. After the remote-alignment check, `git status --short --branch` must show the committed tree aligned with `origin/main`; preserve any pre-existing untracked `graphify-out/` files without staging, deleting, or editing them.
