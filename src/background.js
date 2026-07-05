// Service worker — a persistent, resumable generation QUEUE for scene assets.
//
// The panel enqueues work (one scene, a whole episode, or a whole project);
// this worker processes one scene at a time, human-paced, generating the image
// on Google Flow and writing each result back to the Story Studio episode (or
// Downloads). The queue lives in chrome.storage, so it survives the panel
// closing AND the worker being killed: a chrome.alarms tick wakes the worker to
// resume any pending items.
//
// Strictly sequential — only ever one Flow generation in flight, so the site is
// never flooded no matter how much you queue. Veo video (phase 2) is async and
// slow; the queue's resumability is what makes that safe.

import { getSettings, normalizeFlowProjectId } from './lib/config.js';
import { StudioClient } from './lib/story-studio.js';
import { buildDownloadPath } from './lib/naming.js';

const FLOW_URL = 'https://labs.google/fx/tools/flow';
const PROVIDER = {
  flow: { url: 'https://labs.google/fx/tools/flow', match: 'https://labs.google/fx/*' },
  aistudio: { url: 'https://aistudio.google.com/prompts/new_chat', match: 'https://aistudio.google.com/*' },
  grok: { url: 'https://grok.com/imagine', match: 'https://grok.com/*' },
  perchance: { url: 'https://perchance.org/ai-text-to-image-generator', match: 'https://perchance.org/*' },
  freegen: { url: 'https://freegen.app/', match: 'https://freegen.app/*' },
  leonardo: { url: 'https://app.leonardo.ai/generate', match: 'https://app.leonardo.ai/*' },
};
const PROVIDER_NAME = {
  flow: 'Flow',
  aistudio: 'AI Studio',
  grok: 'Grok',
  perchance: 'Perchance',
  freegen: 'FreeGen',
  leonardo: 'Leonardo AI',
  pollinations: 'Pollinations',
};
// Providers that need no browser tab — generated directly from the worker.
const TABLESS = new Set(['pollinations']);
const QUEUE_KEY = 'queue';
// User-requested pause: the current item finishes, then the loop stops before
// the next one starts. Persisted so it survives service-worker death.
const PAUSE_KEY = 'queuePaused';

const isPaused = async () => !!(await chrome.storage.local.get(PAUSE_KEY))[PAUSE_KEY];
const ALARM = 'queueTick';
const SEEN_PROJECT_KEY = 'lastSeenFlowProjectId';
const NEXT_PROVIDER_RUN_KEY = 'nextProviderRunAt';

// Small guards so a missing/disabled API can never break top-level evaluation
// (which would stop the message listener from registering).
function alarmCreate() {
  try {
    chrome.alarms?.create(ALARM, { periodInMinutes: 0.5 });
  } catch {
    /* alarms unavailable — queue still runs while the worker is alive */
  }
}
function alarmClear() {
  try {
    chrome.alarms?.clear(ALARM);
  } catch {
    /* ignore */
  }
}

// Clicking the toolbar icon opens the persistent side panel (not a popup).
try {
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
} catch {
  /* sidePanel unavailable on older Chrome */
}

// ── provider tab plumbing ────────────────────────────────────────────────────
async function ensureProviderTab(provider = 'flow') {
  const cfg = PROVIDER[provider] || PROVIDER.flow;
  const tabs = await chrome.tabs.query({ url: cfg.match });
  const ready = tabs.find((t) => t.status === 'complete');
  if (ready) {
    if (provider === 'leonardo') await chrome.tabs.update(ready.id, { autoDiscardable: false }).catch(() => {});
    return ready;
  }
  const tab = tabs[0] || (await chrome.tabs.create({ url: cfg.url, active: false }));
  if (provider === 'leonardo') await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  await new Promise((resolve) => {
    const listener = (tabId, info) => {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 1200); // let content scripts + grecaptcha/signing init
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
  return tab;
}
const ensureFlowTab = () => ensureProviderTab('flow');

async function probeAiStudio(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'aistudio:getContext' });
    return response?.ok && response?.ready ? response : null;
  } catch {
    return null;
  }
}

async function ensureAiStudioReady(tab) {
  let current = await chrome.tabs.get(tab.id).catch(() => null);
  if (!current) throw new Error('The AI Studio tab was closed. Reopen it to resume the queue.');

  // A dashboard/settings tab is on the right domain but cannot generate. Move
  // to the generator only when needed; an existing prompt page is preserved.
  if (!/^https:\/\/aistudio\.google\.com\/prompts\//i.test(current.url || '')) {
    current = await chrome.tabs.update(current.id, { url: PROVIDER.aistudio.url });
    await waitForTabReady(current.id);
  }

  // Most jobs return on the first probe. During normal Angular route changes,
  // wait for the controls instead of refreshing the page beneath the user.
  for (let attempt = 0; attempt < 12; attempt++) {
    const context = await probeAiStudio(current.id);
    if (context) return await chrome.tabs.get(current.id);
    await sleep(1000);
  }

  // One bounded recovery reload for a stale content script or frozen page.
  // Never loop reloads: if the controls still do not return, surface the error.
  await writeStatus('AI Studio appears stuck — reloading its tab once…', 'running');
  await chrome.tabs.reload(current.id);
  await waitForTabReady(current.id);
  const context = await probeAiStudio(current.id);
  if (!context)
    throw new Error('AI Studio is not ready after one recovery reload. Open image mode and verify the Run button is available.');
  return await chrome.tabs.get(current.id);
}

