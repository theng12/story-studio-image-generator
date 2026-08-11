// Service worker — a persistent, resumable generation QUEUE for scene assets.
//
// The panel enqueues work (one scene, a whole episode, or a whole project);
// this worker processes one scene at a time, human-paced, generating the image
// on Google Flow and writing each result back to the Story Studio episode. The
// queue lives in chrome.storage, so it survives the panel
// closing AND the worker being killed: a chrome.alarms tick wakes the worker to
// resume any pending items.
//
// Strictly sequential — only ever one provider generation in flight, so sites
// are never flooded no matter how much image work is queued.

import { getSettings, saveSettings, normalizeFlowProjectId, providerCooldown } from './lib/config.js';
import { StudioClient } from './lib/story-studio.js';
import { flowCommand } from './lib/flow-exec.js';
import { DEFAULT_PROVIDER_ID, PROVIDERS, getProvider, isMaintainedProvider, limitProviderReferences } from './lib/providers.js';
import {
  assertSupportedProjectScene,
  canRetryItem,
  migrateQueue,
  unsupportedSceneQueueItem,
} from './lib/queue-migration.js';
import { enqueueItems } from './lib/queue-operations.js';
import { createQueueStore } from './lib/queue-store.js';
import { legacyCharacterReferenceDescriptor, normalizeReferenceContext, referenceCacheKey, resolveReferenceDescriptors } from './lib/reference-assets.js';
import {
  ambiguousLeonardoQueueItem,
  isAmbiguousLeonardoFailure,
  isKnownPreSubmitLimit,
  providerLabelForItem,
} from './lib/failure-policy.js';

const FLOW_URL = 'https://labs.google/fx/tools/flow';
// How many images have gone into the CURRENT Flow project — drives auto rollover.
const FLOW_COUNT_KEY = 'flowProjectImageCount';
const PROVIDER = Object.freeze(Object.fromEntries(PROVIDERS.map(({ id, workspace }) => [id, workspace])));
const PROVIDER_NAME = Object.freeze(Object.fromEntries(PROVIDERS.map(({ id, label }) => [id, label])));
const PROVIDER_SCRIPTS = Object.freeze(
  Object.fromEntries(PROVIDERS.filter(({ scripts }) => scripts).map(({ id, scripts }) => [id, scripts]))
);

function providerRemovedError(provider) {
  const error = new Error(`The ${provider || 'unknown'} provider is not supported by this extension.`);
  error.code = 'provider-removed';
  return error;
}
const QUEUE_KEY = 'queue';
// User-requested pause: the current item finishes, then the loop stops before
// the next one starts. Persisted so it survives service-worker death.
const PAUSE_KEY = 'queuePaused';

const isPaused = async () => !!(await chrome.storage.local.get(PAUSE_KEY))[PAUSE_KEY];

// "(pos/total) label" of the item currently running — reused to show live
// sub-phase progress (e.g. Qwen "uploading reference" → "generating").
let runStatusPrefix = '';
const ALARM = 'queueTick';
// Dedicated fleet heartbeat alarm (30s). The queueTick alarm is cleared when the
// queue drains, so an idle machine would stop reporting and drop offline; this
// one stays scheduled while the agent is enabled, waking the worker to check in.
const FLEET_ALARM = 'fleetTick';
const FLEET_IDENTITY_KEY = 'fleetV2Identity';
const FLEET_QUEUE_REVISION_KEY = 'fleetV2QueueRevision';
const FLEET_RESPONSE_NONCES_KEY = 'fleetV2ResponseNonces';
const FLEET_COMMAND_RECEIPTS_KEY = 'fleetV2CommandReceipts';
const FLEET_HUB_PAUSE_KEY = 'fleetV2HubPause';
const SEEN_PROJECT_KEY = 'lastSeenFlowProjectId';
const NEXT_PROVIDER_RUN_KEY = 'nextProviderRunAt';
// Per-provider auto-resume timestamps: { [provider]: resumeAtMs }. One key so a
// cooldown is scoped to the provider that hit its limit and never blocks others.
const COOLDOWN_KEY = 'cooldownUntil';

const getCooldowns = async () => (await chrome.storage.local.get(COOLDOWN_KEY))[COOLDOWN_KEY] || {};
async function setCooldownUntil(provider, resumeAt) {
  const map = await getCooldowns();
  map[provider] = resumeAt;
  await chrome.storage.local.set({ [COOLDOWN_KEY]: map });
}
const clearCooldowns = () => chrome.storage.local.remove(COOLDOWN_KEY);

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
  const cfg = PROVIDER[provider];
  if (!cfg) throw providerRemovedError(provider);
  const tabs = await chrome.tabs.query({ url: cfg.match });
  const ready = tabs.find((t) => t.status === 'complete');
  if (ready) {
    if (provider === 'leonardo' || provider === 'qwen')
      await chrome.tabs.update(ready.id, { autoDiscardable: false }).catch(() => {});
    return ready;
  }
  const tab = tabs[0] || (await chrome.tabs.create({ url: cfg.url, active: false }));
  if (provider === 'leonardo' || provider === 'qwen')
    await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
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

// Roll over to a fresh Flow project. A project accumulates every generated image
// and its page gets heavy over time; a new one keeps the tab light. We CREATE a
// real project via Flow's own tRPC endpoint first (navigating to an un-created
// UUID just shows "Something went wrong" — verified live 2026-07-09), then point
// the tab at it, make it the active project, and move any remaining pending Flow
// scenes onto it so the rest of the batch lands there too. On any failure we keep
// the current project so generation is never broken.
async function startNewFlowProject(reason) {
  const tab = await ensureFlowTab();
  let projectId, title;
  try {
    const r = await send(tab.id, { type: 'flow:createProject', params: {} });
    if (!r || !r.ok || !r.projectId) throw new Error((r && r.error) || 'no projectId returned');
    projectId = r.projectId;
    title = r.title || '';
  } catch (e) {
    await writeStatus(`Couldn't start a new Flow project: ${String(e.message || e)}`, 'err');
    return null; // keep the current project — don't break generation
  }
  // Point the tab at the new (real) project so it's active + light.
  try {
    await chrome.tabs.update(tab.id, { url: `${FLOW_URL}/project/${projectId}`, autoDiscardable: false });
    await new Promise((resolve) => {
      const done = () => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      };
      const listener = (tabId, info) => {
        if (tabId === tab.id && info.status === 'complete') setTimeout(done, 1500); // let content scripts + grecaptcha init
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(done, 20000); // safety: never hang the queue on navigation
    });
  } catch {
    /* navigation is best-effort — generation is keyed by projectId regardless */
  }
  await saveSettings({ flowProjectId: projectId, flowProjectName: title });
  await chrome.storage.local.set({ [FLOW_COUNT_KEY]: 0 });
  // Send the rest of this batch to the new project too.
  await queueStore.update((queue) => {
    for (const item of queue) {
      if (item.provider === 'flow' && item.status === 'pending') item.projectId = projectId;
    }
    return queue;
  });
  await writeStatus(`Started a new Flow project (${reason}).`, 'info');
  return projectId;
}

