// Executes the shipped background module. Only browser APIs, provider commands
// and HTTP are mocked; no queue or Gateway lifecycle logic is copied here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { gatewayBinding, imageGatewayJobToItem } from '../src/lib/gateway-worker.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9ZkAAAAASUVORK5CYII=';
const JOB = { jobId: 'image/a', kind: 'image', provider: 'flow', prompt: 'A quiet village.', modelKey: 'nano-banana-2', aspectRatio: '16:9', flowProjectId: '5852b0c6-e4a4-455a-8215-5513c208c29d', referenceImages: [{ mediaType: 'image/png', dataBase64: PNG }] };
const connection = { gatewayModeEnabled: true, gatewayUrl: 'http://gateway.invalid', gatewayToken: 'fixture-only', gatewayWorkerId: 'fixture-image' };
const clone = (value) => value === undefined ? value : structuredClone(value);
let rows = new Map();
let bootId = 0;
const fakeDatabase = {
  transaction() {
    const transaction = { objectStore: () => ({
      get: (key) => operation(() => clone(rows.get(key))),
      put: (value, key) => operation(() => { rows.set(key, clone(value)); return key; }),
      delete: (key) => operation(() => rows.delete(key)),
    }) };
    function operation(run) {
      const request = {};
      queueMicrotask(() => { request.result = run(); transaction.oncomplete?.(); });
      return request;
    }
    return transaction;
  },
};
const fakeIndexedDB = { open() { const request = {}; queueMicrotask(() => { request.result = fakeDatabase; request.onsuccess(); }); return request; } };
function area(state) {
  return {
    async get(keys) { return keys == null ? clone(state) : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((key) => key in state).map((key) => [key, clone(state[key])])); },
    async set(values) { Object.assign(state, clone(values)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key]; },
  };
}
async function waitFor(predicate) {
  for (let count = 0; count < 300; count++) { if (predicate()) return; await pause(5); }
  throw new Error('Mocked background did not reach the expected state.');
}
async function boot({ local, mode = 'gateway', job = JOB, resultAnswers = [{ ok: true }], onSubmit, onHealth, clock, defaultPacing = false, failure, uploadConfirmed = true, claimLost = false, uploadLimit = 1024, synced = {}, allowStorySave = false, inventory = { source: 'live', entries: [{ id: 'NARWHAL', label: 'Nano Banana 2' }] } } = {}) {
  local ||= { gatewayConnection: clone(connection), imageGeneratorWorkMode: mode };
  const sync = { settings: { ...(defaultPacing ? {} : { humanDelayMinSec: 0, humanDelayMaxSec: 0 }), ...synced } };
  const previous = Object.fromEntries(['chrome', 'fetch', 'indexedDB', 'setInterval', 'setTimeout', 'clearTimeout'].map((key) => [key, globalThis[key]]));
  const realNow = Date.now, realRandom = Math.random;
  const timers = new Map();
  let timerId = 0;
  if (clock) {
    Date.now = () => clock.now;
    Math.random = () => clock.random ?? 0;
    globalThis.setTimeout = (fn, ms) => { const id = ++timerId; timers.set(id, { fn, at: clock.now + ms }); return id; };
    globalThis.clearTimeout = (id) => timers.delete(id);
  }
  const alarms = [], calls = [], provider = [], downloads = [];
  let listener;
  const tab = { id: 7, status: 'complete', url: `https://flow.google.com/project/${JOB.flowProjectId}` };
  globalThis.chrome = {
    storage: { local: area(local), sync: area(sync), session: area({}), onChanged: { addListener() {} } },
    alarms: { create() {}, clear() {}, onAlarm: { addListener(fn) { alarms.push(fn); } } },
    runtime: { getManifest: () => ({ version: '0.50.13' }), onMessage: { addListener(fn) { listener = fn; } } },
    sidePanel: { setPanelBehavior: async () => {} },
    downloads: { download: async (options) => { downloads.push(clone(options)); return downloads.length; } },
    tabs: { query: async () => [tab], get: async () => tab },
    scripting: { async executeScript({ args }) {
      const command = args[0]; provider.push(clone(command));
      if (command.op === 'listImageModels') {
        if (inventory instanceof Error) throw inventory;
        return [{ result: { ok: true, result: clone(inventory) } }];
      }
      if (command.op === 'uploadImage') return [{ result: { ok: true, result: uploadConfirmed ? { mediaId: 'ref-exact' } : {} } }];
      if (command.op === 'prepareGenerateImage') return [{ result: { ok: true, result: { preparationId: 'prepared' } } }];
      if (command.op === 'submitGenerateImage') {
        await onSubmit?.(local);
        if (failure) throw new Error(failure);
        return [{ result: { ok: true, result: { base64: PNG, mime: 'image/png' } } }];
      }
      throw new Error(`Unexpected provider command ${command.op}`);
    } },
  };
  globalThis.indexedDB = fakeIndexedDB;
  globalThis.setInterval = () => 0;
  globalThis.fetch = async (url, init = {}) => {
    if (allowStorySave && url === 'http://studio.invalid/api/projects/my%20project/scene-review/EP%200001/upload-image/scene%2Fone') {
      calls.push({ url, init });
      return Response.json({ scene_id: 'scene/one' });
    }
    assert.equal(new URL(url).origin, connection.gatewayUrl, 'No real network or unexpected Story request permitted.');
    const entry = { url, init }; calls.push(entry);
    if (url.endsWith('/health')) {
      await onHealth?.(local);
      return Response.json({ ok: true, kind: 'image', workerId: connection.gatewayWorkerId, maxResultBytes: uploadLimit });
    }
    if (url.endsWith('/claim')) {
      if (claimLost) throw new Error('Fixture claim connection lost.');
      return job ? Response.json({ job }) : new Response(null, { status: 204 });
    }
    if (url.endsWith('/result')) {
      entry.bytes = Buffer.from(await init.body.get('file').arrayBuffer());
      entry.mime = init.body.get('mediaType');
      return Response.json(resultAnswers.length > 1 ? resultAnswers.shift() : resultAnswers[0]);
    }
    if (url.endsWith('/progress') || url.endsWith('/fail')) return Response.json({ ok: true });
    throw new Error(`Unexpected HTTP ${url}`);
  };
  await import(`../src/background.js?gateway-fixture=${++bootId}`);
  await pause(20);
  return {
    local, sync, calls, provider, downloads,
    tick(name = 'gatewayTick') { for (const alarm of alarms) alarm({ name }); },
    async send(message) { return new Promise((resolve) => listener(message, {}, resolve)); },
    async stopped() { await pause(20); },
    advance(ms) {
      clock.now += ms;
      for (const [id, timer] of timers) if (timer.at <= clock.now) { timers.delete(id); timer.fn(); }
    },
    restore() {
      for (const [key, value] of Object.entries(previous)) globalThis[key] = value;
      Date.now = realNow; Math.random = realRandom;
    },
  };
}

