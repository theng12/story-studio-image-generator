// Service worker — a persistent, resumable generation QUEUE for scene assets.
//
// The panel enqueues work (one scene, a whole episode, or a whole project);
// this worker processes one scene at a time, human-paced, generating the image
// on Google Flow and saving it to Downloads (Standalone) or delivering it to
// Gateway Studio. The queue lives in chrome.storage, so it survives the panel
// closing AND the worker being killed: a chrome.alarms tick wakes the worker to
// resume any pending items.
//
// Strictly sequential — only ever one provider generation in flight, so sites
// are never flooded no matter how much image work is queued.

import {
  getLeonardoModels,
  getSettings as loadSettings,
  normalizeFlowProjectId,
  normalizeSettings,
  persistSettings,
  providerCooldown,
  flowWorkspace,
} from './lib/config.js';
import { flowCommand } from './lib/flow-exec.js';
import { DEFAULT_PROVIDER_ID, PROVIDERS, getFlowModel, getProvider, isMaintainedProvider } from './lib/providers.js';
import {
  assertSupportedQueueItem,
  gatewayNeedsReview,
  canRetryItem,
  migrateQueue,
  recoverInterruptedQueue,
  unsupportedSceneQueueItem,
} from './lib/queue-migration.js';
import { enqueueItems } from './lib/queue-operations.js';
import { createQueueStore } from './lib/queue-store.js';
import { createSettingsStore } from './lib/settings-store.js';
import { createSubmissionGate } from './lib/submission-gate.js';
import {
  assertFlowModelApproval,
  assertProviderModel,
  assertQueuedModelIdentity,
  configuredFlowModel,
  flowInventoryResult,
  generationParamsFor,
  generationSettingsFor,
  snapshotProviderModel,
} from './lib/model-identity.js';
import {
  ambiguousProviderQueueItem,
  isAmbiguousProviderFailure,
  isKnownPreSubmitLimit,
  providerLabelForItem,
} from './lib/failure-policy.js';
import {
  claimImageJob,
  reportImageProgress,
  reportImageResult,
  reportImageFailure,
  testImageGateway,
  reportImageTelemetry,
} from './lib/gateway-client.js';
import {
  gatewayBinding,
  imageGatewayJobToItem,
  isImageGatewayJobQueued,
} from './lib/gateway-worker.js';
import { imageQuote, observedAccount } from './lib/gateway-account.js';
import { getGatewayArtifact, putGatewayArtifact, deleteGatewayArtifact } from './lib/gateway-artifacts.js';
import { readWorkMode } from './lib/work-mode.js';
chrome.storage.local.set({ workerBootAt: Date.now() });
// Older releases stored a 'studio' choice; move it to Standalone on worker load.
readWorkMode().catch(() => {});

// How many images have gone into the CURRENT Flow project — drives auto rollover.
const FLOW_COUNT_KEY = 'flowProjectImageCount';
const FLOW_MODEL_INVENTORY_KEY = 'flowImageModelInventory';
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

const isPaused = async () => !!(await chrome.storage.local.get(PAUSE_KEY))[PAUSE_KEY] || await gatewayManagerPaused();

// "(pos/total) label" of the item currently running — reused to show live
// sub-phase progress (e.g. Qwen "uploading reference" → "generating").
let runStatusPrefix = '';
const ALARM = 'queueTick';
const SEEN_PROJECT_KEY = 'lastSeenFlowProjectId';
const NEXT_PROVIDER_RUN_KEY = 'nextProviderRunAt';
// Gateway image worker claim polling alarm (30s). Only scheduled while gateway
// mode is enabled; wakes the worker to poll for new jobs without blocking the
// regular provider queue.
const GATEWAY_ALARM = 'gatewayTick';
const GATEWAY_WORKER_ID_KEY = 'gatewayWorkerId';
// Set by any context to ask the worker for a claim without a panel page being open.
const CLAIM_NOW_KEY = 'gatewayClaimNowAt';
// Per-provider auto-resume timestamps: { [provider]: resumeAtMs }. One key so a
// cooldown is scoped to the provider that hit its limit and never blocks others.
const COOLDOWN_KEY = 'cooldownUntil';

const settingsStore = createSettingsStore({
  load: loadSettings,
  save: persistSettings,
  normalize: normalizeSettings,
});
const getSettings = () => settingsStore.read();
const saveSettings = (patch) => settingsStore.patch(patch);

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
// One tab per provider, ever: calls are serialised per provider, and the tab this
// worker opened is remembered (session storage survives worker restarts) so a
// tab query that comes back empty can never make us open a second one.
const ensuringTab = {};
const OWNED_TABS_KEY = 'ownedProviderTabs';
async function ownedTab(provider) {
  const stored = await chrome.storage.session?.get(OWNED_TABS_KEY).catch(() => null);
  const id = stored?.[OWNED_TABS_KEY]?.[provider];
  if (!Number.isInteger(id)) return null;
  return chrome.tabs.get(id).catch(() => null);
}
async function rememberOwnedTab(provider, tabId) {
  const stored = await chrome.storage.session?.get(OWNED_TABS_KEY).catch(() => null);
  await chrome.storage.session?.set({ [OWNED_TABS_KEY]: { ...(stored?.[OWNED_TABS_KEY] || {}), [provider]: tabId } }).catch(() => {});
}
function ensureProviderTab(provider = 'flow') {
  return (ensuringTab[provider] ||= findOrOpenProviderTab(provider).finally(() => delete ensuringTab[provider]));
}
// Flow's address is a setting; every other provider's workspace is fixed.
async function providerWorkspace(provider) {
  if (provider === 'flow') return flowWorkspace(await getSettings());
  const cfg = PROVIDER[provider];
  if (!cfg) throw providerRemovedError(provider);
  return cfg;
}
async function findOrOpenProviderTab(provider) {
  const cfg = await providerWorkspace(provider);
  const tabs = await chrome.tabs.query({ url: cfg.match });
  const ready = tabs.find((t) => t.status === 'complete');
  if (ready) {
    if (provider === 'leonardo' || provider === 'qwen')
      await chrome.tabs.update(ready.id, { autoDiscardable: false }).catch(() => {});
    return ready;
  }
  let tab = tabs[0] || (await ownedTab(provider));
  if (!tab) {
    tab = await chrome.tabs.create({ url: cfg.url, active: false });
    await rememberOwnedTab(provider, tab.id);
  }
  if (provider === 'leonardo' || provider === 'qwen')
    await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  if (tab.status === 'complete') return tab;
  await new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      setTimeout(resolve, 1200); // let content scripts + grecaptcha/signing init
    };
    const listener = (tabId, info) => {
      if (tabId === tab.id && info.status === 'complete') done();
    };
    chrome.tabs.onUpdated.addListener(listener);
    // The load may have finished between the query and the listener attaching.
    chrome.tabs.get(tab.id).then((t) => { if (t?.status === 'complete') done(); }).catch(() => {});
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
    await chrome.tabs.update(tab.id, { url: flowWorkspace(await getSettings()).project(projectId), autoDiscardable: false });
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
      if (item.provider === 'flow' && item.status === 'pending' && item.target !== 'gateway') item.projectId = projectId;
    }
    return queue;
  });
  await writeStatus(`Started a new Flow project (${reason}).`, 'info');
  return projectId;
}

