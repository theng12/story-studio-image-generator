// Flow account + exact-price observations for the Gateway image worker.
// Schema 1: identity and balance come from the signed-in Flow page; a price the
// extension has not been told is unknown and never becomes a quote.
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;
const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function fresh(value, maxAgeSeconds) {
  if (typeof value !== 'string' || !/(Z|[+-]\d\d:\d\d)$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && time > 0 && time <= Date.now() && Date.now() - time <= maxAgeSeconds * 1000;
}

export function observedAccount(raw, maxAgeSeconds = 90) {
  if (!raw || raw.schema !== 1 || raw.provider !== 'flow' || typeof raw.accountId !== 'string' || !ID.test(raw.accountId) ||
      !SLUG.test(raw.source || '') || !fresh(raw.observedAt, maxAgeSeconds) ||
      !['connected', 'disconnected', 'offline', 'error', 'unknown'].includes(raw.connection) ||
      !['signed_in', 'signed_out', 'unknown'].includes(raw.signIn) ||
      !['ready', 'not_ready', 'unknown'].includes(raw.readiness)) return null;
  const balance = raw.balance && Number.isFinite(raw.balance.value) && raw.balance.value >= 0 &&
    SLUG.test(raw.balance.source || '') && fresh(raw.balance.observedAt, maxAgeSeconds)
    ? { value: raw.balance.value, unit: SLUG.test(raw.balance.unit || '') ? raw.balance.unit : 'credits',
        source: raw.balance.source, observedAt: raw.balance.observedAt }
    : null;
  return { schema: 1, provider: 'flow', accountId: raw.accountId, source: raw.source, observedAt: raw.observedAt,
    connection: raw.connection, signIn: raw.signIn, readiness: raw.readiness, balance };
}

// Python json.dumps(sort_keys=True, separators:(",", ":")) equivalent.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function payloadSha256(payload) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(payload)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// credits: the per-image price for this model. 0 is a real price (Flow images are
// free), not "unknown"; only a non-number means there is nothing to quote.
export function imageQuote(preview, account, credits) {
  if (!account || !preview || typeof preview.payloadSha256 !== 'string') return null;
  if (!Number.isFinite(credits) || credits < 0) return null;
  return { provider: account.provider, accountId: account.accountId, payloadSha256: preview.payloadSha256,
    value: credits, unit: 'credits', source: 'settings.image-credits', observedAt: account.observedAt };
}
