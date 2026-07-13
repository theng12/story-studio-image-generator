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

import { getSettings, saveSettings, normalizeFlowProjectId, providerCooldown } from './lib/config.js';
import { StudioClient } from './lib/story-studio.js';
import { buildDownloadPath } from './lib/naming.js';

const FLOW_URL = 'https://labs.google/fx/tools/flow';
// How many images have gone into the CURRENT Flow project — drives auto rollover.
const FLOW_COUNT_KEY = 'flowProjectImageCount';
const PROVIDER = {
  flow: { url: 'https://labs.google/fx/tools/flow', match: 'https://labs.google/fx/*' },
  aistudio: { url: 'https://aistudio.google.com/prompts/new_chat', match: 'https://aistudio.google.com/*' },
  qwen: { url: 'https://chat.qwen.ai/', match: 'https://chat.qwen.ai/*' },
  grok: { url: 'https://grok.com/imagine', match: 'https://grok.com/*' },
  perchance: { url: 'https://perchance.org/ai-text-to-image-generator', match: 'https://perchance.org/*' },
  freegen: { url: 'https://freegen.app/', match: 'https://freegen.app/*' },
  leonardo: { url: 'https://app.leonardo.ai/generate', match: 'https://app.leonardo.ai/*' },
  piclumen: { url: 'https://www.piclumen.com/ai-image/', match: 'https://www.piclumen.com/*' },
  chatgpt: { url: 'https://chatgpt.com/images', match: 'https://chatgpt.com/*' },
};
const PROVIDER_NAME = {
  flow: 'Flow',
  aistudio: 'AI Studio',
  qwen: 'Qwen Studio',
  grok: 'Grok',
  perchance: 'Perchance',
  freegen: 'FreeGen',
  leonardo: 'Leonardo AI',
  pollinations: 'Pollinations',
  piclumen: 'PicLumen',
  chatgpt: 'ChatGPT',
};
const PROVIDER_SCRIPTS = {
  leonardo: {
    main: 'src/content/leonardo-main.js',
    isolated: 'src/content/leonardo.js',
  },
  qwen: {
    main: 'src/content/qwen-main.js',
    isolated: 'src/content/qwen.js',
  },
  piclumen: {
    main: 'src/content/piclumen-main.js',
    isolated: 'src/content/piclumen.js',
  },
  chatgpt: {
    main: 'src/content/chatgpt-main.js',
    isolated: 'src/content/chatgpt.js',
  },
};
// Providers that need no browser tab — generated directly from the worker.
const TABLESS = new Set(['pollinations']);
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
  const cfg = PROVIDER[provider] || PROVIDER.flow;
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
  const q = await getQueue();
  let moved = false;
  for (const it of q)
    if (it.provider === 'flow' && it.status === 'pending') {
      it.projectId = projectId;
      moved = true;
    }
  if (moved) await setQueue(q);
  await writeStatus(`Started a new Flow project (${reason}).`, 'info');
  return projectId;
}

// Panel "↗ Open provider" click: focus an existing tab for the provider's
// generation page, or open a new active one. Tabless providers have no page.
async function openProviderPage(provider) {
  const cfg = PROVIDER[provider];
  if (!cfg) return { ok: false, error: 'This provider has no page to open.' };
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
  await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: [scripts.main] });
  await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', files: [scripts.isolated] });
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