// Panel "↗ Open provider" click: focus an existing tab for the provider's
// generation page, or open a new active one.
async function openProviderPage(provider) {
  const cfg = PROVIDER[provider];
  if (!cfg) return { ok: false, error: providerRemovedError(provider).message };
  const tabs = await chrome.tabs.query({ url: cfg.match });
  if (tabs[0]) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true }).catch(() => {});
    return { ok: true };
  }
  await chrome.tabs.create({ url: cfg.url, active: true });
  return { ok: true };
}

// Which provider a message targets, but only for providers we can re-inject
// (a MAIN+isolated pair in PROVIDER_SCRIPTS). Used to auto-heal a tab whose
// content script is missing/stale — e.g. a provider tab open from before the
// extension loaded. Prefix of "<provider>:generateImage" etc. is the provider.
function providerForMessage(type) {
  const provider = String(type || '').split(':')[0];
  return PROVIDER_SCRIPTS[provider] ? provider : null;
}

function isMissingReceiverError(error) {
  return /receiving end does not exist|could not establish connection/i.test(String(error?.message || error || ''));
}

async function restoreProviderScripts(provider, tabId) {
  const scripts = PROVIDER_SCRIPTS[provider];
  if (!scripts) throw new Error(`${PROVIDER_NAME[provider] || 'Provider'} cannot restore its page connection automatically.`);
  if (scripts.mainWorld) {
    await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: [scripts.main] });
    await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', files: [scripts.isolated] });
  } else {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      files: [scripts.main, scripts.isolated],
    });
  }
  await sleep(250);
}

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

// Generate on the regular ChatGPT (chatgpt.com) with a FRESH chat every scene:
// navigate to the new-chat root before each one. This full page LOAD is
// load-bearing, not leftover batch cruft — verified live 2026-07-13 that a 2nd
// image request in the same page session stalls ("Adding final touches…/One last
// tweak…", no new image) and only a page refresh clears it (likely OpenAI
// automation/abuse throttling on repeated same-session sends). A fresh load per
// scene is that refresh, and also gives each image its own clean chat (a chat is
// a conversation, so images can't share one). After a scene the tab sits on
// /c/<id>; navigating back to the root reloads a clean composer.
async function ensureChatgptReady(tab, settings) {
  let current = await chrome.tabs.get(tab.id).catch(() => null);
  if (!current) throw new Error('The ChatGPT tab was closed. Reopen it to resume the queue.');
  let path = '';
  try {
    path = new URL(current.url || '').pathname.replace(/\/+$/, '');
  } catch {
    /* leave blank → navigate */
  }
  // Reload to a clean new chat unless we're already on the bare root.
  if (path !== '') {
    current = await chrome.tabs.update(current.id, { url: 'https://chatgpt.com/' });
    await waitForTabReady(current.id);
    await sleep(1200); // let the composer hydrate
  }
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
  if (String(message?.type || '').startsWith('flow:')) {
    const tab = await chrome.tabs.get(tabId);
    if (!/^https:\/\/labs\.google\/fx\//i.test(tab?.url || '')) {
      throw new Error('Refusing to run a Flow command outside labs.google/fx.');
    }
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: flowCommand,
      args: [{ op: message.type.slice('flow:'.length), payload: message.params || {} }],
    });
    if (!result?.ok) throw new Error(result?.error || 'Flow command failed.');
    return { ok: true, ...result.result, result: result.result };
  }
  // Retrying generation is safe for free Flow images. Read-only checks and
  // uploads are safe too.
  const reloadSafe = new Set([
    'flow:generateImage',
    'flow:uploadImage',
    'flow:getContext',
    'chatgpt:getContext',
    'leonardo:getContext',
    'leonardo:listModels',
    'leonardo:modelControls',
    'qwen:getContext',
  ]).has(message?.type);
  const attempts = reloadSafe ? 4 : 1;
  const provider = providerForMessage(message?.type);
  let restoredScripts = false;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, message);
      if (!res || !res.ok)
        throw Object.assign(new Error(res?.error || 'No response from the provider tab.'), {
          limit: !!res?.limit,
          submitted: res?.submitted,
        });
      return res;
    } catch (error) {
      // Tabs that survived an extension update still contain the old, now
      // invalid content-script context. A missing receiver means the page
      // operation never started, so reinjection and one retry are safe even
      // for a generation request.
      if (provider && !restoredScripts && isMissingReceiverError(error)) {
        await writeStatus(`Restoring the ${PROVIDER_NAME[provider]} tab connection…`, 'running');
        await restoreProviderScripts(provider, tabId);
        restoredScripts = true;
        attempt--;
        continue;
      }
      if (!reloadSafe || !isTabReloadError(error) || attempt === attempts) throw error;
      await writeStatus('Provider tab refreshed — waiting to resume the current job…', 'running');
      await waitForTabReady(tabId);
    }
  }
  throw new Error('Provider tab did not become ready.');
}

async function responseToPayload(response) {
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > 50 * 1024 * 1024) throw new Error('Generated image exceeded 50 MB.');
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return { base64: btoa(binary), mime: response.headers.get('content-type') || 'image/png' };
}

const IMAGE_DOWNLOAD_HOSTS = {
  chatgpt: ['oaiusercontent.com'],
  qwen: ['cdn.qwenlm.ai'],
  leonardo: ['leonardo.ai'],
};

function hostnameAllowed(hostname, suffixes) {
  return suffixes.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

async function fetchImagePayload(provider, imageUrl) {
  const url = new URL(String(imageUrl || ''));
  const allowed = IMAGE_DOWNLOAD_HOSTS[provider] || [];
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    !hostnameAllowed(url.hostname, allowed)
  ) {
    throw new Error(`${PROVIDER_NAME[provider] || 'Provider'} returned an untrusted image URL.`);
  }
  const response = await fetch(url.href, { credentials: 'omit', redirect: 'error' });
  if (!response.ok) throw new Error(`Generated image download failed (${response.status}).`);
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.startsWith('image/')) throw new Error('Generated asset was not an image.');
  const length = Number(response.headers.get('content-length')) || 0;
  if (length > 50 * 1024 * 1024) throw new Error('Generated image exceeded 50 MB.');
  return responseToPayload(response);
}

// Reference descriptors persist as small URLs. Image bytes are fetched only
// when a job runs and cached for this worker lifetime, never in queue storage.
const refImageCache = new Map();
async function resolveReferenceImages(item, settings, provider) {
  const references = limitProviderReferences(
    provider,
    Array.isArray(item.referenceDescriptors) ? item.referenceDescriptors : []
  );
  const descriptors = references;
  if (!descriptors.length) return [];
  const client = new StudioClient(settings.studioBaseUrl);
  return Promise.all(descriptors.map(async (descriptor, index) => {
    const sourceKey = referenceCacheKey(settings.studioBaseUrl, descriptor?.url);
    if (!descriptor?.url) throw new Error(`Story Studio reference ${descriptor?.label || index + 1} has no download URL.`);
    let request = refImageCache.get(sourceKey);
    if (!request) {
      request = client.referenceAssetBase64(descriptor);
      refImageCache.set(sourceKey, request);
    }
    try {
      const image = await request;
      return {
        base64: image.base64,
        mime: image.mime,
        sourceKey,
        name: descriptor.filename || `reference-${index + 1}.png`,
        label: descriptor.label || `Reference ${index + 1}`,
      };
    } catch (error) {
      refImageCache.delete(sourceKey);
      throw error;
    }
  }));
}