// Panel "↗ Open provider" click: focus an existing tab for the provider's
// generation page, or open a new active one.
async function openProviderPage(provider) {
  let cfg;
  try {
    cfg = await providerWorkspace(provider);
  } catch (error) {
    return { ok: false, error: error.message };
  }
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
    const flowSettings = await getSettings();
    const { origin } = flowWorkspace(flowSettings);
    if (!String(tab?.url || '').startsWith(`${origin}/`)) {
      throw new Error(`Refusing to run a Flow command outside ${origin}.`);
    }
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: flowCommand,
      // The configured ids are only a fallback; the page resolves them from observed exchanges first.
      args: [{ op: message.type.slice('flow:'.length), payload: { ...(message.params || {}), rpcFallback: flowSettings.rpcIds } }],
    });
    if (!result?.ok) {
      throw Object.assign(new Error(result?.error || 'Flow command failed.'), {
        providerRejectedBeforeGeneration: result?.providerRejectedBeforeGeneration === true,
      });
    }
    return { ok: true, ...result.result, result: result.result };
  }
  // Retrying generation is safe for free Flow images. Read-only checks and
  // uploads are safe too.
  const reloadSafe = new Set([
    'flow:generateImage',
    'flow:uploadImage',
    'flow:getContext',
    'flow:listImageModels',
    'flow:inspectAccount',
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
          providerRejectedBeforeGeneration: res?.providerRejectedBeforeGeneration === true,
        });
      return res;
    } catch (error) {
      const submissionToken = message?.params?.submissionToken;
      if (submissionToken && !submissionGate.canReplayTransport(submissionToken)) throw error;
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

async function refreshFlowModels(tabId) {
  try {
    const targetId = Number.isInteger(tabId) ? tabId : (await ensureFlowTab()).id;
    const response = await send(targetId, { type: 'flow:listImageModels' });
    const inventory = flowInventoryResult(response.entries, response.source);
    const refreshedAt = Date.now();
    const stored = {
      source: inventory.source,
      models: inventory.models.map((model) => ({ ...model })),
      refreshedAt,
    };
    await chrome.storage.local.set({ [FLOW_MODEL_INVENTORY_KEY]: stored });
    return { ok: true, ...stored };
  } catch {
    const inventory = { ...flowInventoryResult([]), refreshedAt: Date.now() };
    await chrome.storage.local.set({ [FLOW_MODEL_INVENTORY_KEY]: inventory });
    return { ok: false, code: 'flow-model-discovery-unavailable', ...inventory };
  }
}

async function snapshotProviderModelAtEnqueue(provider, settings, flowInventory) {
  if (provider === 'leonardo') await leonardoModelControls(settings.leonardoModel);
  const context = provider === 'flow' ? null : await webGeneratorContext(provider);
  if (provider === 'leonardo' && context?.modelIdentity?.id && !context.modelIdentity.label) {
    const saved = (await getLeonardoModels()).find((model) => model.id === context.modelIdentity.id);
    if (saved?.label) context.modelIdentity = { ...context.modelIdentity, label: saved.label };
  }
  const liveModel = context?.modelIdentity
    ? { id: context.modelIdentity.id, label: context.modelIdentity.label }
    : undefined;
  const configuredModel = provider === 'flow' ? configuredFlowModel(settings, flowInventory) : undefined;
  const modelSnapshot = snapshotProviderModel({ provider, configuredModel, liveModel, flowInventory });
  return { modelSnapshot, generationSettings: generationSettingsFor(provider, settings, modelSnapshot) };
}

const modelError = (code, message) => Object.assign(new Error(message), { code });

async function requireCurrentFlowModel(item, tabId) {
  const current = await refreshFlowModels(tabId);
  if (!current.ok) throw modelError('model-unknown', 'Flow model discovery is unavailable. Refresh the signed-in Flow page and re-queue this item.');
  if ((item.target === 'gateway' || item.modelSnapshot.modelSource === 'live') && current.source !== 'live') {
    throw modelError('model-unknown', 'Flow has only bundled model records. Gateway and live-model work require a captured live inventory; manual work can use the bundled catalog.');
  }
  if (item.modelSnapshot.modelSource === 'live') {
    const selected = current.models.find((model) => model.modelId === item.modelSnapshot.modelId);
    if (!selected || selected.modelLabel !== item.modelSnapshot.modelLabel) {
      throw modelError('model-selection-changed', 'The queued Flow model was removed or changed. Refresh the signed-in Flow page and re-queue this item.');
    }
  } else if (!current.models.some((model) => model.modelId === item.modelSnapshot.modelId)) {
    throw modelError('model-unknown', 'The queued Flow fallback model is unavailable. Refresh the signed-in Flow page and re-queue this item.');
  }
}

async function verifyQueuedModel(item, provider, tab) {
  assertQueuedModelIdentity(item, provider);
  if (provider === 'flow') return requireCurrentFlowModel(item, tab.id);
  const config = getProvider(provider);
  const current = await send(tab.id, { type: config.contextMessage });
  assertProviderModel({ provider, snapshot: item.modelSnapshot, current: current.modelIdentity });
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

// Gateway stages reference bytes with the job. Standalone prompts carry none.
async function resolveReferenceImages(item) {
  if (item.target !== 'gateway') return [];
  const staged = await getGatewayArtifact(item.gatewayJobId);
  if (!staged || !Array.isArray(staged.references) || staged.references.length !== item.gatewayReferenceCount) {
    throw new Error('Gateway references are unavailable; work is held without generation.');
  }
  return staged.references;
}

const refMediaCache = new Map();
async function resolveReferenceMediaIds(item, settings, tab) {
  const references = await resolveReferenceImages(item);
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
      if (item.target === 'gateway' && !mediaId) throw new Error('Gateway reference upload was not confirmed; generation will not start.');
      if (mediaId) refMediaCache.set(key, mediaId);
    }
    if (mediaId) mediaIds.push(mediaId);
  }
  return mediaIds;
}

