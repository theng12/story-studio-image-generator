import { getFlowModel, getProvider } from './providers.js';
import { generationSettingsFor, snapshotProviderModel } from './model-identity.js';
import { normalizeFlowProjectId } from './config.js';

// This candidate serves captured Flow image models only. Other providers need
// their own verified Gateway capability mapping; never invent model aliases.
export const GATEWAY_IMAGE_KINDS = Object.freeze(['image']);
export const createImageGatewayWorkerId = () => `imgworker_${crypto.randomUUID()}`;
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
  if (aspectRatio !== '16:9') throw new Error('Only captured 16:9 Flow output is available.');
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
  return { jobId, kind: 'image', provider: 'flow', prompt, model, aspectRatio, references, flowProjectId: job.flowProjectId };
}
export function imageGatewayJobToItem(job, settings) {
  const normalized = normalizeImageGatewayJob(job);
  const projectId = normalizeFlowProjectId(normalized.flowProjectId ?? settings?.flowProjectId);
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(projectId)) throw new Error('Gateway image job needs a valid Flow project id.');
  const modelSnapshot = snapshotProviderModel({ provider: 'flow', configuredModel: normalized.model.id });
  return {
    id: `gateway_${normalized.jobId}`, gatewayJobId: normalized.jobId,
    status: 'pending', queuedAt: Date.now(), source: 'gateway', kind: 'scene', target: 'gateway',
    provider: 'flow', prompt: normalized.prompt, projectId,
    label: `Gateway ${normalized.jobId.slice(0, 8)}`, modelSnapshot,
    generationSettings: generationSettingsFor('flow', { aspectRatio: normalized.aspectRatio }, modelSnapshot),
    gatewayReferenceCount: normalized.references.length,
  };
}
export const gatewayImageHasReferenceBytes = (job) => Array.isArray(job?.references) && job.references.length > 0;
export const isImageGatewayJobQueued = (queue, jobId) => Array.isArray(queue) && queue.some((item) => item.gatewayJobId === jobId);
export async function gatewayBinding(settings) {
  const input = JSON.stringify([new URL(settings.gatewayUrl).href.replace(/\/+$/, ''), settings.gatewayWorkerId, settings.gatewayToken]);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
