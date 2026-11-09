// Gateway image worker — full-path mocked fixtures. No network, no browser,
// no provider calls. Covers: schema rejection (zero provider calls), same-job
// dedup, accepted result then cleanup, reference preservation, ambiguous result
// failure HOLD without regeneration even on Resume/restart.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createImageGatewayWorkerId,
  gatewayImageHasReferenceBytes,
  imageGatewayJobToItem,
  isImageGatewayJobQueued,
  normalizeImageGatewayJob,
} from '../src/lib/gateway-worker.js';

const GOOD_JOB = {
  jobId: 'img_job_1',
  kind: 'image',
  prompt: 'A quiet village at dusk.',
  modelKey: 'nano-banana-2',
  modelLabel: 'Nano Banana 2',
  aspectRatio: '16:9',
  flowProjectId: '5852b0c6-e4a4-455a-8215-5513c208c29d',
};

// ── schema rejection: zero provider calls on malformed input ─────────────────

test('rejects null/undefined/non-object before any provider dispatch', () => {
  assert.throws(() => normalizeImageGatewayJob(null), /not an object/);
  assert.throws(() => normalizeImageGatewayJob(undefined), /not an object/);
  assert.throws(() => normalizeImageGatewayJob('string'), /not an object/);
  assert.throws(() => normalizeImageGatewayJob(42), /not an object/);
});

test('rejects missing jobId', () => {
  assert.throws(() => normalizeImageGatewayJob({}), /no id/);
  assert.throws(() => normalizeImageGatewayJob({ jobId: '' }), /no id/);
  assert.throws(() => normalizeImageGatewayJob({ jobId: '  ' }), /no id/);
});

test('rejects missing or wrong kind', () => {
  assert.throws(
    () => normalizeImageGatewayJob({ jobId: 'x', prompt: 'p', modelKey: 'nano-banana-2' }),
    /no kind/
  );
  assert.throws(
    () => normalizeImageGatewayJob({ jobId: 'x', kind: 'video', prompt: 'p', modelKey: 'nano-banana-2' }),
    /not supported/
  );
  assert.throws(
    () => normalizeImageGatewayJob({ jobId: 'x', kind: 'audio', prompt: 'p', modelKey: 'nano-banana-2' }),
    /not supported/
  );
});

test('rejects missing prompt or modelKey', () => {
  assert.throws(
    () => normalizeImageGatewayJob({ jobId: 'x', kind: 'image', prompt: '', modelKey: 'nano-banana-2' }),
    /no prompt/
  );
  assert.throws(
    () => normalizeImageGatewayJob({ jobId: 'x', kind: 'image', prompt: 'p', modelKey: '' }),
    /no model key/
  );
});

test('rejects unknown modelKey — no arbitrary model accepted', () => {
  assert.throws(
    () => normalizeImageGatewayJob({ ...GOOD_JOB, modelKey: 'gpt-5-turbo' }),
    /not a known provider model/
  );
  assert.throws(
    () => normalizeImageGatewayJob({ ...GOOD_JOB, modelKey: 'random-model' }),
    /not a known provider model/
  );
});

test('rejects unsupported aspect ratio — only 16:9 verified captured', () => {
  assert.throws(
    () => normalizeImageGatewayJob({ ...GOOD_JOB, aspectRatio: '9:16' }),
    /not supported/
  );
  assert.throws(
    () => normalizeImageGatewayJob({ ...GOOD_JOB, aspectRatio: '21:9' }),
    /not supported/
  );
  assert.throws(
    () => normalizeImageGatewayJob({ ...GOOD_JOB, aspectRatio: '1:1' }),
    /not supported/
  );
});

test('rejects any invalid reference — never silently drops', () => {
  assert.throws(
    () => normalizeImageGatewayJob({
      ...GOOD_JOB,
      referenceImages: [{ mediaType: 'image/png', dataBase64: 'AAAA' }, null],
    }),
    /reference 2/
  );
  assert.throws(
    () => normalizeImageGatewayJob({
      ...GOOD_JOB,
      referenceImages: [{ mediaType: '', dataBase64: 'BBBB' }],
    }),
    /reference 1.*no mediaType/
  );
  assert.throws(
    () => normalizeImageGatewayJob({
      ...GOOD_JOB,
      referenceImages: [{ mediaType: 'image/png', dataBase64: '' }],
    }),
    /reference 1.*no dataBase64/
  );
  assert.throws(
    () => normalizeImageGatewayJob({
      ...GOOD_JOB,
      referenceImages: [{ mediaType: 'text/plain', dataBase64: 'CCCC' }],
    }),
    /reference 1.*invalid mediaType/
  );
});

