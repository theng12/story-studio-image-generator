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

import { getSettings } from './lib/config.js';
import { StudioClient } from './lib/story-studio.js';
import { buildDownloadPath } from './lib/naming.js';

const FLOW_URL = 'https://labs.google/fx/tools/flow';
const QUEUE_KEY = 'queue';
const ALARM = 'queueTick';
const SEEN_PROJECT_KEY = 'lastSeenFlowProjectId';

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

// On install/update, reload open Flow tabs so their content scripts aren't stale.
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://labs.google/fx/*' });
    for (const t of tabs) chrome.tabs.reload(t.id);
  } catch {
    /* best-effort */
  }
});

// ── Flow tab plumbing ────────────────────────────────────────────────────────
async function ensureFlowTab() {
  const tabs = await chrome.tabs.query({ url: 'https://labs.google/fx/*' });
  const ready = tabs.find((t) => t.status === 'complete');
  if (ready) return ready;
  const tab = tabs[0] || (await chrome.tabs.create({ url: FLOW_URL, active: false }));
  await new Promise((resolve) => {
    const listener = (tabId, info) => {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 1200); // let content scripts + grecaptcha initialise
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
  return tab;
}

async function send(tabId, message) {
  const res = await chrome.tabs.sendMessage(tabId, message);
  if (!res || !res.ok) throw new Error(res?.error || 'No response from the Flow tab.');
  return res;
}

// Generate one scene's image on Flow and save it (project or Downloads).
async function generateAndSave(item, settings, tab) {
  const projectId = item.projectId || settings.flowProjectId;
  if (!projectId) throw new Error('No Flow project set. Open a Flow project and pick it in the panel.');
  if (!item.prompt || !item.prompt.trim()) throw new Error('Scene has no image prompt.');

  const r = await send(tab.id, {
    type: 'flow:generateImage',
    params: {
      projectId,
      prompt: item.prompt,
      model: item.model || settings.imageModel,
      aspectRatio: item.aspectRatio || settings.aspectRatio,
    },
  });
  const { base64, mime } = r;
  const ext = mime === 'image/jpeg' ? 'jpg' : 'png';

  if (item.target === 'project' && item.slug && item.episodeCode && item.sceneId) {
    const client = new StudioClient(settings.studioBaseUrl);
    const out = await client.uploadSceneImage(item.slug, item.episodeCode, item.sceneId, base64);
    return { savedAs: `${item.sceneId}.png`, target: 'project', sceneId: out.scene_id };
  }

  const filename = item.downloadPath.replace(/\.(png|jpg|jpeg)$/i, '') + `.${ext}`;
  const downloadId = await chrome.downloads.download({
    url: `data:${mime};base64,${base64}`,
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
const politeGap = () => 2500 + Math.floor(Math.random() * 3500); // 2.5–6s

// ── the queue ───────────────────────────────────────────────────────────────
async function getQueue() {
  const { queue = [] } = await chrome.storage.local.get(QUEUE_KEY);
  return queue;
}
async function setQueue(q) {
  await chrome.storage.local.set({ [QUEUE_KEY]: q });
}

let _seq = 0;
function mkItem(o) {
  return { id: `${Date.now()}_${_seq++}`, status: 'pending', ...o };
}

let processing = false;

// Identity of a scene item, used to dedupe (so a double-click — or re-queuing
// an episode — can't add the same scene twice and waste work/credits).
function itemKey(it) {
  return it.episodeCode && it.sceneId ? `${it.episodeCode}::${it.sceneId}` : null;
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
    q.push({ ...it, id: it.id || `${Date.now()}_${_seq++}`, status: 'pending' });
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

// Expand an episode (or list of scenes) into queue items. Done worker-side so
// the panel stays snappy and dedupe is centralised.
async function enqueueScenes({ slug, episodeCode, episodeTitle, projectName, scenes, target, projectId }) {
  const settings = await getSettings();
  const items = (scenes || []).map((s) =>
    mkItem({
      kind: 'scene',
      slug,
      episodeCode,
      episodeTitle: episodeTitle || '',
      sceneId: s.id,
      sceneIndex: s.scene_index,
      prompt: s.visual_prompt,
      target: target || settings.saveTarget,
      projectId: projectId || settings.flowProjectId,
      model: settings.imageModel,
      aspectRatio: settings.aspectRatio,
      label: `${episodeCode} scene ${s.scene_index}`,
      // tokens for Downloads naming:
      project: projectName || episodeTitle || slug,
      downloadPath:
        (target || settings.saveTarget) === 'project'
          ? null
          : buildDownloadPath(settings, {
              project: projectName || episodeTitle || slug,
              episodeCode,
              episodeTitle: episodeTitle || '',
              sceneId: s.id,
              sceneIndex: String(s.scene_index),
            }),
    })
  );
  return enqueue(items);
}

async function processQueue() {
  if (processing) return;
  processing = true;
  try {
    const settings = await getSettings();
    let tab = null;
    for (;;) {
      let q = await getQueue();
      const idx = q.findIndex((i) => i.status === 'pending');
      if (idx < 0) break;
      q[idx].status = 'running';
      await setQueue(q);
      const item = q[idx];
      const pos = q.filter((i) => i.status === 'done' || i.status === 'failed').length + 1;
      await writeStatus(`(${pos}/${q.length}) ${item.label}…`, 'running');
      try {
        if (!tab) tab = await ensureFlowTab();
        const r = await generateAndSave(item, settings, tab);
        q = await getQueue();
        const it = q.find((i) => i.id === item.id);
        if (it) {
          it.status = 'done';
          it.savedAs = r.savedAs;
        }
        await setQueue(q);
      } catch (e) {
        q = await getQueue();
        const it = q.find((i) => i.id === item.id);
        if (it) {
          it.status = 'failed';
          it.error = String(e.message || e);
        }
        await setQueue(q);
      }
      const more = (await getQueue()).some((i) => i.status === 'pending');
      if (more) await sleep(politeGap());
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
      i.status = 'pending';
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
    case 'clearQueue':
      reply(clearQueue());
      return true;
    case 'getQueue':
      reply(getQueue().then((queue) => ({ ok: true, queue })));
      return true;
    case 'flowContext':
      reply(flowContext());
      return true;
    default:
      return false;
  }
});