const refMediaCache = new Map();
async function resolveReferenceMediaIds(item, settings, tab) {
  const references = await resolveReferenceImages(item, settings, 'flow');
  if (!references.length) return [];
  const projectId = normalizeFlowProjectId(item.projectId || settings.flowProjectId);
  const mediaIds = [];
  for (const reference of references) {
    const key = `${projectId}::${reference.sourceKey}`;
    let mediaId = refMediaCache.get(key);
    if (!mediaId) {
      const up = await send(tab.id, {
        type: 'flow:uploadImage',
        params: { projectId, base64: reference.base64, mime: reference.mime, fileName: reference.name },
      });
      mediaId = up.mediaId;
      if (mediaId) refMediaCache.set(key, mediaId);
    }
    if (mediaId) mediaIds.push(mediaId);
  }
  return mediaIds;
}

async function generateAndSave(item, settings, tab) {
  assertSupportedProjectScene(item);
  if (!item.prompt || !item.prompt.trim()) throw new Error('Scene has no image prompt.');
  const provider = item.provider || DEFAULT_PROVIDER_ID;
  const handlers = {
    chatgpt: async () => {
      const r = await send(tab.id, {
        type: 'chatgpt:generateImage',
        params: {
          prompt: item.prompt,
          aspectRatio: item.aspectRatio || settings.aspectRatio,
          references: await resolveReferenceImages(item, settings, provider),
          maxWaitSec: settings.chatgptMaxWaitSec,
        },
      });
      // The adapter returns in-page PNG bytes when it can, else a URL for the
      // worker to fetch (oaiusercontent can be CORS-locked in the page).
      return r.base64 ? r : fetchImagePayload(provider, r.imageUrl);
    },
    aistudio: async () => {
      return send(tab.id, {
        type: 'aistudio:generateImage',
        params: {
          prompt: item.prompt,
          aspectRatio: item.aspectRatio || settings.aistudioAspectRatio || settings.aspectRatio,
          references: await resolveReferenceImages(item, settings, provider),
        },
      });
    },
    flow: async () => {
      const projectId = normalizeFlowProjectId(item.projectId || settings.flowProjectId);
      if (!projectId) throw new Error('No Flow project set. Open a Flow project and pick it in the panel.');
      const params = {
        projectId,
        prompt: item.prompt,
        model: item.model || settings.imageModel,
        aspectRatio: item.aspectRatio || settings.aspectRatio,
        recaptchaMaxAttempts: settings.flowRecaptchaMaxAttempts,
      };
      const referenceIds = await resolveReferenceMediaIds(item, settings, tab);
      if (referenceIds.length) {
        params.imageInputs = referenceIds.map((name) => ({ imageInputType: 'IMAGE_INPUT_TYPE_REFERENCE', name }));
      }
      return send(tab.id, { type: 'flow:generateImage', params });
    },
    qwen: async () => {
      const r = await send(tab.id, {
        type: 'qwen:generateImage',
        params: {
          prompt: item.prompt,
          aspectRatio: item.aspectRatio || settings.aspectRatio,
          references: await resolveReferenceImages(item, settings, provider),
        },
      });
      return r.base64 ? r : fetchImagePayload(provider, r.imageUrl);
    },
    leonardo: async () => {
      const r = await send(tab.id, {
        type: 'leonardo:generateImage',
        params: {
          prompt: item.prompt,
          aspectRatio: item.aspectRatio || settings.aspectRatio,
          style: settings.leonardoStyle,
          model: settings.leonardoModel,
          mode: settings.leonardoMode,
          size: settings.leonardoSize,
          count: settings.leonardoCount,
        },
      });
      return r.base64 ? r : fetchImagePayload(provider, r.imageUrl);
    },
  };
  const handler = handlers[provider];
  if (!handler) throw providerRemovedError(provider);
  const { base64, mime } = await handler();
  if (item.target === 'download') {
    const ext = mime.includes('webp') ? 'webp' : mime.includes('jpeg') ? 'jpg' : 'png';
    const filename = `${String(item.downloadPath || 'StoryStudioImages/Standalone/image.png').replace(/\.(png|jpg|jpeg|webp)$/i, '')}.${ext}`;
    const downloadId = await chrome.downloads.download({
      url: `data:${mime};base64,${base64}`,
      filename,
      saveAs: false,
      conflictAction: 'uniquify',
    });
    return { downloadId, savedAs: filename, target: 'download' };
  }
  if (!item.slug || !item.episodeCode || item.sceneKey == null) {
    throw new Error('Story Studio project details are required to save an image.');
  }
  try {
    const client = new StudioClient(settings.studioBaseUrl);
    const pad = String(item.sceneKey).padStart(2, '0');
    if (item.kind === 'thumbnail') {
      const out = await client.ingestImage(item.slug, item.episodeCode, 'thumbnail', item.sceneKey, base64, item.episodeTitle);
      return { savedAs: out.saved_as || `${item.episodeCode}_Thumb${pad}_v1.png`, target: 'project' };
    }
    const out = await client.uploadSceneImage(item.slug, item.episodeCode, item.sceneKey, base64);
    return { savedAs: `${item.sceneKey}.png`, target: 'project', sceneId: out.scene_id };
  } catch (error) {
    throw new Error(`Story Studio save failed: ${String(error?.message || error)}`);
  }
}

// ── status (persisted so the panel survives close/reopen) ───────────────────
async function writeStatus(text, kind = 'info', details = {}) {
  try {
    await chrome.storage.local.set({ lastStatus: { text, kind, ts: Date.now(), ...details } });
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
    const provider = PROVIDER_NAME[item.provider] || 'provider';
    await writeStatus(`Waiting ${seconds}s before ${provider} request: ${item.label}`, 'info', {
      countdownUntil: Number(nextRunAt),
      countdownProvider: provider,
      countdownLabel: item.label,
    });
    await sleep(Math.min(remaining, 10000));
  }
}

// Pull a "wait N hours / N minutes" (or Chinese 小时/分钟) out of Qwen's limit
// message. Returns ms, or 0 when nothing parseable.
function parseWaitMs(message) {
  const s = String(message || '');
  const h = s.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|小时|時間|時)/i);
  const m = s.match(/(\d+)\s*(?:minutes?|mins?|分钟|分鐘|分)/i);
  return (h ? parseFloat(h[1]) * 3600000 : 0) + (m ? parseInt(m[1], 10) * 60000 : 0);
}

// Per-provider auto-resume cooldown: hold the queue until this provider's
// resume time, then clear and proceed. Scoped to the given provider so another
// provider's cooldown never blocks it. Self-corrects — if the provider is still
// limited after resuming, the next attempt re-arms this. Only holds while the
// provider's auto-resume toggle is on; otherwise the entry is dropped (a manual
// pause, if any, keeps the queue stopped instead).
async function holdForCooldown(provider, settings) {
  const map = await getCooldowns();
  const resumeAt = Number(map[provider]) || 0;
  if (!providerCooldown(settings, provider).autoResume || resumeAt <= Date.now()) {
    if (resumeAt) {
      delete map[provider];
      await chrome.storage.local.set({ [COOLDOWN_KEY]: map });
    }
    return false;
  }
  const name = PROVIDER_NAME[provider] || provider;
  await writeStatus(`${name} cooldown — the queue will resume automatically.`, 'info', {
    countdownUntil: resumeAt,
    countdownReason: 'cooldown',
    countdownProvider: provider,
  });
  alarmCreate();
  return true;
}

