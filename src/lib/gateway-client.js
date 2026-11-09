// Gateway Studio image worker transport. Outbound calls only; no port opened.
// Wire contract v1 (image kind proposed — Gateway currently ships video only):
//   GET  /api/workers/health
//   POST /api/workers/claim                    -> 204 | { job }
//   POST /api/workers/jobs/{id}/progress       -> { ok }
//   POST /api/workers/jobs/{id}/result         multipart file + mediaType
//   POST /api/workers/jobs/{id}/fail           -> { ok }

function baseUrl(settings) {
  const base = String(settings?.gatewayUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('Gateway Studio URL is not set.');
  return base;
}

function authHeaders(settings, extra = {}) {
  const headers = { ...extra };
  if (settings?.gatewayToken) headers.Authorization = `Bearer ${settings.gatewayToken}`;
  return headers;
}

async function request(settings, path, { method = 'GET', json, body, timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = authHeaders(settings);
    let payload = body;
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(json);
    }
    const response = await fetch(`${baseUrl(settings)}${path}`, {
      method,
      headers,
      body: payload,
      signal: controller.signal,
    });
    if (response.status === 204) return null;
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const detail = parsed?.error || parsed?.detail || text || `HTTP ${response.status}`;
      throw new Error(`Gateway ${path} failed (${response.status}): ${String(detail).slice(0, 200)}`);
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

export async function claimImageJob(settings) {
  const workerId = String(settings?.gatewayWorkerId || '').trim();
  if (!workerId) throw new Error('Gateway worker id is not set.');
  const result = await request(settings, '/api/workers/claim', {
    method: 'POST',
    json: { workerId, kind: 'image' },
    timeoutMs: 35000,
  });
  // 204 = no job available (idle). Null result is valid idle.
  if (!result) return null;
  const job = result.job && typeof result.job === 'object' ? result.job : result;
  if (!job?.jobId) throw new Error('Gateway claim returned a malformed response (no jobId).');
  if (job.kind && job.kind !== 'image') {
    throw new Error(`Gateway claim returned wrong kind "${job.kind}" (expected image).`);
  }
  return job;
}

export async function reportImageProgress(settings, jobId, phase, message = '') {
  if (!jobId) return null;
  return request(settings, `/api/workers/jobs/${encodeURIComponent(jobId)}/progress`, {
    method: 'POST',
    json: { phase: String(phase || ''), message: String(message || '').slice(0, 300) },
  });
}

export async function reportImageResult(settings, jobId, buffer, mediaType = 'image/png') {
  if (!jobId) return null;
  const ext = mediaType === 'image/jpeg' ? 'jpg' : mediaType === 'image/webp' ? 'webp' : 'png';
  const form = new FormData();
  form.append('mediaType', mediaType);
  form.append('file', new Blob([buffer], { type: mediaType }), `${jobId}.${ext}`);
  const result = await request(settings, `/api/workers/jobs/${encodeURIComponent(jobId)}/result`, {
    method: 'POST',
    body: form,
    timeoutMs: 120000,
  });
  // HTTP 200 + {ok:true,ignored:true} means another terminal answer already won.
  // NOT artifact acceptance: staged refs/result must be preserved, job stays held.
  if (result && typeof result === 'object' && result.ok === true && result.ignored === true) {
    return { ok: true, ignored: true };
  }
  return result;
}

export async function reportImageFailure(settings, jobId, error, ambiguous = false) {
  if (!jobId) return null;
  return request(settings, `/api/workers/jobs/${encodeURIComponent(jobId)}/fail`, {
    method: 'POST',
    json: { error: String(error?.message || error || 'unknown').slice(0, 500), ambiguous: ambiguous === true },
  });
}

// Health must return matching ok/workerId/kind. Malformed responses are errors,
// not idle — a broken health endpoint must never silently pass as "no work".
export async function testImageGateway(settings) {
  const workerId = String(settings?.gatewayWorkerId || '').trim();
  if (!workerId) throw new Error('Gateway worker id is not set.');
  const health = await request(settings, '/api/workers/health', { timeoutMs: 8000 });
  if (!health || typeof health !== 'object') {
    throw new Error('Gateway health returned a malformed response.');
  }
  if (health.ok !== true) {
    throw new Error(`Gateway health reported not ok: ${String(health.error || 'unknown').slice(0, 200)}`);
  }
  if (health.workerId && health.workerId !== workerId) {
    throw new Error(`Gateway health worker id mismatch (expected ${workerId}, got ${health.workerId}).`);
  }
  if (health.kinds && Array.isArray(health.kinds) && !health.kinds.includes('image')) {
    throw new Error('Gateway does not support image kind.');
  }
  return { ok: true, ...health };
}