test('default random pacing is inclusive 5–15s after completion, even when generation takes longer', async () => {
  for (const [random, gap] of [[0, 5000], [0.5, 10000], [0.999999, 15000]]) {
    const clock = { now: 1_000_000, random };
    const worker = await boot({ mode: 'standalone', clock, defaultPacing: true,
      synced: { flowProjectId: JOB.flowProjectId }, onSubmit: () => { clock.now += 120_000; } });
    try {
      assert.equal((await worker.send({ type: 'enqueueStandalone', payload: { prompt: JOB.prompt, provider: 'flow' } })).ok, true);
      await waitFor(() => worker.local.queue?.[0]?.status === 'done');
      await worker.stopped();
      assert.equal(worker.downloads.length, 1);
      assert.equal(worker.local.nextProviderRunAt, clock.now + gap);
      assert.deepEqual([worker.sync.settings.humanDelayMinSec, worker.sync.settings.humanDelayMaxSec], [5, 15]);
    } finally { worker.restore(); }
  }
});

test('saved custom pacing and explicit zero survive settings reload and govern actual generation completion', async () => {
  for (const [min, max, gap] of [[0, 0, 0], [22, 22, 22000], [5, 60, 60000]]) {
    const clock = { now: 2_000_000, random: 0.999999 };
    const worker = await boot({ mode: 'standalone', clock, synced: { humanDelayMinSec: min, humanDelayMaxSec: max, flowProjectId: JOB.flowProjectId } });
    try {
      for (let i = 0; i < 2; i++) {
        const result = await worker.send({ type: 'settings:get' });
        assert.deepEqual([result.settings.humanDelayMinSec, result.settings.humanDelayMaxSec], [min, max]);
      }
      await worker.send({ type: 'enqueueStandalone', payload: { prompt: JOB.prompt, provider: 'flow' } });
      await waitFor(() => worker.local.queue?.[0]?.status === 'done');
      await worker.stopped();
      assert.equal(worker.local.nextProviderRunAt, clock.now + gap);
    } finally { worker.restore(); }
  }
});