function isFlowRecaptchaFailure(error, item) {
  return (item.provider || 'flow') === 'flow' && diagnoseFailure(error, item).code === 'recaptcha';
}

// ── the queue ───────────────────────────────────────────────────────────────
function diagnoseFailure(error, item = {}) {
  const raw = String(error?.message || error || 'Unknown error');
  const text = raw.toLowerCase();
  const provider = providerLabelForItem(item);
  const match = (pattern) => pattern.test(text);

  if (error?.code === 'provider-removed' || match(/provider (?:was )?removed|provider is not supported/))
    return {
      code: 'provider-removed',
      title: 'Provider removed from Story Studio Image Generator',
      hint: 'Choose a maintained provider and queue this asset again. Jobs are never redirected automatically.',
      raw,
    };

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
      hint: 'Check the provider tab for a completed image before retrying.',
      raw,
    };
  if (match(/interrupted after submission|outcome is unknown/))
    return {
      code: 'ambiguous',
      title: `${provider} result needs confirmation`,
      hint: `Check the ${provider} tab for a completed image before retrying so tokens are not spent twice.`,
      raw,
    };
  if (match(/asset download|downloaded asset was empty|returned no image url/))
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

const queueStore = createQueueStore({
  load: async () => (await chrome.storage.local.get(QUEUE_KEY))[QUEUE_KEY],
  save: async (queue) => {
    const stored = await chrome.storage.local.get(FLEET_QUEUE_REVISION_KEY);
    const revision = Math.max(0, Number(stored[FLEET_QUEUE_REVISION_KEY]) || 0) + 1;
    await chrome.storage.local.set({ [QUEUE_KEY]: queue, [FLEET_QUEUE_REVISION_KEY]: revision });
  },
  normalize: (storedQueue) => {
    const queue = migrateQueue(storedQueue, Date.now());
    for (const item of queue) {
      if (item.status === 'failed' && item.error && !item.failure) {
        item.failure = diagnoseFailure(item.error, item);
      }
    }
    return queue;
  },
});
const getQueue = () => queueStore.read();

async function getQueueRevision() {
  const stored = await chrome.storage.local.get(FLEET_QUEUE_REVISION_KEY);
  return Math.max(0, Number(stored[FLEET_QUEUE_REVISION_KEY]) || 0);
}

let _seq = 0;
function mkItem(o) {
  return { id: `${Date.now()}_${_seq++}`, status: 'pending', queuedAt: Date.now(), ...o };
}

let processing = false;

async function enqueue(items) {
  if (!items?.length) return { ok: true, added: 0, skipped: 0 };
  let added = 0;
  let skipped = 0;
  await queueStore.update((queue) => {
    const result = enqueueItems(queue, items, Date.now());
    added = result.added;
    skipped = result.skipped;
    return result.queue;
  });
  if (added) {
    alarmCreate();
    processQueue();
  }
  return { ok: true, added, skipped };
}

// Remove a single item from the queue — only if it hasn't started yet.
async function removeFromQueue(id) {
  await queueStore.update((queue) => queue.filter((item) => !(item.id === id && item.status === 'pending')));
  return { ok: true };
}

async function retryFailed(id = null) {
  let retried = 0;
  await queueStore.update((queue) => {
    for (const item of queue) {
      if (!canRetryItem(item) || (id && item.id !== id)) continue;
      item.status = 'pending';
      delete item.error;
      delete item.failure;
      delete item.fleetReported; // report this attempt's outcome to the hub again
      delete item.startedAt;
      delete item.finishedAt;
      delete item.durationMs;
      retried++;
    }
    return queue;
  });
  if (retried) {
    await writeStatus(`Retrying ${retried} failed job${retried === 1 ? '' : 's'}…`, 'running');
    alarmCreate();
    processQueue();
  }
  return { ok: true, retried };
}

// Remote retry is deliberately more conservative than the local Retry Failed
// button. A remote command cannot inspect a provider tab, so it may only retry
// an item explicitly marked safe by the local queue in a future adapter.
function isFleetRetrySafe(item) {
  return canRetryItem(item) && item.fleetRetrySafe === true && item.failure?.code !== 'ambiguous';
}

async function retryFleetSafeFailed() {
  let retried = 0;
  await queueStore.update((queue) => {
    for (const item of queue) {
      if (!isFleetRetrySafe(item)) continue;
      item.status = 'pending';
      delete item.error;
      delete item.failure;
      delete item.fleetReported;
      delete item.startedAt;
      delete item.finishedAt;
      delete item.durationMs;
      delete item.fleetRetrySafe;
      retried++;
    }
    return queue;
  });
  if (retried) {
    await writeStatus(`Retrying ${retried} Fleet-safe failed job${retried === 1 ? '' : 's'}…`, 'running');
    alarmCreate();
    processQueue();
  }
  return { retried };
}

