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
  generationSettings: { modelId: 'NARWHAL', aspectRatio: '16:9', style: '', mode: '', size: '', count: 1 },
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

test('done and failed history do not participate in active deduplication', () => {
  for (const status of ['done', 'failed']) {
    const result = enqueueItems([standalone({ id: status, status })], [standalone()], 1000);
    assert.equal(result.added, 1);
    assert.equal(result.skipped, 0);
  }
});

test('project work keeps the existing scene identity', () => {
  const project = {
    id: 'queued',
    status: 'pending',
    provider: 'flow',
    episodeCode: 'TN0001',
    kind: 'scene',
    source: 'plan',
    sceneKey: 'scene-1',
  };
  const result = enqueueItems([project], [{ ...project, id: 'new' }], 1000);

  assert.equal(result.added, 0);
  assert.equal(result.skipped, 1);
});