test('an edit during generation applies to the next gap without changing the running generation', async () => {
  const clock = { now: 3_000_000 };
  let worker;
  worker = await boot({ mode: 'standalone', clock, defaultPacing: true, synced: { flowProjectId: JOB.flowProjectId },
    onSubmit: async () => { await worker.send({ type: 'settings:patch', patch: { humanDelayMinSec: 0, humanDelayMaxSec: 0 } }); } });
  try {
    await worker.send({ type: 'enqueueStandalone', payload: { prompt: JOB.prompt, provider: 'flow' } });
    await waitFor(() => worker.local.queue?.[0]?.status === 'done');
    await worker.stopped();
    assert.equal(worker.local.nextProviderRunAt, clock.now);
    assert.equal(worker.provider.filter(({ op }) => op === 'submitGenerateImage').length, 1);
  } finally { worker.restore(); }
});

test('a second generation waits the full gap after the first completes and respects a new cooldown', async () => {
  const clock = { now: 3_500_000 };
  const submissions = [];
  const worker = await boot({ mode: 'standalone', clock, defaultPacing: true, synced: { flowProjectId: JOB.flowProjectId,
    providerCooldowns: { flow: { autoResume: true, minutes: 1, retries: 0 } } },
    onSubmit: () => { submissions.push(clock.now); clock.now += 120_000; } });
  try {
    await worker.send({ type: 'enqueueStandalone', payload: { prompts: [JOB.prompt, 'Another village.'], provider: 'flow' } });
    await waitFor(() => worker.local.queue?.[0]?.status === 'done');
    await worker.stopped();
    assert.deepEqual(submissions, [3_500_000]);
    worker.advance(4999); await worker.stopped();
    assert.equal(submissions.length, 1);
    worker.local.cooldownUntil = { flow: clock.now + 60_000 };
    worker.advance(1); await worker.stopped();
    assert.equal(submissions.length, 1);
    assert.equal(worker.local.queue[1].status, 'pending');
    worker.advance(60_000); worker.tick('queueTick');
    await waitFor(() => worker.local.queue?.[1]?.status === 'done');
    await worker.stopped();
    assert.deepEqual(submissions, [3_500_000, 3_685_000]);
  } finally { worker.restore(); }
});

test('restarted pending generation retains its chosen gap even if the new settings are Off', async () => {
  const clock = { now: 3_800_000 };
  const item = imageGatewayJobToItem({ ...JOB, referenceImages: [] }, {});
  item.target = 'download'; item.source = 'standalone';
  const local = { imageGeneratorWorkMode: 'standalone', queue: [item], nextProviderRunAt: clock.now + 5000 };
  const worker = await boot({ local, clock });
  try {
    await worker.stopped();
    assert.equal(worker.provider.length, 0);
    assert.equal(local.queue[0].status, 'pending');
    worker.advance(4999); await worker.stopped();
    assert.equal(worker.provider.length, 0);
    worker.advance(1);
    await waitFor(() => local.queue[0].status === 'done');
    await worker.stopped();
    assert.equal(worker.provider.filter(({ op }) => op === 'submitGenerateImage').length, 1);
    assert.equal(local.nextProviderRunAt, clock.now);
  } finally { worker.restore(); }
});

test('Gateway pacing and cooldown block even discovery/health, survive restart, and release only at eligibility', async () => {
  for (const hold of [{ nextProviderRunAt: 4_010_000 }, { cooldownUntil: { flow: 4_010_000 } }]) {
    const clock = { now: 4_000_000 };
    const local = { gatewayConnection: clone(connection), imageGeneratorWorkMode: 'gateway', ...hold };
    const first = await boot({ local, clock, job: null });
    try {
      first.tick(); await first.stopped();
      assert.equal(first.calls.length, 0);
      assert.equal(first.provider.length, 0);
    } finally { first.restore(); }
    const restarted = await boot({ local, clock, job: null });
    try {
      restarted.tick(); await restarted.stopped();
      assert.equal(restarted.calls.length, 0);
      restarted.advance(9999); restarted.tick(); await restarted.stopped();
      assert.equal(restarted.calls.length, 0);
      restarted.advance(1); restarted.tick();
      await waitFor(() => restarted.calls.some(({ url }) => url.endsWith('/claim')));
      await restarted.stopped();
      assert.equal(restarted.calls.filter(({ url }) => url.endsWith('/claim')).length, 1, JSON.stringify({ hold, status: local.lastStatus }));
    } finally { restarted.restore(); }
  }
});

