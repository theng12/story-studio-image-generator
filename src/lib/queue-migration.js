import { DEFAULT_PROVIDER_ID, isMaintainedProvider } from './providers.js';
import { generationSettingsFor, snapshotProviderModel } from './model-identity.js';
import { legacyCharacterReferenceDescriptor } from './reference-assets.js';

const MODEL_FAILURE_CODES = new Set(['model-unknown', 'model-selection-changed']);

function removedFailure(provider) {
  const name = String(provider ?? '').trim() || 'invalid provider ID';
  return {
    code: 'provider-removed',
    title: 'Provider removed from Story Studio Image Generator',
    hint: `Choose a maintained provider and queue this asset again. ${name} jobs cannot be redirected automatically.`,
    raw: `The ${name} is no longer supported.`,
  };
}

function queueProvider(item) {
  return item && Object.hasOwn(item, 'provider') ? item.provider : DEFAULT_PROVIDER_ID;
}

export function isUnsupportedProjectScene(item) {
  if (item?.target === 'gateway') return item.source !== 'gateway' || typeof item.gatewayJobId !== 'string' || !item.gatewayJobId;
  return item?.target !== 'download' && item?.kind !== 'thumbnail' && item?.source !== 'plan';
}

export const gatewayNeedsReview = (item) => item?.target === 'gateway' && item.gatewayAcknowledged !== true;

function sceneSourceFailure() {
  return {
    code: 'scene-source-retired',
    title: 'Scene source is no longer supported',
    hint: 'Create or load a Scene Plan in Story Studio, then queue the scene again.',
    raw: 'Project scene generation requires a Scene Plan with stable Scene Review IDs.',
  };
}

function modelUnknownFailure(provider) {
  const name = provider === 'leonardo' ? 'Leonardo AI' : 'Flow';
  return {
    code: 'model-unknown',
    title: `${name} model identity is unavailable`,
    hint: `Refresh the signed-in ${name} page, choose the model again, and re-queue this item.`,
    raw: `The queued ${name} model cannot be verified safely.`,
  };
}

function failedModelQueueItem(item, provider, now) {
  const failure = modelUnknownFailure(provider);
  return {
    ...item,
    status: 'failed',
    error: failure.raw,
    failure,
    finishedAt: now,
    ...(Number.isFinite(item?.startedAt) ? { durationMs: Math.max(0, now - item.startedAt) } : {}),
  };
}

function ambiguousRecoveryQueueItem(item, now) {
  const provider = String(queueProvider(item) || 'provider');
  const failure = {
    code: 'ambiguous',
    title: `${provider} result needs confirmation`,
    hint: `Inspect the ${provider} tab and Story Studio save result before you re-queue this item.`,
    raw: 'Provider or result evidence exists, but no confirmed Story Studio save was recorded.',
  };
  return {
    ...item,
    status: 'failed',
    error: failure.raw,
    failure,
    finishedAt: now,
    ...(Number.isFinite(item.startedAt) ? { durationMs: Math.max(0, now - item.startedAt) } : {}),
  };
}

function recoveryEvidenceQueueItem(item, now) {
  if (item?.status !== 'pending' && item?.status !== 'running') return null;
  if (item.savedAs) {
    const completed = {
      ...item,
      status: 'done',
      finishedAt: Number.isFinite(item.finishedAt) ? item.finishedAt : now,
    };
    completed.durationMs = Number.isFinite(item.durationMs)
      ? item.durationMs
      : Math.max(0, completed.finishedAt - (item.startedAt || completed.finishedAt));
    delete completed.error;
    delete completed.failure;
    return completed;
  }
  if (item.providerAttempted !== true && !item.mediaId) return null;
  return ambiguousRecoveryQueueItem(item, now);
}