async function generateAndSave(item, settings, tab) {
  assertSupportedQueueItem(item);
  const provider = item.provider || DEFAULT_PROVIDER_ID;
  assertQueuedModelIdentity(item, provider);
  if (!item.prompt || !item.prompt.trim()) throw new Error('Scene has no image prompt.');
  const handlers = {
    chatgpt: async () => {
      const references = await resolveReferenceImages(item);
      const r = await dispatchProviderGeneration(item, provider, tab, {
        type: 'chatgpt:generateImage',
        params: generationParamsFor('chatgpt', item, { references }),
      });
      // The adapter returns in-page PNG bytes when it can, else a URL for the
      // worker to fetch (oaiusercontent can be CORS-locked in the page).
      return r.base64 ? r : fetchImagePayload(provider, r.imageUrl);
    },
    aistudio: async () => {
      const references = await resolveReferenceImages(item);
      return dispatchProviderGeneration(item, provider, tab, {
        type: 'aistudio:generateImage',
        params: generationParamsFor('aistudio', item, { references }),
      });
    },
    flow: async () => {
      const projectId = normalizeFlowProjectId(item.projectId || settings.flowProjectId);
      if (!projectId) throw new Error('No Flow project set. Open a Flow project and pick it in the panel.');
      const params = generationParamsFor('flow', item, {
        projectId,
        recaptchaMaxAttempts: settings.flowRecaptchaMaxAttempts,
      });
      const referenceIds = await resolveReferenceMediaIds(item, settings, tab);
      if (referenceIds.length) {
        params.imageInputs = referenceIds.map((name) => ({ imageInputType: 'IMAGE_INPUT_TYPE_REFERENCE', name }));
      }
      const prepared = await send(tab.id, { type: 'flow:prepareGenerateImage', params });
      return dispatchFlowGeneration(item, tab, prepared.preparationId);
    },
    qwen: async () => {
      const references = await resolveReferenceImages(item);
      const r = await dispatchProviderGeneration(item, provider, tab, {
        type: 'qwen:generateImage',
        params: generationParamsFor('qwen', item, { references }),
      });
      return r.base64 ? r : fetchImagePayload(provider, r.imageUrl);
    },
    leonardo: async () => {
      const r = await dispatchProviderGeneration(item, provider, tab, {
        type: 'leonardo:generateImage',
        params: generationParamsFor('leonardo', item),
      });
      return r.base64 ? r : fetchImagePayload(provider, r.imageUrl);
    },
  };
  const handler = handlers[provider];
  if (!handler) throw providerRemovedError(provider);
  const { base64, mime } = await handler();
  if (item.target === 'gateway') {
    const staged = await getGatewayArtifact(item.gatewayJobId);
    if (!staged) throw new Error('Gateway reference storage is missing; generated output needs review.');
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    await putGatewayArtifact(item.gatewayJobId, { ...staged, bytes, mime });
    return deliverGatewayImage(item);
  }
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
  throw new Error('Unsupported queue target. Only Standalone Downloads and Gateway jobs are supported.');
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
  const min = Math.max(0, Math.round((Number(settings.humanDelayMinSec) || 0) * 1000));
  const max = Math.max(min, Math.round((Number(settings.humanDelayMaxSec) || 0) * 1000));
  return min + Math.floor(Math.random() * (max - min + 1));
}

async function setNextProviderRun(settings) {
  const delayMs = randomHumanDelayMs(settings);
  await chrome.storage.local.set({ [NEXT_PROVIDER_RUN_KEY]: Date.now() + delayMs });
  return delayMs;
}