function isTabReloadError(error) {
  return /message port closed|receiving end does not exist|could not establish connection|frame (?:was )?removed|tab (?:was )?closed|context invalidated|no tab with id|asynchronous response|provider tab (?:was closed|reload timed out)/i.test(
    String(error?.message || error || '')
  );
}

async function waitForTabReady(tabId, timeoutMs = 60000) {
  const current = await chrome.tabs.get(tabId).catch(() => null);
  if (!current) throw new Error('The provider tab was closed. Reopen it to resume the queue.');
  if (current.status !== 'complete') {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error('Provider tab reload timed out.'));
      }, timeoutMs);
      const listener = (updatedId, info) => {
        if (updatedId === tabId && info.status === 'complete') {
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  }
  // document_idle scripts and Flow's grecaptcha initialize just after complete.
  await sleep(1500);
}

async function send(tabId, message) {
  // Retrying generation is safe for free Flow images. Read-only checks and
  // uploads are safe too. Never retry a paid video submit after losing its
  // response: it may have reached Flow and could charge twice.
  const reloadSafe = new Set([
    'flow:generateImage',
    'flow:uploadImage',
    'flow:checkVideo',
    'flow:getContext',
    'freegen:getContext',
    'leonardo:getContext',
    'leonardo:listModels',
    'leonardo:modelControls',
  ]).has(message?.type);
  const attempts = reloadSafe ? 4 : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, message);
      if (!res || !res.ok)
        throw Object.assign(new Error(res?.error || 'No response from the provider tab.'), {
          limit: !!res?.limit,
        });
      return res;
    } catch (error) {
      if (!reloadSafe || !isTabReloadError(error) || attempt === attempts) throw error;
      await writeStatus('Provider tab refreshed — waiting to resume the current job…', 'running');
      await waitForTabReady(tabId);
    }
  }
  throw new Error('Provider tab did not become ready.');
}

async function responseToPayload(response) {
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return { base64: btoa(binary), mime: response.headers.get('content-type') || 'image/png' };
}

async function fetchImagePayload(imageUrl) {
  const response = await fetch(imageUrl, { credentials: 'include' });
  if (!response.ok) throw new Error(`Generated image download failed (${response.status}).`);
  return responseToPayload(response);
}

// Pollinations is keyless and tabless: build the image URL and fetch it in the
// background worker. No content script, no visible tab. Anonymous tier is rate
// limited (~1 req/15s), so back off and retry on 429/5xx.
function ratioToDims(ratio) {
  switch (ratio) {
    case '1:1':
      return { width: 1024, height: 1024 };
    case '9:16':
      return { width: 768, height: 1344 };
    case '4:3':
      return { width: 1152, height: 896 };
    case '3:4':
      return { width: 896, height: 1152 };
    default:
      return { width: 1344, height: 768 }; // 16:9
  }
}

