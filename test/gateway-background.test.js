// Executes the shipped background module. Only browser APIs, provider commands
// and HTTP are mocked; no queue or Gateway lifecycle logic is copied here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { gatewayBinding, imageGatewayJobToItem } from '../src/lib/gateway-worker.js';
import { payloadSha256 as sha256Of } from '../src/lib/gateway-account.js';

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
async function boot({ local, mode = 'gateway', job = JOB, resultAnswers = [{ ok: true }], onSubmit, onPrepare, onHealth, onTelemetry, onClaim, claimEnvelope = {}, claimAnswers = [], control = { dispatchEnabled: true, closeRequested: false, revision: 'fixture-on', requestedAt: 1, pacing: { minSeconds: 0, maxSeconds: 0 } }, quoteRequired, clock, defaultPacing = false, failure, uploadConfirmed = true, claimLost = false, uploadLimit = 1024, synced = {}, allowStorySave = false, observedAccount, inventory = { source: 'live', entries: [{ id: 'NARWHAL', label: 'Nano Banana 2.1' }] } } = {}) {
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
    runtime: { getManifest: () => ({ version: '0.50.14' }), onMessage: { addListener(fn) { listener = fn; } } },
    sidePanel: { setPanelBehavior: async () => {} },
    downloads: { download: async (options) => { downloads.push(clone(options)); return downloads.length; } },
    tabs: { query: async () => [tab], get: async () => tab },
    scripting: { async executeScript({ args }) {
      const command = args[0]; provider.push(clone(command));
      if (command.op === 'listImageModels') {
        if (inventory instanceof Error) throw inventory;
        return [{ result: { ok: true, result: clone(inventory) } }];
      }
      if (command.op === 'inspectAccount') {
        if (observedAccount === null) return [{ result: { ok: true, result: { account: null } } }];
        const observedAt = new Date(Date.now()).toISOString();
        return [{ result: { ok: true, result: { account: observedAccount || {
          schema: 1, provider: 'flow', accountId: 'fixture-account', source: 'flow.account', observedAt,
          connection: 'connected', signIn: 'signed_in', readiness: 'ready',
          balance: { value: 23, unit: 'credits', source: 'flow.nzlxg', observedAt },
        } } } }];
      }
      if (command.op === 'uploadImage') return [{ result: { ok: true, result: uploadConfirmed ? { mediaId: 'ref-exact' } : {} } }];
      if (command.op === 'prepareGenerateImage') {
        await onPrepare?.(local);
        return [{ result: { ok: true, result: { preparationId: 'prepared' } } }];
      }
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
      return Response.json({ ok: true, kind: 'image', workerId: connection.gatewayWorkerId, maxResultBytes: uploadLimit, control });
    }
    if (url.endsWith('/telemetry')) {
      await onTelemetry?.(JSON.parse(init.body), local);
      return Response.json({ ok: true, receivedAt: Date.now() / 1000, control });
    }
    if (url.endsWith('/claim')) {
      await onClaim?.(JSON.parse(init.body), local, sync.settings);
      if (claimLost) throw new Error('Fixture claim connection lost.');
      if (claimAnswers.length) return Response.json(claimAnswers.shift());
      return Response.json({ job: quoteRequired ? null : job, ...(quoteRequired ? { quoteRequired } : {}), control, ...claimEnvelope });
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
    get workCalls() { return calls.filter(({ url }) => !/\/(health|telemetry)$/.test(url)); },
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

const offControl = (revision = 'stop-1', pacing = { minSeconds: 5, maxSeconds: 15 }) => ({ dispatchEnabled: false, closeRequested: true, revision, requestedAt: 2, pacing });

test('manager stop is persisted before its revision is acknowledged and local Resume cannot bypass it after restart', async () => {
  const control = offControl('persisted-stop', { minSeconds: 0, maxSeconds: 0 });
  const first = await boot({ control, onTelemetry: (body, local) => {
    assert.equal(local.gatewayWorkerControl.dispatchEnabled, false);
    assert.equal(body.telemetry.state.controlRevision, 'persisted-stop');
    assert.equal(body.telemetry.state.paused, true);
    assert.equal(body.account, undefined);
    assert.equal(body.telemetry.credits, undefined);
  } });
  let local;
  try {
    first.tick();
    await waitFor(() => first.calls.some(({ url }) => url.endsWith('/telemetry')));
    await first.stopped();
    await first.send({ type: 'enqueueStandalone', payload: { prompt: JOB.prompt, provider: 'flow' } });
    await first.send({ type: 'resumeQueue' }); await first.stopped();
    assert.equal(first.local.queue[0].status, 'pending');
    assert.equal(first.provider.filter(({ op }) => op === 'submitGenerateImage').length, 0);
    assert.equal(first.calls.filter(({ url }) => url.endsWith('/claim')).length, 0);
    local = first.local;
  } finally { first.restore(); }
  const restarted = await boot({ local, onHealth: () => { throw new Error('Fixture manager offline.'); } });
  try {
    restarted.tick(); await restarted.stopped();
    await restarted.send({ type: 'resumeQueue' }); await restarted.stopped();
    assert.equal(local.queue[0].status, 'pending');
    assert.equal(local.gatewayWorkerControl.revision, 'persisted-stop');
    assert.equal(restarted.provider.length, 0);
    assert.equal(restarted.calls.filter(({ url }) => url.endsWith('/claim')).length, 0);
  } finally { restarted.restore(); }
});

test('telemetry response control is applied before a fresh stop acknowledgement is sent', async () => {
  const control = { dispatchEnabled: true, closeRequested: false, revision: 'before-stop', requestedAt: 1, pacing: { minSeconds: 0, maxSeconds: 0 } };
  const messages = [];
  const worker = await boot({ job: null, control, onTelemetry: (body, local) => {
    messages.push(body.telemetry.state);
    if (messages.length === 1) Object.assign(control, offControl('response-stop'));
    else {
      assert.equal(local.gatewayWorkerControl.revision, 'response-stop');
      assert.equal(local.gatewayWorkerControl.dispatchEnabled, false);
    }
  } });
  try {
    worker.tick(); await waitFor(() => messages.length === 2); await worker.stopped();
    assert.equal(messages[0].paused, false);
    assert.equal(messages[0].controlRevision, 'before-stop');
    assert.equal(messages[1].paused, true);
    assert.equal(messages[1].controlRevision, 'response-stop');
    assert.equal(worker.calls.filter(({ url }) => url.endsWith('/claim')).length, 0);
  } finally { worker.restore(); }
});

test('stop during active generation lets that job finish and leaves the next queued job paused', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const worker = await boot({ control: offControl('active-stop'), synced: { flowProjectId: JOB.flowProjectId }, onSubmit: () => blocked });
  try {
    await worker.send({ type: 'enqueueStandalone', payload: { prompts: [JOB.prompt, 'A second village.'], provider: 'flow' } });
    await waitFor(() => worker.provider.some(({ op }) => op === 'submitGenerateImage'));
    worker.tick();
    await waitFor(() => worker.calls.some(({ url }) => url.endsWith('/telemetry'))); await worker.stopped();
    const report = JSON.parse(worker.calls.find(({ url }) => url.endsWith('/telemetry')).init.body).telemetry.state;
    assert.equal(report.paused, true);
    assert.equal(report.activity, 'generating');
    release(); await waitFor(() => worker.local.queue[0].status === 'done'); await worker.stopped();
    assert.equal(worker.local.queue[1].status, 'pending');
    assert.equal(worker.downloads.length, 1);
    assert.equal(worker.provider.filter(({ op }) => op === 'submitGenerateImage').length, 1);
  } finally { release(); worker.restore(); }
});

test('a stop received after preparation is enforced at the persisted provider submission checkpoint', async () => {
  let worker;
  worker = await boot({ control: offControl('prepared-stop'), synced: { flowProjectId: JOB.flowProjectId },
    onPrepare: async () => { assert.equal((await worker.send({ type: 'gateway:testConnection' })).ok, true); } });
  try {
    await worker.send({ type: 'enqueueStandalone', payload: { prompt: JOB.prompt, provider: 'flow' } });
    await waitFor(() => worker.local.lastStatus?.text.includes('prepared job remains queued')); await worker.stopped();
    assert.equal(worker.local.queue[0].status, 'pending');
    assert.notEqual(worker.local.queue[0].providerAttempted, true);
    assert.equal(worker.provider.filter(({ op }) => op === 'submitGenerateImage').length, 0);
    assert.equal(worker.downloads.length, 0);
  } finally { worker.restore(); }
});

test('unclaimed quote previews remain read-only and never enter the queue when no price is set', async () => {
  const quoteRequired = { job: JOB, payloadSha256: 'a'.repeat(64), executionAuthorized: false };
  const worker = await boot({ quoteRequired });
  try {
    worker.tick(); await waitFor(() => worker.local.lastStatus?.text.includes('No credit price is set')); await worker.stopped();
    assert.equal(worker.local.gatewayUnsettledClaim, undefined);
    assert.equal(worker.local.queue?.length || 0, 0);
    assert.equal(worker.provider.filter(({ op }) => !['listImageModels', 'inspectAccount'].includes(op)).length, 0);
    const sent = JSON.parse(worker.calls.find(({ url }) => url.endsWith('/claim')).init.body);
    assert.equal(sent.account.accountId, 'fixture-account');
    assert.equal(sent.quote, undefined);
    assert.equal(sent.telemetry.state.signIn, 'signed_in');
    assert.equal(quoteRequired.payloadSha256, 'a'.repeat(64));
  } finally { worker.restore(); }
});

test('no claim is attempted without a fresh signed-in Flow account observation', async () => {
  const stale = { schema: 1, provider: 'flow', accountId: 'fixture-account', source: 'flow.account',
    observedAt: '2020-01-01T00:00:00Z', connection: 'connected', signIn: 'signed_in', readiness: 'ready' };
  for (const observedAccount of [null, stale]) {
    const worker = await boot({ observedAccount });
    try {
      worker.tick(); await waitFor(() => worker.local.lastStatus?.text.includes('signed-in Flow tab')); await worker.stopped();
      assert.equal(worker.calls.filter(({ url }) => url.endsWith('/claim')).length, 0);
      assert.equal(worker.local.queue?.length || 0, 0);
    } finally { worker.restore(); }
  }
});

async function quotedBoot(extra = {}) {
  const payloadSha256 = await sha256Of(JOB);
  return boot({
    synced: { flowProjectId: JOB.flowProjectId, gatewayImageCreditCosts: { NARWHAL: 0 } },
    claimAnswers: [
      { job: null, quoteRequired: { job: JOB, payloadSha256, executionAuthorized: false } },
      { job: JOB, accountBinding: { provider: 'flow', accountId: 'fixture-account' },
        reservation: { payloadSha256, value: 0, unit: 'credits' } },
    ],
    ...extra,
  });
}

test('a priced claim enqueues exactly one job and delivers its result', async () => {
  const payloadSha256 = await sha256Of(JOB);
  const worker = await quotedBoot();
  try {
    worker.tick();
    await waitFor(() => worker.local.queue?.[0]?.status === 'done');
    await worker.stopped();
    const claims = worker.calls.filter(({ url }) => url.endsWith('/claim')).map(({ init }) => JSON.parse(init.body));
    assert.equal(claims.length, 2, 'the preview is never executable; only the quoted claim is');
    assert.equal(claims[0].quote, undefined);
    assert.equal(claims[1].quote.payloadSha256, payloadSha256);
    assert.equal(claims[1].quote.value, 0);
    assert.equal(claims[1].account.accountId, 'fixture-account');
    assert.deepEqual(worker.local.queue.map(({ gatewayJobId }) => gatewayJobId), [JOB.jobId]);
    const result = worker.calls.find(({ url }) => url.endsWith('/result'));
    assert.deepEqual(Buffer.from(result.bytes), Buffer.from(PNG, 'base64'));
    assert.equal(worker.calls.filter(({ url }) => url.endsWith('/fail')).length, 0);
  } finally { worker.restore(); }
});

test('a claimed job reports progress before it generates', async () => {
  const progressAtSubmit = [];
  const worker = await quotedBoot({ onSubmit: () => {
    progressAtSubmit.push(worker.calls.filter(({ url }) => url.endsWith('/progress')).length);
  } });
  try {
    worker.tick();
    await waitFor(() => worker.local.queue?.[0]?.status === 'done');
    await worker.stopped();
    assert.equal(worker.calls.filter(({ url }) => url.endsWith('/progress')).length, 1);
    assert.deepEqual(progressAtSubmit, [1], 'progress must precede the generation submit');
  } finally { worker.restore(); }
});


test('telemetry reports the actual longer cooldown, unknown account facts and retained custom fractional pacing', async () => {
  const clock = { now: 9_000_000 };
  const control = { dispatchEnabled: true, closeRequested: false, revision: 'fractional-pace', requestedAt: 1, pacing: { minSeconds: 0.25, maxSeconds: 0.75 } };
  const local = { gatewayConnection: clone(connection), imageGeneratorWorkMode: 'gateway', nextProviderRunAt: clock.now + 5000, cooldownUntil: { flow: clock.now + 60000 } };
  const worker = await boot({ local, clock, control });
  try {
    worker.tick(); await waitFor(() => worker.calls.some(({ url }) => url.endsWith('/telemetry'))); await worker.stopped();
    const body = JSON.parse(worker.calls.find(({ url }) => url.endsWith('/telemetry')).init.body);
    assert.equal(body.account, undefined);
    assert.equal(body.telemetry.state.nextEligibleAt, new Date(clock.now + 60000).toISOString());
    assert.equal(body.telemetry.state.activity, 'cooling');
    assert.deepEqual(body.telemetry.state.pacing, { minSeconds: 0.25, maxSeconds: 0.75 });
    assert.equal(body.telemetry.state.connection, 'unknown');
    assert.equal(local.nextProviderRunAt, clock.now + 5000);
    assert.equal(local.cooldownUntil.flow, clock.now + 60000);
    assert.deepEqual([worker.sync.settings.humanDelayMinSec, worker.sync.settings.humanDelayMaxSec], [0.25, 0.75]);
    assert.equal(worker.calls.filter(({ url }) => url.endsWith('/claim')).length, 0);
  } finally { worker.restore(); }
});

test('telemetry retains the next pending provider cooldown rather than substituting the shorter Flow wait', async () => {
  const clock = { now: 9_500_000 };
  const local = { gatewayConnection: clone(connection), imageGeneratorWorkMode: 'gateway',
    queue: [{ id: 'qwen-wait', provider: 'qwen', status: 'pending', target: 'download', source: 'standalone', label: 'Qwen wait' }],
    cooldownUntil: { qwen: clock.now + 120000, flow: clock.now + 60000 } };
  const worker = await boot({ local, clock, synced: { providerCooldowns: { qwen: { autoResume: true, minutes: 2, retries: 0 } } } });
  try {
    worker.tick(); await waitFor(() => worker.calls.some(({ url }) => url.endsWith('/telemetry'))); await worker.stopped();
    const state = JSON.parse(worker.calls.find(({ url }) => url.endsWith('/telemetry')).init.body).telemetry.state;
    assert.equal(state.nextEligibleAt, new Date(clock.now + 120000).toISOString());
    assert.equal(state.activity, 'cooling');
    assert.equal(worker.provider.length, 0);
    assert.equal(worker.calls.filter(({ url }) => url.endsWith('/claim')).length, 0);
  } finally { worker.restore(); }
});

test('failed pacing persistence leaves a durable stop with no false revision acknowledgement', async () => {
  const worker = await boot({ control: offControl('must-not-ack'), onHealth: () => {
    globalThis.chrome.storage.sync.set = async () => { throw new Error('Fixture settings write failed.'); };
  } });
  try {
    worker.tick(); await waitFor(() => worker.local.lastStatus?.text.includes('Fixture settings write failed')); await worker.stopped();
    assert.equal(worker.local.gatewayWorkerControl.dispatchEnabled, false);
    assert.equal(worker.local.gatewayWorkerControl.revision, undefined);
    assert.equal(worker.calls.filter(({ url }) => url.endsWith('/telemetry') || url.endsWith('/claim')).length, 0);
  } finally { worker.restore(); }
});

test('newly paired Gateway defaults stay OFF without inventing a revision or overriding custom zero pacing', async () => {
  const control = { dispatchEnabled: false, closeRequested: false, revision: null, requestedAt: null, pacing: { minSeconds: 5, maxSeconds: 15 } };
  const worker = await boot({ control });
  try {
    worker.tick(); await waitFor(() => worker.calls.some(({ url }) => url.endsWith('/telemetry'))); await worker.stopped();
    const state = JSON.parse(worker.calls.find(({ url }) => url.endsWith('/telemetry')).init.body).telemetry.state;
    assert.equal(state.paused, true);
    assert.equal(state.enabled, false);
    assert.equal(Object.hasOwn(state, 'controlRevision'), false);
    assert.deepEqual(state.pacing, { minSeconds: 0, maxSeconds: 0 });
    assert.equal(worker.calls.filter(({ url }) => url.endsWith('/claim')).length, 0);
  } finally { worker.restore(); }
});

test('invalid controls stop dispatch without acknowledging an unapplied revision', async () => {
  for (const control of [null, {}, { ...offControl(), requestedAt: undefined },
    { ...offControl(), pacing: { minSeconds: -1, maxSeconds: 15 } },
    { ...offControl(), dispatchEnabled: true }]) {
    const worker = await boot({ control });
    try {
      worker.tick(); await waitFor(() => worker.local.lastStatus?.text.includes('control is missing or invalid')); await worker.stopped();
      assert.equal(worker.local.gatewayWorkerControl.dispatchEnabled, false);
      assert.equal(worker.local.gatewayWorkerControl.revision, undefined);
      assert.equal(worker.calls.filter(({ url }) => url.endsWith('/telemetry') || url.endsWith('/claim')).length, 0);
      assert.equal(worker.provider.length, 0);
    } finally { worker.restore(); }
  }
});

test('an older control reply cannot undo a newer durable stop', async () => {
  const binding = await gatewayBinding(connection);
  const local = { gatewayConnection: clone(connection), imageGeneratorWorkMode: 'gateway',
    gatewayWorkerControl: { binding, ...offControl('new-stop'), requestedAt: 20 } };
  const worker = await boot({ local }); // fixture-on requestedAt1 is stale
  try {
    worker.tick(); await waitFor(() => worker.calls.some(({ url }) => url.endsWith('/telemetry'))); await worker.stopped();
    assert.equal(local.gatewayWorkerControl.revision, 'new-stop');
    const state = JSON.parse(worker.calls.find(({ url }) => url.endsWith('/telemetry')).init.body).telemetry.state;
    assert.equal(state.controlRevision, 'new-stop');
    assert.equal(state.paused, true);
    assert.equal(worker.calls.filter(({ url }) => url.endsWith('/claim')).length, 0);
  } finally { worker.restore(); }
});

test('claim state reads the freshly applied current revision and pacing after both telemetry replies change controls', async () => {
  const clock = { now: 10_000_000 };
  const control = { dispatchEnabled: true, closeRequested: false, revision: 'pace-1', requestedAt: 1, pacing: { minSeconds: 0, maxSeconds: 0 } };
  const reports = [];
  let claimed = false;
  const worker = await boot({ clock, control, job: null, onTelemetry: (body) => {
    reports.push(body.telemetry.state);
    clock.now += 100;
    const sequence = reports.length + 1;
    Object.assign(control, { revision: `pace-${sequence}`, requestedAt: sequence, pacing: { minSeconds: sequence / 4, maxSeconds: sequence / 2 } });
  }, onClaim: (body, local, settings) => {
    claimed = { body: clone(body), applied: clone(local.gatewayWorkerControl), settings: clone(settings) };
  } });
  try {
    worker.tick(); await waitFor(() => claimed); await worker.stopped();
    const state = claimed.body.telemetry.state;
    assert.equal(state.controlRevision, control.revision);
    assert.equal(claimed.applied.revision, control.revision);
    assert.deepEqual(state.pacing, control.pacing);
    assert.deepEqual([claimed.settings.humanDelayMinSec, claimed.settings.humanDelayMaxSec], [control.pacing.minSeconds, control.pacing.maxSeconds]);
    assert.equal(state.observedAt, new Date(clock.now).toISOString());
    assert.equal(claimed.body.account.accountId, 'fixture-account');
    assert.equal(claimed.body.quote, undefined);
    assert.deepEqual(reports.map((state) => state.controlRevision), ['pace-1', 'pace-2']);
    assert.equal(worker.local.gatewayWorkerControl.revision, 'pace-3');
    assert.equal(worker.provider.filter(({ op }) => !['listImageModels', 'inspectAccount'].includes(op)).length, 0);
  } finally { worker.restore(); }
});

test('desired resume is acknowledged only after the actual stop and pacing readback changes', async () => {
  const control = offControl('before-resume', { minSeconds: 0, maxSeconds: 0 });
  const reports = [];
  let claimed = false;
  const worker = await boot({ control, job: null, onTelemetry: (body, local) => {
    reports.push(body.telemetry.state);
    assert.equal(body.telemetry.state.controlRevision, local.gatewayWorkerControl.revision);
    if (reports.length === 1) Object.assign(control, { dispatchEnabled: true, closeRequested: false, revision: 'applied-resume', requestedAt: 3, pacing: { minSeconds: 0.5, maxSeconds: 1 } });
  }, onClaim: (body) => { claimed = clone(body); } });
  try {
    worker.tick(); await waitFor(() => claimed); await worker.stopped();
    assert.equal(claimed.telemetry.state.controlRevision, 'applied-resume');
    assert.deepEqual(reports.map((state) => state.controlRevision), ['before-resume', 'applied-resume']);
    assert.equal(reports[0].paused, true);
    assert.equal(reports[0].enabled, false);
    assert.equal(reports[1].paused, false);
    assert.equal(reports[1].enabled, true);
    assert.deepEqual(reports[1].pacing, { minSeconds: 0.5, maxSeconds: 1 });
    assert.equal(worker.provider.filter(({ op }) => !['listImageModels', 'inspectAccount'].includes(op)).length, 0);
  } finally { worker.restore(); }
});

test('a server accountBinding and reservation never authorize work the extension did not quote', async () => {
  const worker = await boot({ claimEnvelope: { accountBinding: { provider: 'flow', accountId: 'server-only-account' },
    reservation: { payloadSha256: 'c'.repeat(64), value: 0, unit: 'credits' } } });
  try {
    worker.tick(); await waitFor(() => worker.local.lastStatus?.text.includes('without our exact price')); await worker.stopped();
    const body = JSON.parse(worker.calls.find(({ url }) => url.endsWith('/claim')).init.body);
    assert.equal(body.account.accountId, 'fixture-account');
    assert.equal(body.quote, undefined);
    assert.equal(worker.local.gatewayUnsettledClaim.jobId, undefined);
    assert.equal(worker.local.queue?.length || 0, 0);
    assert.equal(worker.provider.filter(({ op }) => !['listImageModels', 'inspectAccount'].includes(op)).length, 0);
    assert.equal(worker.calls.some(({ url }) => /\/admin\/|\/(result|fail)$/.test(url)), false, 'Worker never changes the app-only spending flag or settles an unobserved offer.');
  } finally { worker.restore(); }
});

test('a quoteRequired preview remains non-executable even if its executionAuthorized flag is incorrectly true', async () => {
  const worker = await boot({ quoteRequired: { job: JOB, payloadSha256: 'd'.repeat(64), executionAuthorized: true } });
  try {
    worker.tick(); await waitFor(() => worker.local.lastStatus?.text.includes('No credit price is set')); await worker.stopped();
    assert.equal(worker.local.gatewayUnsettledClaim, undefined);
    assert.equal(worker.local.queue?.length || 0, 0);
    assert.equal(worker.provider.filter(({ op }) => !['listImageModels', 'inspectAccount'].includes(op)).length, 0);
    assert.equal(worker.calls.filter(({ url }) => /\/(result|fail)$/.test(url)).length, 0);
  } finally { worker.restore(); }
});

test('close acknowledgement keeps unknown claims recovering across restart and never advertises a safe close', async () => {
  const clock = { now: 11_000_000 };
  const marker = { claimId: 'unknown-claim', jobId: JOB.jobId, at: clock.now - 1000 };
  const local = { gatewayConnection: clone(connection), imageGeneratorWorkMode: 'gateway', gatewayUnsettledClaim: clone(marker) };
  for (let restart = 0; restart < 2; restart++) {
    const worker = await boot({ local, clock, control: offControl('close-unknown', { minSeconds: 0, maxSeconds: 0 }) });
    try {
      worker.tick(); await waitFor(() => worker.calls.some(({ url }) => url.endsWith('/telemetry'))); await worker.stopped();
      const state = JSON.parse(worker.calls.find(({ url }) => url.endsWith('/telemetry')).init.body).telemetry.state;
      assert.equal(state.controlRevision, 'close-unknown');
      assert.equal(state.paused, true);
      assert.equal(state.activity, 'recovering');
      assert.equal(state.attention, true);
      assert.equal(Object.hasOwn(state, 'safeToClose'), false, 'Only Gateway can decide close eligibility.');
      assert.deepEqual(local.gatewayUnsettledClaim, marker);
      assert.equal(worker.workCalls.length, 0);
      assert.equal(worker.provider.length, 0);
    } finally { worker.restore(); }
  }
});

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
      assert.equal(first.workCalls.length, 0);
      assert.equal(first.provider.length, 0);
    } finally { first.restore(); }
    const restarted = await boot({ local, clock, job: null });
    try {
      restarted.tick(); await restarted.stopped();
      assert.equal(restarted.workCalls.length, 0);
      restarted.advance(9999); restarted.tick(); await restarted.stopped();
      assert.equal(restarted.workCalls.length, 0);
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
    assert.equal(worker.calls.filter(({ url }) => url.endsWith('/health')).length, 2, 'Busy workers still report stop/readiness telemetry.');
    assert.equal(worker.calls.filter(({ url }) => url.endsWith('/claim')).length, 0);
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
      assert.equal(worker.workCalls.length, 0);
      assert.equal(worker.provider.length, 0);
      assert.equal(local.gatewayUnsettledClaim.claimId, 'lost-response');
    } finally { worker.restore(); }
  }
});