async function waitForNextProviderRun(item) {
  for (;;) {
    if (await isPaused()) return;
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

  if (error?.code === 'model-unknown' || error?.code === 'model-selection-changed')
    return {
      code: error.code,
      title: 'Queued model settings changed',
      hint: `Refresh the signed-in ${provider} page, choose the model and settings again, then re-queue this item.`,
      raw,
    };

  if (error?.code === 'provider-removed' || match(/provider (?:was )?removed|provider is not supported/))
    return {
      code: 'provider-removed',
      title: 'Provider removed from Story Studio Image Generator',
      hint: 'Choose a maintained provider and queue this asset again. Jobs are never redirected automatically.',
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
  load: async () => {
    const stored = await chrome.storage.local.get(QUEUE_KEY);
    return { queue: stored[QUEUE_KEY] };
  },
  save: (queue) => chrome.storage.local.set({ [QUEUE_KEY]: queue }),
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

const submissionGate = createSubmissionGate({
  persist: async ({ itemId, provider }) => {
    if (await gatewayManagerPaused()) {
      const error = new Error('Gateway dispatch is stopped; the prepared job remains queued.');
      error.code = 'gateway-dispatch-paused';
      throw error;
    }
    return queueStore.update((queue) => {
      const item = queue.find((candidate) => candidate.id === itemId);
      if (!item || item.status !== 'running' || item.provider !== provider) {
        throw new Error('The queued provider item is no longer running.');
      }
      item.providerAttempted = true;
      item.providerAttemptedAt = Date.now();
      return queue;
    });
  },
});

async function dispatchProviderGeneration(item, provider, tab, message) {
  const request = submissionGate.arm({ itemId: item.id, provider, tabId: tab.id });
  try {
    return await send(tab.id, {
      ...message,
      params: { ...(message.params || {}), submissionToken: request.token },
    });
  } catch (error) {
    if (error && typeof error === 'object' && error.submitted == null) {
      error.submitted = request.checkpointed;
    }
    throw error;
  } finally {
    submissionGate.release(request.token);
  }
}

async function dispatchFlowGeneration(item, tab, preparationId) {
  if (item.target === 'gateway') await requireGatewayBinding(item);
  const request = submissionGate.arm({ itemId: item.id, provider: 'flow', tabId: tab.id });
  try {
    await submissionGate.checkpoint({ token: request.token, tabId: tab.id });
    return await send(tab.id, {
      type: 'flow:submitGenerateImage',
      params: { preparationId },
    });
  } catch (error) {
    if (error && typeof error === 'object' && error.submitted == null) {
      error.submitted = request.checkpointed;
    }
    throw error;
  } finally {
    submissionGate.release(request.token);
  }
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
  await queueStore.update((queue) => queue.filter((item) => !(item.id === id && item.status === 'pending' && !gatewayNeedsReview(item))));
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
      delete item.startedAt;
      delete item.finishedAt;
      delete item.durationMs;
      delete item.providerAttempted;
      delete item.providerAttemptedAt;
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

async function enqueueStandalone({ prompts, prompt, label, provider }) {
  const texts = (Array.isArray(prompts) ? prompts : [prompt])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  if (!texts.length) throw new Error('Add at least one image prompt first.');
  if (texts.length > 100) throw new Error('Queue up to 100 standalone prompts at a time.');
  const settings = await getSettings();
  const prov = provider || settings.provider || DEFAULT_PROVIDER_ID;
  if (!isMaintainedProvider(prov)) throw providerRemovedError(prov);
  const flowRefresh = prov === 'flow' ? await refreshFlowModels() : null;
  const flowInventory = flowRefresh?.ok ? flowRefresh : flowInventoryResult([]);
  const { modelSnapshot, generationSettings } = await snapshotProviderModelAtEnqueue(prov, settings, flowInventory);
  if (prov === 'flow') {
    await saveSettings({
      flowModelId: modelSnapshot.modelId,
      flowModelLabel: modelSnapshot.modelLabel,
      flowModelSource: modelSnapshot.modelSource,
      flowModelSelection: settings.imageModel,
    });
  }
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
      modelSnapshot: { ...modelSnapshot },
      generationSettings: { ...generationSettings },
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
        await writeStatus(await gatewayManagerPaused() ? 'Generation is stopped by the account manager — resume dispatch there.' : 'Queue paused — press Resume to continue.', 'info');
        break;
      }
      settings = await getSettings();
      let q = await getQueue();
      const gatewayActive = await gatewayIsActive(settings);
      const idx = q.findIndex((i) => i.status === 'pending' && (i.target !== 'gateway' || gatewayActive));
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
        await writeStatus(await gatewayManagerPaused() ? 'Generation is stopped by the account manager — resume dispatch there.' : 'Queue paused — press Resume to continue.', 'info');
        break;
      }
      settings = await getSettings();
      if (await holdForCooldown(nextProvider, settings)) return;
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
      let providerActionAttempted = false;
      try {
        assertSupportedQueueItem(item);
        if (item.target === 'gateway') {
          // Only a claim the Gateway reserved against an observed account and price may run.
          if (!item.gatewayClaimId || !item.gatewayReservation) {
            const error = new Error('Gateway work has no reserved account and price; retained for review.');
            error.code = 'gateway-observation-unavailable';
            throw error;
          }
          reportImageProgress(settings, item.gatewayJobId, 'generating').catch(() => {});
        }
        if (!tabs[provider]) tabs[provider] = await ensureProviderTab(provider);
        if (provider === 'aistudio') tabs[provider] = await ensureAiStudioReady(tabs[provider]);
        if (provider === 'chatgpt') tabs[provider] = await ensureChatgptReady(tabs[provider], settings);
        await verifyQueuedModel(item, provider, tabs[provider]);
        await setNextProviderRun(settings);
        const r = await generateAndSave(item, settings, tabs[provider]);
        providerAttempted = true;
        providerActionAttempted = true;
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
        if (provider === 'flow' && item.target !== 'gateway') {
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
        try {
          const persisted = (await getQueue()).find((candidate) => candidate.id === item.id);
          providerAttempted = persisted?.providerAttempted === true || e?.submitted === true;
        } catch {
          // If storage cannot prove this was pre-submit, fail closed against a duplicate generation.
          providerAttempted = e?.submitted !== false;
        }
        providerActionAttempted = providerActionAttempted || providerAttempted;
        if (!providerAttempted && e?.code === 'gateway-dispatch-paused') {
          await queueStore.update((queue) => queue.map((candidate) => candidate.id === item.id ? { ...candidate, status: 'pending' } : candidate));
          await writeStatus(e.message, 'info');
          return;
        }
        if (item.target === 'gateway') {
          await holdGatewayImage(item, e, providerAttempted);
          continue;
        }
        if (provider !== 'leonardo' && providerAttempted && e?.providerRejectedBeforeGeneration === true) {
          let checkpointCleared = false;
          await queueStore.update((queue) => {
            const current = queue.find((candidate) => candidate.id === item.id);
            if (current?.providerAttempted === true) {
              delete current.providerAttempted;
              delete current.providerAttemptedAt;
              checkpointCleared = true;
            }
            return queue;
          });
          if (checkpointCleared) {
            providerAttempted = false;
            e.submitted = false;
          }
        }
        const cd = providerCooldown(settings, provider);
        if (e?.code === 'unsupported-target') {
          await queueStore.update((queue) => {
            const current = queue.find((candidate) => candidate.id === item.id);
            if (current) Object.assign(current, unsupportedSceneQueueItem(current));
            return queue;
          });
          await writeStatus(String(e.message || e), 'err');
          continue;
        }
        if (isAmbiguousProviderFailure(providerAttempted, e)) {
          await queueStore.update((queue) => {
            const current = queue.find((candidate) => candidate.id === item.id);
            if (current) Object.assign(current, ambiguousProviderQueueItem(current, e));
            return queue;
          });
          const name = PROVIDER_NAME[provider] || provider;
          await writeStatus(
            `${name} submission outcome is unknown — inspect the provider tab before manually retrying.`,
            'err'
          );
          continue;
        }
        // A known pre-submit provider limit (or Flow giving up on reCAPTCHA)
        // doesn't fail the batch: re-pend the item. With auto-resume on, schedule
        // a per-provider cooldown — the provider's own stated wait when it gives
        // one (Qwen), else the configured minutes — and let the queue resume
        // itself, re-arming if it's still limited. With auto-resume off, hard-
        // pause until the user presses Resume (the prior default behavior).
        if (!providerAttempted && (isKnownPreSubmitLimit(provider, e) || isFlowRecaptchaFailure(e, item))) {
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
            await queueStore.update((queue) => queue, { touch: true });
            const detail = e && e.message ? ` ${e.message}` : '';
            await writeStatus(`${name} limit reached — paused.${detail} Resume after it resets, or switch model/provider.`, 'info');
            alarmClear();
          }
          return;
        }
        // A page reload is a transport interruption, not a generation result.
        // Put safe/resumable work back at the front and let the alarm wake it
        // after the provider tab settles instead of permanently skipping it.
        if (!providerAttempted && isTabReloadError(e)) {
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
        const modelVerificationFailed = ['model-unknown', 'model-selection-changed'].includes(e?.code);
        if (!providerAttempted && !modelVerificationFailed && cd.autoResume && cd.retries > 0 && (item.attempts || 0) < cd.retries) {
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
            current.finishedAt = Date.now();
            current.durationMs = current.finishedAt - (current.startedAt || current.finishedAt);
          }
          return queue;
        });
      } finally {
        if (providerActionAttempted) await setNextProviderRun(await getSettings());
      }
      const more = (await getQueue()).some((i) => i.status === 'pending');
      if (more) await waitForNextProviderRun(item);
    }
    const q = await getQueue();
    if (q.length) {
      const done = q.filter((i) => i.status === 'done').length;
      const failed = q.filter((i) => i.status === 'failed').length;
      if (q.some(gatewayNeedsReview)) await writeStatus('Gateway work is retained. Select Gateway mode or review held results before continuing.', 'err');
      else await writeStatus(`✓ Queue finished: ${done} saved${failed ? `, ${failed} failed` : ''}.`, 'done');
    }
    alarmClear();
  } finally {
    processing = false;
  }
}

