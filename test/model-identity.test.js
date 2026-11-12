import assert from 'node:assert/strict';
import test from 'node:test';
import * as modelIdentity from '../src/lib/model-identity.js';
import {
  assertProviderModel,
  flowInventoryResult,
  generationSettingsFor,
  modelSnapshotDiagnostic,
  resolveFlowModel,
  resolveStoredFlowModelId,
  snapshotProviderModel,
} from '../src/lib/model-identity.js';
import { FLOW_FALLBACK_MODELS, getFlowModel } from '../src/lib/providers.js';

const capturedInventory = (entries) => flowInventoryResult(entries, 'live');

test('Flow exposes only exact tested fallback IDs', () => {
  assert.deepEqual(FLOW_FALLBACK_MODELS, [
    { id: 'nano-banana-2', internalId: 'BELUGA', label: 'Nano Banana 2.1', source: 'fallback' },
    { id: 'nano-banana-2-lite', internalId: 'HARBOR_SEAL', label: 'Nano Banana 2 Lite', source: 'fallback' },
  ]);
  assert.deepEqual(getFlowModel('nano-banana-2'), FLOW_FALLBACK_MODELS[0]);
  assert.equal(getFlowModel('stale-model'), undefined);
});

test('Flow snapshots its exact internal ID as fallback data', () => {
  assert.deepEqual(snapshotProviderModel({ provider: 'flow', configuredModel: 'nano-banana-2' }), {
    modelId: 'BELUGA', modelLabel: 'Nano Banana 2.1', modelSource: 'fallback',
  });
});

