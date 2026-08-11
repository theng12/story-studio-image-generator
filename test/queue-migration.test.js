import assert from 'node:assert/strict';
import test from 'node:test';

import { canRetryItem, migrateQueue } from '../src/lib/queue-migration.js';

const NOW = 1_723_000_000_000;

test('fails pending and running work for retired providers without changing retained history', () => {
  const queue = [
    { id: 'grok-pending', provider: 'grok', kind: 'scene', source: 'plan', status: 'pending' },
    { id: 'piclumen-running', provider: 'piclumen', kind: 'scene', source: 'plan', status: 'running', startedAt: NOW - 2000 },
    { id: 'grok-done', provider: 'grok', status: 'done', savedAs: 'kept.png' },
    { id: 'grok-failed', provider: 'grok', status: 'failed', failure: { code: 'quota' } },
    { id: 'flow-running', provider: 'flow', kind: 'scene', source: 'plan', status: 'running', startedAt: NOW - 1000 },
  ];

  const migrated = migrateQueue(queue, NOW);

  assert.equal(migrated[0].status, 'failed');
  assert.equal(migrated[0].failure.code, 'provider-removed');
  assert.equal(migrated[0].fleetRetrySafe, false);
  assert.equal(migrated[0].finishedAt, NOW);
  assert.equal(migrated[1].status, 'failed');
  assert.equal(migrated[1].failure.code, 'provider-removed');
  assert.deepEqual(migrated[2], queue[2]);
  assert.deepEqual(migrated[3], queue[3]);
  assert.deepEqual(migrated[4], queue[4]);
  assert.deepEqual(queue[0], { id: 'grok-pending', provider: 'grok', kind: 'scene', source: 'plan', status: 'pending' });
});

test('preserves legacy provider-less items and is idempotent', () => {
  const queue = [
    { id: 'legacy', kind: 'scene', source: 'plan', status: 'pending' },
    { id: 'freegen', provider: 'freegen', kind: 'scene', source: 'plan', status: 'pending' },
  ];

  const once = migrateQueue(queue, NOW);
  const twice = migrateQueue(once, NOW + 1);

  assert.deepEqual(once[0], queue[0]);
  assert.deepEqual(twice, once);
});

test('defaults only an absent legacy provider and fails every explicit invalid provider idempotently', () => {
  const queue = [
    { id: 'legacy', kind: 'scene', source: 'plan', status: 'pending' },
    { id: 'empty', provider: '', kind: 'scene', source: 'plan', status: 'pending' },
    { id: 'null', provider: null, kind: 'scene', source: 'plan', status: 'running', startedAt: NOW - 500 },
    { id: 'false', provider: false, kind: 'scene', source: 'plan', status: 'pending' },
    { id: 'unknown', provider: 'not-installed', kind: 'scene', source: 'plan', status: 'pending' },
  ];

  const once = migrateQueue(queue, NOW);
  const twice = migrateQueue(once, NOW + 1);

  assert.deepEqual(once[0], queue[0]);
  for (const item of once.slice(1)) {
    assert.equal(item.status, 'failed');
    assert.equal(item.failure.code, 'provider-removed');
    assert.equal(item.fleetRetrySafe, false);
    assert.equal(canRetryItem(item), false);
  }
  assert.deepEqual(twice, once);
});

test('rejects local retries for removed or unknown provider queue items', () => {
  assert.equal(canRetryItem({ provider: 'flow', kind: 'scene', source: 'plan', status: 'failed' }), true);
  assert.equal(canRetryItem({ kind: 'scene', source: 'plan', status: 'failed' }), true);
  assert.equal(canRetryItem({ provider: '', kind: 'scene', source: 'plan', status: 'failed' }), false);
  assert.equal(canRetryItem({ provider: null, kind: 'scene', source: 'plan', status: 'failed' }), false);
  assert.equal(canRetryItem({ provider: false, kind: 'scene', source: 'plan', status: 'failed' }), false);
  assert.equal(canRetryItem({ provider: 'grok', kind: 'scene', source: 'plan', status: 'failed', failure: { code: 'provider-removed' } }), false);
  assert.equal(canRetryItem({ provider: 'unknown', kind: 'scene', source: 'plan', status: 'failed' }), false);
  assert.equal(canRetryItem({ provider: 'flow', kind: 'scene', source: 'plan', status: 'done' }), false);
});

