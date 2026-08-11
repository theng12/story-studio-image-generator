import { FLOW_FALLBACK_MODELS, PROVIDER_IDS, getFlowModel } from './providers.js';

const FLOW_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,127}$/;

export const MODEL_SOURCES = Object.freeze({
  FALLBACK: 'fallback',
  LIVE: 'live',
  PROVIDER_LABEL: 'provider-label',
  PROVIDER_CONTROLLED: 'provider-controlled',
});

function providerName(provider) {
  return {
    flow: 'Flow',
    aistudio: 'AI Studio',
    qwen: 'Qwen Studio',
    leonardo: 'Leonardo',
    chatgpt: 'ChatGPT',
  }[provider] || String(provider || 'provider');
}

function modelError(code, provider) {
  const error = new Error(`${providerName(provider)} model identity is unavailable. Refresh the signed-in ${providerName(provider)} page and re-queue this generation.`);
  error.code = code;
  return error;
}

function assertSupportedProvider(provider) {
  if (!PROVIDER_IDS.includes(provider)) throw modelError('model-unknown', provider);
}

function liveIdentity(liveModel) {
  return {
    modelId: String(liveModel?.id || '').trim(),
    modelLabel: String(liveModel?.label || '').trim(),
  };
}

export function normalizeFlowInventory(entries) {
  const seen = new Set();
  return (Array.isArray(entries) ? entries : []).flatMap((entry) => {
    const modelId = String(entry?.id || '').trim();
    const modelLabel = String(entry?.label || '').replace(/\s+/g, ' ').trim();
    if (!FLOW_ID.test(modelId) || !modelLabel || modelId === modelLabel || seen.has(modelId)) return [];
    seen.add(modelId);
    return [{ modelId, modelLabel }];
  });
}

export function flowInventoryResult(entries) {
  const models = normalizeFlowInventory(entries);
  if (models.length) return { source: MODEL_SOURCES.LIVE, models };
  return {
    source: MODEL_SOURCES.FALLBACK,
    models: FLOW_FALLBACK_MODELS.map(({ internalId, label }) => ({ modelId: internalId, modelLabel: label })),
  };
}

export function resolveFlowModel(modelId, inventory) {
  return inventory?.models?.find((model) => model.modelId === String(modelId || ''));
}

export function resolveStoredFlowModelId(settings = {}, models = []) {
  const offered = new Set((Array.isArray(models) ? models : []).map(({ modelId }) => modelId));
  const imageModel = String(settings.imageModel || '');
  const exactStoredId = String(settings.flowModelId || '');
  const trustedLiveSelection =
    settings.flowModelSource === MODEL_SOURCES.LIVE &&
    exactStoredId &&
    (!settings.flowModelSelection || settings.flowModelSelection === imageModel);
  if (trustedLiveSelection) return offered.has(exactStoredId) ? exactStoredId : null;

  const fallbackId = getFlowModel(imageModel)?.internalId;
  for (const candidate of [fallbackId, imageModel, exactStoredId]) {
    if (candidate && offered.has(candidate)) return candidate;
  }
  return null;
}

export function configuredFlowModel(settings = {}, flowInventory) {
  if (flowInventory?.source !== MODEL_SOURCES.LIVE) return settings.imageModel;
  return resolveStoredFlowModelId(settings, flowInventory.models) || settings.flowModelId || settings.imageModel;
}

export function snapshotProviderModel({ provider, configuredModel, liveModel, flowInventory } = {}) {
  assertSupportedProvider(provider);
  if (provider === 'flow') {
    if (flowInventory?.source === MODEL_SOURCES.LIVE) {
      const model = resolveFlowModel(configuredModel, flowInventory);
      if (!model) throw modelError('model-unknown', provider);
      return { ...model, modelSource: MODEL_SOURCES.LIVE };
    }

    const model = getFlowModel(configuredModel);
    if (!model) throw modelError('model-unknown', provider);
    return { modelId: model.internalId, modelLabel: model.label, modelSource: MODEL_SOURCES.FALLBACK };
  }

  const { modelId, modelLabel } = liveIdentity(liveModel);
  if (provider === 'leonardo' && !modelId) throw modelError('model-unknown', provider);
  if (modelId) return { modelId, modelLabel, modelSource: MODEL_SOURCES.LIVE };
  if (modelLabel) return { modelId: null, modelLabel, modelSource: MODEL_SOURCES.PROVIDER_LABEL };
  return { modelId: null, modelLabel: '', modelSource: MODEL_SOURCES.PROVIDER_CONTROLLED };
}