// Drop everything not yet started; let an in-flight item finish on its own.
async function clearQueue() {
  let cleared = 0;
  const queue = await queueStore.update((current) => {
    const kept = current.filter((item) => item.status !== 'pending' || gatewayNeedsReview(item));
    cleared = current.length - kept.length;
    return kept;
  });
  if (!queue.some((item) => item.status === 'pending' || item.status === 'running')) await clearCooldowns();
  if (cleared) await writeStatus(`Cleared ${cleared} pending job${cleared === 1 ? '' : 's'}.`, 'info');
  return { ok: true, cleared };
}

// Drop failed items so a batch can be re-queued from scratch. Provider
// cooldowns are untouched: they are safety limits, not batch state.
async function clearFailed() {
  let cleared = 0;
  await queueStore.update((current) => {
    const kept = current.filter((item) => item.status !== 'failed' || gatewayNeedsReview(item));
    cleared = current.length - kept.length;
    return kept;
  });
  if (cleared) await writeStatus(`Cleared ${cleared} failed job${cleared === 1 ? '' : 's'}.`, 'info');
  return { ok: true, cleared };
}

async function clearCompleted() {
  let cleared = 0;
  await queueStore.update((current) => {
    const kept = current.filter((item) => item.status !== 'done' || gatewayNeedsReview(item));
    cleared = current.length - kept.length;
    return kept;
  });
  if (cleared) await writeStatus(`Cleared ${cleared} completed job${cleared === 1 ? '' : 's'}.`, 'info');
  return { ok: true, cleared };
}