async function pollinationsGenerate(item, settings) {
  const { width, height } = ratioToDims(item.aspectRatio || settings.aspectRatio);
  const params = new URLSearchParams({
    model: settings.pollinationsModel || 'flux',
    width: String(width),
    height: String(height),
    nologo: 'true',
    referrer: 'story-studio-bulk-asset',
  });
  const seed = String(settings.pollinationsSeed || '').trim();
  if (seed) params.set('seed', seed);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(item.prompt.trim())}?${params}`;
  const headers = {};
  const token = String(settings.pollinationsToken || '').trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await fetch(url, { headers });
    if (r.ok) return responseToPayload(r);
    if ((r.status === 429 || r.status >= 500) && attempt < 3) {
      await writeStatus('Pollinations is rate-limiting — waiting 16s…', 'running');
      await sleep(16000);
      continue;
    }
    if (r.status === 429) {
      const e = new Error('Pollinations rate limit — slow down (register at auth.pollinations.ai for a faster tier).');
      e.limit = true;
      throw e;
    }
    throw new Error(`Pollinations generation failed (${r.status}).`);
  }
}

// Generate one scene's image and save it to Story Studio or Downloads.
// Character reference: upload the chosen character's sheet to Flow ONCE per
// (project, character, file) and cache the returned mediaId, so every character
// scene in the batch reuses it. Runs through the Flow content-script tab.
const refMediaCache = new Map();
async function resolveCharacterRefMediaId(item, settings, tab) {
  const ref = item.characterRef;
  if (!ref || !ref.characterId || !ref.filename) return null;
  const key = `${item.slug}::${ref.characterId}::${ref.filename}`;
  if (refMediaCache.has(key)) return refMediaCache.get(key);
  const client = new StudioClient(settings.studioBaseUrl);
  const img = await client.characterReferenceImageBase64(item.slug, ref.characterId, ref.filename);
  const projectId = normalizeFlowProjectId(item.projectId || settings.flowProjectId);
  const up = await send(tab.id, {
    type: 'flow:uploadImage',
    params: { projectId, base64: img.base64, mime: img.mime, fileName: `char_${ref.characterId}.png` },
  });
  if (up.mediaId) refMediaCache.set(key, up.mediaId);
  return up.mediaId;
}

async function generateAndSave(item, settings, tab) {
  if (!item.prompt || !item.prompt.trim()) throw new Error('Scene has no image prompt.');
  const provider = item.provider || 'flow';

  let base64, mime;
  if (provider === 'pollinations') {
    const payload = await pollinationsGenerate(item, settings);
    base64 = payload.base64;
    mime = payload.mime;
  } else if (provider === 'grok') {
    const r = await send(tab.id, {
      type: 'grok:generateImage',
      params: { prompt: item.prompt, aspectRatio: item.aspectRatio || settings.aspectRatio },
    });
    base64 = r.base64;
    mime = r.mime;
  } else if (provider === 'flow') {
    const projectId = normalizeFlowProjectId(item.projectId || settings.flowProjectId);
    if (!projectId) throw new Error('No Flow project set. Open a Flow project and pick it in the panel.');
    const params = {
      projectId,
      prompt: item.prompt,
      model: item.model || settings.imageModel,
      aspectRatio: item.aspectRatio || settings.aspectRatio,
    };
    // Character reference — only on scenes flagged as character scenes at enqueue.
    if (item.applyRef && item.characterRef) {
      const refId = await resolveCharacterRefMediaId(item, settings, tab);
      if (refId) params.imageInputs = [{ imageInputType: 'IMAGE_INPUT_TYPE_REFERENCE', name: refId }];
    }
    const r = await send(tab.id, { type: 'flow:generateImage', params });
    base64 = r.base64;
    mime = r.mime;
  } else {
    const messageType =
      provider === 'perchance'
        ? 'perchance:generateImage'
        : provider === 'freegen'
          ? 'freegen:generateImage'
          : provider === 'aistudio'
            ? 'aistudio:generateImage'
            : 'leonardo:generateImage';
    const r = await send(tab.id, {
      type: messageType,
      params: {
        prompt: item.prompt,
        aspectRatio: item.aspectRatio || settings.aspectRatio,
        style:
          provider === 'perchance'
            ? settings.perchanceStyle
            : provider === 'leonardo'
              ? settings.leonardoStyle
              : undefined,
        model: provider === 'leonardo' ? settings.leonardoModel : undefined,
        mode: provider === 'leonardo' ? settings.leonardoMode : undefined,
        size: provider === 'leonardo' ? settings.leonardoSize : undefined,
        count:
          provider === 'leonardo'
            ? settings.leonardoCount
            : provider === 'perchance'
              ? settings.perchanceCount
              : undefined,
      },
    });
    const payload = r.base64 ? r : await fetchImagePayload(r.imageUrl);
    base64 = payload.base64;
    mime = payload.mime;
  }
  const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';

  if (item.target === 'project' && item.slug && item.episodeCode && item.sceneKey != null) {
    try {
      const client = new StudioClient(settings.studioBaseUrl);
      const pad = String(item.sceneKey).padStart(2, '0');
      if (item.kind === 'thumbnail') {
        const out = await client.ingestImage(item.slug, item.episodeCode, 'thumbnail', item.sceneKey, base64, item.episodeTitle);
        return { savedAs: out.saved_as || `${item.episodeCode}_Thumb${pad}_v1.png`, target: 'project' };
      }
      if (item.source === 'prompts') {
        const out = await client.ingestImage(item.slug, item.episodeCode, 'scene', item.sceneKey, base64, item.episodeTitle);
        return { savedAs: out.saved_as || `${item.episodeCode}_Scene${pad}_v1.png`, target: 'project' };
      }
      const out = await client.uploadSceneImage(item.slug, item.episodeCode, item.sceneKey, base64);
      return { savedAs: `${item.sceneKey}.png`, target: 'project', sceneId: out.scene_id };
    } catch (error) {
      throw new Error(`Story Studio save failed: ${String(error?.message || error)}`);
    }
  }

  const filename = item.downloadPath.replace(/\.(png|jpg|jpeg|webp)$/i, '') + `.${ext}`;
  const downloadId = await chrome.downloads.download({
    url: `data:${mime};base64,${base64}`,
    filename,
    saveAs: false,
    conflictAction: 'uniquify',
  });
  return { downloadId, savedAs: filename, target: 'download' };
}

// ── video (Veo): async submit -> poll -> background download ────────────────
// The content script submits and reports status; the worker drives the poll
// loop and downloads the finished mp4 itself (the media redirect is
// cross-origin, so it must be fetched from the background with host
// permissions, not from the page). The submitted mediaId is persisted the
// instant we get it, so a worker restart RESUMES polling instead of
// re-submitting — re-submitting would re-charge Veo credits.
function abToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

// Patch one queue item's fields and persist immediately.
async function patchItem(id, patch) {
  const q = await getQueue();
  const it = q.find((i) => i.id === id);
  if (it) Object.assign(it, patch);
  await setQueue(q);
  return it;
}

async function downloadVideoArrayBuffer(mediaId) {
  const url =
    `https://labs.google/fx/api/trpc/media.getMediaUrlRedirect` +
    `?name=${encodeURIComponent(mediaId)}&mediaUrlType=MEDIA_URL_TYPE_FULL_MEDIA`;
  // credentials:'include' carries the labs.google session; the worker follows
  // the 302 to flow-content.google (both in host_permissions) and reads the
  // body — background fetches aren't CORS-bound for permitted hosts.
  const r = await fetch(url, { credentials: 'include' });
  if (!r.ok) throw new Error(`Video download failed (${r.status}).`);
  const buf = await r.arrayBuffer();
  if (!buf.byteLength) throw new Error('Downloaded video was empty.');
  return buf;
}