test('fallback, empty, cached, unattributed or failed inventory never authorizes a Gateway claim or stale live cache', async () => {
  for (const inventory of [
    { source: 'fallback', entries: [{ id: 'NARWHAL', label: 'Nano Banana 2.1' }] },
    { entries: [{ id: 'NARWHAL', label: 'Nano Banana 2.1' }] },
    { source: 'cached', entries: [{ id: 'NARWHAL', label: 'Nano Banana 2.1' }] },
    { source: 'live', entries: [] },
    new Error('fixture inventory unavailable'),
  ]) {
    const worker = await boot({ inventory, local: { gatewayConnection: clone(connection), imageGeneratorWorkMode: 'gateway',
      flowImageModelInventory: { source: 'live', refreshedAt: 1, models: [{ modelId: 'STALE_MODEL', modelLabel: 'Old' }] } } });
    try {
      worker.tick();
      await waitFor(() => worker.local.lastStatus?.text.includes('no captured live inventory'));
      await worker.stopped();
      assert.equal(worker.workCalls.length, 0, 'No Gateway request, including claim, may rely on fallback.');
      assert.equal(worker.provider.filter(({ op }) => !['listImageModels', 'inspectAccount'].includes(op)).length, 0);
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
    assert.equal(worker.provider.filter(({ op }) => !['listImageModels', 'inspectAccount'].includes(op)).length, 0);
    assert.equal(worker.calls.filter(({ url }) => url.endsWith('/claim') || url.endsWith('/result')).length, 0);
    assert.equal(worker.calls.filter(({ url }) => url.endsWith('/fail')).length, 0);
    assert.equal(worker.local.queue[0].gatewayAcknowledged, false);
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
    assert.equal(worker.workCalls.length, 0);
    assert.equal(worker.downloads.length, 0);
    assert.equal(worker.provider.filter(({ op }) => !['listImageModels', 'inspectAccount'].includes(op)).length, 0);
  } finally { worker.restore(); }
});

test('local credential migration strips sync and does not activate a different mode', async () => {
  const worker = await boot({ local: { imageGeneratorWorkMode: 'standalone' }, synced: connection });
  try {
    assert.equal(worker.local.gatewayConnection.gatewayToken, connection.gatewayToken);
    for (const key of Object.keys(connection)) assert.equal(worker.sync.settings[key], undefined);
    worker.tick(); await worker.stopped();
    assert.equal(worker.workCalls.length, 0);
  } finally { worker.restore(); }
});

test('legacy pending Gateway work is held without touching retained references or generating without an exact quote', async () => {
  rows = new Map();
  const binding = await gatewayBinding(connection);
  const item = { ...imageGatewayJobToItem(JOB, {}), gatewayBinding: binding };
  const retained = { references: [{ base64: PNG, mime: 'image/png' }], binding };
  rows.set(JOB.jobId, clone(retained));
  const worker = await boot({ local: { gatewayConnection: clone(connection), imageGeneratorWorkMode: 'gateway', queue: [item] } });
  try {
    await waitFor(() => worker.local.queue[0].status === 'failed');
    await worker.stopped();
    assert.equal(worker.provider.length, 0);
    assert.equal(worker.workCalls.length, 0);
    assert.equal(worker.local.queue[0].gatewayAcknowledged, false);
    assert.deepEqual(rows.get(JOB.jobId), retained);
  } finally { worker.restore(); }
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
  try { second.tick(); await second.stopped(); assert.equal(second.workCalls.length, 0); }
  finally { second.restore(); }
});

test('an older completed row cannot settle a newer offered-job hold after restart', async () => {
  rows = new Map();
  const binding = await gatewayBinding(connection);
  const completed = { ...imageGatewayJobToItem(JOB, {}), gatewayBinding: binding, status: 'done', gatewayAcknowledged: true };
  const local = { gatewayConnection: clone(connection), imageGeneratorWorkMode: 'gateway', queue: [completed] };
  const first = await boot({ local });
  try {
    first.tick();
    await waitFor(() => local.lastStatus?.text.includes('without our exact price'));
    await first.stopped();
    assert.deepEqual(local.queue, [completed]);
    assert.equal(local.gatewayUnsettledClaim.jobId, undefined);
    assert.equal(first.provider.filter(({ op }) => !['listImageModels', 'inspectAccount'].includes(op)).length, 0);
  } finally { first.restore(); }
  const second = await boot({ local });
  try {
    second.tick(); await second.stopped();
    assert.equal(second.workCalls.length, 0);
    assert.equal(local.gatewayUnsettledClaim.jobId, undefined);
    assert.ok(local.gatewayUnsettledClaim.claimId);
    assert.deepEqual(local.queue, [completed]);
  } finally { second.restore(); }
});


test('restart settles only its exact enqueue receipt and holds legacy pending work without generation', async () => {
  rows = new Map();
  const binding = await gatewayBinding(connection), gatewayClaimId = 'fixture-claim';
  const item = { ...imageGatewayJobToItem(JOB, {}), gatewayBinding: binding, gatewayClaimId };
  const local = { gatewayConnection: clone(connection), imageGeneratorWorkMode: 'gateway',
    gatewayUnsettledClaim: { jobId: JOB.jobId, binding, claimId: gatewayClaimId }, queue: [item] };
  const worker = await boot({ local });
  try {
    await waitFor(() => local.queue[0].status === 'failed'); await worker.stopped();
    assert.equal(local.gatewayUnsettledClaim, undefined);
    assert.equal(local.queue[0].gatewayAcknowledged, false);
    assert.equal(worker.workCalls.length, 0);
    assert.equal(worker.provider.length, 0);
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
    assert.equal(worker.workCalls.length, 0);
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
    assert.equal(worker.workCalls.length, 0);
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
    flowModelApproval: { modelId: 'NARWHAL', modelLabel: 'Nano Banana 2.1', modelSource: 'fallback' } };
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
    assert.equal(worker.workCalls.length, 1);
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

test('an executable job offered without our own price is durably held, never submitted', async () => {
  const worker = await boot();
  try {
    worker.tick(); worker.tick();
    await waitFor(() => worker.local.lastStatus?.text.includes('without our exact price'));
    await worker.stopped();
    assert.equal(worker.local.gatewayUnsettledClaim.jobId, undefined);
    assert.ok(worker.local.gatewayUnsettledClaim.claimId);
    assert.equal(worker.local.queue?.length || 0, 0);
    assert.equal(worker.provider.filter(({ op }) => !['listImageModels', 'inspectAccount'].includes(op)).length, 0);
    assert.equal(worker.calls.filter(({ url }) => /\/(result|fail)$/.test(url)).length, 0);
    const claim = JSON.parse(worker.calls.find(({ url }) => url.endsWith('/claim')).init.body);
    assert.equal(claim.account.accountId, 'fixture-account');
    assert.equal(claim.quote, undefined);
  } finally { worker.restore(); }
});


test('retained result delivery survives invalid acknowledgements and a manager stop without regenerating', async () => {
  rows = new Map();
  const binding = await gatewayBinding(connection);
  rows.set(JOB.jobId, { bytes: Uint8Array.from(Buffer.from(PNG, 'base64')), mime: 'image/png', binding });
  const item = { ...imageGatewayJobToItem(JOB, {}), gatewayBinding: binding, status: 'running', providerAttempted: true };
  const control = { dispatchEnabled: false, closeRequested: true, revision: 'stop-held', requestedAt: 2, pacing: { minSeconds: 0, maxSeconds: 0 } };
  const local = { gatewayConnection: clone(connection), imageGeneratorWorkMode: 'gateway', queue: [item] };
  const worker = await boot({ local, control, resultAnswers: [{ ok: true, ignored: true }, {}, { ok: true }] });
  try {
    assert.equal(local.queue[0].status, 'failed');
    for (let i = 0; i < 2; i++) {
      assert.equal((await worker.send({ type: 'gateway:retryDelivery', id: item.id })).ok, false);
      assert.deepEqual(Buffer.from(rows.get(JOB.jobId).bytes), Buffer.from(PNG, 'base64'));
    }
    assert.equal((await worker.send({ type: 'gateway:retryDelivery', id: item.id })).ok, true);
    assert.equal(local.queue[0].gatewayAcknowledged, true);
    assert.equal(worker.provider.length, 0);
    assert.equal(rows.size, 0);
    assert.equal(local.gatewayWorkerControl.dispatchEnabled, false);
    for (const call of worker.calls.filter(({ url }) => url.endsWith('/result'))) assert.deepEqual(call.bytes, Buffer.from(PNG, 'base64'));
  } finally { worker.restore(); }
});


test('a persisted ambiguous Gateway submission stays held through pause, Resume and alarms', async () => {
  const binding = await gatewayBinding(connection);
  const item = { ...imageGatewayJobToItem(JOB, {}), gatewayBinding: binding, status: 'running', providerAttempted: true };
  const worker = await boot({ local: { gatewayConnection: clone(connection), imageGeneratorWorkMode: 'gateway', queue: [item] } });
  try {
    assert.equal(worker.local.queue[0].status, 'failed');
    await worker.send({ type: 'resumeQueue' });
    worker.tick(); await worker.stopped();
    assert.equal(worker.provider.length, 0);
    assert.equal(worker.workCalls.length, 0);
    assert.notEqual(worker.local.queue[0].gatewayAcknowledged, true);
  } finally { worker.restore(); }
});


test('a changed token cannot redirect retained image bytes or failures', async () => {
  rows = new Map();
  const binding = await gatewayBinding(connection);
  rows.set(JOB.jobId, { bytes: Uint8Array.from(Buffer.from(PNG, 'base64')), mime: 'image/png', binding });
  const item = { ...imageGatewayJobToItem(JOB, {}), gatewayBinding: binding, status: 'failed', gatewayAcknowledged: false };
  const worker = await boot({ local: { gatewayConnection: { ...connection, gatewayToken: 'rotated' }, imageGeneratorWorkMode: 'gateway', queue: [item] } });
  try {
    assert.equal((await worker.send({ type: 'gateway:retryDelivery', id: item.id })).ok, false);
    assert.ok(rows.get(JOB.jobId).bytes);
    assert.equal(worker.calls.filter(({ url }) => /\/(result|fail)$/.test(url)).length, 0);
    assert.equal(worker.provider.length, 0);
  } finally { worker.restore(); }
});


test('Story/standalone or disabled mode never claims; schema rejection never invokes provider', async () => {
  for (const mode of ['studio', 'standalone']) {
    const worker = await boot({ mode });
    try { worker.tick(); await worker.stopped(); assert.equal(worker.workCalls.length, 0); assert.equal(worker.provider.length, 0); }
    finally { worker.restore(); }
  }
  const disabled = await boot({ local: { gatewayConnection: { ...connection, gatewayModeEnabled: false }, imageGeneratorWorkMode: 'gateway' } });
  try { disabled.tick(); await disabled.stopped(); assert.equal(disabled.workCalls.length, 0); } finally { disabled.restore(); }
  const invalid = await boot({ job: { ...JOB, referenceImages: [{ mediaType: 'image/png', dataBase64: 'AAAA' }] } });
  try {
    invalid.tick();
    await waitFor(() => invalid.local.lastStatus?.text.includes('without our exact price'));
    await invalid.stopped();
    assert.equal(invalid.provider.filter(({ op }) => !['listImageModels', 'inspectAccount'].includes(op)).length, 0);
    assert.equal(invalid.calls.filter(({ url }) => url.endsWith('/fail')).length, 0);
  } finally { invalid.restore(); }
});

test('a cleared Gateway address never blocks the manual queue', async () => {
  const binding = await gatewayBinding(connection);
  const worker = await boot({ mode: 'standalone', local: {
    gatewayConnection: { ...connection, gatewayUrl: '' },
    imageGeneratorWorkMode: 'standalone',
    gatewayWorkerControl: { binding, dispatchEnabled: false, closeRequested: false },
  }, synced: { flowProjectId: JOB.flowProjectId } });
  try {
    await worker.send({ type: 'enqueueStandalone', payload: { prompt: JOB.prompt, provider: 'flow' } });
    await waitFor(() => worker.local.queue?.[0]?.status === 'done');
    await worker.stopped();
    assert.equal(worker.downloads.length, 1);
  } finally { worker.restore(); }
});