test('migrates a legacy character reference into one descriptor without changing completed history', () => {
  const queue = [
    { id: 'legacy-pending', slug: 'project', status: 'pending', characterRef: { characterId: 'aria', filename: 'sheet.png' } },
    { id: 'legacy-done', slug: 'project', status: 'done', characterRef: { characterId: 'aria', filename: 'sheet.png' } },
  ];

  const migrated = migrateQueue(queue, NOW);

  assert.deepEqual(migrated[0].referenceDescriptors, [{
    source: 'character',
    label: 'Character reference: aria',
    url: '/api/projects/project/characters/aria/reference-image/sheet.png',
    characterId: 'aria',
    filename: 'sheet.png',
  }]);
  assert.equal(migrated[0].characterRef, undefined);
  assert.deepEqual(migrated[1], queue[1]);
  assert.deepEqual(queue[0].characterRef, { characterId: 'aria', filename: 'sheet.png' });
});

test('migrates retryable failed maintained-provider character references without changing failure history', () => {
  const queue = [{
    id: 'legacy-failed',
    slug: 'project',
    provider: 'flow',
    target: 'project',
    kind: 'scene',
    source: 'plan',
    status: 'failed',
    characterRef: { characterId: 'aria', filename: 'sheet.png' },
    failure: { code: 'network', title: 'Network error' },
    error: 'Network failed',
    finishedAt: NOW,
  }];

  const migrated = migrateQueue(queue, NOW + 1);

  assert.equal(migrated[0].status, 'failed');
  assert.deepEqual(migrated[0].failure, queue[0].failure);
  assert.equal(migrated[0].error, queue[0].error);
  assert.equal(migrated[0].referenceDescriptors[0].characterId, 'aria');
  assert.equal(migrated[0].characterRef, undefined);
});

test('terminalizes active non-plan project scenes without changing allowed jobs or done history', () => {
  const queue = [
    { id: 'prompt-pending', provider: 'flow', target: 'project', kind: 'scene', source: 'prompts', status: 'pending' },
    { id: 'legacy-running', provider: 'qwen', target: 'project', kind: 'scene', source: 'legacy', status: 'running', startedAt: NOW - 250 },
    { id: 'missing-source', provider: 'chatgpt', target: 'project', kind: 'scene', status: 'pending' },
    { id: 'plan', provider: 'flow', target: 'project', kind: 'scene', source: 'plan', status: 'pending' },
    { id: 'thumbnail', provider: 'flow', target: 'project', kind: 'thumbnail', source: 'prompts', status: 'pending' },
    { id: 'standalone', provider: 'flow', target: 'download', kind: 'scene', source: 'prompts', status: 'pending' },
    { id: 'done-history', provider: 'flow', target: 'project', kind: 'scene', source: 'prompts', status: 'done', savedAs: 'legacy.png' },
  ];

  const migrated = migrateQueue(queue, NOW);

  for (const item of migrated.slice(0, 3)) {
    assert.equal(item.status, 'failed');
    assert.equal(item.failure.code, 'scene-source-retired');
    assert.match(item.failure.hint, /create or load a Scene Plan/i);
    assert.equal(item.fleetRetrySafe, false);
    assert.equal(item.finishedAt, NOW);
  }
  assert.equal(migrated[1].durationMs, 250);
  assert.deepEqual(migrated.slice(3), queue.slice(3));
});

test('legacy failed non-plan project scenes cannot retry and migration is idempotent', () => {
  const queue = [{
    id: 'legacy-failed',
    provider: 'flow',
    target: 'project',
    kind: 'scene',
    source: 'prompts',
    status: 'failed',
    failure: { code: 'network' },
  }];

  assert.equal(canRetryItem(queue[0]), false);
  const once = migrateQueue(queue, NOW);
  assert.deepEqual(migrateQueue(once, NOW + 1), once);
});

test('terminalizes legacy non-download scenes with omitted, null, or empty targets', () => {
  const queue = [
    { id: 'omitted-prompt', provider: 'flow', kind: 'scene', source: 'prompts', status: 'pending' },
    { id: 'null-prompt', provider: 'qwen', target: null, kind: 'scene', source: 'prompts', status: 'running', startedAt: NOW - 100 },
    { id: 'empty-missing-source', provider: 'chatgpt', target: '', kind: 'scene', status: 'pending' },
    { id: 'omitted-target-source', provider: 'aistudio', kind: 'scene', status: 'running', startedAt: NOW - 200 },
    { id: 'omitted-plan', provider: 'flow', kind: 'scene', source: 'plan', status: 'pending' },
    { id: 'omitted-thumbnail', provider: 'flow', kind: 'thumbnail', source: 'prompts', status: 'pending' },
    { id: 'download-prompt', provider: 'flow', target: 'download', kind: 'scene', source: 'prompts', status: 'pending' },
    { id: 'download-missing-source', provider: 'flow', target: 'download', kind: 'scene', status: 'pending' },
  ];

  const once = migrateQueue(queue, NOW);

  for (const item of once.slice(0, 4)) {
    assert.equal(item.status, 'failed');
    assert.equal(item.failure.code, 'scene-source-retired');
    assert.equal(item.fleetRetrySafe, false);
    assert.equal(item.finishedAt, NOW);
  }
  assert.deepEqual(once.slice(4), queue.slice(4));
  assert.deepEqual(migrateQueue(once, NOW + 1), once);
});

