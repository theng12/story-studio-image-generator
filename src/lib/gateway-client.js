// Wire v1: scoped worker credentials, outbound requests only, no automatic retries.
function connection(settings) {
  let url;
  try { url = new URL(settings.gatewayUrl); } catch { throw new Error('Enter the Gateway server address.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Gateway address must be HTTP or HTTPS without credentials, query or fragment.');
  }
  if (typeof settings.gatewayToken !== 'string' || !settings.gatewayToken.trim() ||
      typeof settings.gatewayWorkerId !== 'string' || !settings.gatewayWorkerId.trim() || settings.gatewayWorkerId.length > 120) {
    throw new Error('Set the Gateway worker token and worker ID (at most 120 characters).');
  }
  return url.href.replace(/\/+$/, '');
}
async function request(settings, path, { json, body, timeoutMs = 20000, idle = false } = {}) {
  const base = connection(settings);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(base + path, {
      method: json !== undefined || body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${settings.gatewayToken}`, ...(json === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: json === undefined ? body : JSON.stringify(json),
      credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
    });
    if (response.status === 204 && idle) return null;
    // Never echo untrusted server bodies: they may contain rejected credentials.
    if (!response.ok) throw new Error(`Gateway request failed (${response.status}).`);
    let result;
    try { result = await response.json(); } catch { throw new Error('Gateway returned unreadable JSON.'); }
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Gateway returned an invalid response.');
    return result;
  } finally { clearTimeout(timer); }
}
function accepted(result) {
  if (result?.ok !== true || result.ignored === true) throw new Error('Gateway did not accept this answer; retained for review.');
  return result;
}
export async function claimImageJob(settings) {
  const result = await request(settings, '/api/workers/claim', { json: { workerId: settings.gatewayWorkerId, kind: 'image' }, idle: true });
  if (result === null) return null;
  if (!result.job || typeof result.job.jobId !== 'string' || !result.job.jobId) throw new Error('Gateway claim returned a malformed job.');
  return result.job;
}
const jobPath = (jobId, action) => `/api/workers/jobs/${encodeURIComponent(jobId)}/${action}`;
export async function reportImageProgress(settings, jobId, phase, message = '') {
  return accepted(await request(settings, jobPath(jobId, 'progress'), { json: { phase, message } }));
}
export async function reportImageResult(settings, jobId, buffer, mediaType) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mediaType)) throw new Error('Generated image has an unsupported type.');
  const body = new FormData();
  body.append('mediaType', mediaType);
  body.append('file', new Blob([buffer], { type: mediaType }), 'image');
  return accepted(await request(settings, jobPath(jobId, 'result'), { body, timeoutMs: 120000 }));
}
export async function reportImageFailure(settings, jobId, error, ambiguous = true) {
  return accepted(await request(settings, jobPath(jobId, 'fail'), { json: { error: String(error?.message || error || 'Worker failure').slice(0, 500), ambiguous: ambiguous !== false } }));
}
export async function testImageGateway(settings) {
  const health = await request(settings, '/api/workers/health', { timeoutMs: 8000 });
  if (health.ok !== true || health.workerId !== settings.gatewayWorkerId || health.kind !== 'image' ||
      !Number.isSafeInteger(health.maxResultBytes) || health.maxResultBytes <= 0) throw new Error('Gateway health does not match this image worker or omits its upload limit.');
  return health;
}