// Image-to-video: take the scene's image (uploaded existing, or freshly
// generated on Flow) + its motion prompt → Veo start-image clip → save it as
// {scene_id}.mp4 (project) or to Downloads. Every async id is persisted the
// instant we get it, so a worker restart RESUMES rather than re-charging.
async function generateVideoAndSave(item, settings, tab) {
  const projectId = normalizeFlowProjectId(item.projectId || settings.flowProjectId);
  if (!projectId) throw new Error('No Flow project set.');
  const client = new StudioClient(settings.studioBaseUrl);

  // 1. ensure we have the Flow start-image media id.
  if (!item.startMediaId) {
    if (item.videoSource === 'generate') {
      await writeStatus(`${item.label}: generating image…`, 'running');
      const g = await send(tab.id, {
        type: 'flow:generateImage',
        params: {
          projectId,
          prompt: item.imagePrompt || item.prompt,
          model: settings.imageModel,
          aspectRatio: item.aspectRatio || settings.aspectRatio,
        },
      });
      item.startMediaId = g.mediaId;
    } else {
      // animate existing on-disk image
      await writeStatus(`${item.label}: uploading image…`, 'running');
      const img = await client.sceneImageBase64(item.slug, item.episodeCode, item.sceneKey);
      const up = await send(tab.id, {
        type: 'flow:uploadImage',
        params: { projectId, base64: img.base64, mime: img.mime, fileName: `${item.sceneKey}.png` },
      });
      item.startMediaId = up.mediaId;
    }
    await patchItem(item.id, { startMediaId: item.startMediaId, phase: 'submitting' });
  }

  // 2. submit the image-to-video (resume-safe; never re-charge).
  if (!item.videoMediaId) {
    const sub = await send(tab.id, {
      type: 'flow:submitVideoStartImage',
      params: {
        projectId,
        mediaId: item.startMediaId,
        motionPrompt: item.prompt, // the scene's motion_prompt
        model: item.model || settings.videoModel,
        aspectRatio: item.aspectRatio || settings.aspectRatio,
        durationSec: item.durationSec, // request clip ≈ scene window
      },
    });
    item.videoMediaId = sub.mediaId;
    await patchItem(item.id, { videoMediaId: sub.mediaId, workflowId: sub.workflowId, phase: 'polling' });
  }

  // 3. poll until the clip is ready (Veo ~60–180s; allow up to 8 min).
  const deadline = Date.now() + 8 * 60000;
  for (;;) {
    const st = await send(tab.id, { type: 'flow:checkVideo', params: { mediaId: item.videoMediaId, projectId } });
    if (st.done) break;
    if (st.failed) throw new Error(`Flow video generation ${st.status}.`);
    if (Date.now() > deadline) throw new Error(`Video timed out (last status ${st.status}).`);
    await writeStatus(`${item.label}: ${String(st.status).replace('MEDIA_GENERATION_STATUS_', '').toLowerCase()}…`, 'running');
    await sleep(10000);
  }

  // 4. download the mp4 (raw) and save.
  await patchItem(item.id, { phase: 'downloading' });
  const mp4 = await downloadVideoArrayBuffer(item.videoMediaId);
  if (item.target === 'project' && item.sceneKey) {
    await client.uploadClip(item.slug, item.episodeCode, item.sceneKey, mp4);
    return { savedAs: `${item.sceneKey}.mp4`, target: 'project' };
  }
  const filename = item.downloadPath.replace(/\.(mp4|webm)$/i, '') + '.mp4';
  const downloadId = await chrome.downloads.download({
    url: `data:video/mp4;base64,${abToBase64(mp4)}`,
    filename,
    saveAs: false,
    conflictAction: 'uniquify',
  });
  return { downloadId, savedAs: filename, target: 'download' };
}