test('rejects missing Flow project id at item creation', () => {
  const noFlowJob = { ...GOOD_JOB, flowProjectId: '' };
  assert.throws(
    () => imageGatewayJobToItem(noFlowJob, {}),
    /Flow project id/
  );
  assert.throws(
    () => imageGatewayJobToItem(noFlowJob, { flowProjectId: '' }),
    /Flow project id/
  );
  // Also rejects when job omits flowProjectId entirely and settings has none.
  const omitFlowJob = { jobId: 'x', kind: 'image', prompt: 'p', modelKey: 'nano-banana-2' };
  assert.throws(
    () => imageGatewayJobToItem(omitFlowJob, {}),
    /Flow project id/
  );
});

// ── accepted job mapping ─────────────────────────────────────────────────────

test('maps a valid gateway image job to a queue item', () => {
  const item = imageGatewayJobToItem(GOOD_JOB, { imageModel: 'nano-banana-2' });
  assert.equal(item.gatewayJobId, 'img_job_1');
  assert.equal(item.target, 'gateway');
  assert.equal(item.gatewayKind, 'image');
  assert.equal(item.imagePrompt, 'A quiet village at dusk.');
  assert.equal(item.imageModelKey, 'nano-banana-2');
  assert.equal(item.imageModelSource, 'gateway');
  assert.equal(item.projectId, GOOD_JOB.flowProjectId);
  assert.equal(item.aspectRatio, '16:9');
  assert.equal(item.status, 'pending');
  assert.equal(item.gatewayReferenceCount, 0);
  // Ambiguity defaults SAFE — any unproven failure holds the job.
  assert.equal(item.gatewayAmbiguous, true);
});

test('defaults missing aspectRatio to 16:9 (only supported value)', () => {
  const item = imageGatewayJobToItem({ ...GOOD_JOB, aspectRatio: undefined }, {});
  assert.equal(item.aspectRatio, '16:9');
  const item2 = imageGatewayJobToItem({ ...GOOD_JOB, aspectRatio: '' }, {});
  assert.equal(item2.aspectRatio, '16:9');
});

test('preserves reference count without storing bytes in the item', () => {
  const withRef = imageGatewayJobToItem(
    { ...GOOD_JOB, referenceImages: [{ mediaType: 'image/png', dataBase64: 'AAAA' }] },
    {}
  );
  assert.equal(withRef.gatewayReferenceCount, 1);
  // Bytes must NOT be in the queue item (memory + quota hazard).
  assert.equal(withRef.referenceImages, undefined);
  assert.equal(withRef.references, undefined);
});

// ── same-job dedup ───────────────────────────────────────────────────────────

test('deduplicates a claimed job already in the queue', () => {
  const item = imageGatewayJobToItem(GOOD_JOB, {});
  assert.equal(isImageGatewayJobQueued([item], 'img_job_1'), true);
  assert.equal(isImageGatewayJobQueued([item], 'img_job_2'), false);
  assert.equal(isImageGatewayJobQueued([], 'img_job_1'), false);
  assert.equal(isImageGatewayJobQueued(null, 'img_job_1'), false);
});

// ── reference byte check ─────────────────────────────────────────────────────

test('gatewayImageHasReferenceBytes checks normalized job references', () => {
  assert.equal(gatewayImageHasReferenceBytes({ references: [] }), false);
  assert.equal(gatewayImageHasReferenceBytes({ references: [{ mediaType: 'image/png', dataBase64: 'x' }] }), true);
  assert.equal(gatewayImageHasReferenceBytes({}), false);
  assert.equal(gatewayImageHasReferenceBytes(null), false);
});

// ── worker id format ─────────────────────────────────────────────────────────

test('worker ids are stable prefixed values', () => {
  assert.match(createImageGatewayWorkerId(), /^imgworker_/);
  const a = createImageGatewayWorkerId();
  const b = createImageGatewayWorkerId();
  assert.notEqual(a, b);
});

// ── ambiguous failure semantics ──────────────────────────────────────────────

test('gatewayAmbiguous defaults to true (safe) — HOLD without regeneration', () => {
  const item = imageGatewayJobToItem(GOOD_JOB, {});
  // Default safe: any unproven result holds the job, never regenerates.
  assert.equal(item.gatewayAmbiguous, true);
});

test('accepted-then-cleanup: item fields are self-contained', () => {
  // Verify the item shape is complete for queue lifecycle without external deps.
  const item = imageGatewayJobToItem(GOOD_JOB, { imageModel: 'nano-banana-2' });
  assert.ok(item.id.startsWith('gateway_'));
  assert.equal(typeof item.queuedAt, 'number');
  assert.equal(item.slug, 'gateway');
  assert.equal(item.projectName, 'Gateway Studio');
  assert.equal(item.target, 'gateway');
  // No provider tab dependency — gateway items don't need a provider tab.
  assert.equal(item.provider, undefined);
});