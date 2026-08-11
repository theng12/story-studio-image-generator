import assert from 'node:assert/strict';
import test from 'node:test';
import { assertProviderModel, flowInventoryResult, generationSettingsFor, resolveFlowModel, snapshotProviderModel } from '../src/lib/model-identity.js';
import { FLOW_FALLBACK_MODELS, getFlowModel } from '../src/lib/providers.js';

test('Flow exposes only exact tested fallback IDs', () => {
  assert.deepEqual(FLOW_FALLBACK_MODELS, [
    { id: 'nano-banana-2', internalId: 'NARWHAL', label: 'Nano Banana 2', source: 'fallback' },
    { id: 'nano-banana-2-lite', internalId: 'HARBOR_SEAL', label: 'Nano Banana 2 Lite', source: 'fallback' },
    { id: 'nano-banana-pro', internalId: 'GEM_PIX_2', label: 'Nano Banana Pro', source: 'fallback' },
  ]);
  assert.deepEqual(getFlowModel('nano-banana-2'), FLOW_FALLBACK_MODELS[0]);
  assert.equal(getFlowModel('stale-model'), undefined);
});

test('Flow snapshots its exact internal ID as fallback data', () => {
  assert.deepEqual(snapshotProviderModel({ provider: 'flow', configuredModel: 'nano-banana-2' }), {
    modelId: 'NARWHAL', modelLabel: 'Nano Banana 2', modelSource: 'fallback',
  });
});

test('Flow accepts exact provider-owned live IDs and labels only', () => {
  const inventory = flowInventoryResult([
    { id: 'FLOW_NEW_01', label: 'Nano Banana Experimental' },
    { id: 'FLOW_NEW_01', label: 'duplicate' },
    { id: 'Nano Banana Experimental', label: 'display-derived ID' },
    { id: 'FLOW_BAD', label: '' },
  ]);
  assert.deepEqual(inventory, {
    source: 'live',
    models: [{ modelId: 'FLOW_NEW_01', modelLabel: 'Nano Banana Experimental' }],
  });
  assert.deepEqual(resolveFlowModel('FLOW_NEW_01', inventory), inventory.models[0]);
  assert.equal(resolveFlowModel('Nano Banana Experimental', inventory), undefined);
  assert.deepEqual(snapshotProviderModel({
    provider: 'flow', configuredModel: 'FLOW_NEW_01', flowInventory: inventory,
  }), {
    modelId: 'FLOW_NEW_01', modelLabel: 'Nano Banana Experimental', modelSource: 'live',
  });
});

test('removed live Flow IDs fail closed instead of falling back', () => {
  assert.throws(
    () => snapshotProviderModel({
      provider: 'flow',
      configuredModel: 'FLOW_REMOVED',
      flowInventory: { source: 'live', models: [{ modelId: 'FLOW_CURRENT', modelLabel: 'Current' }] },
    }),
    (error) => error.code === 'model-unknown' && /refresh the signed-in Flow page/i.test(error.message),
  );
});

test('Flow uses fallback provenance only when live discovery is empty', () => {
  assert.deepEqual(flowInventoryResult([]), {
    source: 'fallback',
    models: [
      { modelId: 'NARWHAL', modelLabel: 'Nano Banana 2' },
      { modelId: 'HARBOR_SEAL', modelLabel: 'Nano Banana 2 Lite' },
      { modelId: 'GEM_PIX_2', modelLabel: 'Nano Banana Pro' },
    ],
  });
});

test('stable web label is preserved without inventing an ID', () => {
  assert.deepEqual(snapshotProviderModel({ provider: 'aistudio', liveModel: { id: '', label: 'Nano Banana 2' } }), {
    modelId: null, modelLabel: 'Nano Banana 2', modelSource: 'provider-label',
  });
});

test('unreadable web identity is provider-controlled', () => {
  assert.deepEqual(snapshotProviderModel({ provider: 'chatgpt', liveModel: { id: '', label: '' } }), {
    modelId: null, modelLabel: '', modelSource: 'provider-controlled',
  });
});

test('generation settings are copied, not retained by reference', () => {
  const settings = { aspectRatio: '16:9', leonardoStyle: 'Dynamic', leonardoMode: 'FAST', leonardoSize: 'SMALL', leonardoCount: 1, chatgptMaxWaitSec: 480 };
  const snapshot = snapshotProviderModel({ provider: 'leonardo', liveModel: { id: 'phoenix-v1.0', label: 'Phoenix' } });
  const result = generationSettingsFor('leonardo', settings, snapshot);
  settings.leonardoStyle = 'Cinematic';
  assert.equal(result.style, 'Dynamic');
  assert.equal(result.modelId, 'phoenix-v1.0');
});

test('unknown and changed models fail closed with refresh guidance', () => {
  assert.throws(
    () => snapshotProviderModel({ provider: 'flow', configuredModel: 'stale-model' }),
    (error) => error.code === 'model-unknown' && /refresh the signed-in Flow page/i.test(error.message),
  );
  assert.throws(
    () => assertProviderModel({
      provider: 'leonardo',
      snapshot: { modelId: 'phoenix-v1.0', modelLabel: 'Phoenix', modelSource: 'live' },
      current: { id: 'flux-1', label: 'FLUX' },
    }),
    (error) => error.code === 'model-selection-changed' && /refresh the signed-in Leonardo page/i.test(error.message),
  );
});

test('provider-controlled identity does not claim a false match', () => {
  assert.doesNotThrow(() => assertProviderModel({
    provider: 'chatgpt',
    snapshot: { modelId: null, modelLabel: '', modelSource: 'provider-controlled' },
    current: { id: '', label: '' },
  }));
});

test('missing model snapshots fail closed', () => {
  assert.throws(
    () => assertProviderModel({ provider: 'flow', current: { id: 'NARWHAL', label: 'Nano Banana 2' } }),
    (error) => error.code === 'model-unknown' && /refresh the signed-in Flow page/i.test(error.message),
  );
});

test('unsupported providers cannot bypass model identity checks', () => {
  const rejectsGrok = (fn) => assert.throws(
    fn,
    (error) => error.code === 'model-unknown' && /grok.*refresh the signed-in grok page/i.test(error.message),
  );
  rejectsGrok(() => snapshotProviderModel({ provider: 'grok' }));
  rejectsGrok(() => assertProviderModel({
    provider: 'grok',
    snapshot: { modelId: null, modelLabel: '', modelSource: 'provider-controlled' },
    current: { id: '', label: '' },
  }));
});
