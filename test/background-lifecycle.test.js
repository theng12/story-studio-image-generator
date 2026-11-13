import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';

const clone = (value) => value === undefined ? undefined : structuredClone(value);

function storageArea(state, delayMs = 0) {
  return {
    async get(keys) {
      if (delayMs) await pause(delayMs);
      if (keys == null) return clone(state);
      const selected = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(selected.filter((key) => Object.hasOwn(state, key)).map((key) => [key, clone(state[key])]));
    },
    async set(values) {
      if (delayMs) await pause(delayMs);
      for (const [key, value] of Object.entries(values)) state[key] = clone(value);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
    },
  };
}

async function loadBackground({ local = {}, sync = {}, storageDelayMs = 0, fetchImpl } = {}) {
  let messageListener;
  const chrome = {
    alarms: {
      create() {},
      clear() {},
      onAlarm: { addListener() {} },
    },
    runtime: {
      getManifest: () => ({ version: '0.50.0' }),
      onMessage: { addListener(listener) { messageListener = listener; } },
    },
    sidePanel: { setPanelBehavior: async () => {} },
    storage: {
      local: storageArea(local, storageDelayMs),
      sync: storageArea(sync, storageDelayMs),
    },
  };
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  globalThis.chrome = chrome;
  if (fetchImpl) globalThis.fetch = fetchImpl;
  globalThis.setInterval = () => 0;
  await import(`../src/background.js?lifecycle=${Date.now()}-${Math.random()}`);
  await pause(Math.max(20, storageDelayMs * 6));

  return {
    local,
    sync,
    async send(message, sender = {}, timeoutMs = 1000) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const done = (value) => {
          settled = true;
          resolve(value);
        };
        const asyncResponse = messageListener(message, sender, done);
        if (!asyncResponse && !settled) resolve(undefined);
        setTimeout(() => {
          if (!settled && asyncResponse) reject(new Error(`Timed out waiting for ${message.type}`));
        }, timeoutMs);
      });
    },
    restore() {
      globalThis.setInterval = originalSetInterval;
      if (originalFetch === undefined) delete globalThis.fetch;
      else globalThis.fetch = originalFetch;
      if (originalChrome === undefined) delete globalThis.chrome;
      else globalThis.chrome = originalChrome;
    },
  };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await pause(10);
  }
  throw new Error('Timed out waiting for mocked background lifecycle work.');
}

const leonardoRunning = () => ({
  id: 'live-leonardo',
  provider: 'leonardo',
  source: 'standalone',
  kind: 'scene',
  target: 'download',
  status: 'running',
  prompt: 'A quiet lake',
  modelSnapshot: { modelId: 'phoenix-v1.0', modelLabel: 'Phoenix', modelSource: 'live' },
  generationSettings: {
    modelId: 'phoenix-v1.0', modelLabel: 'Phoenix', modelSource: 'live', aspectRatio: '16:9',
  },
});

test('ordinary worker reads do not recover a live Leonardo item', async () => {
  const worker = await loadBackground();
  try {
    worker.local.queue = [leonardoRunning()];

    const response = await worker.send({ type: 'getQueue' });

    assert.equal(response.ok, true);
    assert.equal(response.queue[0].status, 'running');
    assert.equal(response.queue[0].failure, undefined);
    assert.equal(worker.local.queue[0].status, 'running');
  } finally {
    worker.restore();
  }
});

test('worker startup terminalizes a persisted submission instead of replaying it', async () => {
  const submitted = {
    ...leonardoRunning(),
    id: 'submitted-chatgpt',
    provider: 'chatgpt',
    providerAttempted: true,
    providerAttemptedAt: 100,
    modelSnapshot: { modelId: null, modelLabel: '', modelSource: 'provider-controlled' },
    generationSettings: {
      modelId: null, modelLabel: '', modelSource: 'provider-controlled', aspectRatio: '16:9', maxWaitSec: 480,
    },
  };
  const worker = await loadBackground({
    local: { queue: [submitted] },
  });
  try {
    assert.equal(worker.local.queue[0].status, 'failed');
    assert.equal(worker.local.queue[0].failure.code, 'ambiguous');
    assert.equal(worker.local.queue[0].providerAttempted, true);
  } finally {
    worker.restore();
  }
});

test('an explicit manual retry starts a fresh submission-checkpoint lifecycle', async () => {
  const failed = {
    ...leonardoRunning(),
    status: 'failed',
    providerAttempted: true,
    providerAttemptedAt: 100,
    failure: { code: 'ambiguous', raw: 'connection closed' },
  };
  const worker = await loadBackground({
    local: { queue: [failed], queuePaused: true },
  });
  try {
    const response = await worker.send({ type: 'retryFailed', id: failed.id });
    await waitFor(() => worker.local.lastStatus?.text?.includes('Queue finished'));
    assert.equal(response.ok, true);
    assert.equal(response.retried, 1);
    assert.equal(worker.local.queue[0].status, 'pending');
    assert.equal(Object.hasOwn(worker.local.queue[0], 'providerAttempted'), false);
    assert.equal(Object.hasOwn(worker.local.queue[0], 'providerAttemptedAt'), false);
  } finally {
    worker.restore();
  }
});