// Resume only work with no evidence that a provider request or save completed.
(async () => {
  const queue = await queueStore.update((current) => recoverInterruptedQueue(current, Date.now()));
  const marker = (await chrome.storage.local.get('gatewayUnsettledClaim')).gatewayUnsettledClaim;
  // An older row for the same job cannot settle a newer claim.
  if (marker?.claimId && queue.some((item) => item.gatewayJobId === marker.jobId && item.gatewayBinding === marker.binding && item.gatewayClaimId === marker.claimId)) {
    await chrome.storage.local.remove('gatewayUnsettledClaim');
  }
  for (const item of queue.filter((entry) => entry.target === 'gateway' && entry.gatewayAcknowledged === true)) {
    try { await deleteGatewayArtifact(item.gatewayJobId); }
    catch { await writeStatus('Gateway accepted prior work; retained local bytes still need cleanup.', 'err'); }
  }
  if (queue.some((item) => item.status === 'pending')) {
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
  await queueStore.update(async (queue) => {
    await chrome.storage.local.remove([PAUSE_KEY, COOLDOWN_KEY]);
    return queue;
  }, { touch: true });
  alarmCreate();
  processQueue();
  return { ok: true };
}

async function pauseQueue() {
  await queueStore.update(async (queue) => {
    await chrome.storage.local.set({ [PAUSE_KEY]: true });
    return queue;
  }, { touch: true });
  // If something is mid-generation it finishes and saves; the loop then stops.
  await writeStatus(processing ? 'Pausing — finishing the current item first…' : 'Queue paused — press Resume to continue.', 'info');
  return { ok: true };
}

// Gateway jobs use the same provider queue and pacing. Held answers block claims.
let gatewayPolling = false;
// Why the last claim tick could not ask Gateway for work: 'flow-tab' or 'flow-inventory'.
// Reported as activity 'waiting' so an armed but blocked worker never looks idle.
let gatewayBlocked = null;
const GATEWAY_CLAIM_KEY = 'gatewayUnsettledClaim';
const GATEWAY_CONTROL_KEY = 'gatewayWorkerControl';
let gatewayControlTail = Promise.resolve();
async function getGatewayControl(settings = null) {
  const stored = (await chrome.storage.local.get(GATEWAY_CONTROL_KEY))[GATEWAY_CONTROL_KEY];
  if (!stored) return null;
  let binding;
  try { binding = await gatewayBinding(settings || await getSettings()); } catch { return null; }
  return stored.binding === binding ? stored : null;
}
async function gatewayManagerPaused() {
  const control = await getGatewayControl();
  return !!control && (control.dispatchEnabled !== true || control.closeRequested === true);
}
function applyGatewayControl(settings, control) {
  const result = gatewayControlTail.then(async () => {
    const binding = await gatewayBinding(settings);
    if (binding !== await gatewayBinding(await getSettings())) throw new Error('Gateway connection changed before control application.');
    const current = await getGatewayControl(settings);
    if (current && Number(current.requestedAt) > Number(control?.requestedAt)) return current;
    if (current?.revision && current.revision === control?.revision && current.dispatchEnabled === control.dispatchEnabled &&
        current.closeRequested === (control.closeRequested === true) && current.pacing?.minSeconds === control.pacing?.minSeconds &&
        current.pacing?.maxSeconds === control.pacing?.maxSeconds) return current;
    // Persist the stop barrier before applying pacing or acknowledging a revision.
    await chrome.storage.local.set({ [GATEWAY_CONTROL_KEY]: { binding, dispatchEnabled: false, closeRequested: false } });
    const pace = control?.pacing;
    // Newly paired workers have dispatch OFF and no manager revision to acknowledge.
    if (control?.revision == null && control?.requestedAt == null && control?.dispatchEnabled === false &&
        control.closeRequested === false && pace && Number.isFinite(pace.minSeconds) && Number.isFinite(pace.maxSeconds) &&
        pace.minSeconds >= 0 && pace.maxSeconds >= pace.minSeconds) {
      return { binding, dispatchEnabled: false, closeRequested: false };
    }
    if (!control || typeof control.revision !== 'string' || !control.revision ||
        typeof control.dispatchEnabled !== 'boolean' || !Number.isFinite(control.requestedAt) || control.requestedAt < 0 ||
        (control.closeRequested !== undefined && typeof control.closeRequested !== 'boolean') ||
        (control.closeRequested === true && control.dispatchEnabled) ||
        !pace || !Number.isFinite(pace.minSeconds) || !Number.isFinite(pace.maxSeconds) ||
        pace.minSeconds < 0 || pace.maxSeconds < pace.minSeconds || pace.maxSeconds * 1000 > Number.MAX_SAFE_INTEGER) {
      throw new Error('Gateway control is missing or invalid; dispatch remains stopped.');
    }
    await saveSettings({ humanDelayMinSec: pace.minSeconds, humanDelayMaxSec: pace.maxSeconds });
    const applied = { binding, dispatchEnabled: control.dispatchEnabled, closeRequested: control.closeRequested === true,
      revision: control.revision, requestedAt: control.requestedAt, pacing: { ...pace } };
    await chrome.storage.local.set({ [GATEWAY_CONTROL_KEY]: applied });
    return applied;
  });
  gatewayControlTail = result.catch(() => {});
  return result;
}
async function gatewayTelemetry(settings, account = null) {
  const queue = await getQueue();
  const stored = await chrome.storage.local.get([NEXT_PROVIDER_RUN_KEY, COOLDOWN_KEY, GATEWAY_CLAIM_KEY]);
  const control = await getGatewayControl(settings);
  const paused = await isPaused();
  const held = !!stored[GATEWAY_CLAIM_KEY] || queue.some((item) => gatewayNeedsReview(item) || (item.status === 'failed' && item.providerAttempted));
  const running = queue.some((item) => item.status === 'running');
  const provider = queue.find((item) => item.status === 'running' || item.status === 'pending')?.provider || 'flow';
  const cooldown = Number(stored[COOLDOWN_KEY]?.[provider]) || 0;
  const nextRunAt = Math.max(Date.now(), Number(stored[NEXT_PROVIDER_RUN_KEY]) || 0, cooldown);
  const activity = running ? 'generating' : held ? 'recovering' : cooldown > Date.now() ? 'cooling'
    : nextRunAt > Date.now() ? 'resting' : queue.some((item) => item.status === 'pending') ? 'waiting'
    : gatewayBlocked ? 'waiting' : 'idle';
  const state = { extensionVersion: chrome.runtime.getManifest().version, state: {
    connection: account?.connection || 'unknown', signIn: account?.signIn || 'unknown', readiness: account?.readiness || 'not_ready', activity, attention: held,
    enabled: await gatewayIsActive(settings) && control?.dispatchEnabled === true, paused,
    ...(control?.revision ? { controlRevision: control.revision } : {}),
    nextEligibleAt: paused || held ? null : new Date(nextRunAt).toISOString(),
    pacing: { minSeconds: settings.humanDelayMinSec, maxSeconds: settings.humanDelayMaxSec },
    source: 'image.worker', observedAt: new Date(Date.now()).toISOString(),
  } };
  return state;
}
// Gateway requires this block to repeat telemetry.state exactly.
const gatewayAccountBlock = (account, telemetry) => (account ? { ...account, ...telemetry.state } : null);
// Flow images are free, so an unset price is 0 credits, never unknown. A declared
// price in Settings overrides it. 0 is a valid quote, not a missing one.
function gatewayModelCredits(settings, job) {
  const costs = settings.gatewayImageCreditCosts || {};
  const model = getFlowModel(String(job?.modelKey || ''));
  for (const key of [job?.modelKey, model?.id, model?.internalId]) {
    if (typeof key === 'string' && Number.isFinite(costs[key])) return costs[key];
  }
  return 0;
}
async function syncGatewayTelemetry(settings) {
  const health = await testImageGateway(settings);
  await applyGatewayControl(settings, health.control);
  // A changed response is applied first; its acknowledgement uses a new readback.
  for (let attempt = 0; attempt < 2; attempt++) {
    const telemetry = await gatewayTelemetry(await getSettings());
    const answer = await reportImageTelemetry(settings, telemetry);
    const applied = await applyGatewayControl(settings, answer.control);
    if (telemetry.state.controlRevision === applied.revision) break;
  }
}
const GATEWAY_ACCOUNT_MAX_AGE_SECONDS = 90;
// The signed-in Flow page is the only account/credit source; anything less is unknown.
// Uses an open Flow tab only, so a paused or idle worker never opens one.
// Distinguishes "no Flow tab", "signed out" and "signed in but the probe failed", so the
// panel never blames the person for a stale Flow RPC id. The page probe already falls back to
// a visibly signed-in project page with an unknown balance.
async function inspectFlowAccountDetailed() {
  let tabs;
  try {
    const { match } = flowWorkspace(await getSettings());
    tabs = await chrome.tabs.query({ url: match });
  } catch (error) {
    return { account: null, reason: 'unreadable', error: String(error?.message || error) };
  }
  const tab = tabs.find((entry) => entry.status === 'complete');
  if (!tab) return { account: null, reason: 'no-tab', error: null };
  try {
    const observed = await send(tab.id, { type: 'flow:inspectAccount' });
    const account = observedAccount(observed?.account, GATEWAY_ACCOUNT_MAX_AGE_SECONDS);
    if (account) return { account, reason: null, error: null };
    return {
      account: null,
      reason: 'unreadable',
      error: String(observed?.probe?.error || 'the Flow page returned no account'),
    };
  } catch (error) {
    return { account: null, reason: 'unreadable', error: String(error?.message || error) };
  }
}
async function inspectFlowAccount() {
  return (await inspectFlowAccountDetailed()).account;
}
async function gatewayIsActive(settings) {
  return settings.gatewayModeEnabled === true &&
    (await chrome.storage.local.get('imageGeneratorWorkMode')).imageGeneratorWorkMode === 'gateway';
}
async function requireGatewayBinding(item) {
  const settings = await getSettings();
  if (!(await gatewayIsActive(settings)) || await gatewayBinding(settings) !== item.gatewayBinding) {
    throw new Error('Gateway connection or mode changed; retained work will not be redirected.');
  }
  const health = await testImageGateway(settings);
  await applyGatewayControl(settings, health.control);
  return { ...settings, gatewayMaxResultBytes: health.maxResultBytes };
}
async function deliverGatewayImage(item) {
  const settings = await requireGatewayBinding(item);
  const staged = await getGatewayArtifact(item.gatewayJobId);
  if (!staged?.bytes || staged.binding !== item.gatewayBinding) throw new Error('No matching retained image is available. Generation will not repeat.');
  if (staged.bytes.byteLength > settings.gatewayMaxResultBytes) throw new Error(`Image exceeds Gateway upload limit of ${settings.gatewayMaxResultBytes} bytes; retained for review.`);
  await reportImageResult(settings, item.gatewayJobId, staged.bytes, staged.mime);
  const savedAs = `Gateway ${item.gatewayJobId}`;
  // Persist acceptance before deleting bytes, including the restart window.
  await queueStore.update((queue) => {
    const current = queue.find((candidate) => candidate.id === item.id);
    if (current) {
      Object.assign(current, { status: 'done', gatewayAcknowledged: true, savedAs, finishedAt: Date.now() });
      delete current.error;
      delete current.failure;
    }
    return queue;
  });
  try { await deleteGatewayArtifact(item.gatewayJobId); }
  catch { await writeStatus('Gateway accepted the image; local retained bytes still need cleanup.', 'info'); }
  return { savedAs, target: 'gateway' };
}
async function holdGatewayImage(item, error, providerAttempted = true) {
  let acknowledged = false;
  try {
    const staged = await getGatewayArtifact(item.gatewayJobId);
    // An upload may already have won. Never race a retained result with /fail.
    if (!staged?.bytes && error?.code !== 'gateway-observation-unavailable') {
      const settings = await requireGatewayBinding(item);
      await reportImageFailure(settings, item.gatewayJobId, error, providerAttempted);
      acknowledged = !providerAttempted;
      if (acknowledged) await deleteGatewayArtifact(item.gatewayJobId);
    }
  } catch { /* retain local evidence when the answer cannot be confirmed */ }
  await queueStore.update((queue) => {
    const current = queue.find((candidate) => candidate.id === item.id);
    if (current) Object.assign(current, { status: 'failed', gatewayAcknowledged: acknowledged,
      error: String(error?.message || error), finishedAt: Date.now(),
      failure: { code: 'gateway-held', title: 'Gateway work needs review', hint: 'Deliver retained bytes again, or inspect the held job in Gateway. Generation will not repeat.', raw: String(error?.message || error) } });
    return queue;
  });
  await writeStatus('Gateway work is held; generation will not repeat. Retained images can be delivered again.', 'err');
}
async function retryGatewayDelivery(id) {
  if (processing || gatewayPolling) throw new Error('Wait for the current queue action to finish.');
  processing = true;
  try {
    const item = (await getQueue()).find((candidate) => candidate.id === id && gatewayNeedsReview(candidate));
    if (!item) throw new Error('No held Gateway job was selected.');
    try { return { ok: true, ...await deliverGatewayImage(item) }; }
    catch (error) { await holdGatewayImage(item, error); throw error; }
  } finally { processing = false; }
}
async function gatewayCanClaim(settings) {
  if (processing || !(await gatewayIsActive(settings)) || await isPaused()) return false;
  if ((await getGatewayControl(settings))?.dispatchEnabled !== true) return false;
  const queue = await getQueue();
  if (queue.some((item) => gatewayNeedsReview(item) || item.status === 'pending' || item.status === 'running')) return false;
  const stored = await chrome.storage.local.get([GATEWAY_CLAIM_KEY, NEXT_PROVIDER_RUN_KEY, COOLDOWN_KEY]);
  if (stored[GATEWAY_CLAIM_KEY]) {
    await writeStatus('Gateway has an unsettled claim. Review it in Gateway before reconnecting.', 'err');
    return false;
  }
  const nextRunAt = Math.max(Number(stored[NEXT_PROVIDER_RUN_KEY]) || 0, Number(stored[COOLDOWN_KEY]?.flow) || 0);
  if (nextRunAt > Date.now()) {
    await writeStatus('Gateway is waiting for the next allowed Flow request.', 'info', { countdownUntil: nextRunAt, countdownProvider: 'flow' });
    return false;
  }
  return true;
}

// Opens (or waits for) the Flow workspace so a panel-closed worker can claim instead of
// idling until someone opens a tab by hand.
async function waitForFlowTab(tabId) {
  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(500);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.status === 'complete') return tab;
  }
  return null;
}
async function openFlowForGateway(settings) {
  const workspace = flowWorkspace(settings);
  const existing = await chrome.tabs.query({ url: workspace.match });
  let tab = existing.find((entry) => entry.status === 'complete');
  if (!tab) {
    const created = existing[0] || await chrome.tabs.create({ url: workspace.url, active: false });
    // autoDiscardable is an update property, not a create property; passing it to create throws.
    await chrome.tabs.update(created.id, { autoDiscardable: false }).catch(() => {});
    tab = await waitForFlowTab(created.id);
  }
  return tab ? inspectFlowAccount() : null;
}
async function gatewayClaimLoop() {
  if (gatewayPolling) return;
  gatewayPolling = true;
  try {
    // Visible proof the loop is alive; the panel compares this against the clock.
    await chrome.storage.local.set({ gatewayLastTickAt: Date.now() });
    let settings = await getSettings();
    if (!(await gatewayIsActive(settings))) return;
    // Stop acknowledgements must continue while paused, busy, cooling or held.
    await syncGatewayTelemetry(settings);
    settings = await getSettings();
    if (!(await gatewayCanClaim(settings))) return;
    let inspected = await inspectFlowAccountDetailed();
    let account = inspected.account;
    if (!account) {
      gatewayBlocked = 'flow-tab';
      if (inspected.reason === 'unreadable') {
        // Do not open a new tab for this; the page exists, the probe failed.
        await writeStatus(`Flow is open but Relay could not read the account (${inspected.error}). Retrying on the next check.`, 'err');
        return;
      }
      await writeStatus('Gateway is waiting for a signed-in Flow tab; opening one.', 'info');
      account = await openFlowForGateway(settings);
      inspected = account ? { account, reason: null, error: null } : await inspectFlowAccountDetailed();
      account = inspected.account;
      if (!account) {
        await writeStatus(inspected.reason === 'unreadable'
          ? `Flow is open but Relay could not read the account (${inspected.error}). Retrying on the next check.`
          : 'Gateway needs a signed-in Flow tab before it can claim image work.', 'err');
        return;
      }
    }
    gatewayBlocked = null;
    const inventory = await refreshFlowModels();
    if (!inventory.ok || inventory.source !== 'live') {
      gatewayBlocked = 'flow-inventory';
      throw modelError('model-unknown', 'Flow has no captured live inventory. Gateway work will not be claimed; manual work can use the bundled catalog.');
    }
    const binding = await gatewayBinding(settings);
    if (!(await gatewayCanClaim(await getSettings())) || await gatewayBinding(await getSettings()) !== binding) return;
    const claimId = crypto.randomUUID();
    const telemetry = await gatewayTelemetry(settings, account);
    const accountBlock = gatewayAccountBlock(account, telemetry);
    await chrome.storage.local.set({ [GATEWAY_CLAIM_KEY]: { binding, claimId, at: Date.now() } });
    // A price-less job is a read-only preview: never enqueue it, never generate.
    let answer = await claimImageJob(settings, telemetry, accountBlock);
    if (answer.control) await applyGatewayControl(settings, answer.control);
    // Only our own quoted claim may return work; anything else is held, never run.
    if (answer.job) throw new Error('Gateway offered executable work without our own quoted price; the claim is held and nothing will generate.');
    {
      if (!answer.quoteRequired) { await chrome.storage.local.remove(GATEWAY_CLAIM_KEY); return; }
      const quote = imageQuote(answer.quoteRequired, account, gatewayModelCredits(settings, answer.quoteRequired.job));
      if (!quote) {
        await chrome.storage.local.remove(GATEWAY_CLAIM_KEY);
        await writeStatus(`No credit price is set for ${answer.quoteRequired.job?.modelKey || 'this Flow model'}; nothing was claimed. Set credits per image in Settings.`, 'err');
        return;
      }
      answer = await claimImageJob(settings, telemetry, accountBlock, quote);
      if (answer.control) await applyGatewayControl(settings, answer.control);
      if (!answer.job) { await chrome.storage.local.remove(GATEWAY_CLAIM_KEY); return; }
      if (answer.reservation?.payloadSha256 !== quote.payloadSha256 || answer.reservation?.value !== quote.value ||
          answer.reservation?.unit !== quote.unit || answer.accountBinding?.accountId !== account.accountId) {
        throw new Error('Gateway reservation does not match the observed account and price; the claim is held.');
      }
    }
    const job = answer.job;
    await chrome.storage.local.set({ [GATEWAY_CLAIM_KEY]: { binding, claimId, jobId: job.jobId, at: Date.now() } });
    if (isImageGatewayJobQueued(await getQueue(), job.jobId)) {
      throw new Error('Gateway returned an already recorded job; the new claim is held.');
    }
    const item = { ...imageGatewayJobToItem(job, settings, inventory), gatewayBinding: binding, gatewayClaimId: claimId,
      gatewayAccountBinding: answer.accountBinding || null, gatewayReservation: answer.reservation || null };
    await putGatewayArtifact(job.jobId, { binding, references: job.referenceImages || [] });
    await queueStore.update((current) => [...current, item]);
    await writeStatus(`Gateway job ${String(job.jobId).slice(0, 8)} queued.`, 'info');
  } catch (error) {
    await writeStatus(`Gateway work stopped: ${String(error?.message || error).slice(0, 200)}`, 'err');
  } finally {
    gatewayPolling = false;
    if (!processing && (await getQueue()).some((item) => item.status === 'pending')) processQueue();
  }
}