test('Flow accepts exact provider-owned live IDs and labels only', () => {
  const inventory = capturedInventory([
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
  assert.deepEqual(capturedInventory([]), {
    source: 'fallback',
    models: [
      { modelId: 'BELUGA', modelLabel: 'Nano Banana 2.1' },
      { modelId: 'HARBOR_SEAL', modelLabel: 'Nano Banana 2 Lite' },
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
  const inventory = capturedInventory([]);
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
    configuredModel: modelIdentity.configuredFlowModel({ ...persisted, imageModel: 'nano-banana-2-lite' }, inventory),
    flowInventory: inventory,
  });

  assert.deepEqual(first, {
    modelId: 'BELUGA', modelLabel: 'Nano Banana 2.1', modelSource: 'fallback',
  });
  assert.deepEqual(second, first);
  assert.deepEqual(switched, {
    modelId: 'HARBOR_SEAL', modelLabel: 'Nano Banana 2 Lite', modelSource: 'fallback',
  });
  assert.deepEqual(resolveFlowModel(first.modelId, inventory), {
    modelId: 'BELUGA', modelLabel: 'Nano Banana 2.1',
  });
  assert.equal(modelIdentity.configuredFlowModel({
    imageModel: 'nano-banana-2-lite',
    flowModelId: 'FLOW_STALE_LIVE',
    flowModelSource: 'live',
  }, inventory), 'nano-banana-2-lite');
});

test('first enqueue maps a tested fallback selection to its exact live Flow ID', () => {
  assert.equal(typeof modelIdentity.configuredFlowModel, 'function');
  const inventory = capturedInventory([{ id: 'BELUGA', label: 'Provider Nano Banana 2' }]);
  const snapshot = snapshotProviderModel({
    provider: 'flow',
    configuredModel: modelIdentity.configuredFlowModel({ imageModel: 'nano-banana-2' }, inventory),
    flowInventory: inventory,
  });

  assert.deepEqual(snapshot, {
    modelId: 'BELUGA', modelLabel: 'Provider Nano Banana 2', modelSource: 'live',
  });
});

test('released Flow settings resolve friendly and exact IDs without losing provenance', () => {
  const live = capturedInventory([
    { id: 'BELUGA', label: 'Provider Nano Banana 2' },
    { id: 'FLOW_LIVE_NEW', label: 'Workspace Model' },
  ]);

  assert.equal(resolveStoredFlowModelId({ imageModel: 'nano-banana-2' }, live.models), 'BELUGA');
  assert.equal(resolveStoredFlowModelId({ imageModel: 'BELUGA' }, live.models), 'BELUGA');
  assert.equal(resolveStoredFlowModelId({
    imageModel: 'FLOW_LIVE_NEW',
    flowModelId: 'FLOW_LIVE_NEW',
    flowModelSource: 'live',
    flowModelSelection: 'FLOW_LIVE_NEW',
  }, live.models), 'FLOW_LIVE_NEW');
  assert.equal(resolveStoredFlowModelId({
    imageModel: 'nano-banana-2',
    flowModelId: 'REMOVED_LIVE_ID',
    flowModelSource: 'live',
    flowModelSelection: 'nano-banana-2',
  }, live.models), null, 'trusted live provenance must not silently remap a removed exact ID');
});

test('first live Flow enqueue fails closed when the mapped exact catalog ID is absent', () => {
  const inventory = capturedInventory([{ id: 'FLOW_LIVE_NEW', label: 'Flow Live New' }]);
  assert.throws(
    () => snapshotProviderModel({
      provider: 'flow',
      configuredModel: modelIdentity.configuredFlowModel({ imageModel: 'nano-banana-2' }, inventory),
      flowInventory: inventory,
    }),
    (error) => error.code === 'model-unknown',
  );
});

test('explicit live Flow selection remains authoritative over the fallback catalog setting', () => {
  const inventory = capturedInventory([{ id: 'FLOW_LIVE_NEW', label: 'Flow Live New' }]);
  assert.equal(modelIdentity.configuredFlowModel({
    imageModel: 'FLOW_LIVE_NEW',
    flowModelId: 'FLOW_LIVE_NEW',
    flowModelSource: 'live',
    flowModelSelection: 'FLOW_LIVE_NEW',
  }, inventory), 'FLOW_LIVE_NEW');
});

test('live Flow snapshots follow a changed friendly selection across consecutive enqueues', () => {
  const inventory = capturedInventory([
    { id: 'BELUGA', label: 'Provider Nano Banana 2' },
    { id: 'HARBOR_SEAL', label: 'Provider Nano Banana 2 Lite' },
  ]);
  const firstSettings = { imageModel: 'nano-banana-2' };
  const first = snapshotProviderModel({
    provider: 'flow',
    configuredModel: modelIdentity.configuredFlowModel(firstSettings, inventory),
    flowInventory: inventory,
  });
  const persisted = {
    ...firstSettings,
    flowModelId: first.modelId,
    flowModelLabel: first.modelLabel,
    flowModelSource: first.modelSource,
    flowModelSelection: firstSettings.imageModel,
  };
  const switchedSettings = { ...persisted, imageModel: 'nano-banana-2-lite' };
  const switched = snapshotProviderModel({
    provider: 'flow',
    configuredModel: modelIdentity.configuredFlowModel(switchedSettings, inventory),
    flowInventory: inventory,
  });

  assert.equal(first.modelId, 'BELUGA');
  assert.deepEqual(switched, {
    modelId: 'HARBOR_SEAL', modelLabel: 'Provider Nano Banana 2 Lite', modelSource: 'live',
  });
});

test('generation parameters reject every queued model identity mismatch', () => {
  assert.equal(typeof modelIdentity.assertQueuedModelIdentity, 'function');
  const item = {
    prompt: 'A moonlit river',
    modelSnapshot: { modelId: 'BELUGA', modelLabel: 'Nano Banana 2', modelSource: 'live' },
    generationSettings: {
      modelId: 'BELUGA', modelLabel: 'Nano Banana 2', modelSource: 'live', aspectRatio: '16:9',
    },
  };

  assert.deepEqual(modelIdentity.generationParamsFor('flow', item, { projectId: 'flow-project' }), {
    projectId: 'flow-project',
    prompt: 'A moonlit river',
    modelId: 'BELUGA',
    aspectRatio: '16:9',
    recaptchaMaxAttempts: undefined,
  });
  for (const changed of [
    { modelId: 'GEM_PIX_2' },
    { modelId: 'malformed model id' },
    { modelLabel: 'Changed label' },
    { modelSource: 'fallback' },
  ]) {
    assert.throws(
      () => modelIdentity.generationParamsFor('flow', {
        ...item,
        generationSettings: { ...item.generationSettings, ...changed },
      }),
      (error) => error.code === 'model-selection-changed',
    );
  }
});

test('generation parameter construction produces every immutable provider payload field', () => {
  assert.equal(typeof modelIdentity.generationParamsFor, 'function');
  const references = [{ dataUrl: 'data:image/png;base64,ref', label: 'Character' }];
  const base = {
    prompt: 'A moonlit river',
  };

  assert.deepEqual(modelIdentity.generationParamsFor('flow', {
    ...base,
    modelSnapshot: { modelId: 'BELUGA', modelLabel: 'Nano Banana 2', modelSource: 'live' },
    generationSettings: {
      modelId: 'BELUGA', modelLabel: 'Nano Banana 2', modelSource: 'live', aspectRatio: '16:9',
    },
  }, {
    projectId: 'flow-project',
    recaptchaMaxAttempts: 4,
    referenceIds: ['media/reference-1'],
  }), {
    projectId: 'flow-project',
    prompt: 'A moonlit river',
    modelId: 'BELUGA',
    aspectRatio: '16:9',
    recaptchaMaxAttempts: 4,
    imageInputs: [{ imageInputType: 'IMAGE_INPUT_TYPE_REFERENCE', name: 'media/reference-1' }],
  });
  assert.deepEqual(modelIdentity.generationParamsFor('aistudio', {
    ...base,
    modelSnapshot: { modelId: null, modelLabel: '', modelSource: 'provider-controlled' },
    generationSettings: {
      modelId: null, modelLabel: '', modelSource: 'provider-controlled', aspectRatio: '4:3',
    },
  }, { references }), {
    prompt: 'A moonlit river',
    aspectRatio: '4:3',
    references,
    expectedModel: { modelId: null, modelLabel: '', modelSource: 'provider-controlled' },
  });
  assert.deepEqual(modelIdentity.generationParamsFor('qwen', {
    ...base,
    modelSnapshot: { modelId: null, modelLabel: '', modelSource: 'provider-controlled' },
    generationSettings: {
      modelId: null, modelLabel: '', modelSource: 'provider-controlled', aspectRatio: '3:4',
    },
  }, { references }), {
    prompt: 'A moonlit river',
    aspectRatio: '3:4',
    references,
    expectedModel: { modelId: null, modelLabel: '', modelSource: 'provider-controlled' },
  });
  assert.deepEqual(modelIdentity.generationParamsFor('chatgpt', {
    ...base,
    modelSnapshot: { modelId: null, modelLabel: '', modelSource: 'provider-controlled' },
    generationSettings: {
      modelId: null, modelLabel: '', modelSource: 'provider-controlled', aspectRatio: '1:1', maxWaitSec: 725,
    },
  }, { references }), {
    prompt: 'A moonlit river',
    aspectRatio: '1:1',
    references,
    maxWaitSec: 725,
    expectedModel: { modelId: null, modelLabel: '', modelSource: 'provider-controlled' },
  });
  assert.deepEqual(modelIdentity.generationParamsFor('leonardo', {
    ...base,
    modelSnapshot: { modelId: 'lucid-origin', modelLabel: 'Lucid Origin', modelSource: 'live' },
    generationSettings: {
      modelId: 'lucid-origin',
      modelLabel: 'Lucid Origin',
      modelSource: 'live',
      aspectRatio: '21:9',
      style: 'Cinematic',
      mode: 'QUALITY',
      size: 'LARGE',
      count: 3,
    },
  }), {
    prompt: 'A moonlit river',
    aspectRatio: '21:9',
    style: 'Cinematic',
    model: 'lucid-origin',
    mode: 'QUALITY',
    size: 'LARGE',
    count: 3,
    expectedModel: { modelId: 'lucid-origin', modelLabel: 'Lucid Origin', modelSource: 'live' },
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
  assert.throws(
    () => assertProviderModel({
      provider: 'leonardo',
      snapshot: { modelId: 'phoenix-v1.0', modelLabel: 'Phoenix', modelSource: 'live' },
      current: { id: 'phoenix-v1.0', label: 'Renamed or changed selection' },
    }),
    (error) => error.code === 'model-selection-changed',
  );
});

test('provider-controlled identity does not claim a false match', () => {
  assert.doesNotThrow(() => assertProviderModel({
    provider: 'chatgpt',
    snapshot: { modelId: null, modelLabel: '', modelSource: 'provider-controlled' },
    current: { id: '', label: '' },
  }));
});

test('diagnostics distinguish provider labels from provider-controlled snapshots', () => {
  assert.equal(modelSnapshotDiagnostic({
    modelId: null,
    modelLabel: 'Qwen Image',
    modelSource: 'provider-label',
  }), 'Qwen Image (provider-selected label)');
  assert.equal(modelSnapshotDiagnostic({
    modelId: null,
    modelLabel: '',
    modelSource: 'provider-controlled',
  }), 'Provider-controlled model');
});

test('missing model snapshots fail closed', () => {
  assert.throws(
    () => assertProviderModel({ provider: 'flow', current: { id: 'BELUGA', label: 'Nano Banana 2' } }),
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