// Expand an episode (or list of scenes) into queue items. Done worker-side so
// the panel stays snappy and dedupe is centralised.
async function enqueueScenes({ slug, episodeCode, episodeTitle, scenes, source, kind, projectId, provider, characterRef, fleetJobId }) {
  const src = source;
  const akind = kind === 'thumbnail' ? 'thumbnail' : 'scene';
  assertSupportedProjectScene({ target: 'project', kind: akind, source: src });
  const settings = await getSettings();
  const prov = provider || settings.provider || DEFAULT_PROVIDER_ID;
  if (!isMaintainedProvider(prov)) throw providerRemovedError(prov);
  const providerConfig = getProvider(prov);
  const effTarget = 'project';
  const maxReferences = providerConfig?.capabilities?.maxReferences || 0;

  // Reference metadata is read once for the complete enqueue operation. Each
  // queued item receives only its bounded descriptors; bytes stay lazy.
  let referenceContext = null;
  if (settings.storyStudioReferencesEnabled !== false && providerConfig?.capabilities?.storyStudioReferences && maxReferences) {
    try {
      const client = new StudioClient(settings.studioBaseUrl);
      referenceContext = normalizeReferenceContext(await client.referenceAssets(slug, episodeCode, episodeTitle || ''));
    } catch (error) {
      throw new Error(`Story Studio reference assets could not be read: ${String(error?.message || error)}`);
    }
  }

  // Character reference (Flow / Qwen / ChatGPT images). Gate by scene_type so the
  // sheet only lands on character scenes — read the raw scene plan (scene-review
  // doesn't expose scene_type). Untagged scenes count as character (matches SS's
  // renderer).
  const wantLegacyCharacterRef =
    providerConfig?.capabilities?.characterReferences &&
    akind === 'scene' &&
    !!(characterRef && characterRef.characterId && characterRef.filename);
  let sceneTypeById = null;
  if (wantLegacyCharacterRef && src === 'plan') {
    try {
      const plan = await new StudioClient(settings.studioBaseUrl).scenePlan(slug, episodeCode);
      sceneTypeById = new Map((plan?.scene_plan?.scenes || []).map((s) => [s.id, s.scene_type]));
    } catch {
      sceneTypeById = null; // fail-open: if we can't read types, reference all
    }
  }
  const appliesLegacyCharacterRef = (key) => {
    if (!wantLegacyCharacterRef) return false;
    if (!sceneTypeById) return true;
    const t = sceneTypeById.get(key);
    return t === 'character' || t == null;
  };

  const referencesForScene = (scene) => {
    const automatic = referenceContext
      ? resolveReferenceDescriptors({
          kind: akind,
          sceneKey: scene.key,
          sceneNumber: scene.sceneNumber,
          prompt: scene.prompt,
          context: referenceContext,
          maxReferences,
        })
      : [];
    const selectedCharacter = appliesLegacyCharacterRef(scene.key)
      ? legacyCharacterReferenceDescriptor(slug, characterRef)
      : null;
    const candidates = selectedCharacter ? [selectedCharacter, ...automatic] : automatic;
    const seen = new Set();
    return candidates.filter((descriptor) => {
      if (!descriptor || seen.has(descriptor.url)) return false;
      seen.add(descriptor.url);
      return true;
    }).slice(0, maxReferences);
  };

  // scenes are normalized: { source, key, label, prompt, hasImage }
  const items = (scenes || []).map((s) => {
    const referenceDescriptors = referencesForScene(s);
    const sceneNumber = Number(s.sceneNumber ?? (src === 'prompts' ? s.key : NaN));
    return mkItem({
      kind: akind, // 'scene' | 'thumbnail'
      provider: prov,
      source: src,
      slug,
      episodeCode,
      episodeTitle: episodeTitle || '',
      sceneKey: s.key, // stable scene-plan id or thumbnail prompt number
      sceneNumber: Number.isFinite(sceneNumber) ? sceneNumber : undefined,
      prompt: s.prompt,
      target: effTarget,
      projectId: normalizeFlowProjectId(projectId || settings.flowProjectId),
      model: settings.imageModel,
      aspectRatio:
        prov === 'qwen'
          ? settings.qwenAspectRatio || '16:9'
          : prov === 'aistudio'
            ? settings.aistudioAspectRatio || '16:9'
            : prov === 'chatgpt'
              ? settings.chatgptAspectRatio || '16:9'
              : settings.aspectRatio,
      referenceDescriptors,
      fleetJobId: fleetJobId || undefined, // tag scenes dispatched by the Fleet Hub
      label: `${episodeCode} ${s.label || akind + ' ' + s.key}`,
    });
  });
  return enqueue(items);
}