test('a hold or active job arriving during Gateway health prevents the claim at its actual boundary', async () => {
  for (const hold of [{ nextProviderRunAt: 5_010_000 }, { cooldownUntil: { flow: 5_010_000 } },
    { gatewayUnsettledClaim: { claimId: 'unknown' } }]) {
    const clock = { now: 5_000_000 };
    const worker = await boot({ clock, job: null, onHealth: (local) => Object.assign(local, clone(hold)) });
    try {
      worker.tick(); await worker.stopped();
      assert.equal(worker.calls.filter(({ url }) => url.endsWith('/health')).length, 1);
      assert.equal(worker.calls.filter(({ url }) => url.endsWith('/claim')).length, 0, JSON.stringify({ hold, status: worker.local.lastStatus }));
    } finally { worker.restore(); }
  }
});

test('a real enqueue during health reserves the worker and concurrent polling cannot claim', async () => {
  let release, worker;
  const blocked = new Promise((resolve) => { release = resolve; });
  worker = await boot({ job: null, synced: { flowProjectId: JOB.flowProjectId }, onSubmit: () => blocked,
    onHealth: () => worker.send({ type: 'enqueueStandalone', payload: { prompt: JOB.prompt, provider: 'flow' } }) });
  try {
    worker.tick(); worker.tick();
    await waitFor(() => worker.provider.some(({ op }) => op === 'submitGenerateImage'));
    await worker.stopped();
    assert.equal(worker.local.queue[0].status, 'running');
    assert.equal(worker.calls.filter(({ url }) => url.endsWith('/claim')).length, 0);
    worker.tick(); await worker.stopped();
    assert.equal(worker.calls.filter(({ url }) => url.endsWith('/health')).length, 1);
    release();
    await waitFor(() => worker.local.queue[0].status === 'done');
    await worker.stopped();
    assert.equal(worker.provider.filter(({ op }) => op === 'submitGenerateImage').length, 1);
  } finally { release(); worker.restore(); }
});

test('an expired pacing gap never clears an unknown claim across restart', async () => {
  const clock = { now: 6_000_000 };
  const local = { gatewayConnection: clone(connection), imageGeneratorWorkMode: 'gateway', nextProviderRunAt: clock.now - 1,
    gatewayUnsettledClaim: { claimId: 'lost-response', at: clock.now - 60000 } };
  for (let i = 0; i < 2; i++) {
    const worker = await boot({ local, clock });
    try {
      worker.tick(); await worker.stopped();
      assert.equal(worker.calls.length, 0);
      assert.equal(worker.provider.length, 0);
      assert.equal(local.gatewayUnsettledClaim.claimId, 'lost-response');
    } finally { worker.restore(); }
  }
});

test('fallback, empty, cached, unattributed or failed inventory never authorizes a Gateway claim or stale live cache', async () => {
  for (const inventory of [
    { source: 'fallback', entries: [{ id: 'NARWHAL', label: 'Nano Banana 2' }] },
    { entries: [{ id: 'NARWHAL', label: 'Nano Banana 2' }] },
    { source: 'cached', entries: [{ id: 'NARWHAL', label: 'Nano Banana 2' }] },
    { source: 'live', entries: [] },
    new Error('fixture inventory unavailable'),
  ]) {
    const worker = await boot({ inventory, local: { gatewayConnection: clone(connection), imageGeneratorWorkMode: 'gateway',
      flowImageModelInventory: { source: 'live', refreshedAt: 1, models: [{ modelId: 'STALE_MODEL', modelLabel: 'Old' }] } } });
    try {
      worker.tick();
      await waitFor(() => worker.local.lastStatus?.text.includes('no captured live inventory'));
      await worker.stopped();
      assert.equal(worker.calls.length, 0, 'No Gateway request, including claim, may rely on fallback.');
      assert.equal(worker.provider.filter(({ op }) => op !== 'listImageModels').length, 0);
      assert.equal(worker.local.gatewayUnsettledClaim, undefined);
      assert.equal(worker.local.flowImageModelInventory.source, 'fallback');
      assert.equal(worker.local.flowImageModelInventory.models.some(({ modelId }) => modelId === 'STALE_MODEL'), false);
    } finally { worker.restore(); }
  }
});

