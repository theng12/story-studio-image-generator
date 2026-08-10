import { DEFAULT_PROVIDER_ID, isMaintainedProvider } from './providers.js';

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
    if ((item?.status !== 'pending' && item?.status !== 'running') || isMaintainedProvider(provider)) return { ...item };
    return {
      ...item,
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
