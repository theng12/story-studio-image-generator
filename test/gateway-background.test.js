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
async function boot({ local, mode = 'gateway', job = JOB, resultAnswers = [{ ok: true }], onSubmit, failure, uploadConfirmed = true, claimLost = false, uploadLimit = 1024, synced = {} } = {}) {
  local ||= { gatewayConnection: clone(connection), imageGeneratorWorkMode: mode };
  const sync = { settings: { humanDelayMinSec: 0, humanDelayMaxSec: 0, ...synced } };
  const previous = Object.fromEntries(['chrome', 'fetch', 'indexedDB', 'setInterval'].map((key) => [key, globalThis[key]]));
  const alarms = [], calls = [], provider = [];
  let listener;
  const tab = { id: 7, status: 'complete', url: `https://flow.google.com/project/${JOB.flowProjectId}` };
  globalThis.chrome = {
    storage: { local: area(local), sync: area(sync), session: area({}), onChanged: { addListener() {} } },
    alarms: { create() {}, clear() {}, onAlarm: { addListener(fn) { alarms.push(fn); } } },
    runtime: { getManifest: () => ({ version: '0.50.10' }), onMessage: { addListener(fn) { listener = fn; } } },
    sidePanel: { setPanelBehavior: async () => {} },
    tabs: { query: async () => [tab], get: async () => tab },
    scripting: { async executeScript({ args }) {
      const command = args[0]; provider.push(clone(command));
      if (command.op === 'listImageModels') return [{ result: { ok: true, result: { entries: [{ id: 'NARWHAL', label: 'Nano Banana 2' }] } } }];
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
    assert.equal(new URL(url).origin, connection.gatewayUrl, 'No real network or Story request permitted.');
    const entry = { url, init }; calls.push(entry);
    if (url.endsWith('/health')) return Response.json({ ok: true, kind: 'image', workerId: connection.gatewayWorkerId, maxResultBytes: uploadLimit });
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
  await import(`../src/background.js?gateway-fixture=${Date.now()}-${Math.random()}`);
  await pause(20);
  return {
    local, sync, calls, provider,
    tick() { for (const alarm of alarms) alarm({ name: 'gatewayTick' }); },
    async send(message) { return new Promise((resolve) => listener(message, {}, resolve)); },
    async stopped() { await pause(20); },
    restore() { for (const [key, value] of Object.entries(previous)) globalThis[key] = value; },
  };
}

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
    assert.equal(invalid.provider.length, 0);
    assert.equal(JSON.parse(invalid.calls.find((entry) => entry.url.endsWith('/fail')).init.body).ambiguous, false);
  } finally { invalid.restore(); }
});
