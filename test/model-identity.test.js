import assert from 'node:assert/strict';
import test from 'node:test';
import * as modelIdentity from '../src/lib/model-identity.js';
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

test('fallback Flow selection ignores persisted internal IDs across consecutive enqueues', () => {
  assert.equal(typeof modelIdentity.configuredFlowModel, 'function');
  const inventory = flowInventoryResult([]);
  const initial = { imageModel: 'nano-banana-2' };
  const first = snapshotProviderModel({
    provider: 'flow',
    configuredModel: modelIdentity.configuredFlowModel(initial, inventory),
    flowInventory: inventory,
  });
  const persisted = {
    ...initial,
    flowModelId: first.modelId,
    flowModelLabel: first.modelLabel,
    flowModelSource: first.modelSource,
  };
  const second = snapshotProviderModel({
    provider: 'flow',
    configuredModel: modelIdentity.configuredFlowModel(persisted, inventory),
    flowInventory: inventory,
  });
  const switched = snapshotProviderModel({
    provider: 'flow',
    configuredModel: modelIdentity.configuredFlowModel({ ...persisted, imageModel: 'nano-banana-pro' }, inventory),
    flowInventory: inventory,
  });

  assert.deepEqual(first, {
    modelId: 'NARWHAL', modelLabel: 'Nano Banana 2', modelSource: 'fallback',
  });
  assert.deepEqual(second, first);
  assert.deepEqual(switched, {
    modelId: 'GEM_PIX_2', modelLabel: 'Nano Banana Pro', modelSource: 'fallback',
  });
  assert.deepEqual(resolveFlowModel(first.modelId, inventory), {
    modelId: 'NARWHAL', modelLabel: 'Nano Banana 2',
  });
  assert.equal(modelIdentity.configuredFlowModel({
    imageModel: 'nano-banana-pro',
    flowModelId: 'FLOW_STALE_LIVE',
    flowModelSource: 'live',
  }, inventory), 'nano-banana-pro');
});

test('first enqueue can snapshot a newly discovered exact live Flow ID', () => {
  assert.equal(typeof modelIdentity.configuredFlowModel, 'function');
  const inventory = flowInventoryResult([{ id: 'FLOW_LIVE_NEW', label: 'Flow Live New' }]);
  const snapshot = snapshotProviderModel({
    provider: 'flow',
    configuredModel: modelIdentity.configuredFlowModel({
      imageModel: 'nano-banana-2',
      flowModelId: 'FLOW_LIVE_NEW',
      flowModelSource: 'live',
    }, inventory),
    flowInventory: inventory,
  });

  assert.deepEqual(snapshot, {
    modelId: 'FLOW_LIVE_NEW', modelLabel: 'Flow Live New', modelSource: 'live',
  });
});

test('generation settings snapshot every immutable dispatched field', () => {
  const settings = {
    aspectRatio: '16:9',
    aistudioAspectRatio: '4:3',
    qwenAspectRatio: '3:4',
    chatgptAspectRatio: '1:1',
    chatgptMaxWaitSec: 725,
    leonardoStyle: 'Cinematic',
    leonardoMode: 'QUALITY',
    leonardoSize: 'LARGE',
    leonardoCount: 3,
  };
  const leonardoSnapshot = {
    modelId: 'lucid-origin', modelLabel: 'Lucid Origin', modelSource: 'live',
  };

  assert.deepEqual(generationSettingsFor('leonardo', settings, leonardoSnapshot), {
    modelId: 'lucid-origin',
    modelLabel: 'Lucid Origin',
    modelSource: 'live',
    aspectRatio: '16:9',
    style: 'Cinematic',
    mode: 'QUALITY',
    size: 'LARGE',
    count: 3,
    maxWaitSec: undefined,
  });
  assert.equal(generationSettingsFor('flow', settings, {}).aspectRatio, '16:9');
  assert.equal(generationSettingsFor('aistudio', settings, {}).aspectRatio, '4:3');
  assert.equal(generationSettingsFor('qwen', settings, {}).aspectRatio, '3:4');
  assert.deepEqual(generationSettingsFor('chatgpt', settings, {}), {
    modelId: null,
    modelLabel: '',
    modelSource: undefined,
    aspectRatio: '1:1',
    style: undefined,
    mode: undefined,
    size: undefined,
    count: undefined,
    maxWaitSec: 725,
  });
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
