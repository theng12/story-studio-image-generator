// Gateway Studio image worker mode — pure map between a gateway image job and
// a queue item. Kept separate from story/standalone paths so those modes are
// untouched; the queue processor only sees ordinary items with a gatewayJobId.
//
// Wire proposal (Gateway currently ships video only; image kind is proposed):
//   job: {
//     jobId: string,
//     kind: 'image',
//     prompt: string,
//     modelKey: string,
//     modelLabel?: string,
//     aspectRatio?: '16:9' | '9:16' | '1:1' | '4:3' | '3:4',
//     referenceImages?: [{ mediaType, dataBase64 }],
//     flowProjectId?: string
//   }
// Unsupported/missing schema rejects BEFORE provider invocation.

export const GATEWAY_IMAGE_KINDS = Object.freeze(['image']);

export function createImageGatewayWorkerId() {
  if (globalThis.crypto?.randomUUID) return `imgworker_${crypto.randomUUID()}`;
  return `imgworker_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

const SUPPORTED_ASPECT_RATIOS = new Set(['16:9', '9:16', '1:1', '4:3', '3:4']);

function requireString(value, label) {
  const s = String(value || '').trim();
  if (!s) throw new Error(`Gateway image job has no ${label}.`);
  return s;
}

export function normalizeImageGatewayJob(job) {
  if (!job || typeof job !== 'object') throw new Error('Gateway image job is not an object.');
  const jobId = requireString(job.jobId, 'id');
  const kind = String(job.kind || 'image').trim();
  if (!GATEWAY_IMAGE_KINDS.includes(kind)) {
    throw new Error(`Gateway job kind ${kind} is not supported by the image worker.`);
  }
  const prompt = requireString(job.prompt, 'prompt');
  const modelKey = requireString(job.modelKey, 'model key');
  const aspectRatio = SUPPORTED_ASPECT_RATIOS.has(job.aspectRatio) ? job.aspectRatio : '16:9';
  const references = (Array.isArray(job.referenceImages) ? job.referenceImages : [])
    .map((ref) => {
      if (!ref || typeof ref !== 'object') return null;
      const mediaType = String(ref.mediaType || '').trim();
      const dataBase64 = String(ref.dataBase64 || '').trim();
      if (!mediaType || !dataBase64) return null;
      if (!/^image\/[a-z0-9.+-]+$/i.test(mediaType)) return null;
      return { mediaType, dataBase64 };
    })
    .filter(Boolean);
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

// Reference bytes are fetched and staged at run time; they are NEVER stored in
// the durable queue (base64 in chrome.storage is a memory + quota hazard).
export function gatewayImageHasReferenceBytes(job) {
  return Array.isArray(job?.references) && job.references.length > 0;
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
  };
}

export function isImageGatewayJobQueued(queue, jobId) {
  return (Array.isArray(queue) ? queue : []).some((item) => item.gatewayJobId === jobId);
}