test('queued Gateway work loses eligibility when current inventory is only fallback, without submitting', async () => {
  rows = new Map();
  const binding = await gatewayBinding(connection);
  const item = { ...imageGatewayJobToItem(JOB, {}), gatewayBinding: binding };
  rows.set(JOB.jobId, { references: [{ base64: PNG, mime: 'image/png', sourceKey: 'fixture-ref', name: 'reference' }], binding });
  const worker = await boot({ inventory: { source: 'fallback', entries: [] }, local: {
    gatewayConnection: clone(connection), imageGeneratorWorkMode: 'gateway', queue: [item],
  } });
  try {
    await waitFor(() => worker.local.queue?.[0]?.status === 'failed');
    await worker.stopped();
    assert.equal(worker.provider.filter(({ op }) => op !== 'listImageModels').length, 0);
    assert.equal(worker.calls.filter(({ url }) => url.endsWith('/claim') || url.endsWith('/result')).length, 0);
    const failure = worker.calls.find(({ url }) => url.endsWith('/fail'));
    assert.equal(JSON.parse(failure.init.body).ambiguous, false);
    assert.notEqual(worker.local.queue[0].providerAttempted, true);
  } finally { worker.restore(); }
});

test('a queued live manual model cannot be verified by the bundled list after inventory is lost', async () => {
  const item = imageGatewayJobToItem(JOB, {});
  item.target = 'download';
  item.source = 'standalone';
  item.modelSnapshot.modelSource = item.generationSettings.modelSource = 'live';
  const worker = await boot({ mode: 'standalone', inventory: { source: 'fallback', entries: [] }, local: {
    gatewayConnection: clone(connection), imageGeneratorWorkMode: 'standalone', queue: [item],
  } });
  try {
    await waitFor(() => worker.local.queue?.[0]?.status === 'failed');
    await worker.stopped();
    assert.equal(worker.calls.length, 0);
    assert.equal(worker.downloads.length, 0);
    assert.equal(worker.provider.filter(({ op }) => op !== 'listImageModels').length, 0);
  } finally { worker.restore(); }
});

test('local credential migration strips sync and does not activate a different mode', async () => {
  const worker = await boot({ local: { imageGeneratorWorkMode: 'standalone' }, synced: connection });
  try {
    assert.equal(worker.local.gatewayConnection.gatewayToken, connection.gatewayToken);
    for (const key of Object.keys(connection)) assert.equal(worker.sync.settings[key], undefined);
    worker.tick(); await worker.stopped();
    assert.equal(worker.calls.length, 0);
  } finally { worker.restore(); }
});

test('missing or unconfirmed references stop before Generate; live upload limits retain output', async () => {
  rows = new Map();
  const item = { ...imageGatewayJobToItem(JOB, {}), gatewayBinding: await gatewayBinding(connection), gatewayMaxResultBytes: 1024 };
  const missing = await boot({ local: { gatewayConnection: clone(connection), imageGeneratorWorkMode: 'gateway', queue: [item] } });
  try {
    await waitFor(() => missing.local.queue?.[0]?.status === 'failed');
    await missing.stopped();
    assert.equal(missing.provider.filter((entry) => entry.op === 'submitGenerateImage').length, 0);
  } finally { missing.restore(); }
  const unconfirmed = await boot({ uploadConfirmed: false });
  try {
    unconfirmed.tick();
    await waitFor(() => unconfirmed.local.queue?.[0]?.status === 'failed');
    await unconfirmed.stopped();
    assert.equal(unconfirmed.provider.filter((entry) => entry.op === 'submitGenerateImage').length, 0);
    assert.equal(rows.size, 0, 'Confirmed pre-submit failure safely releases references.');
  } finally { unconfirmed.restore(); }
  rows = new Map();
  const limited = await boot({ uploadLimit: 1 });
  try {
    limited.tick();
    await waitFor(() => limited.local.queue?.[0]?.status === 'failed');
    await limited.stopped();
    assert.deepEqual(Buffer.from(rows.get(JOB.jobId).bytes), Buffer.from(PNG, 'base64'));
    assert.equal(limited.calls.filter((entry) => entry.url.endsWith('/result')).length, 0);
  } finally { limited.restore(); }
});

test('a lost claim response persists a hold and does not poll another claim after restart', async () => {
  const first = await boot({ claimLost: true });
  let local;
  try {
    first.tick();
    await waitFor(() => first.local.lastStatus?.text.includes('Fixture claim connection lost'));
    first.tick(); await first.stopped();
    assert.equal(first.calls.filter((entry) => entry.url.endsWith('/claim')).length, 1);
    local = first.local;
  } finally { first.restore(); }
  const second = await boot({ local });
  try { second.tick(); await second.stopped(); assert.equal(second.calls.length, 0); }
  finally { second.restore(); }
});