export function generationSettingsFor(provider, settings = {}, modelSnapshot = {}) {
  const aspectRatio = provider === 'aistudio' ? settings.aistudioAspectRatio
    : provider === 'qwen' ? settings.qwenAspectRatio
      : provider === 'chatgpt' ? settings.chatgptAspectRatio
        : settings.aspectRatio;
  return {
    modelId: modelSnapshot.modelId ?? null,
    modelLabel: modelSnapshot.modelLabel || '',
    modelSource: modelSnapshot.modelSource,
    aspectRatio,
    style: provider === 'leonardo' ? settings.leonardoStyle : undefined,
    mode: provider === 'leonardo' ? settings.leonardoMode : undefined,
    size: provider === 'leonardo' ? settings.leonardoSize : undefined,
    count: provider === 'leonardo' ? settings.leonardoCount : undefined,
    maxWaitSec: provider === 'chatgpt' ? settings.chatgptMaxWaitSec : undefined,
  };
}

export function assertQueuedModelIdentity(item = {}, provider = item.provider) {
  const snapshot = item.modelSnapshot;
  const generation = item.generationSettings;
  if (!snapshot || !generation) throw modelError('model-unknown', provider);
  if (
    snapshot.modelId !== generation.modelId ||
    snapshot.modelLabel !== generation.modelLabel ||
    snapshot.modelSource !== generation.modelSource
  ) throw modelError('model-selection-changed', provider);
  if (provider === 'flow' && !FLOW_ID.test(String(snapshot.modelId || ''))) {
    throw modelError('model-unknown', provider);
  }
  return snapshot;
}

export function generationParamsFor(provider, item = {}, operational = {}) {
  assertSupportedProvider(provider);
  const snapshot = assertQueuedModelIdentity(item, provider);
  const generation = item.generationSettings || {};
  const base = { prompt: item.prompt, aspectRatio: generation.aspectRatio };
  if (provider === 'flow') {
    const params = {
      projectId: operational.projectId,
      prompt: item.prompt,
      modelId: snapshot.modelId,
      aspectRatio: generation.aspectRatio,
      recaptchaMaxAttempts: operational.recaptchaMaxAttempts,
    };
    if (operational.referenceIds?.length) {
      params.imageInputs = operational.referenceIds.map((name) => ({
        imageInputType: 'IMAGE_INPUT_TYPE_REFERENCE',
        name,
      }));
    }
    return params;
  }
  if (provider === 'leonardo') {
    return {
      ...base,
      style: generation.style,
      model: snapshot.modelId,
      mode: generation.mode,
      size: generation.size,
      count: generation.count,
      expectedModel: { ...snapshot },
    };
  }
  const params = {
    ...base,
    references: operational.references || [],
    expectedModel: { ...snapshot },
  };
  if (provider === 'chatgpt') params.maxWaitSec = generation.maxWaitSec;
  return params;
}

export function assertProviderModel({ provider, snapshot, current } = {}) {
  assertSupportedProvider(provider);
  if (!snapshot) throw modelError('model-unknown', provider);
  if (snapshot.modelSource === MODEL_SOURCES.PROVIDER_CONTROLLED) return;

  const { modelId, modelLabel } = liveIdentity(current);
  const matches = snapshot.modelSource === MODEL_SOURCES.PROVIDER_LABEL
    ? snapshot.modelLabel === modelLabel
    : snapshot.modelId === modelId && (!snapshot.modelLabel || snapshot.modelLabel === modelLabel);
  if (!matches) throw modelError('model-selection-changed', provider);
}

export function assertFlowModelApproval(approval, current) {
  const approvedId = String(approval?.modelId || '');
  const approvedLabel = String(approval?.modelLabel || '');
  const approvedSource = String(approval?.modelSource || '');
  const matches =
    FLOW_ID.test(approvedId) &&
    approvedLabel &&
    [MODEL_SOURCES.LIVE, MODEL_SOURCES.FALLBACK].includes(approvedSource) &&
    approvedId === current?.modelId &&
    approvedLabel === current?.modelLabel &&
    approvedSource === current?.modelSource;
  if (!matches) {
    const error = new Error('Flow model discovery changed after confirmation. Refresh models, review the selected model and provenance, then confirm again.');
    error.code = 'model-approval-changed';
    throw error;
  }
  return approval;
}

export function modelSnapshotDiagnostic(snapshot) {
  if (!snapshot) return 'Legacy queue item';
  if (snapshot.modelSource === MODEL_SOURCES.PROVIDER_CONTROLLED) return 'Provider-controlled model';
  if (snapshot.modelSource === MODEL_SOURCES.PROVIDER_LABEL) {
    return `${snapshot.modelLabel || 'Selected model'} (provider-selected label)`;
  }
  const identity = [snapshot.modelLabel, snapshot.modelId && `(${snapshot.modelId})`].filter(Boolean).join(' ');
  return `${identity || 'Unknown model'} (${snapshot.modelSource || 'unknown source'})`;
}
