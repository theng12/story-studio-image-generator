// Gateway image worker — deterministic offline fixtures only. No network, no
// browser, no provider calls. Validates schema rejection and queue mapping.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createImageGatewayWorkerId,
  gatewayImageHasReferenceBytes,
  imageGatewayJobToItem,
  isImageGatewayJobQueued,
  normalizeImageGatewayJob,
} from '../src/lib/gateway-worker.js';

const JOB = {
  jobId: 'img_job_1',
  kind: 'image',
  prompt: 'A quiet village at dusk.',
  modelKey: 'nano-banana-2',
  modelLabel: 'Nano Banana 2',
  aspectRatio: '16:9',
  flowProjectId: '5852b0c6-e4a4-455a-8215-5513c208c29d',
};

test('maps a gateway image job to an ordinary queue item', () => {
  const item = imageGatewayJobToItem(JOB, { imageModel: 'nano-banana-2' });
  assert.equal(item.gatewayJobId, 'img_job_1');
  assert.equal(item.target, 'gateway');
  assert.equal(item.gatewayKind, 'image');
  assert.equal(item.imagePrompt, 'A quiet village at dusk.');
  assert.equal(item.imageModelKey, 'nano-banana-2');
  assert.equal(item.imageModelLabel, 'Nano Banana 2');
  assert.equal(item.imageModelSource, 'gateway');
  assert.equal(item.projectId, JOB.flowProjectId);
  assert.equal(item.aspectRatio, '16:9');
  assert.equal(item.status, 'pending');
  assert.equal(item.gatewayReferenceCount, 0);
});

test('preserves reference count without storing bytes in the item', () => {
  const withRef = imageGatewayJobToItem(
    { ...JOB, referenceImages: [{ mediaType: 'image/png', dataBase64: 'AAAA' }] },
    {}
  );
  assert.equal(withRef.gatewayReferenceCount, 1);
  assert.equal(withRef.imagePrompt, JOB.prompt);
  // Bytes must NOT be in the queue item (memory + quota hazard).
  assert.equal(withRef.referenceImages, undefined);
  assert.equal(withRef.references, undefined);
});

test('rejects malformed jobs before provider invocation', () => {
  assert.throws(() => normalizeImageGatewayJob(null), /not an object/);
  assert.throws(() => normalizeImageGatewayJob({}), /no id/);
  assert.throws(
    () => normalizeImageGatewayJob({ jobId: 'x', kind: 'video', prompt: 'p', modelKey: 'm' }),
    /not supported/
  );
  assert.throws(
    () => normalizeImageGatewayJob({ jobId: 'x', kind: 'image', prompt: '', modelKey: 'm' }),
    /no prompt/
  );
  assert.throws(
    () => normalizeImageGatewayJob({ jobId: 'x', kind: 'image', prompt: 'p', modelKey: '' }),
    /no model key/
  );
  assert.throws(
    () => imageGatewayJobToItem({ ...JOB, flowProjectId: '' }, {}),
    /Flow project id/
  );
});

test('drops invalid reference entries silently', () => {
  const normalized = normalizeImageGatewayJob({
    ...JOB,
    referenceImages: [
      { mediaType: 'image/png', dataBase64: 'AAAA' },
      { mediaType: '', dataBase64: 'BBBB' },
      { mediaType: 'image/png', dataBase64: '' },
      null,
      { mediaType: 'text/plain', dataBase64: 'CCCC' },
    ],
  });
  assert.equal(normalized.references.length, 1);
  assert.equal(normalized.references[0].mediaType, 'image/png');
});

test('defaults aspect ratio to 16:9 when unknown', () => {
  const normalized = normalizeImageGatewayJob({ ...JOB, aspectRatio: '21:9' });
  assert.equal(normalized.aspectRatio, '16:9');
});

test('deduplicates a claimed job that is already queued', () => {
  const item = imageGatewayJobToItem(JOB, {});
  assert.equal(isImageGatewayJobQueued([item], 'img_job_1'), true);
  assert.equal(isImageGatewayJobQueued([item], 'img_job_2'), false);
  assert.equal(isImageGatewayJobQueued([], 'img_job_1'), false);
});

test('worker ids are stable, prefixed values', () => {
  assert.match(createImageGatewayWorkerId(), /^imgworker_/);
});

test('reference byte check does not read base64 content', () => {
  assert.equal(gatewayImageHasReferenceBytes({ references: [] }), false);
  assert.equal(gatewayImageHasReferenceBytes({ references: [{ mediaType: 'image/png', dataBase64: 'x' }] }), true);
  assert.equal(gatewayImageHasReferenceBytes({}), false);
  assert.equal(gatewayImageHasReferenceBytes(null), false);
});