test('a repeated completed job keeps the claim held across restart without replay or evidence loss', async () => {
  rows = new Map();
  const first = await boot();
  let local, completed;
  try {
    first.tick();
    await waitFor(() => first.local.queue?.[0]?.status === 'done');
    await first.stopped();
    completed = clone(first.local.queue[0]);
    first.tick();
    await waitFor(() => first.local.gatewayUnsettledClaim?.jobId === JOB.jobId);
    await first.stopped();
    first.tick();
    await waitFor(() => first.local.lastStatus?.text.includes('unsettled claim'));
    assert.deepEqual(first.local.queue, [completed]);
    assert.equal(first.calls.filter((entry) => entry.url.endsWith('/claim')).length, 2);
    assert.equal(first.calls.filter((entry) => entry.url.endsWith('/result')).length, 1);
    assert.equal(first.calls.filter((entry) => entry.url.endsWith('/fail')).length, 0);
    assert.equal(first.provider.filter((entry) => entry.op === 'submitGenerateImage').length, 1);
    assert.equal(rows.size, 0);
    local = first.local;
  } finally { first.restore(); }
  const second = await boot({ local });
  try {
    second.tick(); await second.stopped();
    assert.equal(second.calls.length, 0);
    assert.equal(second.provider.length, 0);
    assert.deepEqual(local.queue, [completed]);
    assert.equal(local.gatewayUnsettledClaim.jobId, JOB.jobId);
  } finally { second.restore(); }
});

test('restart settles only the exact claim already committed to the queue', async () => {
  rows = new Map();
  const binding = await gatewayBinding(connection);
  const gatewayClaimId = 'fixture-claim';
  const item = { ...imageGatewayJobToItem(JOB, {}), gatewayBinding: binding, gatewayClaimId };
  rows.set(JOB.jobId, { references: [{ base64: PNG, mime: 'image/png', sourceKey: 'fixture-ref', name: 'reference' }], binding });
  const worker = await boot({ local: { gatewayConnection: clone(connection), imageGeneratorWorkMode: 'gateway',
    gatewayUnsettledClaim: { jobId: JOB.jobId, binding, claimId: gatewayClaimId }, queue: [item] } });
  try {
    await waitFor(() => worker.local.queue?.[0]?.status === 'done');
    await worker.stopped();
    assert.equal(worker.local.gatewayUnsettledClaim, undefined);
    assert.equal(worker.calls.filter((entry) => entry.url.endsWith('/claim')).length, 0);
    assert.equal(worker.calls.filter((entry) => entry.url.endsWith('/result')).length, 1);
    assert.equal(worker.provider.filter((entry) => entry.op === 'submitGenerateImage').length, 1);
  } finally { worker.restore(); }
});

test('legacy claim markers remain held when an older matching job is already completed', async () => {
  rows = new Map();
  const binding = await gatewayBinding(connection);
  const item = { ...imageGatewayJobToItem(JOB, {}), gatewayBinding: binding, status: 'done', gatewayAcknowledged: true, savedAs: `Gateway ${JOB.jobId}` };
  const worker = await boot({ local: { gatewayConnection: clone(connection), imageGeneratorWorkMode: 'gateway',
    gatewayUnsettledClaim: { jobId: JOB.jobId, binding }, queue: [item] } });
  try {
    worker.tick(); await worker.stopped();
    assert.equal(worker.calls.length, 0);
    assert.equal(worker.provider.length, 0);
    assert.equal(worker.local.gatewayUnsettledClaim.jobId, JOB.jobId);
    assert.equal(worker.local.queue[0].status, 'done');
  } finally { worker.restore(); }
});

