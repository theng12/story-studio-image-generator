import { getFlowModel, getProvider } from './providers.js';
import { generationSettingsFor, snapshotProviderModel } from './model-identity.js';
import { normalizeFlowProjectId } from './config.js';

// This candidate serves captured Flow image models only. Other providers need
// their own verified Gateway capability mapping; never invent model aliases.
export const GATEWAY_IMAGE_KINDS = Object.freeze(['image']);
// Only the ratios with an observed submit value; the rest are refused at claim.
export const GATEWAY_IMAGE_ASPECTS = Object.freeze(['16:9', '9:16']);
export const createImageGatewayWorkerId = () => `imgworker_${crypto.randomUUID()}`;

// The Gateway owns the claim truth: it holds a job whose worker has been silent past its own
// advertised `leaseSeconds` (GET /api/workers/health). This marker is only a local guard against
// claiming twice, so it expires on that same clock instead of waiting for a person.
// Two guards keep it from ever getting ahead of Gateway:
//   - an unreadable lease (`leaseSeconds` null/undefined, i.e. health could not be read) is never
//     treated as expired, because we cannot prove Gateway let the job go;
//   - one extra settle window is added, so our marker never expires before Gateway's own reaper.
export const GATEWAY_CLAIM_DEFAULT_LEASE_SECONDS = 600;
export const GATEWAY_CLAIM_SETTLE_SECONDS = 30;
export function claimMarkerIsStale(marker, leaseSeconds, now = Date.now()) {
  if (!marker || typeof marker !== 'object') return false;
  const at = Number(marker.at);
  // A marker with no usable time cannot be proven old, so it is never judged stale here. The
  // caller stamps one on first sight, which bounds it to one lease from then.
  if (!Number.isFinite(at) || at <= 0) return false;
  const lease = Number(leaseSeconds);
  if (!Number.isFinite(lease) || lease <= 0) return false; // lease unknown: hold, never guess
  return now - at > (lease + GATEWAY_CLAIM_SETTLE_SECONDS) * 1000;
}
function required(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Gateway image job has no ${label}.`);
  return value;
}
export function normalizeImageGatewayJob(job) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) throw new Error('Gateway image job is not an object.');
  const jobId = required(job.jobId, 'id');
  if (job.kind !== 'image') throw new Error('Gateway image job must state kind image.');
  if (job.provider !== undefined && job.provider !== 'flow') throw new Error('Only captured Flow image models are available in this Gateway candidate.');
  const prompt = required(job.prompt, 'prompt');
  const model = getFlowModel(required(job.modelKey, 'model key'));
  if (!model) throw new Error('Gateway image job has no known Flow model.');
  const aspectRatio = job.aspectRatio ?? '16:9';
  if (!GATEWAY_IMAGE_ASPECTS.includes(aspectRatio)) throw new Error(`Flow image aspect ${aspectRatio} has no observed submit value — 16:9 and 9:16 only.`);
  const count = job.count ?? 1;
  if (![1, 2, 4].includes(count)) throw new Error(`Flow image count ${count} is not 1, 2 or 4.`);
  // No observed provider encoding exists for size.
  if (job.size !== undefined) throw new Error(`Flow image size ${job.size} has no observed Gateway mapping.`);
  const raw = job.referenceImages === undefined ? [] : job.referenceImages;
  if (!Array.isArray(raw) || raw.length > getProvider('flow').capabilities.maxReferences) {
    throw new Error('Gateway Flow references must be an array of at most four images.');
  }
  const references = raw.map((ref) => {
    if (!ref || !['image/png', 'image/jpeg', 'image/webp'].includes(ref.mediaType) ||
        typeof ref.dataBase64 !== 'string' || !ref.dataBase64 || ref.dataBase64.length % 4 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(ref.dataBase64)) throw new Error('Gateway reference must contain valid PNG, JPEG or WebP bytes.');
    let bytes;
    try { bytes = Uint8Array.from(atob(ref.dataBase64), (c) => c.charCodeAt(0)); }
    catch { throw new Error('Gateway reference encoding is invalid.'); }
    const matches = ref.mediaType === 'image/png' ? [137,80,78,71,13,10,26,10].every((v, i) => bytes[i] === v)
      : ref.mediaType === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : String.fromCharCode(...bytes.slice(0,4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8,12)) === 'WEBP';
    if (!matches) throw new Error('Gateway reference bytes do not match their image type.');
    return { base64: ref.dataBase64, mime: ref.mediaType, sourceKey: `${jobId}:${raw.indexOf(ref)}`, name: 'reference' };
  });
  return { jobId, kind: 'image', provider: 'flow', prompt, model, aspectRatio, count, references, flowProjectId: job.flowProjectId };
}
export function imageGatewayJobToItem(job, settings, flowInventory, projectIdOverride = null) {
  const normalized = normalizeImageGatewayJob(job);
  // The project comes from the tab Gateway is working in; a payload copy is only a fallback.
  const projectId = normalizeFlowProjectId(projectIdOverride || normalized.flowProjectId || settings?.flowProjectId);
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(projectId)) throw new Error('Gateway image job needs a valid Flow project id.');
  const modelSnapshot = snapshotProviderModel({ provider: 'flow', configuredModel: normalized.model.internalId, flowInventory });
  return {
    id: `gateway_${normalized.jobId}`, gatewayJobId: normalized.jobId,
    status: 'pending', queuedAt: Date.now(), source: 'gateway', kind: 'scene', target: 'gateway',
    provider: 'flow', prompt: normalized.prompt, projectId,
    label: `Gateway ${normalized.jobId.slice(0, 8)}`, modelSnapshot,
    generationSettings: generationSettingsFor('flow', { aspectRatio: normalized.aspectRatio, count: normalized.count }, modelSnapshot),
    gatewayReferenceCount: normalized.references.length,
  };
}
export const gatewayImageHasReferenceBytes = (job) => Array.isArray(job?.references) && job.references.length > 0;
export const isImageGatewayJobQueued = (queue, jobId) => Array.isArray(queue) && queue.some((item) => item.gatewayJobId === jobId);
export async function gatewayBinding(settings) {
  const input = JSON.stringify([new URL(settings.gatewayUrl).href.replace(/\/+$/, ''), settings.gatewayWorkerId, settings.gatewayToken]);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