test('clear failed drops only failed items and leaves pending work', async () => {
  const failed = { ...leonardoRunning(), id: 'f1', status: 'failed', failure: { code: 'ambiguous', raw: 'x' } };
  const pending = { ...leonardoRunning(), id: 'p1', status: 'pending' };
  const worker = await loadBackground({
    local: { queue: [failed, pending], queuePaused: true },
  });
  try {
    const response = await worker.send({ type: 'clearFailed' });
    assert.equal(response.ok, true);
    assert.equal(response.cleared, 1);
    assert.deepEqual(worker.local.queue.map((i) => i.id), ['p1']);
    assert.equal(worker.local.queue[0].status, 'pending');
  } finally {
    worker.restore();
  }
});

test('clear pending preserves completed and failed history', async () => {
  const done = { ...leonardoRunning(), id: 'd1', status: 'done' };
  const failed = { ...leonardoRunning(), id: 'f1', status: 'failed' };
  const pending = { ...leonardoRunning(), id: 'p1', status: 'pending' };
  const running = { ...leonardoRunning(), id: 'r1', status: 'running' };
  const worker = await loadBackground({
    local: { queue: [done, failed, pending, running], queuePaused: true },
  });
  try {
    const response = await worker.send({ type: 'clearQueue' });
    assert.equal(response.ok, true);
    assert.equal(response.cleared, 1);
    assert.deepEqual(worker.local.queue.map((i) => i.id), ['d1', 'f1', 'r1']);
  } finally {
    worker.restore();
  }
});

test('clear completed drops only done items and preserves actionable queue state', async () => {
  const done = {
    ...leonardoRunning(),
    id: 'd1',
    status: 'done',
    source: 'prompts',
    slug: 'project-one',
    episodeCode: 'EP0001',
    savedAs: 'EP0001_Thumb01_v1.png',
  };
  const failed = { ...leonardoRunning(), id: 'f1', status: 'failed', failure: { code: 'ambiguous', raw: 'x' } };
  const pending = { ...leonardoRunning(), id: 'p1', status: 'pending' };
  const running = { ...leonardoRunning(), id: 'r1', status: 'running' };
  const worker = await loadBackground({
    local: { queue: [done, failed, pending, running], queuePaused: true },
  });
  try {
    const response = await worker.send({ type: 'clearCompleted' });
    assert.equal(response.ok, true);
    assert.equal(response.cleared, 1);
    assert.deepEqual(worker.local.queue.map((i) => i.id), ['f1', 'p1', 'r1']);
  } finally {
    worker.restore();
  }
});

test('background-owned concurrent settings patches cannot overwrite unrelated fields', async () => {
  const worker = await loadBackground({
    sync: {
      settings: {
        provider: 'flow',
        flowProjectName: 'First',
        humanDelayMinSec: 5,
        humanDelayMaxSec: 60,
      },
    },
    storageDelayMs: 4,
  });
  try {
    const [panel, options] = await Promise.all([
      worker.send({ type: 'settings:patch', patch: { humanDelayMinSec: 12 } }),
      worker.send({ type: 'settings:patch', patch: { flowProjectName: 'Second' } }),
    ]);

    assert.equal(panel.ok, true);
    assert.equal(options.ok, true);
    assert.equal(options.settings.humanDelayMinSec, 12);
    assert.equal(worker.sync.settings.humanDelayMinSec, 12);
    assert.equal(worker.sync.settings.flowProjectName, 'Second');
  } finally {
    worker.restore();
  }
});

test('a provider tab is opened at most once even when the tab query cannot see it', async () => {
  const created = [];
  const tab = { id: 41, status: 'complete', url: 'https://flow.google.com/project/abc' };
  const worker = await loadBackground();
  try {
    globalThis.chrome.tabs = {
      query: async () => [], // what the user's Chrome did: existing Flow tabs invisible
      create: async (opts) => { created.push(opts.url); return { id: 41, status: 'loading' }; },
      get: async (id) => (id === 41 ? tab : Promise.reject(new Error('No tab'))),
      update: async () => tab,
      onUpdated: { addListener() {}, removeListener() {} },
    };
    globalThis.chrome.scripting = { executeScript: async () => [{ result: { ok: true, result: { entries: [] } } }] };
    globalThis.chrome.storage.session = storageArea({});
    // Two overlapping calls, then two sequential ones — one queue-all can do both.
    const slow = (type) => worker.send({ type }, {}, 4000);
    await Promise.all([slow('refreshFlowModels'), slow('refreshFlowModels')]);
    await slow('refreshFlowModels');
    await slow('flowContext');
    assert.deepEqual(created, ['https://flow.google.com/']);
  } finally {
    worker.restore();
  }
});