async function enqueueStandalone({ prompts, prompt, label, provider }) {
  const texts = (Array.isArray(prompts) ? prompts : [prompt])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  if (!texts.length) throw new Error('Add at least one image prompt first.');
  if (texts.length > 100) throw new Error('Queue up to 100 standalone prompts at a time.');
  const settings = await getSettings();
  const prov = provider || settings.provider || DEFAULT_PROVIDER_ID;
  if (!isMaintainedProvider(prov)) throw providerRemovedError(prov);
  const safeLabel = String(label || 'image')
    .trim()
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'image';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const items = texts.map((text, index) => {
    const sequence = String(index + 1).padStart(2, '0');
    const sceneKey = `standalone_${stamp}_${sequence}_${safeLabel}`;
    return mkItem({
      source: 'standalone',
      kind: 'scene',
      key: sceneKey,
      sceneKey,
      slug: 'standalone',
      episodeCode: 'Standalone',
      episodeTitle: '',
      prompt: text,
      provider: prov,
      target: 'download',
      projectId: normalizeFlowProjectId(settings.flowProjectId),
      model: settings.imageModel,
      aspectRatio:
        prov === 'qwen' ? settings.qwenAspectRatio || '16:9'
          : prov === 'aistudio' ? settings.aistudioAspectRatio || '16:9'
            : prov === 'chatgpt' ? settings.chatgptAspectRatio || '16:9'
              : settings.aspectRatio,
      label: `Standalone ${sequence}/${texts.length} — ${safeLabel}`,
      project: 'Standalone',
      downloadPath: `StoryStudioImages/Standalone/${stamp}_${sequence}_${safeLabel}.png`,
    });
  });
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
      settings = await getSettings();
      let q = await getQueue();
      const idx = q.findIndex((i) => i.status === 'pending');
      if (idx < 0) break;
      // Only a cooldown for the *next item's* provider should hold the queue —
      // one provider's cooldown must never block a pending item for another.
      const nextProvider = q[idx].provider || DEFAULT_PROVIDER_ID;
      if (!isMaintainedProvider(nextProvider)) throw providerRemovedError(nextProvider);
      if (await holdForCooldown(nextProvider, settings)) return;
      const pendingId = q[idx].id;
      await waitForNextProviderRun(q[idx]);
      // Re-check after the human-pace delay (it can be up to a minute long).
      if (await isPaused()) {
        await writeStatus('Queue paused — press Resume to continue.', 'info');
        break;
      }
      settings = await getSettings();
      let item = null;
      q = await queueStore.update((queue) => {
        const current = queue.find((candidate) => candidate.id === pendingId && candidate.status === 'pending');
        if (!current) return queue;
        current.status = 'running';
        current.startedAt = current.startedAt || Date.now();
        delete current.finishedAt;
        delete current.durationMs;
        item = current;
        return queue;
      });
      if (!item) continue;
      const provider = item.provider || DEFAULT_PROVIDER_ID;
      const pos = q.filter((i) => i.status === 'done' || i.status === 'failed').length + 1;
      // Prefix reused by live sub-phase progress (e.g. Qwen upload → generate).
      runStatusPrefix = `(${pos}/${q.length}) ${item.label}`;
      await writeStatus(`${runStatusPrefix}…`, 'running');
      let providerAttempted = false;
      try {
        assertSupportedProjectScene(item);
        if (!tabs[provider]) tabs[provider] = await ensureProviderTab(provider);
        if (provider === 'aistudio') tabs[provider] = await ensureAiStudioReady(tabs[provider]);
        if (provider === 'chatgpt') tabs[provider] = await ensureChatgptReady(tabs[provider], settings);
        await setNextProviderRun(settings);
        providerAttempted = true;
        const r = await generateAndSave(item, settings, tabs[provider]);
        await queueStore.update((queue) => {
          const current = queue.find((candidate) => candidate.id === item.id);
          if (current) {
            current.status = 'done';
            delete current.error;
            delete current.failure;
            delete current.attempts;
            current.savedAs = r.savedAs;
            current.finishedAt = Date.now();
            current.durationMs = current.finishedAt - (current.startedAt || current.finishedAt);
          }
          return queue;
        });

        // Count images into the current Flow project; roll over to a fresh one
        // once it fills up so the tab/project stays light. Between-items, so the
        // Flow tab is idle — safe to navigate. Guarded so a rollover hiccup can
        // never fail the image that just succeeded.
        if (provider === 'flow') {
          try {
            const stored = await chrome.storage.local.get(FLOW_COUNT_KEY);
            const n = (Number(stored[FLOW_COUNT_KEY]) || 0) + 1;
            await chrome.storage.local.set({ [FLOW_COUNT_KEY]: n });
            const every = Math.max(1, Number(settings.flowNewProjectEvery) || 300);
            if (settings.flowAutoNewProject && n >= every) {
              await startNewFlowProject(`auto — every ${every} images`);
              tabs.flow = null; // the tab was navigated — re-check readiness next item
            }
          } catch {
            /* counting/rollover is best-effort — never disturb a saved image */
          }
        }
      } catch (e) {
        const cd = providerCooldown(settings, provider);
        if (e?.code === 'scene-source-retired') {
          await queueStore.update((queue) => {
            const current = queue.find((candidate) => candidate.id === item.id);
            if (current) Object.assign(current, unsupportedSceneQueueItem(current));
            return queue;
          });
          await writeStatus(String(e.message || e), 'err');
          continue;
        }
        // A known pre-submit provider limit (or Flow giving up on reCAPTCHA)
        // doesn't fail the batch: re-pend the item. With auto-resume on, schedule
        // a per-provider cooldown — the provider's own stated wait when it gives
        // one (Qwen), else the configured minutes — and let the queue resume
        // itself, re-arming if it's still limited. With auto-resume off, hard-
        // pause until the user presses Resume (the prior default behavior).
        if (isKnownPreSubmitLimit(provider, e) || isFlowRecaptchaFailure(e, item)) {
          await queueStore.update((queue) => {
            const current = queue.find((candidate) => candidate.id === item.id);
            if (current) {
              current.status = 'pending';
              delete current.error;
              delete current.failure;
              delete current.startedAt;
              delete current.finishedAt;
              delete current.durationMs;
            }
            return queue;
          });
          const name = PROVIDER_NAME[provider] || provider;
          if (cd.autoResume) {
            const parsed = parseWaitMs(e && e.message);
            const waitMs = parsed ? parsed + 20 * 60000 : cd.minutes * 60000;
            const resumeAt = Date.now() + waitMs;
            await setCooldownUntil(provider, resumeAt);
            await writeStatus(`${name} limit reached — auto-resuming automatically.`, 'info', {
              countdownUntil: resumeAt,
              countdownReason: 'cooldown',
              countdownProvider: provider,
            });
            alarmCreate();
          } else {
            await chrome.storage.local.set({ [PAUSE_KEY]: true });
            await chrome.storage.local.remove(FLEET_HUB_PAUSE_KEY);
            await queueStore.update((queue) => queue);
            const detail = e && e.message ? ` ${e.message}` : '';
            await writeStatus(`${name} limit reached — paused.${detail} Resume after it resets, or switch model/provider.`, 'info');
            alarmClear();
          }
          return;
        }
        if (isAmbiguousLeonardoFailure(provider, providerAttempted, e)) {
          await queueStore.update((queue) => {
            const current = queue.find((candidate) => candidate.id === item.id);
            if (current) Object.assign(current, ambiguousLeonardoQueueItem(current, e));
            return queue;
          });
          await writeStatus(
            'Leonardo AI submission outcome is unknown — inspect the Leonardo tab before manually retrying.',
            'err'
          );
          continue;
        }
        // A page reload is a transport interruption, not a generation result.
        // Put safe/resumable work back at the front and let the alarm wake it
        // after the provider tab settles instead of permanently skipping it.
        if (isTabReloadError(e)) {
          await queueStore.update((queue) => {
            const current = queue.find((candidate) => candidate.id === item.id);
            if (current) {
              current.status = 'pending';
              delete current.error;
            }
            return queue;
          });
          await writeStatus('Provider tab interrupted — current job will retry automatically…', 'running');
          alarmCreate();
          return;
        }
        // Auto-retry a normal failure up to the provider's configured count —
        // only while its auto-resume toggle is on, so "off" keeps prior behavior
        // (fail immediately, retry manually with the Retry-failed button).
        if (cd.autoResume && cd.retries > 0 && (item.attempts || 0) < cd.retries) {
          let retryAttempt = (item.attempts || 0) + 1;
          await queueStore.update((queue) => {
            const current = queue.find((candidate) => candidate.id === item.id);
            if (current) {
              current.attempts = (current.attempts || 0) + 1;
              retryAttempt = current.attempts;
              current.status = 'pending';
              delete current.error;
              delete current.failure;
              delete current.startedAt;
              delete current.finishedAt;
              delete current.durationMs;
            }
            return queue;
          });
          const name = PROVIDER_NAME[provider] || provider;
          await writeStatus(`${runStatusPrefix} failed — retry ${retryAttempt}/${cd.retries} (${name})…`, 'running');
          alarmCreate();
          return;
        }
        await queueStore.update((queue) => {
          const current = queue.find((candidate) => candidate.id === item.id);
          if (current) {
            current.status = 'failed';
            current.error = String(e.message || e);
            current.failure = diagnoseFailure(e, current);
            // A terminal provider failure never proves that no generation was
            // accepted. Keep remote retry disabled unless a future adapter can
            // establish that no provider request was made.
            current.fleetRetrySafe = false;
            current.finishedAt = Date.now();
            current.durationMs = current.finishedAt - (current.startedAt || current.finishedAt);
          }
          return queue;
        });
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
  const queue = await queueStore.update((current) => current.filter((item) => item.status === 'running'));
  if (!queue.length) await clearCooldowns();
  await writeStatus('Queue cleared.', 'info');
  return { ok: true };
}

// The Hub may clear only work that has not started. It must not alter provider
// cooldowns: those are local safety limits, not Fleet scheduling knobs.
async function clearPendingFromFleet() {
  await queueStore.update((queue) => queue.filter((item) => item.status !== 'pending'));
  await writeStatus('Pending queue items cleared by Fleet Hub.', 'info');
  return { cleared: true };
}

// Resume after a worker restart: re-pend any item that was mid-flight when the
// worker died, then keep going if anything is pending.
(async () => {
  const queue = await queueStore.update((current) => {
    for (const item of current) {
      if (item.status === 'running') {
        if (item.provider === 'leonardo') {
          item.status = 'failed';
          item.error = 'Leonardo generation was interrupted after submission; its outcome is unknown. Check the Leonardo tab before retrying.';
          item.failure = diagnoseFailure(item.error, item);
          item.fleetRetrySafe = false;
          item.finishedAt = Date.now();
          item.durationMs = item.finishedAt - (item.startedAt || item.finishedAt);
        } else {
          item.status = 'pending';
          delete item.startedAt;
        }
      }
    }
    return current;
  });
  if (queue.some((item) => item.status === 'pending')) {
    alarmCreate();
    processQueue();
  }
})();

chrome.alarms?.onAlarm?.addListener((a) => {
  if (a.name === ALARM) {
    processQueue();
    fleetHeartbeat();
  } else if (a.name === FLEET_ALARM) {
    fleetHeartbeat();
  }
});

// ── Fleet Hub v2 agent ───────────────────────────────────────────────────────
// Fleet is an authenticated observer of this persistent queue. It never drives
// providers, Story Studio, settings, or scene dispatch; the small command set
// below delegates only to local queue operations after a revision check.
const FLEET_HEARTBEAT_PATH = '/api/v2/agents/heartbeat';
const FLEET_SESSION_ID = crypto.randomUUID ? crypto.randomUUID() : `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;

async function hmacHex(secret, value) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fleetSigningText(timestamp, nonce, bodyText) {
  return `POST\n${FLEET_HEARTBEAT_PATH}\n${timestamp}\n${nonce}\n${bodyText}`;
}

function fleetRandomId(prefix) {
  return crypto.randomUUID ? crypto.randomUUID() : `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function getFleetIdentity() {
  const stored = await chrome.storage.local.get(FLEET_IDENTITY_KEY);
  const current = stored[FLEET_IDENTITY_KEY] || {};
  const identity = {
    agentId: typeof current.agentId === 'string' && current.agentId ? current.agentId : fleetRandomId('agent'),
    machineId: typeof current.machineId === 'string' && current.machineId ? current.machineId : fleetRandomId('machine'),
  };
  if (identity.agentId !== current.agentId || identity.machineId !== current.machineId) {
    await chrome.storage.local.set({ [FLEET_IDENTITY_KEY]: identity });
  }
  return identity;
}

function fleetSafeText(value, max = 240) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

async function fleetResponseAuthenticated(response, bodyText, secret) {
  if (!secret) return { ok: false, error: 'No local pairing secret configured.' };
  const timestamp = response.headers.get('x-fleet-timestamp') || '';
  const nonce = response.headers.get('x-fleet-nonce') || '';
  const signature = response.headers.get('x-fleet-signature') || '';
  const timestampMs = Number(timestamp);
  if (!timestamp || !nonce || !signature || !Number.isFinite(timestampMs)) return { ok: false, error: 'Hub response is missing authentication headers.' };
  if (Math.abs(Date.now() - timestampMs) > 60000) return { ok: false, error: 'Hub response timestamp is stale.' };
  const expected = await hmacHex(secret, fleetSigningText(timestamp, nonce, bodyText));
  if (expected.length !== signature.length) return { ok: false, error: 'Hub response signature is invalid.' };
  let difference = 0;
  for (let index = 0; index < expected.length; index++) {
    difference |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
  }
  if (difference !== 0) return { ok: false, error: 'Hub response signature is invalid.' };

  // Persist response nonces before processing commands. A terminated service
  // worker must not turn a signed response into a replayable command batch.
  const stored = await chrome.storage.local.get(FLEET_RESPONSE_NONCES_KEY);
  const now = Date.now();
  const recent = (Array.isArray(stored[FLEET_RESPONSE_NONCES_KEY]) ? stored[FLEET_RESPONSE_NONCES_KEY] : [])
    .filter((entry) => entry && typeof entry.nonce === 'string' && now - Number(entry.at || 0) <= 5 * 60 * 1000)
    .slice(-200);
  if (recent.some((entry) => entry.nonce === nonce)) return { ok: false, error: 'Hub response was already processed.' };
  recent.push({ nonce, at: now });
  await chrome.storage.local.set({ [FLEET_RESPONSE_NONCES_KEY]: recent.slice(-200) });
  return { ok: true };
}

async function getFleetCommandReceipts() {
  const stored = await chrome.storage.local.get(FLEET_COMMAND_RECEIPTS_KEY);
  return stored[FLEET_COMMAND_RECEIPTS_KEY] && typeof stored[FLEET_COMMAND_RECEIPTS_KEY] === 'object'
    ? stored[FLEET_COMMAND_RECEIPTS_KEY]
    : {};
}

async function recordFleetCommandResult(commandId, result) {
  const receipts = await getFleetCommandReceipts();
  receipts[commandId] = { commandId, ...result, recordedAt: Date.now() };
  const retained = Object.values(receipts)
    .filter((entry) => entry && entry.commandId)
    .sort((a, b) => Number(a.recordedAt || 0) - Number(b.recordedAt || 0))
    .slice(-200);
  await chrome.storage.local.set({ [FLEET_COMMAND_RECEIPTS_KEY]: Object.fromEntries(retained.map((entry) => [entry.commandId, entry])) });
  return receipts[commandId];
}

function fleetCommandResult(command, status, extra = {}) {
  return {
    action: String(command?.action || command?.type || ''),
    status,
    ...extra,
  };
}

async function fleetHeartbeat({ testOnly = false } = {}) {
  const settings = await getSettings();
  const hub = String(settings.fleetHubUrl || '')
    .trim()
    .replace(/\/+$/, '');
  if (!hub) return { ok: false, error: 'Enter a Fleet Hub URL first.' };
  if (!testOnly && (!settings.fleetAgentEnabled || !settings.fleetTelemetryEnabled)) {
    return { ok: false, error: 'Enable Fleet telemetry before connecting.' };
  }
  const secret = String(settings.fleetSharedSecret || '').trim();
  if (!secret) return { ok: false, error: 'Enter this agent’s local pairing secret first.' };

  await queueStore.read();

  const [queue, paused, stored, identity, queueRevision, receipts] = await Promise.all([
    getQueue(),
    isPaused(),
    chrome.storage.local.get([COOLDOWN_KEY, 'lastStatus']),
    getFleetIdentity(),
    getQueueRevision(),
    getFleetCommandReceipts(),
  ]);
  const cooldowns = stored[COOLDOWN_KEY] || {};
  const cooldownUntil = Number(cooldowns[settings.provider]) || null;
  const counts = {
    done: queue.filter((i) => i.status === 'done').length,
    failed: queue.filter((i) => i.status === 'failed').length,
    pending: queue.filter((i) => i.status === 'pending').length,
    running: queue.filter((i) => i.status === 'running').length,
  };
  const left = counts.pending + counts.running;
  let state = 'idle';
  if (paused) state = 'paused';
  else if (cooldownUntil && cooldownUntil > Date.now()) state = 'cooldown';
  else if (left > 0) state = counts.running ? 'generating' : 'queued';

  const body = {
    protocolVersion: 2,
    agent: {
      ...identity,
      extensionType: 'image',
      sessionId: FLEET_SESSION_ID,
      version: chrome.runtime.getManifest().version,
      displayName: fleetSafeText(settings.fleetAgentName, 80),
      capabilities: { actions: ['pause_after_current', 'resume_hub_pause', 'clear_pending', 'retry_failed'] },
      consent: {
        telemetry: settings.fleetTelemetryEnabled === true,
        queueControl: settings.fleetQueueControlEnabled === true,
      },
    },
    snapshot: {
      queueRevision,
      state,
      counts,
      current: fleetSafeText(queue.find((i) => i.status === 'running')?.label, 160),
      cooldownUntil: cooldownUntil > Date.now() ? cooldownUntil : null,
      status: fleetSafeText(stored.lastStatus?.text, 240),
      config: {
        provider: fleetSafeText(settings.provider, 40),
        humanDelayMinSec: Number(settings.humanDelayMinSec) || 0,
        humanDelayMaxSec: Number(settings.humanDelayMaxSec) || 0,
      },
    },
    commandResults: Object.values(receipts).slice(-100),
  };
  try {
    const bodyText = JSON.stringify(body);
    const timestamp = String(Date.now());
    const nonce = fleetRandomId('request');
    const headers = {
      'Content-Type': 'application/json',
      'X-Fleet-Timestamp': timestamp,
      'X-Fleet-Nonce': nonce,
      'X-Fleet-Signature': await hmacHex(secret, fleetSigningText(timestamp, nonce, bodyText)),
    };
    const r = await fetch(`${hub}${FLEET_HEARTBEAT_PATH}`, {
      method: 'POST',
      headers,
      body: bodyText,
    });
    if (!r.ok) return { ok: false, error: `Hub returned HTTP ${r.status}.` };
    const responseText = await r.text();
    let data;
    try {
      data = JSON.parse(responseText || '{}');
    } catch {
      return { ok: false, error: 'Hub returned invalid JSON.' };
    }
    const authenticated = await fleetResponseAuthenticated(r, responseText, secret);
    if (!authenticated.ok) return authenticated;
    if (!testOnly && Array.isArray(data.commands)) {
      for (const command of data.commands) await executeFleetCommand(command, settings, identity);
    }
    return { ok: true, commands: Array.isArray(data.commands) ? data.commands.length : 0 };
  } catch {
    return { ok: false, error: 'Hub is unreachable. Check its URL and site access.' };
  }
}

async function executeFleetCommand(command, settings, identity) {
  const commandId = String(command?.commandId || command?.id || '');
  if (!commandId) return null;
  const receipts = await getFleetCommandReceipts();
  if (receipts[commandId]) return receipts[commandId];
  const action = String(command?.action || command?.type || '');
  const reject = async (reason) => recordFleetCommandResult(commandId, fleetCommandResult(command, 'rejected', { reason, queueRevision: await getQueueRevision() }));
  const createdAt = Number(command?.createdAt);
  const expiresAt = Number(command?.expiresAt);
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || createdAt > expiresAt || expiresAt <= Date.now() || expiresAt > Date.now() + 15 * 60 * 1000) {
    return reject('expired_or_invalid_timing');
  }
  if (command.targetAgentId !== identity.agentId) return reject('wrong_agent');
  if (command.targetSessionId !== FLEET_SESSION_ID) return reject('stale_session');
  if (!settings.fleetQueueControlEnabled) return reject('queue_control_not_consented');
  await queueStore.read();
  if (!Number.isInteger(command.expectedQueueRevision) || command.expectedQueueRevision !== await getQueueRevision()) return reject('stale_queue_revision');

  try {
    switch (action) {
      case 'pause_after_current':
        await pauseQueue({ byHub: true, commandId });
        break;
      case 'resume_hub_pause': {
        const marker = (await chrome.storage.local.get(FLEET_HUB_PAUSE_KEY))[FLEET_HUB_PAUSE_KEY];
        const q = await getQueue();
        const nextProvider = q.find((item) => item.status === 'pending')?.provider;
        const cooldownUntil = Number((await getCooldowns())[nextProvider]) || 0;
        if (!marker || !(await isPaused())) return reject('not_hub_paused');
        if (cooldownUntil > Date.now()) return reject('local_cooldown_active');
        await chrome.storage.local.remove([PAUSE_KEY, FLEET_HUB_PAUSE_KEY]);
        await queueStore.update((queue) => queue); // record the state transition in the revision
        alarmCreate();
        processQueue();
        break;
      }
      case 'clear_pending':
        await clearPendingFromFleet();
        break;
      case 'retry_failed': {
        const result = await retryFleetSafeFailed();
        if (!result.retried) return reject('no_provably_safe_failed_items');
        break;
      }
      default:
        return reject('unsupported_action');
    }
    return recordFleetCommandResult(commandId, fleetCommandResult(command, 'succeeded', { queueRevision: await getQueueRevision() }));
  } catch (error) {
    return recordFleetCommandResult(commandId, fleetCommandResult(command, 'failed', {
      reason: fleetSafeText(error?.message || error, 180),
      queueRevision: await getQueueRevision(),
    }));
  }
}

