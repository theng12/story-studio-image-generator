import { DEFAULT_PROVIDER_ID, isMaintainedProvider } from './providers.js';
import { legacyCharacterReferenceDescriptor } from './reference-assets.js';

function removedFailure(provider) {
  return {
    code: 'provider-removed',
    title: 'Provider removed from Story Studio Image Generator',
    hint: `Choose a maintained provider and queue this asset again. ${provider} jobs cannot be redirected automatically.`,
    raw: `The ${provider} provider is no longer supported.`,
  };
}

export function migrateQueue(queue, now = Date.now()) {
  if (!Array.isArray(queue)) return [];
  return queue.map((item) => {
    const provider = item?.provider || DEFAULT_PROVIDER_ID;
    const active = item?.status === 'pending' || item?.status === 'running';
    const retryableFailure = canRetryItem(item);
    if (!active && !retryableFailure) return { ...item };
    const legacyReference = !Array.isArray(item?.referenceDescriptors) && item?.applyRef !== false
      ? legacyCharacterReferenceDescriptor(item?.slug, item?.characterRef)
      : null;
    const normalized = legacyReference
      ? { ...item, referenceDescriptors: [legacyReference], characterRef: undefined }
      : { ...item };
    if (isMaintainedProvider(provider)) return normalized;
    return {
      ...normalized,
      status: 'failed',
      error: `The ${provider} provider was removed and this queued job cannot be run.`,
      failure: removedFailure(provider),
      fleetRetrySafe: false,
      finishedAt: now,
      ...(Number.isFinite(item?.startedAt) ? { durationMs: Math.max(0, now - item.startedAt) } : {}),
    };
  });
}

export function canRetryItem(item) {
  const provider = item?.provider || DEFAULT_PROVIDER_ID;
  return item?.status === 'failed' && isMaintainedProvider(provider) && item?.failure?.code !== 'provider-removed';
}
