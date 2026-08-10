import assert from 'node:assert/strict';
import test from 'node:test';

import { canRetryItem, migrateQueue } from '../src/lib/queue-migration.js';

const NOW = 1_723_000_000_000;

test('fails pending and running work for retired providers without changing retained history', () => {
  const queue = [
    { id: 'grok-pending', provider: 'grok', status: 'pending' },
    { id: 'piclumen-running', provider: 'piclumen', status: 'running', startedAt: NOW - 2000 },
    { id: 'grok-done', provider: 'grok', status: 'done', savedAs: 'kept.png' },
    { id: 'grok-failed', provider: 'grok', status: 'failed', failure: { code: 'quota' } },
    { id: 'flow-running', provider: 'flow', status: 'running', startedAt: NOW - 1000 },
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
  assert.deepEqual(queue[0], { id: 'grok-pending', provider: 'grok', status: 'pending' });
});

test('preserves legacy provider-less items and is idempotent', () => {
  const queue = [
    { id: 'legacy', status: 'pending' },
    { id: 'freegen', provider: 'freegen', status: 'pending' },
  ];

  const once = migrateQueue(queue, NOW);
  const twice = migrateQueue(once, NOW + 1);

  assert.deepEqual(once[0], queue[0]);
  assert.deepEqual(twice, once);
});

test('rejects local retries for removed or unknown provider queue items', () => {
  assert.equal(canRetryItem({ provider: 'flow', status: 'failed' }), true);
  assert.equal(canRetryItem({ provider: 'grok', status: 'failed', failure: { code: 'provider-removed' } }), false);
  assert.equal(canRetryItem({ provider: 'unknown', status: 'failed' }), false);
  assert.equal(canRetryItem({ provider: 'flow', status: 'done' }), false);
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