setInterval(() => fleetHeartbeat(), 5000);
fleetHeartbeat();
// Keep an always-on 30s alarm so an idle (but enabled) machine still checks in
// and shows as online — the worker sleeps between beats otherwise.
try {
  chrome.alarms?.create(FLEET_ALARM, { periodInMinutes: 0.5 });
} catch {
  /* alarms unavailable — the 5s interval still beats while the worker is alive */
}

// Probe the active Flow tab for its current project id / sign-in state.
async function flowContext() {
  const tab = await ensureFlowTab();
  const r = await send(tab.id, { type: 'flow:getContext' });
  return { ok: true, ...r.result };
}

async function webGeneratorContext(provider) {
  const config = getProvider(provider);
  if (!config || provider === 'flow') throw providerRemovedError(provider);
  const tab = await ensureProviderTab(provider);
  const r = await send(tab.id, { type: config.contextMessage });
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

// Resume a paused/pending queue after a user pause or provider limit.
async function resumeQueue() {
  // Manual resume overrides any provider's cooldown — clear them all.
  await chrome.storage.local.remove([PAUSE_KEY, COOLDOWN_KEY, FLEET_HUB_PAUSE_KEY]);
  await queueStore.update((queue) => queue); // pause state is part of the Fleet snapshot
  alarmCreate();
  processQueue();
  return { ok: true };
}

async function pauseQueue({ byHub = false, commandId = '' } = {}) {
  if (byHub) await chrome.storage.local.set({ [PAUSE_KEY]: true, [FLEET_HUB_PAUSE_KEY]: { commandId, at: Date.now() } });
  else {
    await chrome.storage.local.set({ [PAUSE_KEY]: true });
    await chrome.storage.local.remove(FLEET_HUB_PAUSE_KEY);
  }
  await queueStore.update((queue) => queue); // pause state is part of the Fleet snapshot
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
    case 'flow:newProject':
      // Manual "New project" button — roll over to a fresh Flow project now.
      reply(startNewFlowProject('manual').then((id) => ({ ok: true, projectId: id })));
      return true;
    case 'enqueueScenes':
      reply(enqueueScenes(msg.payload));
      return true;
    case 'enqueueStandalone':
      reply(enqueueStandalone(msg.payload));
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
          const [queue, paused, cooldowns] = await Promise.all([
            getQueue(),
            isPaused(),
            getCooldowns(),
          ]);
          // A cooldown only counts as "cooling down" when it blocks the next
          // pending item's provider — not just because some entry lingers.
          const headProvider = queue.find((i) => i.status === 'pending')?.provider || null;
          const coolingDown = !!headProvider && Number(cooldowns[headProvider]) > Date.now();
          if (!paused && queue.some((i) => i.status === 'pending') && !processing) {
            alarmCreate();
            processQueue();
          }
          return { ok: true, queue, paused: paused || coolingDown, coolingDown };
        })()
      );
      return true;
    case 'pauseQueue':
      reply(pauseQueue());
      return true;
    case 'fleet:testConnection':
      // A test authenticates the exact v2 heartbeat contract but never executes
      // any returned command.
      reply(fleetHeartbeat({ testOnly: true }));
      return true;
    case 'flowContext':
      reply(flowContext());
      return true;
    case 'openProviderPage':
      reply(openProviderPage(msg.provider));
      return true;
    case 'webGeneratorContext':
      reply(webGeneratorContext(msg.provider));
      return true;
    case 'qwen:progress':
      // Live sub-phase note from the Qwen content script (upload vs generate).
      if (processing && runStatusPrefix) writeStatus(`${runStatusPrefix} — ${msg.phase}…`, 'running');
      return false;
    case 'chatgpt:progress':
      // Live sub-phase note from the ChatGPT content script (upload vs generate).
      if (processing && runStatusPrefix) writeStatus(`${runStatusPrefix} — ${msg.phase}…`, 'running');
      return false;
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
