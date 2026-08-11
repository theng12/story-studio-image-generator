import assert from 'node:assert/strict';
import test from 'node:test';
import { createQueueStore } from '../src/lib/queue-store.js';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('concurrent updates preserve both mutations', async () => {
  let stored = [{ id: 'seed', status: 'pending' }];
  let writes = 0;
  const store = createQueueStore({
    load: async () => { await pause(5); return structuredClone(stored); },
    save: async (queue) => { await pause(5); stored = structuredClone(queue); writes++; },
    normalize: (queue) => queue,
  });
  await Promise.all([
    store.update(async (queue) => { await pause(10); return [...queue, { id: 'panel', status: 'pending' }]; }),
    store.update(async (queue) => { await pause(1); return [...queue, { id: 'alarm', status: 'pending' }]; }),
  ]);
  assert.deepEqual(stored.map((item) => item.id), ['seed', 'panel', 'alarm']);
  assert.equal(writes, 2);
});

test('read persists normalization inside the serialized boundary', async () => {
  let stored = [{ id: 'legacy' }];
  const store = createQueueStore({
    load: async () => structuredClone(stored),
    save: async (queue) => { stored = structuredClone(queue); },
    normalize: (queue) => queue.map((item) => ({ ...item, migrated: true })),
  });
  assert.deepEqual(await store.read(), [{ id: 'legacy', migrated: true }]);
  assert.deepEqual(stored, [{ id: 'legacy', migrated: true }]);
});

test('no-op update does not save an unchanged queue', async () => {
  const stored = [{ id: 'pending', status: 'pending' }];
  let writes = 0;
  const store = createQueueStore({
    load: async () => structuredClone(stored),
    save: async () => { writes++; },
  });

  assert.deepEqual(await store.update((queue) => queue), stored);
  assert.equal(writes, 0);
});

test('no-op update still saves normalization changes', async () => {
  let stored = [{ id: 'legacy' }];
  let writes = 0;
  const store = createQueueStore({
    load: async () => structuredClone(stored),
    save: async (queue) => { stored = structuredClone(queue); writes++; },
    normalize: (queue) => queue.map((item) => ({ ...item, migrated: true })),
  });

  assert.deepEqual(await store.update((queue) => queue), [{ id: 'legacy', migrated: true }]);
  assert.deepEqual(stored, [{ id: 'legacy', migrated: true }]);
  assert.equal(writes, 1);
});