function gatewayAlarmCreate() {
  try {
    chrome.alarms?.create(GATEWAY_ALARM, { periodInMinutes: 0.5 });
  } catch { /* alarms unavailable */ }
}

function gatewayAlarmClear() {
  try {
    chrome.alarms?.clear(GATEWAY_ALARM);
  } catch { /* ignore */ }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const reply = (p) =>
    p.then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
  switch (msg?.type) {
    case 'settings:get':
      reply(getSettings().then((settings) => ({ ok: true, settings })));
      return true;
    case 'settings:patch':
      reply(saveSettings(msg.patch).then((settings) => ({ ok: true, settings })));
      return true;
    case 'flow:projectSeen':
      // A Flow project tab announced its id; remember it for the panel.
      chrome.storage.local.set({ [SEEN_PROJECT_KEY]: msg.projectId });
      return false; // no async response needed
    case 'flow:newProject':
      // Manual "New project" button — roll over to a fresh Flow project now.
      reply(startNewFlowProject('manual').then((id) => ({ ok: true, projectId: id })));
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
    case 'clearFailed':
      reply(clearFailed());
      return true;
    case 'clearCompleted':
      reply(clearCompleted());
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
    case 'flowContext':
      reply(flowContext());
      return true;
    case 'refreshFlowModels':
      reply(refreshFlowModels(msg.tabId));
      return true;
    case 'openProviderPage':
      reply(openProviderPage(msg.provider));
      return true;
    case 'webGeneratorContext':
      reply(webGeneratorContext(msg.provider));
      return true;
    case 'providerSubmissionCheckpoint':
      reply(
        submissionGate
          .checkpoint({ token: msg.token, tabId: sender?.tab?.id })
          .then(() => ({ ok: true }))
      );
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
    case 'gateway:testConnection':
      reply(getSettings().then(async (settings) => {
        const health = await testImageGateway(settings);
        await applyGatewayControl(settings, health.control);
        return { ...health, balance: (await inspectFlowAccount())?.balance || null };
      }));
      return true;
    case 'gateway:claimNow':
      reply((async () => {
        const settings = await getSettings();
        if (!(await gatewayIsActive(settings))) throw new Error('Select Gateway Studio mode in the side panel first.');
        await gatewayClaimLoop();
        return { ok: true };
      })());
      return true;
    case 'gateway:retryDelivery':
      reply(retryGatewayDelivery(msg.id));
      return true;
    default:
      return false;
  }
});

