import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PROVIDER_ID,
  PROVIDER_IDS,
  PROVIDERS,
  getProvider,
  isMaintainedProvider,
  normalizeSelectedProvider,
} from '../src/lib/providers.js';

test('exposes the maintained providers in the required order', () => {
  assert.deepEqual(PROVIDER_IDS, ['flow', 'aistudio', 'qwen', 'leonardo', 'chatgpt']);
  assert.equal(new Set(PROVIDER_IDS).size, PROVIDER_IDS.length);
  assert.equal(DEFAULT_PROVIDER_ID, 'flow');
  assert.equal(PROVIDERS.length, PROVIDER_IDS.length);
});

test('normalizes stored selections to Flow but rejects invalid registry lookups', () => {
  assert.equal(normalizeSelectedProvider('grok'), 'flow');
  assert.equal(normalizeSelectedProvider('not-a-provider'), 'flow');
  assert.equal(getProvider('grok'), undefined);
  assert.equal(getProvider('not-a-provider'), undefined);
  assert.equal(isMaintainedProvider('flow'), true);
  assert.equal(isMaintainedProvider('grok'), false);
});

test('exposes provider metadata and maintained capabilities', () => {
  for (const provider of PROVIDERS) {
    for (const key of ['id', 'label', 'workspace', 'scripts', 'contextMessage', 'downloadHosts', 'settings', 'capabilities']) {
      assert.ok(Object.hasOwn(provider, key), `${provider.id} should expose ${key}`);
    }
    for (const key of ['characterReferences', 'storyStudioReferences', 'maxReferences', 'cooldown', 'visibleTab', 'modelDiscovery']) {
      assert.ok(Object.hasOwn(provider.capabilities, key), `${provider.id} should expose capabilities.${key}`);
    }
  }

  assert.deepEqual(
    Object.fromEntries(PROVIDERS.map(({ id, capabilities }) => [id, capabilities.maxReferences])),
    { flow: 4, aistudio: 4, qwen: 1, leonardo: 0, chatgpt: 4 }
  );
  assert.equal(getProvider('leonardo').capabilities.modelDiscovery, true);
  for (const id of ['flow', 'aistudio', 'qwen', 'chatgpt']) {
    assert.equal(getProvider(id).capabilities.modelDiscovery, false);
  }
});