// Generate on the dedicated image generator (chatgpt.com/images) with a FRESH
// chat every scene: navigate back to /images before each one (a full reload that
// also clears any prior attachment). We do NOT reuse chats — verified live
// 2026-07-13 that a 2nd image request in a chat that already has an image makes
// ChatGPT treat it as an EDIT of the previous image and hang forever on "Adding
// final touches…/One last tweak…", never producing a new image. A chat is a
// conversation (not a stateless container like a Flow project), so every image
// needs its own clean chat.
async function ensureChatgptReady(tab, settings) {
  let current = await chrome.tabs.get(tab.id).catch(() => null);
  if (!current) throw new Error('The ChatGPT tab was closed. Reopen it to resume the queue.');
  let path = '';
  try {
    path = new URL(current.url || '').pathname.replace(/\/+$/, '');
  } catch {
    /* leave blank → navigate */
  }
  if (path !== '/images') {
    current = await chrome.tabs.update(current.id, { url: 'https://chatgpt.com/images' });
    await waitForTabReady(current.id);
    await sleep(1200); // let the /images composer hydrate
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
  // Retrying generation is safe for free Flow images. Read-only checks and
  // uploads are safe too. Never retry a paid video submit after losing its
  // response: it may have reached Flow and could charge twice.
  const reloadSafe = new Set([
    'flow:generateImage',
    'flow:uploadImage',
    'flow:checkVideo',
    'flow:getContext',
    'freegen:getContext',
    'piclumen:getContext',
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
// For content-script providers (Qwen) the character sheet is uploaded into the
// site's own composer each generation, so we just need its raw bytes. Cache the
// Story Studio fetch per (project, character, file) — the content script
// re-uploads from these bytes every scene (Qwen consumes the image each time).
const refImageCache = new Map();
async function resolveCharacterRefImage(item, settings) {
  const ref = item.characterRef;
  if (!ref || !ref.characterId || !ref.filename) return null;
  const key = `${item.slug}::${ref.characterId}::${ref.filename}`;
  if (refImageCache.has(key)) return refImageCache.get(key);
  const client = new StudioClient(settings.studioBaseUrl);
  const img = await client.characterReferenceImageBase64(item.slug, ref.characterId, ref.filename);
  const payload = { base64: img.base64, mime: img.mime, name: `char_${ref.characterId}.png` };
  refImageCache.set(key, payload);
  return payload;
}

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
  } else if (provider === 'piclumen') {
    const r = await send(tab.id, {
      type: 'piclumen:generateImage',
      params: { prompt: item.prompt, aspectRatio: item.aspectRatio || settings.aspectRatio, model: settings.piclumenModel },
    });
    base64 = r.base64;
    mime = r.mime;
  } else if (provider === 'chatgpt') {
    // Character reference (img2img): fetch the sheet bytes so the content script
    // can paste it into the composer before generating (character scenes only).
    const reference =
      item.applyRef && item.characterRef ? await resolveCharacterRefImage(item, settings) : undefined;
    const r = await send(tab.id, {
      type: 'chatgpt:generateImage',
      params: { prompt: item.prompt, aspectRatio: item.aspectRatio || settings.aspectRatio, reference },
    });
    // The adapter returns in-page PNG bytes when it can, else a URL for the
    // worker to fetch (oaiusercontent can be CORS-locked in the page).
    const payload = r.base64 ? r : await fetchImagePayload(r.imageUrl);
    base64 = payload.base64;
    mime = payload.mime;
  } else if (provider === 'flow') {
    const projectId = normalizeFlowProjectId(item.projectId || settings.flowProjectId);
    if (!projectId) throw new Error('No Flow project set. Open a Flow project and pick it in the panel.');
    const params = {
      projectId,
      prompt: item.prompt,
      model: item.model || settings.imageModel,
      aspectRatio: item.aspectRatio || settings.aspectRatio,
      recaptchaMaxAttempts: settings.flowRecaptchaMaxAttempts,
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
            : provider === 'qwen'
              ? 'qwen:generateImage'
              : 'leonardo:generateImage';
    // Qwen img2img: fetch the character sheet bytes so the content script can
    // upload it into the Qwen composer before generating (character scenes only).
    const reference =
      provider === 'qwen' && item.applyRef && item.characterRef ? await resolveCharacterRefImage(item, settings) : undefined;
    const r = await send(tab.id, {
      type: messageType,
      params: {
        prompt: item.prompt,
        aspectRatio: item.aspectRatio || settings.aspectRatio,
        reference: provider === 'qwen' ? reference : undefined,
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
  return (item.provider || 'flow') === 'flow' && item.assetType === 'image' && diagnoseFailure(error, item).code === 'recaptcha';
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
  // Starting a fresh run: clear the COMPLETED entries so they don't pile up, but
  // KEEP failed ones (capped) so you can still see what went wrong on this
  // machine — a fresh batch no longer wipes your failures.
  if (!q.some((i) => i.status === 'pending' || i.status === 'running')) {
    q = q.filter((i) => i.status === 'failed').slice(-100);
  }
  // A fresh attempt for a scene supersedes its prior failed entry (e.g. a hub
  // "retry"), so the panel shows the retry, not a stale failure beside it.
  const incoming = new Set(items.map(itemKey).filter(Boolean));
  if (incoming.size) q = q.filter((i) => !(i.status === 'failed' && incoming.has(itemKey(i))));
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
    delete item.fleetReported; // report this attempt's outcome to the hub again
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
async function enqueueScenes({ slug, episodeCode, episodeTitle, projectName, scenes, source, kind, target, projectId, assetType, provider, characterRef, fleetJobId }) {
  const settings = await getSettings();
  const prov = provider || settings.provider || 'flow';
  const src = source || 'plan'; // 'plan' (scene_plan) | 'prompts' (03/04 prompts)
  const akind = kind === 'thumbnail' ? 'thumbnail' : 'scene'; // asset kind
  const stem = akind === 'thumbnail' ? 'Thumb' : 'Scene';
  // Only Flow supports video; every web generator provider is image-only.
  const isVideo = assetType === 'video' && prov === 'flow' && akind === 'scene';
  const effTarget = target || settings.saveTarget;

  // Character reference (Flow / Qwen / ChatGPT images). Gate by scene_type so the
  // sheet only lands on character scenes — read the raw scene plan (scene-review
  // doesn't expose scene_type). Untagged scenes count as character (matches SS's
  // renderer). Non-plan sources have no scene_type, so the reference applies to
  // all of them.
  const wantRef =
    (prov === 'flow' || prov === 'qwen' || prov === 'chatgpt') &&
    !isVideo &&
    akind === 'scene' &&
    !!(characterRef && characterRef.characterId && characterRef.filename);
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
      aspectRatio:
        prov === 'qwen'
          ? settings.qwenAspectRatio || '16:9'
          : prov === 'aistudio'
            ? settings.aistudioAspectRatio || '16:9'
            : prov === 'chatgpt'
              ? settings.chatgptAspectRatio || '16:9'
              : settings.aspectRatio,
      applyRef: appliesRef(s.key),
      characterRef: appliesRef(s.key) ? characterRef : undefined,
      fleetJobId: fleetJobId || undefined, // tag scenes dispatched by the Fleet Hub
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
      settings = await getSettings();
      let q = await getQueue();
      const idx = q.findIndex((i) => i.status === 'pending');
      if (idx < 0) break;
      // Only a cooldown for the *next item's* provider should hold the queue —
      // one provider's cooldown must never block a pending item for another.
      const nextProvider = q[idx].provider || 'flow';
      if (await holdForCooldown(nextProvider, settings)) return;
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
      // Prefix reused by live sub-phase progress (e.g. Qwen upload → generate).
      runStatusPrefix = `(${pos}/${q.length}) ${item.label}`;
      await writeStatus(`${runStatusPrefix}…`, 'running');
      let providerAttempted = false;
      try {
        if (!TABLESS.has(provider) && !tabs[provider]) tabs[provider] = await ensureProviderTab(provider);
        if (provider === 'aistudio') tabs[provider] = await ensureAiStudioReady(tabs[provider]);
        if (provider === 'chatgpt') tabs[provider] = await ensureChatgptReady(tabs[provider], settings);
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
          delete it.attempts;
          it.savedAs = r.savedAs;
          it.finishedAt = Date.now();
          it.durationMs = it.finishedAt - (it.startedAt || it.finishedAt);
        }
        await setQueue(q);

        // Count images into the current Flow project; roll over to a fresh one
        // once it fills up so the tab/project stays light. Between-items, so the
        // Flow tab is idle — safe to navigate. Guarded so a rollover hiccup can
        // never fail the image that just succeeded.
        if (provider === 'flow' && item.assetType !== 'video') {
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
        // A provider limit (or Flow giving up on reCAPTCHA) doesn't fail the
        // batch: re-pend the item. With this provider's auto-resume on, schedule
        // a per-provider cooldown — the provider's own stated wait when it gives
        // one (Qwen), else the configured minutes — and let the queue resume
        // itself, re-arming if it's still limited. With auto-resume off, hard-
        // pause until the user presses Resume (the prior default behavior).
        if ((e && e.limit) || isFlowRecaptchaFailure(e, item)) {
          q = await getQueue();
          const it = q.find((i) => i.id === item.id);
          if (it) {
            it.status = 'pending';
            delete it.error;
            delete it.failure;
            delete it.startedAt;
            delete it.finishedAt;
            delete it.durationMs;
          }
          await setQueue(q);
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
            const detail = e && e.message ? ` ${e.message}` : '';
            await writeStatus(`${name} limit reached — paused.${detail} Resume after it resets, or switch model/provider.`, 'info');
            alarmClear();
          }
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
        // Auto-retry a normal failure up to the provider's configured count —
        // only while its auto-resume toggle is on, so "off" keeps prior behavior
        // (fail immediately, retry manually with the Retry-failed button).
        if (cd.autoResume && cd.retries > 0 && (item.attempts || 0) < cd.retries) {
          q = await getQueue();
          const it = q.find((i) => i.id === item.id);
          if (it) {
            it.attempts = (it.attempts || 0) + 1;
            it.status = 'pending';
            delete it.error;
            delete it.failure;
            delete it.startedAt;
            delete it.finishedAt;
            delete it.durationMs;
          }
          await setQueue(q);
          const name = PROVIDER_NAME[provider] || provider;
          await writeStatus(`${runStatusPrefix} failed — retry ${(item.attempts || 0) + 1}/${cd.retries} (${name})…`, 'running');
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
  if (!q.length) await clearCooldowns();
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
  if (a.name === ALARM) {
    processQueue();
    fleetHeartbeat();
  } else if (a.name === FLEET_ALARM) {
    fleetHeartbeat();
  }
});

// ── Fleet Hub agent ───────────────────────────────────────────────────────────
// When enabled, report this machine's queue status to the hub every few seconds
// and run any commands it returns. All outbound — Chrome extensions can't accept
// inbound connections, so control rides the heartbeat response. The 5s interval
// runs while the worker is alive (i.e. during active batches, when it matters);
// the 30s queue alarm also fires a heartbeat so idle machines still report.
let fleetAckedIds = [];
let fleetEnumeration = null; // { jobId, scenes:[{id,prompt,label}] } to report next beat
let fleetCatalog = null; // { kind:'projects'|'episodes', slug?, items } to report next beat

async function fleetHeartbeat() {
  const settings = await getSettings();
  const hub = String(settings.fleetHubUrl || '')
    .trim()
    .replace(/\/+$/, '');
  const name = String(settings.fleetAgentName || '').trim();
  if (!settings.fleetAgentEnabled || !hub || !name) return;

  const [rawQueue, paused, stored] = await Promise.all([
    getQueue(),
    isPaused(),
    chrome.storage.local.get([COOLDOWN_KEY, 'lastStatus']),
  ]);
  // COOLDOWN_KEY holds a PER-PROVIDER map ({ flow: resumeAt, qwen: resumeAt, … }),
  // so read this machine's provider — not the map itself. (Reading it as a bare
  // number always gave NaN→null, so the fleet never noticed a provider cooldown
  // and never released its scenes; the hub then held them hostage.)
  const cooldowns = stored[COOLDOWN_KEY] || {};
  const cooldownUntil = Number(cooldowns[settings.provider]) || null;

  // If we can't generate right now (paused or cooling down), hand our
  // not-yet-started fleet scenes back to the pool: drop them from our queue so
  // the hub redistributes them to a free machine AND so we don't double-generate
  // them when we resume. Running / done / failed items stay put.
  let queue = rawQueue;
  const cantGenerate = paused || (cooldownUntil && cooldownUntil > Date.now());
  if (cantGenerate) {
    const trimmed = queue.filter((i) => !(i.fleetJobId && i.status === 'pending'));
    if (trimmed.length !== queue.length) {
      await setQueue(trimmed);
      queue = trimmed;
    }
  }

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

  // Dispatch bookkeeping: report done/failed for hub-assigned scenes and how many
  // are still in flight so the hub knows our capacity.
  const fleetItems = queue.filter((i) => i.fleetJobId);
  const report = fleetItems
    .filter((i) => (i.status === 'done' || i.status === 'failed') && !i.fleetReported)
    .map((i) => ({
      jobId: i.fleetJobId,
      sceneId: i.sceneKey,
      status: i.status,
      // Send a concise reason so the hub can show WHY a scene failed.
      ...(i.status === 'failed' ? { error: (i.failure && i.failure.title) || String(i.error || 'Generation failed').slice(0, 300) } : {}),
    }));
  const fleetPending = fleetItems.filter((i) => i.status === 'pending' || i.status === 'running').length;

  const body = {
    agentId: name,
    name,
    version: chrome.runtime.getManifest().version,
    provider: settings.provider,
    studioUrl: settings.studioBaseUrl,
    state,
    counts,
    current: queue.find((i) => i.status === 'running')?.label || '',
    status: stored.lastStatus?.text || '',
    cooldownUntil,
    ackedCommandIds: fleetAckedIds,
    fleet: { pending: fleetPending, report, enumeration: fleetEnumeration, catalog: fleetCatalog },
    // Current pacing + this provider's cooldown + Flow auto-new-project so the hub
    // can show and push fleet-wide settings without guessing.
    config: {
      humanDelayMinSec: settings.humanDelayMinSec,
      humanDelayMaxSec: settings.humanDelayMaxSec,
      cooldown: providerCooldown(settings, settings.provider),
      flowAutoNewProject: settings.flowAutoNewProject === true,
      flowNewProjectEvery: Number(settings.flowNewProjectEvery) || 300,
    },
  };
  try {
    const r = await fetch(`${hub}/api/agents/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) return; // keep acks/report pending; retry next tick
    const data = await r.json().catch(() => ({}));
    fleetAckedIds = [];
    fleetEnumeration = null; // sent
    fleetCatalog = null; // sent
    // After reporting: drop the SUCCESSFUL scenes so they don't pile up, but KEEP
    // the failed ones on this machine so their error stays visible — just flag
    // them reported so we don't re-send them every heartbeat.
    if (report.length) {
      const reported = new Set(report.map((x) => `${x.jobId}|${x.sceneId}`));
      const isReported = (i) => i.fleetJobId && reported.has(`${i.fleetJobId}|${i.sceneKey}`);
      const q = await getQueue();
      await setQueue(
        q
          .filter((i) => !(i.status === 'done' && isReported(i)))
          .map((i) => (i.status === 'failed' && isReported(i) ? { ...i, fleetReported: true } : i))
      );
    }
    for (const cmd of data.commands || []) await executeFleetCommand(cmd, settings);
  } catch {
    /* hub unreachable — try again next tick */
  }
}

async function executeFleetCommand(cmd, settings) {
  try {
    switch (cmd.type) {
      case 'pause':
        await pauseQueue();
        break;
      case 'resume':
        await resumeQueue();
        break;
      case 'retryFailed':
        await retryFailed(null);
        break;
      case 'clear':
        await clearQueue();
        break;
      case 'fetchCatalog': {
        // The hub can't reach the shared Story Studio (auth) — we can, so list
        // projects/episodes for the hub's Distribute picker.
        const client = new StudioClient(settings.studioBaseUrl);
        if (cmd.kind === 'episodes' && cmd.slug) {
          // Episodes + characters in one shot (both per-project) for the picker.
          const [rows, chars] = await Promise.all([client.listEpisodes(cmd.slug), client.listCharacters(cmd.slug).catch(() => [])]);
          const eps = (Array.isArray(rows) ? rows : rows.episodes || [])
            .map((e) => ({ code: e.episode_code || e.code, title: e.title || '', done: !!e.status?.images, hasPlan: !!e.status?.scene_plan }))
            .filter((e) => e.code);
          const characters = [];
          for (const c of Array.isArray(chars) ? chars : chars.characters || []) {
            const imgs = (c.references && c.references.images) || c.reference_images || [];
            const first = imgs[0];
            const filename = typeof first === 'string' ? first : first && (first.filename || first.name);
            if (filename) characters.push({ id: c.id, name: c.name || c.id, filename });
          }
          fleetCatalog = { kind: 'episodes', slug: cmd.slug, items: eps, characters };
        } else {
          const rows = await client.listProjects();
          const projects = (Array.isArray(rows) ? rows : rows.projects || [])
            .map((p) => ({ slug: p.slug, name: p.name || p.slug }))
            .filter((p) => p.slug);
          fleetCatalog = { kind: 'projects', items: projects };
        }
        break;
      }
      case 'enumerateEpisode': {
        // Report this episode's missing scenes so the hub can build the pool.
        const data = await new StudioClient(settings.studioBaseUrl).sceneReview(cmd.slug, cmd.episodeCode);
        const scenes = (data?.scenes || [])
          .filter((s) => !s.image_filename && (s.visual_prompt || '').trim())
          .map((s) => ({ id: s.id, prompt: s.visual_prompt, label: `Scene ${s.scene_index}` }));
        fleetEnumeration = { jobId: cmd.jobId, scenes };
        break;
      }
      case 'applySettings': {
        // Fleet-wide settings push from the hub (pacing, per-provider cooldown,
        // Flow auto-new-project). providerCooldowns must DEEP-merge or we'd wipe
        // providers we didn't set.
        const patch = { ...(cmd.settings || {}) };
        if (patch.providerCooldowns) {
          const cur = (await getSettings()).providerCooldowns || {};
          const merged = { ...cur };
          for (const [prov, val] of Object.entries(patch.providerCooldowns)) merged[prov] = { ...(cur[prov] || {}), ...val };
          patch.providerCooldowns = merged;
        }
        await saveSettings(patch);
        // Record that the HUB set these, so the panel can show who's in control.
        const src = {};
        if ('humanDelayMinSec' in patch || 'humanDelayMaxSec' in patch) src.pace = { by: 'hub', at: Date.now() };
        if (patch.providerCooldowns) src.cooldown = { by: 'hub', at: Date.now() };
        if (Object.keys(src).length) {
          const cur = (await chrome.storage.local.get('settingsSource')).settingsSource || {};
          await chrome.storage.local.set({ settingsSource: { ...cur, ...src } });
        }
        break;
      }
      case 'newFlowProject':
        // Fleet Hub asked this machine to roll over to a fresh Flow project.
        await startNewFlowProject('Fleet Hub');
        break;
      case 'generateScenes':
        // Queue exactly the scenes the hub leased to us (dedupe guards double work).
        await enqueueScenes({
          slug: cmd.slug,
          episodeCode: cmd.episodeCode,
          provider: cmd.provider,
          target: cmd.target,
          source: 'plan',
          kind: 'scene',
          assetType: 'image',
          projectName: cmd.slug,
          fleetJobId: cmd.jobId,
          // Character reference for character scenes — enqueueScenes gates it to
          // Flow/Qwen and to scene_type === 'character', so it's safe to pass through.
          characterRef: cmd.characterRef || undefined,
          scenes: (cmd.scenes || []).map((x) => ({ source: 'plan', kind: 'scene', key: x.id, prompt: x.prompt, label: x.label, hasImage: false })),
        });
        break;
      default:
        break;
    }
  } catch {
    /* command failed — acked anyway so it doesn't loop forever */
  } finally {
    fleetAckedIds.push(cmd.id);
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
          : provider === 'qwen'
            ? 'qwen:getContext'
            : provider === 'piclumen'
              ? 'piclumen:getContext'
              : provider === 'chatgpt'
                ? 'chatgpt:getContext'
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
  // Manual resume overrides any provider's cooldown — clear them all.
  await chrome.storage.local.remove([PAUSE_KEY, COOLDOWN_KEY]);
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
    case 'flow:newProject':
      // Manual "New project" button — roll over to a fresh Flow project now.
      reply(startNewFlowProject('manual').then((id) => ({ ok: true, projectId: id })));
      return true;
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
    case 'grokContext':
      reply(grokContext());
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