// Gateway alarm listener: wake the worker to poll for new image jobs.
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === GATEWAY_ALARM) {
    // Listener-level proof, separate from the loop's own marker: an alarm that exists but
    // never fires must be visible as such.
    chrome.storage.local.set({ gatewayAlarmFiredAt: Date.now(), gatewayAlarmPeriodMinutes: alarm.periodInMinutes ?? null });
    gatewayClaimLoop();
  }
});

async function syncGatewayAlarm() {
  // Always keep the tick. Gateway settings can arrive from restored or synced storage with no
  // panel save, and a missing alarm is a worker that silently never claims. The loop itself
  // refuses instantly when gateway mode is off, so the idle cost is one quick wake per 30 s.
  gatewayAlarmCreate();
}
chrome.storage.onChanged?.addListener((changes, area) => {
  if (area === 'local' && (changes.imageGeneratorWorkMode || changes.gatewayConnection)) {
    syncGatewayAlarm().catch(() => {});
    processQueue().catch(() => {});
  }
  // Settings live in sync storage; a restored or admin-written value never touches the panel.
  if (area === 'sync' && changes.settings) syncGatewayAlarm().catch(() => {});
  // Any context (a test harness included) can request a claim by writing CLAIM_NOW_KEY.
  if (area === 'local' && changes[CLAIM_NOW_KEY]) gatewayClaimLoop();
});
syncGatewayAlarm().catch(() => {});
// One account probe per worker start: a broken Flow RPC id is named now, not at the first claim.
async function rpcSelfCheck() {
  try {
    const settings = await getSettings();
    if (!(await gatewayIsActive(settings))) return;
    const inspected = await inspectFlowAccountDetailed();
    if (!inspected.account && inspected.reason === 'unreadable') {
      gatewayBlocked = 'account-probe';
      await writeStatus(`Account probe failed: ${inspected.error}. Claims retry after the next check; manual work still works.`, 'err');
    }
  } catch { /* best effort */ }
}
// Delayed so it never races the first claim tick; the claim loop also names a failed probe.
setTimeout(() => { rpcSelfCheck().catch(() => {}); }, 10000);
// Alarms are profile-local and are not restored with synced/restored settings; a browser
// launch or extension update must (re)create the claim alarm, not only a settings save.
try { chrome.runtime.onStartup?.addListener(() => { syncGatewayAlarm().catch(() => {}); }); } catch { /* older Chrome */ }
try { chrome.runtime.onInstalled?.addListener(() => { syncGatewayAlarm().catch(() => {}); }); } catch { /* older Chrome */ }
chrome.storage.local.set({ workerReadyAt: Date.now() });
