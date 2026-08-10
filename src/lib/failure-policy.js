import { getProvider } from './providers.js';

export function providerLabelForItem(item = {}) {
  if (!Object.hasOwn(item, 'provider')) return 'provider';
  const configured = getProvider(item.provider);
  if (configured) return configured.label;
  const stored = String(item.provider ?? '').trim();
  return stored || 'invalid provider';
}

export function isAmbiguousLeonardoFailure(provider, providerAttempted, error) {
  return provider === 'leonardo' && providerAttempted && error?.submitted !== false;
}

export function isKnownPreSubmitLimit(provider, error) {
  return !!error?.limit && (provider !== 'leonardo' || error.submitted === false);
}

export function ambiguousLeonardoQueueItem(item, error, now = Date.now()) {
  const raw = String(error?.message || error || 'Unknown Leonardo error');
  const provider = providerLabelForItem(item);
  return {
    ...item,
    status: 'failed',
    error: raw,
    failure: {
      code: 'ambiguous',
      title: `${provider} result needs confirmation`,
      hint: `Inspect the ${provider} tab for a completed image before manually retrying so paid tokens are not spent twice.`,
      raw,
    },
    fleetRetrySafe: false,
    finishedAt: now,
    durationMs: Math.max(0, now - (Number.isFinite(item.startedAt) ? item.startedAt : now)),
  };
}
