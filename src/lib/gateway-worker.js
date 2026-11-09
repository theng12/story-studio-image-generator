// Gateway Studio image worker mode — strict mapping between a gateway image job
// and a queue item. Rejects malformed/missing schema BEFORE provider dispatch.
// Kept separate from story/standalone paths so those modes are untouched.
//
// Wire proposal (Gateway currently ships video only; image kind is proposed):
// job: {
//   jobId: string (required),
//   kind: 'image' (required),
//   prompt: string (required),
//   modelKey: string (required, must match known provider model),
//   modelLabel?: string,
//   aspectRatio?: '16:9' (only supported value; others REJECT),
//   referenceImages?: [{ mediaType: string, dataBase64: string }] (all valid or reject),
//   flowProjectId?: string (falls back to extension settings)
// }

export const GATEWAY_IMAGE_KINDS = Object.freeze(['image']);

// Source-grounded model mapping: only models the extension actually supports.
// No arbitrary modelKey accepted; no settings model substituted.
const KNOWN_IMAGE_MODELS = Object.freeze(new Set([
  'nano-banana-2',       // Flow NARWHAL (free)
  'nano-banana-2-lite',  // Flow HARBOR_SEAL (free)
  'nano-banana-pro',     // Flow GEM_PIX_2
  'phoenix-v1.0',        // Leonardo
  'aistudio-imagen',     // AI Studio
  'qwen-image',          // Qwen
  'chatgpt-dalle',       // ChatGPT
]));

// Only 16:9 is verified captured for Flow. Other ratios are NOT invented.
const SUPPORTED_ASPECT_RATIOS = Object.freeze(new Set(['16:9']));

export function createImageGatewayWorkerId() {
  if (globalThis.crypto?.randomUUID) return `imgworker_${crypto.randomUUID()}`;
  return `imgworker_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function requireString(value, label) {
  const s = String(value || '').trim();
  if (!s) throw new Error(`Gateway image job has no ${label}.`);
  return s;
}

// Strict normalizer: rejects on ANY schema violation. Never silently drops
// invalid references or defaults unsupported values — both could spend credits
// on a different job than intended.
export function normalizeImageGatewayJob(job) {
  if (!job || typeof job !== 'object') throw new Error('Gateway image job is not an object.');
  const jobId = requireString(job.jobId, 'id');
  const kind = String(job.kind || '').trim();
  if (!kind) throw new Error('Gateway image job has no kind.');
  if (!GATEWAY_IMAGE_KINDS.includes(kind)) {
    throw new Error(`Gateway job kind "${kind}" is not supported by the image worker.`);
  }
  const prompt = requireString(job.prompt, 'prompt');
  const modelKey = requireString(job.modelKey, 'model key');
  if (!KNOWN_IMAGE_MODELS.has(modelKey)) {
    throw new Error(`Gateway image job model "${modelKey}" is not a known provider model.`);
  }
  // Aspect ratio: only 16:9 is verified. Missing defaults to 16:9; anything else rejects.
  const rawRatio = job.aspectRatio == null ? null : String(job.aspectRatio).trim();
  const aspectRatio = rawRatio == null || rawRatio === '' ? '16:9' : rawRatio;
  if (!SUPPORTED_ASPECT_RATIOS.has(aspectRatio)) {
    throw new Error(`Gateway image job aspect ratio "${aspectRatio}" is not supported (only 16:9).`);
  }
  // References: ALL entries must be valid, or the job is rejected. Silent drop
  // would change what the provider receives vs what was requested.
  const rawRefs = Array.isArray(job.referenceImages) ? job.referenceImages : [];
  const references = [];
  for (let i = 0; i < rawRefs.length; i++) {
    const ref = rawRefs[i];
    if (!ref || typeof ref !== 'object') {
      throw new Error(`Gateway image job reference ${i + 1} is not an object.`);
    }
    const mediaType = String(ref.mediaType || '').trim();
    const dataBase64 = String(ref.dataBase64 || '').trim();
    if (!mediaType) throw new Error(`Gateway image job reference ${i + 1} has no mediaType.`);
    if (!dataBase64) throw new Error(`Gateway image job reference ${i + 1} has no dataBase64.`);
    if (!/^image\/[a-z0-9.+-]+$/i.test(mediaType)) {
      throw new Error(`Gateway image job reference ${i + 1} has invalid mediaType "${mediaType}".`);
    }
    references.push({ mediaType, dataBase64 });
  }
  return {
    jobId,
    kind,
    prompt,
    modelKey,
    modelLabel: String(job.modelLabel || modelKey),
    aspectRatio,
    references,
    flowProjectId: String(job.flowProjectId || '').trim(),
  };
}

// Reference bytes are staged outside the durable queue. This count is metadata
// only; actual bytes live in a runtime cache keyed by jobId.
export function gatewayImageHasReferenceBytes(normalizedJob) {
  return Array.isArray(normalizedJob?.references) && normalizedJob.references.length > 0;
}

export function imageGatewayJobToItem(job, settings) {
  const normalized = normalizeImageGatewayJob(job);
  const projectId = String(normalized.flowProjectId || settings?.flowProjectId || '').trim();
  if (!projectId) throw new Error('Gateway image job has no Flow project id.');
  return {
    id: `gateway_${normalized.jobId}`,
    status: 'pending',
    phase: 'queued',
    queuedAt: Date.now(),
    slug: 'gateway',
    projectName: 'Gateway Studio',
    episodeCode: normalized.jobId.slice(0, 8),
    episodeTitle: '',
    sceneId: `gateway_${normalized.jobId}`,
    label: `Gateway · ${normalized.jobId.slice(0, 8)}`,
    imagePrompt: normalized.prompt,
    motionPrompt: '',
    projectId,
    imageModel: settings?.imageModel,
    imageModelKey: normalized.modelKey,
    imageModelLabel: normalized.modelLabel,
    imageModelSource: 'gateway',
    aspectRatio: normalized.aspectRatio,
    target: 'gateway',
    gatewayJobId: normalized.jobId,
    gatewayKind: normalized.kind,
    gatewayReferenceCount: normalized.references.length,
    // Ambiguity defaults SAFE: any unproven failure holds the job rather than
    // risking duplicate generation. Explicit false only after proven pre-submit.
    gatewayAmbiguous: true,
  };
}

export function isImageGatewayJobQueued(queue, jobId) {
  return (Array.isArray(queue) ? queue : []).some((item) => item.gatewayJobId === jobId);
}