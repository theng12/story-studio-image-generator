import assert from 'node:assert/strict';
import test from 'node:test';

import { createSettingsStore } from '../src/lib/settings-store.js';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('concurrent settings patches preserve unrelated fields and return the merged snapshots', async () => {
  let stored = {
    provider: 'flow',
    studioBaseUrl: 'http://localhost:8766',
    humanDelayMinSec: 5,
    humanDelayMaxSec: 60,
  };
  const store = createSettingsStore({
    load: async () => {
      await pause(3);
      return structuredClone(stored);
    },
    save: async (settings) => {
      await pause(3);
      stored = structuredClone(settings);
    },
    normalize: (settings) => ({ ...settings }),
  });

  const [panel, options] = await Promise.all([
    store.patch(async () => {
      await pause(8);
      return { humanDelayMinSec: 12 };
    }),
    store.patch({ studioBaseUrl: 'http://localhost:8000' }),
  ]);

  assert.equal(panel.humanDelayMinSec, 12);
  assert.equal(options.humanDelayMinSec, 12);
  assert.equal(options.studioBaseUrl, 'http://localhost:8000');
  assert.deepEqual(stored, {
    provider: 'flow',
    studioBaseUrl: 'http://localhost:8000',
    humanDelayMinSec: 12,
    humanDelayMaxSec: 60,
  });
});

test('rejected settings patches do not poison later updates', async () => {
  let stored = { provider: 'flow', theme: 'system' };
  const store = createSettingsStore({
    load: async () => structuredClone(stored),
    save: async (settings) => { stored = structuredClone(settings); },
  });

  await assert.rejects(store.patch(() => { throw new Error('bad patch'); }), /bad patch/);
  assert.deepEqual(await store.patch({ theme: 'dark' }), { provider: 'flow', theme: 'dark' });
});
