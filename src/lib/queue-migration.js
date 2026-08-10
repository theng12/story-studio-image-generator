import { DEFAULT_PROVIDER_ID, isMaintainedProvider } from './providers.js';
import { legacyCharacterReferenceDescriptor } from './reference-assets.js';

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
  return item?.target !== 'download' && item?.kind !== 'thumbnail' && item?.source !== 'plan';
}

function sceneSourceFailure() {
  return {
    code: 'scene-source-retired',
    title: 'Scene source is no longer supported',
    hint: 'Create or load a Scene Plan in Story Studio, then queue the scene again.',
    raw: 'Project scene generation requires a Scene Plan with stable Scene Review IDs.',
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
    fleetRetrySafe: false,
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
    if (isMaintainedProvider(provider)) return normalized;
    return {
      ...normalized,
      status: 'failed',
      error: removedFailure(provider).raw,
      failure: removedFailure(provider),
      fleetRetrySafe: false,
      finishedAt: now,
      ...(Number.isFinite(item?.startedAt) ? { durationMs: Math.max(0, now - item.startedAt) } : {}),
    };
  });
}

export function canRetryItem(item) {
  const provider = queueProvider(item);
  return (
    item?.status === 'failed' &&
    !isUnsupportedProjectScene(item) &&
    isMaintainedProvider(provider) &&
    item?.failure?.code !== 'provider-removed' &&
    item?.failure?.code !== 'scene-source-retired'
  );
}