// ── status (persisted so the panel survives close/reopen) ───────────────────
async function writeStatus(text, kind = 'info') {
  try {
    await chrome.storage.local.set({ lastStatus: { text, kind, ts: Date.now() } });
  } catch {
    /* best-effort */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function randomHumanDelayMs(settings) {
  const min = Math.max(0, Math.round(Number(settings.humanDelayMinSec) || 0));
  const max = Math.max(min, Math.round(Number(settings.humanDelayMaxSec) || 0));
  return (min + Math.floor(Math.random() * (max - min + 1))) * 1000;
}

async function setNextProviderRun(settings) {
  const delayMs = randomHumanDelayMs(settings);
  await chrome.storage.local.set({ [NEXT_PROVIDER_RUN_KEY]: Date.now() + delayMs });
  return delayMs;
}

async function waitForNextProviderRun(item) {
  for (;;) {
    const { [NEXT_PROVIDER_RUN_KEY]: nextRunAt = 0 } = await chrome.storage.local.get(NEXT_PROVIDER_RUN_KEY);
    const remaining = Number(nextRunAt) - Date.now();
    if (remaining <= 0) return;
    const seconds = Math.max(1, Math.ceil(remaining / 1000));
    await writeStatus(`Waiting ${seconds}s before ${PROVIDER_NAME[item.provider] || 'provider'} request: ${item.label}`, 'info');
    await sleep(Math.min(remaining, 10000));
  }
}

// ── the queue ───────────────────────────────────────────────────────────────
function diagnoseFailure(error, item = {}) {
  const raw = String(error?.message || error || 'Unknown error');
  const text = raw.toLowerCase();
  const provider = PROVIDER_NAME[item.provider] || 'Flow';
  const match = (pattern) => pattern.test(text);

  if (match(/story studio save failed|story studio rejected|scene image not found|scene image is empty/))
    return {
      code: 'save',
      title: 'Story Studio save failed',
      hint: 'Test the Studio connection and access settings, then retry.',
      raw,
    };
  if (match(/resource has been exhausted|quota|rate.?limit|too many requests|\b429\b|daily free limit/))
    return {
      code: 'quota',
      title: `${provider} quota reached`,
      hint: 'Wait for the limit to reset or switch to another signed-in account, then retry.',
      raw,
    };
  if (match(/not signed in|sign in again|no access_token|unauthori[sz]ed|\b401\b|authentication/))
    return {
      code: 'auth',
      title: `${provider} sign-in expired`,
      hint: `Sign in again in the ${provider} tab, reload it, then retry.`,
      raw,
    };
  if (match(/recaptcha|captcha evaluation|grecaptcha/))
    return {
      code: 'recaptcha',
      title: `${provider} verification failed`,
      hint: `Reload the ${provider} tab, complete any browser check, then retry.`,
      raw,
    };
  if (match(/safety|responsible ai|policy|blocked prompt|prohibited|moderation/))
    return {
      code: 'safety',
      title: 'Prompt rejected by safety filters',
      hint: 'Revise the prompt to remove sensitive or restricted wording, then retry.',
      raw,
    };
  if (match(/invalid argument|no flow project|project.*(?:not found|invalid)|\b400\b|\b404\b/))
    return {
      code: 'request',
      title: 'Invalid project or generation request',
      hint: 'Open the intended Flow project, select it again in the panel, and verify the model and prompt.',
      raw,
    };
  if (match(/provider tab|message port|receiving end|could not establish connection|frame .*removed|context invalidated/))
    return {
      code: 'tab',
      title: `${provider} tab disconnected`,
      hint: `Keep the ${provider} tab open, reload it, then retry.`,
      raw,
    };
  if (match(/network|failed to fetch|load failed|offline|connection|\b5\d\d\b|service unavailable/))
    return {
      code: 'network',
      title: `${provider} service or network error`,
      hint: 'Check the connection and provider page, wait briefly, then retry.',
      raw,
    };
  if (match(/timed? out|timeout|deadline/))
    return {
      code: 'timeout',
      title: 'Generation timed out',
      hint: 'Check the provider tab for a completed asset before retrying, especially for paid video.',
      raw,
    };
  if (match(/interrupted after submission|outcome is unknown/))
    return {
      code: 'ambiguous',
      title: `${provider} result needs confirmation`,
      hint: `Check the ${provider} tab for a completed image before retrying so tokens are not spent twice.`,
      raw,
    };
  if (match(/asset download|video download|downloaded asset was empty|returned no image url/))
    return {
      code: 'download',
      title: 'Generated asset could not be downloaded',
      hint: 'Check whether the asset exists in Flow, then retry the save or generation.',
      raw,
    };
  if (match(/is not available for (?:this|the selected) model|model .* is not available/))
    return {
      code: 'settings',
      title: 'Selected option not offered by this model',
      hint: 'Pick the model in the side panel and re-check its style/mode/size options, then retry.',
      raw,
    };
  if (match(/permission denied|forbidden|\b403\b/))
    return {
      code: 'access',
      title: `${provider} access denied`,
      hint: `Check that the signed-in ${provider} account can access the selected project, then retry.`,
      raw,
    };
  return {
    code: 'unknown',
    title: 'Unclassified generation failure',
    hint: 'Open the details below and use the raw message to investigate before retrying.',
    raw,
  };
}

async function getQueue() {
  const { queue = [] } = await chrome.storage.local.get(QUEUE_KEY);
  let changed = false;
  for (const item of queue) {
    if (item.status === 'failed' && item.error && !item.failure) {
      item.failure = diagnoseFailure(item.error, item);
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ [QUEUE_KEY]: queue });
  return queue;
}
async function setQueue(q) {
  await chrome.storage.local.set({ [QUEUE_KEY]: q });
}

let _seq = 0;
function mkItem(o) {
  return { id: `${Date.now()}_${_seq++}`, status: 'pending', queuedAt: Date.now(), ...o };
}

let processing = false;

// Identity of a scene item, used to dedupe (so a double-click — or re-queuing
// an episode — can't add the same scene twice and waste work/credits).
function itemKey(it) {
  return it.episodeCode && it.sceneKey != null
    ? `${it.provider || 'flow'}::${it.episodeCode}::${it.assetType}::${it.kind}::${it.source}::${it.sceneKey}`
    : null;
}

async function enqueue(items) {
  if (!items?.length) return { ok: true, added: 0, skipped: 0 };
  let q = await getQueue();
  // If the previous run is fully finished, start a fresh queue so old
  // done/failed entries don't pile up.
  if (!q.some((i) => i.status === 'pending' || i.status === 'running')) q = [];
  const active = new Set(
    q.filter((i) => i.status === 'pending' || i.status === 'running').map(itemKey).filter(Boolean)
  );
  let added = 0;
  let skipped = 0;
  for (const it of items) {
    const key = itemKey(it);
    if (key && active.has(key)) {
      skipped++;
      continue;
    }
    q.push({ ...it, id: it.id || `${Date.now()}_${_seq++}`, status: 'pending', queuedAt: it.queuedAt || Date.now() });
    if (key) active.add(key);
    added++;
  }
  await setQueue(q);
  if (added) {
    alarmCreate();
    processQueue();
  }
  return { ok: true, added, skipped };
}

// Remove a single item from the queue — only if it hasn't started yet.
async function removeFromQueue(id) {
  const q = await getQueue();
  await setQueue(q.filter((i) => !(i.id === id && i.status === 'pending')));
  return { ok: true };
}

async function retryFailed(id = null) {
  const q = await getQueue();
  let retried = 0;
  let skippedPaid = 0;
  for (const item of q) {
    if (item.status !== 'failed' || (id && item.id !== id)) continue;
    // A paid submit with no returned media id is ambiguous: Flow may have
    // accepted it before the tab reloaded. Only a deliberate single-item retry
    // may resubmit it; bulk retry skips it to avoid surprise double charges.
    if (!id && item.assetType === 'video' && item.phase === 'submitting' && !item.videoMediaId) {
      skippedPaid++;
      continue;
    }
    item.status = 'pending';
    delete item.error;
    delete item.failure;
    delete item.startedAt;
    delete item.finishedAt;
    delete item.durationMs;
    retried++;
  }
  await setQueue(q);
  if (retried) {
    await writeStatus(`Retrying ${retried} failed job${retried === 1 ? '' : 's'}…`, 'running');
    alarmCreate();
    processQueue();
  }
  return { ok: true, retried, skippedPaid };
}

// Expand an episode (or list of scenes) into queue items. Done worker-side so
// the panel stays snappy and dedupe is centralised.
async function enqueueScenes({ slug, episodeCode, episodeTitle, projectName, scenes, source, kind, target, projectId, assetType, provider, characterRef }) {
  const settings = await getSettings();
  const prov = provider || settings.provider || 'flow';
  const src = source || 'plan'; // 'plan' (scene_plan) | 'prompts' (03/04 prompts)
  const akind = kind === 'thumbnail' ? 'thumbnail' : 'scene'; // asset kind
  const stem = akind === 'thumbnail' ? 'Thumb' : 'Scene';
  // Only Flow supports video; every web generator provider is image-only.
  const isVideo = assetType === 'video' && prov === 'flow' && akind === 'scene';
  const effTarget = target || settings.saveTarget;

  // Character reference (Flow images only). Gate by scene_type so the sheet only
  // lands on character scenes — read the raw scene plan (scene-review doesn't
  // expose scene_type). Untagged scenes count as character (matches SS's
  // renderer). Non-plan sources have no scene_type, so the reference applies to
  // all of them.
  const wantRef = prov === 'flow' && !isVideo && akind === 'scene' && !!(characterRef && characterRef.characterId && characterRef.filename);
  let sceneTypeById = null;
  if (wantRef && src === 'plan') {
    try {
      const plan = await new StudioClient(settings.studioBaseUrl).scenePlan(slug, episodeCode);
      sceneTypeById = new Map((plan?.scene_plan?.scenes || []).map((s) => [s.id, s.scene_type]));
    } catch {
      sceneTypeById = null; // fail-open: if we can't read types, reference all
    }
  }
  const appliesRef = (key) => {
    if (!wantRef) return false;
    if (src !== 'plan' || !sceneTypeById) return true;
    const t = sceneTypeById.get(key);
    return t === 'character' || t == null;
  };

  // scenes are normalized: { source, key, label, prompt, hasImage }
  const items = (scenes || []).map((s) =>
    mkItem({
      kind: akind, // 'scene' | 'thumbnail'
      provider: prov,
      source: src,
      assetType: isVideo ? 'video' : 'image',
      slug,
      episodeCode,
      episodeTitle: episodeTitle || '',
      sceneKey: s.key, // scene_plan id (string) OR scene/thumb prompts number
      prompt: s.prompt, // image: visual prompt; video: the scene's motion prompt
      imagePrompt: isVideo ? s.imagePrompt || '' : undefined, // video "generate" mode
      videoSource: isVideo ? settings.videoSource : undefined, // 'existing' | 'generate'
      durationSec: isVideo ? s.durationSec : undefined, // request clip ≈ scene window
      target: effTarget,
      projectId: normalizeFlowProjectId(projectId || settings.flowProjectId),
      model: isVideo ? settings.videoModel : settings.imageModel,
      aspectRatio: settings.aspectRatio,
      applyRef: appliesRef(s.key),
      characterRef: appliesRef(s.key) ? characterRef : undefined,
      label: `${episodeCode} ${isVideo ? 'video · ' : ''}${s.label || akind + ' ' + s.key}`,
      // tokens for Downloads naming:
      project: projectName || episodeTitle || slug,
      downloadPath:
        effTarget === 'project'
          ? null
          : buildDownloadPath(
              settings,
              {
                project: projectName || episodeTitle || slug,
                episodeCode,
                episodeTitle: episodeTitle || '',
                sceneId: src === 'plan' && akind === 'scene' ? s.key : `${stem}${String(s.key).padStart(2, '0')}`,
                sceneIndex: String(s.key),
              },
              isVideo ? 'mp4' : 'png'
            ),
    })
  );
  return enqueue(items);
}

async function processQueue() {
  if (processing) return;
  processing = true;
  try {
    let settings = await getSettings();
    const tabs = {}; // per-provider tab cache
    for (;;) {
      if (await isPaused()) {
        await writeStatus('Queue paused — press Resume to continue.', 'info');
        break;
      }
      let q = await getQueue();
      const idx = q.findIndex((i) => i.status === 'pending');
      if (idx < 0) break;
      const pendingId = q[idx].id;
      await waitForNextProviderRun(q[idx]);
      // Re-check after the human-pace delay (it can be up to a minute long).
      if (await isPaused()) {
        await writeStatus('Queue paused — press Resume to continue.', 'info');
        break;
      }
      settings = await getSettings();
      q = await getQueue();
      const currentIdx = q.findIndex((i) => i.id === pendingId && i.status === 'pending');
      if (currentIdx < 0) continue;
      q[currentIdx].status = 'running';
      q[currentIdx].startedAt = q[currentIdx].startedAt || Date.now();
      delete q[currentIdx].finishedAt;
      delete q[currentIdx].durationMs;
      await setQueue(q);
      const item = q[currentIdx];
      const provider = item.provider || 'flow';
      const pos = q.filter((i) => i.status === 'done' || i.status === 'failed').length + 1;
      await writeStatus(`(${pos}/${q.length}) ${item.label}…`, 'running');
      let providerAttempted = false;
      try {
        if (!TABLESS.has(provider) && !tabs[provider]) tabs[provider] = await ensureProviderTab(provider);
        if (provider === 'aistudio') tabs[provider] = await ensureAiStudioReady(tabs[provider]);
        await setNextProviderRun(settings);
        providerAttempted = true;
        const r =
          item.assetType === 'video'
            ? await generateVideoAndSave(item, settings, tabs[provider])
            : await generateAndSave(item, settings, tabs[provider]);
        q = await getQueue();
        const it = q.find((i) => i.id === item.id);
        if (it) {
          it.status = 'done';
          delete it.error;
          delete it.failure;
          it.savedAs = r.savedAs;
          it.finishedAt = Date.now();
          it.durationMs = it.finishedAt - (it.startedAt || it.finishedAt);
        }
        await setQueue(q);
      } catch (e) {
        // A provider limit pauses the run instead of failing the whole
        // batch. Re-pend this item, stop the loop, and don't auto-hammer — it
        // resumes when the panel/worker next kicks the queue (e.g. tomorrow).
        if (e && e.limit) {
          q = await getQueue();
          const it = q.find((i) => i.id === item.id);
          if (it) {
            it.status = 'pending';
            delete it.startedAt;
          }
          await setQueue(q);
          const name = PROVIDER_NAME[provider] || provider;
          const detail = e.message ? ` ${e.message}` : '';
          await writeStatus(`${name} limit reached — paused.${detail} Resume after it resets, or switch model/provider.`, 'info');
          alarmClear();
          return;
        }
        // A page reload is a transport interruption, not a generation result.
        // Put safe/resumable work back at the front and let the alarm wake it
        // after the provider tab settles instead of permanently skipping it.
        const resumableVideo = item.assetType === 'video' && (item.videoMediaId || item.phase !== 'submitting');
        if (isTabReloadError(e) && (item.assetType !== 'video' || resumableVideo)) {
          q = await getQueue();
          const it = q.find((i) => i.id === item.id);
          if (it) {
            it.status = 'pending';
            delete it.error;
          }
          await setQueue(q);
          await writeStatus('Provider tab interrupted — current job will retry automatically…', 'running');
          alarmCreate();
          return;
        }
        q = await getQueue();
        const it = q.find((i) => i.id === item.id);
        if (it) {
          it.status = 'failed';
          it.error = String(e.message || e);
          it.failure = diagnoseFailure(e, it);
          it.finishedAt = Date.now();
          it.durationMs = it.finishedAt - (it.startedAt || it.finishedAt);
        }
        await setQueue(q);
      } finally {
        if (providerAttempted) await setNextProviderRun(settings);
      }
      const more = (await getQueue()).some((i) => i.status === 'pending');
      if (more) await waitForNextProviderRun(item);
    }
    const q = await getQueue();
    if (q.length) {
      const done = q.filter((i) => i.status === 'done').length;
      const failed = q.filter((i) => i.status === 'failed').length;
      await writeStatus(`✓ Queue finished: ${done} saved${failed ? `, ${failed} failed` : ''}.`, 'done');
    }
    alarmClear();
  } finally {
    processing = false;
  }
}

// Drop everything not yet started; let an in-flight item finish on its own.
async function clearQueue() {
  const q = (await getQueue()).filter((i) => i.status === 'running');
  await setQueue(q);
  await writeStatus('Queue cleared.', 'info');
  return { ok: true };
}

// Resume after a worker restart: re-pend any item that was mid-flight when the
// worker died, then keep going if anything is pending.
(async () => {
  const q = await getQueue();
  let changed = false;
  for (const i of q)
    if (i.status === 'running') {
      if (i.provider === 'leonardo' && i.assetType === 'image') {
        i.status = 'failed';
        i.error = 'Leonardo generation was interrupted after submission; its outcome is unknown. Check the Leonardo tab before retrying.';
        i.failure = diagnoseFailure(i.error, i);
        i.finishedAt = Date.now();
        i.durationMs = i.finishedAt - (i.startedAt || i.finishedAt);
      } else {
        i.status = 'pending';
        delete i.startedAt;
      }
      changed = true;
    }
  if (changed) await setQueue(q);
  if (q.some((i) => i.status === 'pending')) {
    alarmCreate();
    processQueue();
  }
})();

chrome.alarms?.onAlarm?.addListener((a) => {
  if (a.name === ALARM) processQueue();
});

// Probe the active Flow tab for its current project id / sign-in state.
async function flowContext() {
  const tab = await ensureFlowTab();
  const r = await send(tab.id, { type: 'flow:getContext' });
  return { ok: true, ...r.result };
}

// Probe Grok: signed in? has a captured request template (needed to generate)?
async function grokContext() {
  const tab = await ensureProviderTab('grok');
  const r = await send(tab.id, { type: 'grok:getContext' });
  return { ok: true, ...r.result };
}

async function webGeneratorContext(provider) {
  if (!PROVIDER[provider] || provider === 'flow' || provider === 'grok') throw new Error('Unknown web generator.');
  const tab = await ensureProviderTab(provider);
  const messageType =
    provider === 'perchance'
      ? 'perchance:getContext'
      : provider === 'freegen'
        ? 'freegen:getContext'
        : provider === 'aistudio'
          ? 'aistudio:getContext'
          : 'leonardo:getContext';
  const r = await send(tab.id, { type: messageType });
  return { ok: true, ...r.result };
}

// Read Leonardo's live model catalogue from the picker on its own tab, so the
// Options dropdown can pick up new models without a code change.
async function listLeonardoModels() {
  const tab = await ensureProviderTab('leonardo');
  const r = await send(tab.id, { type: 'leonardo:listModels' });
  return { ok: true, ...r.result };
}

// Select a model on the Leonardo tab and report which controls it really
// offers (modes/sizes/ratios/maxCount/styles) so the panel can adapt.
async function leonardoModelControls(model) {
  const tab = await ensureProviderTab('leonardo');
  const r = await send(tab.id, { type: 'leonardo:modelControls', params: { model } });
  return { ok: true, ...r.result };
}

// Resume a paused/pending queue (user pause, or e.g. a Grok daily-limit pause).
async function resumeQueue() {
  await chrome.storage.local.remove(PAUSE_KEY);
  alarmCreate();
  processQueue();
  return { ok: true };
}

async function pauseQueue() {
  await chrome.storage.local.set({ [PAUSE_KEY]: true });
  // If something is mid-generation it finishes and saves; the loop then stops.
  await writeStatus(processing ? 'Pausing — finishing the current item first…' : 'Queue paused — press Resume to continue.', 'info');
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const reply = (p) =>
    p.then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
  switch (msg?.type) {
    case 'flow:projectSeen':
      // A Flow project tab announced its id; remember it for the panel.
      chrome.storage.local.set({ [SEEN_PROJECT_KEY]: msg.projectId });
      return false; // no async response needed
    case 'enqueueScenes':
      reply(enqueueScenes(msg.payload));
      return true;
    case 'removeItem':
      reply(removeFromQueue(msg.id));
      return true;
    case 'retryFailed':
      reply(retryFailed(msg.id || null));
      return true;
    case 'clearQueue':
      reply(clearQueue());
      return true;
    case 'getQueue':
      // Reopening the panel nudges a stalled queue — but never overrides an
      // explicit user pause.
      reply(
        (async () => {
          const [queue, paused] = await Promise.all([getQueue(), isPaused()]);
          if (!paused && queue.some((i) => i.status === 'pending') && !processing) {
            alarmCreate();
            processQueue();
          }
          return { ok: true, queue, paused };
        })()
      );
      return true;
    case 'pauseQueue':
      reply(pauseQueue());
      return true;
    case 'flowContext':
      reply(flowContext());
      return true;
    case 'grokContext':
      reply(grokContext());
      return true;
    case 'webGeneratorContext':
      reply(webGeneratorContext(msg.provider));
      return true;
    case 'listLeonardoModels':
      reply(listLeonardoModels());
      return true;
    case 'leonardoModelControls':
      reply(leonardoModelControls(msg.model));
      return true;
    case 'resumeQueue':
      reply(resumeQueue());
      return true;
    default:
      return false;
  }
});
