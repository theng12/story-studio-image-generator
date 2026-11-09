import test from 'node:test';
import assert from 'node:assert/strict';
import { gatewayBinding, imageGatewayJobToItem, normalizeImageGatewayJob } from '../src/lib/gateway-worker.js';
import { assertQueuedModelIdentity } from '../src/lib/model-identity.js';
import { canRetryItem, isUnsupportedProjectScene, recoverInterruptedQueue } from '../src/lib/queue-migration.js';
import { enqueueItems } from '../src/lib/queue-operations.js';
import { claimImageJob, reportImageFailure, reportImageResult, testImageGateway } from '../src/lib/gateway-client.js';

export const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9ZkAAAAASUVORK5CYII=';
export const JOB = { jobId: 'image/a', kind: 'image', provider: 'flow', prompt: 'A quiet village.', modelKey: 'nano-banana-2', aspectRatio: '16:9', flowProjectId: '5852b0c6-e4a4-455a-8215-5513c208c29d' };
const connection = { gatewayUrl: 'http://gateway.invalid', gatewayToken: 'fixture-token', gatewayWorkerId: 'fixture-image' };

test('strict captured model, ratio and reference validation; actual queue identity', () => {
  const item = imageGatewayJobToItem({ ...JOB, referenceImages: [{ mediaType: 'image/png', dataBase64: PNG }] }, {});
  assertQueuedModelIdentity(item, 'flow');
  assert.equal(item.prompt, JOB.prompt);
  assert.equal(item.modelSnapshot.modelId, 'NARWHAL');
  assert.equal(item.gatewayReferenceCount, 1);
  assert.equal(item.references, undefined);
  assert.equal(isUnsupportedProjectScene(item), false);
  assert.equal(isUnsupportedProjectScene({ source: 'prompts', kind: 'scene', target: 'project' }), true);
  for (const patch of [{ kind: 'video' }, { modelKey: 'invented' }, { provider: 'chatgpt' }, { aspectRatio: '' }, { aspectRatio: '9:16' }, { referenceImages: null }, { referenceImages: [{ mediaType: 'image/png', dataBase64: 'AAAA' }] }, { prompt: 42 }]) {
    assert.throws(() => normalizeImageGatewayJob({ ...JOB, ...patch }));
  }
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

test('actual transport uses claim envelope and encoded job route; strict acknowledgements', async () => {
  const original = globalThis.fetch;
  const calls = [];
  let answer = { job: JOB };
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return Response.json(answer); };
  try {
    assert.deepEqual(await claimImageJob(connection), JOB);
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
