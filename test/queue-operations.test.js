import assert from 'node:assert/strict';
import test from 'node:test';
import { activeWorkKey, normalizePrompt } from '../src/lib/queue-identity.js';
import { enqueueItems } from '../src/lib/queue-operations.js';

const standalone = (overrides = {}) => ({
  id: overrides.id || 'new',
  source: 'standalone',
  kind: 'scene',
  provider: 'flow',
  prompt: '  A quiet cabin   at dusk  ',
  generationSettings: {
    modelId: 'BELUGA',
    modelLabel: 'Nano Banana 2',
    modelSource: 'live',
    aspectRatio: '16:9',
    style: '',
    mode: '',
    size: '',
    count: 1,
  },
  ...overrides,
});

const legacyStandalone = (overrides = {}) => ({
  id: overrides.id || 'new',
  status: 'pending',
  source: 'standalone',
  kind: 'scene',
  key: 'standalone_stamp_01_image',
  sceneKey: 'standalone_stamp_01_image',
  slug: 'standalone',
  episodeCode: 'Standalone',
  episodeTitle: '',
  prompt: 'A quiet cabin at dusk',
  provider: 'flow',
  target: 'download',
  projectId: 'project-1',
  model: 'BELUGA',
  aspectRatio: '16:9',
  label: 'Standalone 01/01 — image',
  project: 'Standalone',
  downloadPath: 'StoryStudioImages/Standalone/stamp_01_image.png',
  ...overrides,
});

test('normalizes standalone prompts and matches equivalent active work', () => {
  const queued = standalone({ id: 'queued', status: 'pending' });
  const incoming = standalone({ prompt: 'a QUIET cabin\nat dusk' });

  assert.equal(normalizePrompt('  A quiet cabin\nAT dusk '), 'a quiet cabin at dusk');
  assert.equal(activeWorkKey(queued), activeWorkKey(incoming));
});

test('same active standalone prompt and settings deduplicate', () => {
  const current = standalone({ id: 'queued', status: 'running' });
  const result = enqueueItems([current], [standalone()], 1000);

  assert.deepEqual(result, { queue: [current], added: 0, skipped: 1 });
});

test('changed standalone model remains distinct', () => {
  const current = standalone({ id: 'queued', status: 'pending' });
  const changed = standalone({
    generationSettings: { ...current.generationSettings, modelId: 'ORCA' },
  });
  const result = enqueueItems([current], [changed], 1000);

  assert.equal(result.added, 1);
  assert.equal(result.skipped, 0);
  assert.notEqual(activeWorkKey(current), activeWorkKey(changed));
});

test('standalone label and provenance changes remain distinct', () => {
  const current = standalone({ id: 'queued', status: 'pending' });
  for (const changedField of [
    { modelLabel: 'Nano Banana 2 renamed' },
    { modelSource: 'fallback' },
  ]) {
    const changed = standalone({
      generationSettings: { ...current.generationSettings, ...changedField },
    });
    const result = enqueueItems([current], [changed], 1000);

    assert.equal(result.added, 1);
    assert.equal(result.skipped, 0);
    assert.notEqual(activeWorkKey(current), activeWorkKey(changed));
  }
});

test('legacy standalone items deduplicate exact settings but not changed model or aspect ratio', () => {
  const active = legacyStandalone({ id: 'active' });

  assert.deepEqual(enqueueItems([active], [legacyStandalone()], 1000), {
    queue: [active],
    added: 0,
    skipped: 1,
  });
  for (const changed of [
    legacyStandalone({ model: 'ORCA' }),
    legacyStandalone({ aspectRatio: '1:1' }),
  ]) {
    const result = enqueueItems([active], [changed], 1000);
    assert.equal(result.added, 1);
    assert.equal(result.skipped, 0);
  }
});

test('done and failed history do not participate in active deduplication', () => {
  for (const status of ['done', 'failed']) {
    const result = enqueueItems([standalone({ id: status, status })], [standalone()], 1000);
    assert.equal(result.added, 1);
    assert.equal(result.skipped, 0);
  }
});
