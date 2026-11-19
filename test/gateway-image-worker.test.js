import test from 'node:test';
import assert from 'node:assert/strict';
import { claimMarkerIsStale, gatewayBinding, imageGatewayJobToItem, normalizeImageGatewayJob } from '../src/lib/gateway-worker.js';
import { assertQueuedModelIdentity } from '../src/lib/model-identity.js';
import { canRetryItem, isUnsupportedQueueItem, recoverInterruptedQueue } from '../src/lib/queue-migration.js';
import { enqueueItems } from '../src/lib/queue-operations.js';
import { claimImageJob, reportImageFailure, reportImageResult, reportImageTelemetry, testImageGateway } from '../src/lib/gateway-client.js';

export const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9ZkAAAAASUVORK5CYII=';
export const JOB = { jobId: 'image/a', kind: 'image', provider: 'flow', prompt: 'A quiet village.', modelKey: 'nano-banana-2', aspectRatio: '16:9', flowProjectId: '5852b0c6-e4a4-455a-8215-5513c208c29d' };
const connection = { gatewayUrl: 'http://gateway.invalid', gatewayToken: 'fixture-token', gatewayWorkerId: 'fixture-image' };

test('strict captured model, ratio and reference validation; actual queue identity', () => {
  const item = imageGatewayJobToItem({ ...JOB, referenceImages: [{ mediaType: 'image/png', dataBase64: PNG }] }, {});
  assertQueuedModelIdentity(item, 'flow');
  assert.equal(item.prompt, JOB.prompt);
  assert.equal(item.modelSnapshot.modelId, 'BELUGA');
  assert.equal(item.gatewayReferenceCount, 1);
  assert.equal(item.references, undefined);
  assert.equal(isUnsupportedQueueItem(item), false);
  assert.equal(isUnsupportedQueueItem({ source: 'prompts', kind: 'scene', target: 'project' }), true);
  for (const patch of [{ kind: 'video' }, { modelKey: 'invented' }, { provider: 'chatgpt' }, { aspectRatio: '' }, { aspectRatio: '2:1' }, { aspectRatio: '21:9' },
    { aspectRatio: '4:3' }, { aspectRatio: '1:1' }, { aspectRatio: '3:4' },
    { count: 3 }, { count: 0 }, { size: '1024x1024' }, { referenceImages: null }, { referenceImages: [{ mediaType: 'image/png', dataBase64: 'AAAA' }] }, { prompt: 42 }]) {
    assert.throws(() => normalizeImageGatewayJob({ ...JOB, ...patch }));
  }
  // Only the ratios with a real submit behind them, plus the three observed counts.
  for (const aspectRatio of ['16:9', '9:16']) {
    assert.equal(normalizeImageGatewayJob({ ...JOB, aspectRatio }).aspectRatio, aspectRatio);
  }
  for (const count of [1, 2, 4]) {
    const item = imageGatewayJobToItem({ ...JOB, count }, {});
    assert.equal(item.generationSettings.count, count);
  }
  assert.equal(normalizeImageGatewayJob(JOB).count, 1);
  assert.throws(() => imageGatewayJobToItem({ ...JOB, flowProjectId: '' }, {}));
});

test('Gateway holds cannot be retried, truncated or replaced by ordinary enqueue', () => {
  const item = { ...imageGatewayJobToItem(JOB, {}), status: 'running' };
  const held = recoverInterruptedQueue([item])[0];
  assert.equal(held.status, 'failed');
  assert.equal(held.failure.code, 'gateway-held');
  assert.equal(canRetryItem(held), false);
  const history = Array.from({ length: 130 }, (_, i) => ({ id: String(i), status: 'failed' }));
  const next = enqueueItems([held, ...history], [{ id: 'local', source: 'standalone', prompt: 'new', target: 'download' }]);
  assert.ok(next.queue.some((entry) => entry.id === item.id));
});

test('binding includes token rotation and contains no credential text', async () => {
  const hash = await gatewayBinding(connection);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.notEqual(hash, await gatewayBinding({ ...connection, gatewayToken: 'rotated' }));
  assert.equal(hash, await gatewayBinding({ ...connection, gatewayUrl: connection.gatewayUrl + '/' }));
});