test('Standalone enqueue downloads exact bytes without Gateway work when its connection is enabled', async () => {
  const worker = await boot({ mode: 'standalone', inventory: { source: 'fallback', entries: [] }, synced: { imageModel: 'nano-banana-2-lite', flowProjectId: JOB.flowProjectId, flowAutoNewProject: false } });
  try {
    const result = await worker.send({ type: 'enqueueStandalone', payload: { prompt: JOB.prompt, label: 'quiet village', provider: 'flow' } });
    assert.equal(result.ok, true);
    assert.equal(result.added, 1);
    await waitFor(() => worker.local.queue?.[0]?.status === 'done');
    await worker.stopped();
    worker.tick(); await worker.stopped();
    assert.equal(worker.calls.length, 0);
    assert.equal(worker.downloads.length, 1);
    assert.equal(worker.downloads[0].url, `data:image/png;base64,${PNG}`);
    assert.match(worker.downloads[0].filename, /^StoryStudioImages\/Standalone\/.+_01_quiet-village\.png$/);
    assert.equal(worker.downloads[0].saveAs, false);
    assert.equal(worker.downloads[0].conflictAction, 'uniquify');
    assert.equal(worker.local.queue[0].target, 'download');
    assert.equal(worker.local.queue[0].modelSnapshot.modelId, 'HARBOR_SEAL');
    assert.equal(worker.local.queue[0].modelSnapshot.modelSource, 'fallback');
    assert.equal(worker.provider.find(({ op }) => op === 'prepareGenerateImage').payload.modelId, 'HARBOR_SEAL');
    assert.equal(worker.provider.filter((entry) => entry.op === 'submitGenerateImage').length, 1);
  } finally { worker.restore(); }
});

test('Story enqueue saves exact bytes to Scene Review and refuses non-plan scenes before submission', async () => {
  const worker = await boot({ mode: 'studio', allowStorySave: true, inventory: { source: 'fallback', entries: [] }, synced: {
    imageModel: 'nano-banana-2', flowProjectId: JOB.flowProjectId, flowAutoNewProject: false,
    storyStudioReferencesEnabled: false, studioBaseUrl: 'http://studio.invalid',
  } });
  const payload = { slug: 'my project', episodeCode: 'EP 0001', kind: 'scene', provider: 'flow',
    scenes: [{ key: 'scene/one', prompt: JOB.prompt }],
    flowModelApproval: { modelId: 'NARWHAL', modelLabel: 'Nano Banana 2', modelSource: 'fallback' } };
  try {
    const refused = await worker.send({ type: 'enqueueScenes', payload: { ...payload, source: 'prompts' } });
    assert.equal(refused.ok, false);
    assert.equal(worker.provider.length, 0);
    const result = await worker.send({ type: 'enqueueScenes', payload: { ...payload, source: 'plan' } });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.added, 1);
    await waitFor(() => worker.local.queue?.[0]?.status === 'done');
    await worker.stopped();
    worker.tick(); await worker.stopped();
    assert.equal(worker.calls.length, 1);
    const save = worker.calls[0];
    assert.equal(save.url, 'http://studio.invalid/api/projects/my%20project/scene-review/EP%200001/upload-image/scene%2Fone');
    assert.equal(save.init.method, 'POST');
    assert.equal(save.init.credentials, 'include');
    assert.deepEqual(JSON.parse(save.init.body), { data_base64: PNG });
    assert.equal(worker.local.queue[0].savedAs, 'scene/one.png');
    assert.equal(worker.local.queue[0].target, 'project');
    assert.equal(worker.downloads.length, 0);
    assert.equal(worker.provider.filter((entry) => entry.op === 'submitGenerateImage').length, 1);
  } finally { worker.restore(); }
});

test('actual claim -> exact reference -> single dispatch -> multipart acceptance -> cleanup', async () => {
  rows = new Map();
  const worker = await boot();
  try {
    worker.tick(); worker.tick();
    await waitFor(() => worker.local.queue?.[0]?.status === 'done');
    await worker.stopped();
    const result = worker.calls.find((entry) => entry.url.endsWith('/result'));
    assert.deepEqual(result.bytes, Buffer.from(PNG, 'base64'));
    assert.equal(result.mime, 'image/png');
    assert.equal(worker.provider.filter((entry) => entry.op === 'submitGenerateImage').length, 1);
    assert.equal(worker.provider.find((entry) => entry.op === 'uploadImage').payload.base64, PNG);
    assert.deepEqual(worker.provider.find((entry) => entry.op === 'prepareGenerateImage').payload.imageInputs, [{ imageInputType: 'IMAGE_INPUT_TYPE_REFERENCE', name: 'ref-exact' }]);
    assert.equal(worker.local.queue[0].gatewayAcknowledged, true);
    assert.equal(rows.size, 0);
    assert.equal(worker.sync.settings.gatewayToken, undefined);
    assert.ok(!JSON.stringify(worker.local.queue).includes('fixture-only'));
  } finally { worker.restore(); }
});