test('failed legacy scenes with omitted targets cannot retry locally', () => {
  const failed = [
    { provider: 'flow', kind: 'scene', source: 'prompts', status: 'failed', failure: { code: 'network' } },
    { provider: 'flow', kind: 'scene', status: 'failed', failure: { code: 'network' } },
    { provider: 'flow', target: null, kind: 'scene', source: 'prompts', status: 'failed', failure: { code: 'network' } },
    { provider: 'flow', target: '', kind: 'scene', status: 'failed', failure: { code: 'network' } },
  ];

  for (const item of failed) assert.equal(canRetryItem(item), false);
});

test('legacy Leonardo work without a model snapshot fails closed', () => {
  const input = [{
    id: 'legacy-leonardo',
    provider: 'leonardo',
    target: 'project',
    kind: 'scene',
    source: 'plan',
    status: 'pending',
    prompt: 'A quiet mountain lake',
  }];

  const [migrated] = migrateQueue(input, NOW);

  assert.equal(migrated.status, 'failed');
  assert.equal(migrated.failure.code, 'model-unknown');
  assert.match(migrated.failure.hint, /refresh.*re-queue/i);
  assert.equal(migrated.fleetRetrySafe, false);
  assert.equal(migrated.finishedAt, NOW);
  assert.deepEqual(input[0], {
    id: 'legacy-leonardo',
    provider: 'leonardo',
    target: 'project',
    kind: 'scene',
    source: 'plan',
    status: 'pending',
    prompt: 'A quiet mountain lake',
  });
});

test('legacy Flow work retains its prompt and friendly model', () => {
  const input = [{
    id: 'legacy-flow',
    provider: 'flow',
    target: 'project',
    kind: 'scene',
    source: 'plan',
    status: 'pending',
    prompt: 'A paper boat on a moonlit river',
    model: 'nano-banana-2',
  }];

  const [migrated] = migrateQueue(input, NOW);

  assert.equal(migrated.prompt, input[0].prompt);
  assert.equal(migrated.model, 'nano-banana-2');
  assert.deepEqual(migrated.modelSnapshot, {
    modelId: 'NARWHAL',
    modelLabel: 'Nano Banana 2',
    modelSource: 'fallback',
  });
  assert.equal(migrated.generationSettings.modelId, 'NARWHAL');
});

test('legacy picker-driven web work becomes explicitly provider-controlled', () => {
  const input = ['aistudio', 'qwen', 'chatgpt'].map((provider) => ({
    id: provider,
    provider,
    target: 'download',
    kind: 'scene',
    source: 'standalone',
    status: 'pending',
    aspectRatio: '4:3',
  }));

  const migrated = migrateQueue(input, NOW);

  for (const item of migrated) {
    assert.deepEqual(item.modelSnapshot, {
      modelId: null,
      modelLabel: '',
      modelSource: 'provider-controlled',
    });
    assert.equal(item.generationSettings.aspectRatio, '4:3');
  }
});

test('stale model failures require a fresh queue item', () => {
  for (const code of ['model-unknown', 'model-selection-changed']) {
    assert.equal(canRetryItem({
      provider: 'flow',
      target: 'project',
      kind: 'scene',
      source: 'plan',
      status: 'failed',
      failure: { code },
    }), false);
  }
});

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

test('migration preserves known Leonardo submission evidence for ambiguity recovery', () => {
  const input = [{
    id: 'leonardo-submitted',
    provider: 'leonardo',
    target: 'download',
    kind: 'scene',
    source: 'standalone',
    status: 'running',
    providerAttempted: true,
    startedAt: NOW - 100,
  }];

  const [migrated] = migrateQueue(input, NOW);

  assert.deepEqual(migrated, input[0]);
});