test('telemetry and read-only quote previews retain exact control envelopes without adding account or credits', async () => {
  const original = globalThis.fetch, calls = [];
  const control = { dispatchEnabled: false, closeRequested: true, revision: 'wire-stop', requestedAt: 1, pacing: { minSeconds: 0, maxSeconds: 0 } };
  const telemetry = { state: { paused: true, controlRevision: control.revision, source: 'image.worker', observedAt: '2026-11-11T01:00:00Z' } };
  let answer = { ok: true, receivedAt: 1, control };
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return Response.json(answer); };
  try {
    assert.deepEqual((await reportImageTelemetry(connection, telemetry)).control, control);
    assert.deepEqual(JSON.parse(calls[0].init.body), { workerId: connection.gatewayWorkerId, kind: 'image', telemetry });
    assert.equal(calls[0].init.credentials, 'omit');
    answer = { job: null, quoteRequired: { job: JOB, payloadSha256: 'b'.repeat(64), executionAuthorized: false }, control };
    assert.deepEqual(await claimImageJob(connection, telemetry), answer);
    assert.deepEqual(JSON.parse(calls[1].init.body), { workerId: connection.gatewayWorkerId, kind: 'image', telemetry });
  } finally { globalThis.fetch = original; }
});

test('actual transport uses claim envelope and encoded job route; strict acknowledgements', async () => {
  const original = globalThis.fetch;
  const calls = [];
  let answer = { job: JOB };
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return Response.json(answer); };
  try {
    assert.deepEqual(await claimImageJob(connection), { job: JOB });
    assert.deepEqual(JSON.parse(calls[0].init.body), { workerId: connection.gatewayWorkerId, kind: 'image' });
    answer = { ok: true };
    await reportImageFailure(connection, JOB.jobId, 'fixture');
    assert.ok(calls[1].url.endsWith('/api/workers/jobs/image%2Fa/fail'));
    assert.equal(JSON.parse(calls[1].init.body).ambiguous, true);
    for (answer of [{}, { ok: true, ignored: true }, { ok: 'true' }]) {
      await assert.rejects(reportImageResult(connection, JOB.jobId, Buffer.from(PNG, 'base64'), 'image/png'), /did not accept/);
    }
    answer = { ok: true, kind: 'image', workerId: connection.gatewayWorkerId, maxResultBytes: 1024 };
    assert.equal((await testImageGateway(connection)).maxResultBytes, 1024);
    answer = { ok: true, kind: 'image', maxResultBytes: 1024 };
    await assert.rejects(testImageGateway(connection), /does not match/);
    assert.equal(calls[0].init.redirect, 'error');
  } finally { globalThis.fetch = original; }
});

test('an unsettled claim marker expires on Gateway\'s lease, never on a person', () => {
  const now = 1_800_000_000_000;
  const marker = { binding: 'b', claimId: 'c', at: now - 60_000 };
  // Inside the advertised lease: still a real hold, so a second claim is refused.
  assert.equal(claimMarkerIsStale(marker, 600, now), false);
  // Past the lease (plus the settle window): Gateway has already let the job go.
  assert.equal(claimMarkerIsStale({ ...marker, at: now - 700_000 }, 600, now), true);
  // A lease Gateway did not state is never treated as expired on a guess.
  assert.equal(claimMarkerIsStale({ ...marker, at: now - 10 * 24 * 3600_000 }, undefined, now), false);
  assert.equal(claimMarkerIsStale({ ...marker, at: now - 10 * 24 * 3600_000 }, null, now), false);
  // A short lease Gateway really advertised does expire, and the 30 s settle window is honoured:
  // 90 + 30 = 120 s, so 119 s is still held and 121 s has expired.
  assert.equal(claimMarkerIsStale({ ...marker, at: now - 119_000 }, 90, now), false);
  assert.equal(claimMarkerIsStale({ ...marker, at: now - 121_000 }, 90, now), true);
  // A marker with no usable time cannot be proven old, so the rule never guesses it stale; the
  // caller stamps one on first sight (`liveClaimMarker`), which bounds it to one lease from then.
  assert.equal(claimMarkerIsStale({ binding: 'b' }, 600, now), false);
  assert.equal(claimMarkerIsStale(null, 600, now), false);
});