test('ignored/malformed answers retain exact bytes; actual restart and delivery never regenerate', async () => {
  rows = new Map();
  const first = await boot({ resultAnswers: [{ ok: true, ignored: true }] });
  let local;
  try {
    first.tick();
    await waitFor(() => first.local.queue?.[0]?.status === 'failed');
    await first.stopped();
    assert.deepEqual(Buffer.from(rows.get(JOB.jobId).bytes), Buffer.from(PNG, 'base64'));
    const retried = await first.send({ type: 'retryFailed' });
    assert.equal(retried.retried, 0);
    await first.send({ type: 'clearFailed' });
    await first.send({ type: 'clearQueue' });
    assert.equal(first.local.queue.length, 1);
    first.tick(); await first.stopped();
    assert.equal(first.calls.filter((entry) => entry.url.endsWith('/claim')).length, 1);
    assert.equal(first.calls.filter((entry) => entry.url.endsWith('/fail')).length, 0);
    local = first.local;
    local.queue[0].status = 'running'; // suspension after bytes were staged
  } finally { first.restore(); }
  const second = await boot({ local, resultAnswers: [{}, { ok: true }] });
  try {
    assert.equal(local.queue[0].status, 'failed');
    const badAck = await second.send({ type: 'gateway:retryDelivery', id: local.queue[0].id });
    assert.equal(badAck.ok, false);
    assert.ok(rows.get(JOB.jobId).bytes);
    const accepted = await second.send({ type: 'gateway:retryDelivery', id: local.queue[0].id });
    assert.equal(accepted.ok, true);
    assert.equal(local.queue[0].status, 'done');
    assert.equal(second.provider.length, 0);
    assert.equal(rows.size, 0);
  } finally { second.restore(); }
});

test('post-submit provider failure is ambiguous and alarm/Resume cannot regenerate', async () => {
  rows = new Map();
  const worker = await boot({ failure: 'fixture lost response' });
  try {
    worker.tick();
    await waitFor(() => worker.local.queue?.[0]?.status === 'failed');
    await worker.stopped();
    const fail = worker.calls.find((entry) => entry.url.endsWith('/fail'));
    assert.equal(JSON.parse(fail.init.body).ambiguous, true);
    assert.equal(worker.local.queue[0].gatewayAcknowledged, false);
    await worker.send({ type: 'resumeQueue' });
    worker.tick(); await worker.stopped();
    assert.equal(worker.provider.filter((entry) => entry.op === 'submitGenerateImage').length, 1);
    assert.equal(worker.calls.filter((entry) => entry.url.endsWith('/claim')).length, 1);
  } finally { worker.restore(); }
});

test('changed token retains generated bytes and sends neither result nor failure to new credentials', async () => {
  rows = new Map();
  const worker = await boot({ onSubmit: (local) => { local.gatewayConnection.gatewayToken = 'rotated'; } });
  try {
    worker.tick();
    await waitFor(() => worker.local.queue?.[0]?.status === 'failed');
    await worker.stopped();
    assert.ok(rows.get(JOB.jobId).bytes);
    assert.equal(worker.calls.filter((entry) => /\/(result|fail)$/.test(entry.url)).length, 0);
    assert.equal((await worker.send({ type: 'gateway:retryDelivery', id: worker.local.queue[0].id })).ok, false);
  } finally { worker.restore(); }
});

test('Story/standalone or disabled mode never claims; schema rejection never invokes provider', async () => {
  for (const mode of ['studio', 'standalone']) {
    const worker = await boot({ mode });
    try { worker.tick(); await worker.stopped(); assert.equal(worker.calls.length, 0); assert.equal(worker.provider.length, 0); }
    finally { worker.restore(); }
  }
  const disabled = await boot({ local: { gatewayConnection: { ...connection, gatewayModeEnabled: false }, imageGeneratorWorkMode: 'gateway' } });
  try { disabled.tick(); await disabled.stopped(); assert.equal(disabled.calls.length, 0); } finally { disabled.restore(); }
  const invalid = await boot({ job: { ...JOB, referenceImages: [{ mediaType: 'image/png', dataBase64: 'AAAA' }] } });
  try {
    invalid.tick();
    await waitFor(() => invalid.calls.some((entry) => entry.url.endsWith('/fail')));
    await invalid.stopped();
    assert.equal(invalid.provider.filter(({ op }) => op !== 'listImageModels').length, 0);
    assert.equal(JSON.parse(invalid.calls.find((entry) => entry.url.endsWith('/fail')).init.body).ambiguous, false);
  } finally { invalid.restore(); }
});