export function recoverInterruptedQueue(queue, now = Date.now()) {
  if (!Array.isArray(queue)) return [];
  return queue.map((item) => {
    if (gatewayNeedsReview(item) && item.status === 'running') {
      return { ...item, status: 'failed', finishedAt: now,
        failure: { code: 'gateway-held', title: 'Gateway work is held', hint: 'Deliver retained bytes again or review the job in Gateway.', raw: 'Worker restarted. Retained bytes may be delivered again; generation will not repeat.' },
        error: 'Gateway work is held after worker restart.' };
    }
    const evidence = recoveryEvidenceQueueItem(item, now);
    if (evidence) return evidence;
    if (item?.status !== 'running') return { ...item };
    if (item.provider === 'leonardo') return ambiguousRecoveryQueueItem(item, now);
    const pending = { ...item, status: 'pending' };
    delete pending.startedAt;
    return pending;
  });
}

function legacyGenerationSettings(item) {
  return {
    aspectRatio: item.aspectRatio,
    aistudioAspectRatio: item.aspectRatio,
    qwenAspectRatio: item.aspectRatio,
    chatgptAspectRatio: item.aspectRatio,
    chatgptMaxWaitSec: item.maxWaitSec,
  };
}

function migrateLegacyModel(item, provider, now, active) {
  if (item.modelSnapshot || !Object.hasOwn(item, 'provider')) return item;
  if (provider === 'leonardo') {
    if (item.status === 'running' || item.providerAttempted === true || item.mediaId || item.savedAs) return item;
    return active ? failedModelQueueItem(item, provider, now) : item;
  }

  let modelSnapshot;
  if (provider === 'flow') {
    if (!item.model) return item;
    try {
      modelSnapshot = snapshotProviderModel({ provider, configuredModel: item.model });
    } catch {
      return active ? failedModelQueueItem(item, provider, now) : item;
    }
  } else {
    modelSnapshot = snapshotProviderModel({ provider });
  }
  return {
    ...item,
    modelSnapshot: { ...modelSnapshot },
    generationSettings: { ...generationSettingsFor(provider, legacyGenerationSettings(item), modelSnapshot) },
  };
}

export function assertSupportedProjectScene(item) {
  if (!isUnsupportedProjectScene(item)) return;
  const failure = sceneSourceFailure();
  const error = new Error(`${failure.raw} ${failure.hint}`);
  error.code = failure.code;
  throw error;
}

export function unsupportedSceneQueueItem(item, now = Date.now()) {
  const failure = sceneSourceFailure();
  return {
    ...item,
    status: 'failed',
    error: failure.raw,
    failure,
    finishedAt: now,
    ...(Number.isFinite(item?.startedAt) ? { durationMs: Math.max(0, now - item.startedAt) } : {}),
  };
}

export function migrateQueue(queue, now = Date.now()) {
  if (!Array.isArray(queue)) return [];
  return queue.map((item) => {
    const provider = queueProvider(item);
    const active = item?.status === 'pending' || item?.status === 'running';
    const retryableFailure = canRetryItem(item);
    if (!active && !retryableFailure) return { ...item };
    const legacyReference = !Array.isArray(item?.referenceDescriptors) && item?.applyRef !== false
      ? legacyCharacterReferenceDescriptor(item?.slug, item?.characterRef)
      : null;
    const normalized = legacyReference
      ? { ...item, referenceDescriptors: [legacyReference], characterRef: undefined }
      : { ...item };
    if (isUnsupportedProjectScene(normalized)) return unsupportedSceneQueueItem(normalized, now);
    if (isMaintainedProvider(provider)) return migrateLegacyModel(normalized, provider, now, active);
    return {
      ...normalized,
      status: 'failed',
      error: removedFailure(provider).raw,
      failure: removedFailure(provider),
      finishedAt: now,
      ...(Number.isFinite(item?.startedAt) ? { durationMs: Math.max(0, now - item.startedAt) } : {}),
    };
  });
}

export function canRetryItem(item) {
  const provider = queueProvider(item);
  return (
    item?.status === 'failed' &&
    item?.target !== 'gateway' &&
    !isUnsupportedProjectScene(item) &&
    isMaintainedProvider(provider) &&
    item?.failure?.code !== 'provider-removed' &&
    item?.failure?.code !== 'scene-source-retired' &&
    !MODEL_FAILURE_CODES.has(item?.failure?.code)
  );
}
