// Side-panel controller.
//
// The panel reads projects/episodes/scenes straight from the Story Studio
// server (it's an extension page, so it has host-permission to localhost), and
// hands batches to the background worker, which owns the Flow generation + the
// persistent queue. A confirmation step guards every batch so an accidental
// click can't burn work/credits.

import {
  requestSettings as getSettings,
  saveSettings,
  getLeonardoModels,
  saveLeonardoModels,
  providerCooldown,
} from '../lib/config.js';
import { PROVIDERS, getProvider } from '../lib/providers.js';
import { StudioClient } from '../lib/story-studio.js';
import { initTheme } from '../lib/theme.js';
import { pendingEpisodeRows, queuePendingEpisodes, summarizeQueueAll } from '../lib/queue-all.js';
import {
  createEpisodeAssetLoadRunner,
  createEpisodeRefreshQueue,
  createVisibleEpisodeIndex,
  episodeFilterState,
  episodeProgressLabel,
  newlySettledEpisodeCodes,
  thumbnailAvailability,
} from '../lib/episode-progress.js';
import {
  captureQueueAllContext,
  captureSceneEnqueueContext,
  captureStandaloneEnqueueContext,
} from '../lib/enqueue-context.js';
import { modelSnapshotDiagnostic, resolveStoredFlowModelId } from '../lib/model-identity.js';

const $ = (id) => document.getElementById(id);
let settings = null;
let client = null;
// Normalized items: { source, kind, key, label, prompt, hasImage, stale }
let currentScenes = [];
let currentSource = 'plan'; // 'plan' (scene_plan.json) | 'prompts' (03/04 prompts)
let loadedKind = 'scene'; // 'scene' | 'thumbnail' — what's currently loaded
let currentEpisode = null; // { code, title }
let currentProject = null; // { slug, name }
let allEpisodes = []; // [{ code, title, st, scene_images, thumbnail_images }]
let episodeRowsByCode = new Map();
let episodeOptionsByCode = new Map();
let liveStatus = null;
let studioConnection = null;
let workMode = 'studio';
let standalonePrompts = [];
let currentFlowModels = [];
let currentFlowModelSource = 'fallback';
let flowModelSaveTail = Promise.resolve();
let episodeListRevision = 0;
const episodeAssetLoad = createEpisodeAssetLoadRunner();
const episodeRefreshQueue = createEpisodeRefreshQueue();
const visibleEpisodeIndex = createVisibleEpisodeIndex();
let episodeRefreshInFlight = false;
const EPISODE_REFRESH_RETRY_MS = 10_000;

const HUMAN_PACE_PRESETS = {
  off: { label: 'Off', min: 0, max: 0 },
  quick: { label: 'Quick', min: 5, max: 15 },
  balanced: { label: 'Balanced', min: 15, max: 45 },
  cautious: { label: 'Cautious', min: 30, max: 90 },
  'very-cautious': { label: 'Very cautious', min: 60, max: 180 },
};

// The "Make:" selector chooses scene or thumbnail images.
const currentKind = () => ($('mediaType').value.startsWith('thumbnail') ? 'thumbnail' : 'scene');
const humanDelayValues = () => {
  const first = Number(settings?.humanDelayMinSec) || 0;
  const second = Number(settings?.humanDelayMaxSec) || 0;
  return { min: Math.min(first, second), max: Math.max(first, second) };
};
const humanDelayLabel = () => {
  const { min, max } = humanDelayValues();
  return min === max ? `${min}s` : `${min}-${max}s`;
};

function humanPacePresetKey(min, max) {
  return Object.entries(HUMAN_PACE_PRESETS).find(([, preset]) => preset.min === min && preset.max === max)?.[0] || 'custom';
}

function renderHumanPace() {
  if (!$('humanPacePreset') || !settings) return;
  const { min, max } = humanDelayValues();
  const key = humanPacePresetKey(min, max);
  const disabled = min === 0 && max === 0;
  const mode = key === 'custom' ? 'Custom' : HUMAN_PACE_PRESETS[key].label;
  const timing = disabled ? 'disabled' : min === max ? `${min}s fixed` : `${min}-${max}s random`;

  $('humanPacePreset').value = key;
  $('humanPaceCustom').classList.toggle('hidden', key !== 'custom');
  $('humanPaceMin').value = String(min);
  $('humanPaceMax').value = String(max);
  $('humanPaceState').textContent = disabled ? 'Disabled' : `${mode} · ${timing}`;
  $('humanPaceState').title = disabled ? 'Human pacing is off' : `Active human pace: ${mode}, ${timing}`;
  $('humanPaceState').classList.toggle('off', disabled);
}

async function selectHumanPacePreset() {
  const key = $('humanPacePreset').value;
  if (key === 'custom') {
    $('humanPaceCustom').classList.remove('hidden');
    $('humanPaceMin').focus();
    return;
  }
  const preset = HUMAN_PACE_PRESETS[key];
  if (!preset) return;
  settings = await saveSettings({ humanDelayMinSec: preset.min, humanDelayMaxSec: preset.max });
  await markSource('pace');
  renderHumanPace();
  renderAppliedSettings();
  flashSaved();
}

async function saveCustomHumanPace() {
  settings = await saveSettings({
    humanDelayMinSec: $('humanPaceMin').value,
    humanDelayMaxSec: $('humanPaceMax').value,
  });
  await markSource('pace');
  renderHumanPace();
  renderAppliedSettings();
  flashSaved();
}

// ── Provider cooldown / auto-resume ─────────────────────────────────────────
// Mirrors the Human Pace card but scoped to the currently-selected provider.
// Auto-resume defaults off (manual Resume); when on, a recommended-but-editable
// cooldown + retries apply for that provider only.
const COOLDOWN_PRESETS = [15, 30, 60, 480, 720, 1440];
const COOLDOWN_SUPPORTED = new Set(PROVIDERS.filter(({ capabilities }) => capabilities.cooldown).map(({ id }) => id));

const cooldownProviderKey = () => ($('provider') ? $('provider').value : 'flow');

function cooldownMinutesLabel(minutes) {
  if (minutes % 60 === 0) return `${minutes / 60} hr`;
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function renderCooldownCard() {
  if (!$('cooldownCard') || !settings) return;
  const provider = cooldownProviderKey();
  const name = PROVIDER_LABEL[provider] || provider;
  const supported = COOLDOWN_SUPPORTED.has(provider);
  $('cooldownProviderName').textContent = name;
  $('cooldownAutoResume').closest('label').classList.toggle('hidden', !supported);
  $('cooldownUnsupported').classList.toggle('hidden', supported);
  if (!supported) {
    $('cooldownOpts').classList.add('hidden');
    $('cooldownState').textContent = '';
    return;
  }
  const cd = providerCooldown(settings, provider);
  $('cooldownAutoResume').checked = !!cd.autoResume;
  $('cooldownOpts').classList.toggle('hidden', !cd.autoResume);
  const isPreset = COOLDOWN_PRESETS.includes(cd.minutes);
  $('cooldownPreset').value = isPreset ? String(cd.minutes) : 'custom';
  $('cooldownCustom').classList.toggle('hidden', isPreset);
  $('cooldownMinutes').value = String(cd.minutes);
  $('cooldownRetries').value = String(cd.retries);
  renderCooldownState();
}

// The state chip: live countdown when THIS provider is cooling down, else the
// configured mode. Split out so the 250ms status tick can refresh just this.
function renderCooldownState() {
  if (!$('cooldownCard') || !settings) return;
  const provider = cooldownProviderKey();
  const el = $('cooldownState');
  if (!COOLDOWN_SUPPORTED.has(provider)) return;
  const cd = providerCooldown(settings, provider);
  if (!cd.autoResume) {
    el.textContent = 'Manual';
    el.classList.add('off');
    return;
  }
  el.classList.remove('off');
  const cooling =
    liveStatus &&
    liveStatus.countdownReason === 'cooldown' &&
    liveStatus.countdownProvider === provider &&
    Number.isFinite(liveStatus.countdownUntil) &&
    liveStatus.countdownUntil > Date.now();
  el.textContent = cooling
    ? `On cooldown · ${formatDuration(liveStatus.countdownUntil - Date.now())}`
    : `Auto-resume · ${cooldownMinutesLabel(cd.minutes)}`;
}

function saveProviderCooldown(patch) {
  const provider = cooldownProviderKey();
  const current = providerCooldown(settings, provider);
  const next = { ...settings.providerCooldowns, [provider]: { ...current, ...patch } };
  markSource('cooldown').then(renderAppliedSettings);
  return saveSettings({ providerCooldowns: next });
}

async function onCooldownToggle() {
  settings = await saveProviderCooldown({ autoResume: $('cooldownAutoResume').checked });
  renderCooldownCard();
  flashSaved();
}

async function onCooldownPreset() {
  const val = $('cooldownPreset').value;
  if (val === 'custom') {
    $('cooldownCustom').classList.remove('hidden');
    $('cooldownMinutes').focus();
    return;
  }
  settings = await saveProviderCooldown({ minutes: Number(val) });
  renderCooldownCard();
  flashSaved();
}

async function saveCooldownCustom() {
  const minutes = Math.max(1, Math.min(1440, Number($('cooldownMinutes').value) || 15));
  settings = await saveProviderCooldown({ minutes });
  renderCooldownCard();
  flashSaved();
}

async function saveCooldownRetries() {
  const retries = Math.max(0, Math.min(10, Number($('cooldownRetries').value) || 0));
  settings = await saveProviderCooldown({ retries });
  renderCooldownCard();
  flashSaved();
}

// ── What's new (changelog) ──────────────────────────────────────────────────
// Renders CHANGELOG.md (packaged with the extension) in a modal, and shows a
// red dot on the button until the current version's notes have been opened.
function renderChangelog(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');
  return md
    .split('\n')
    .map((line) => {
      if (/^#\s/.test(line)) return ''; // top-level title — skip (modal already titled)
      if (/^##\s/.test(line)) return `<h3 class="cl-ver">${inline(line.replace(/^##\s+/, ''))}</h3>`;
      if (/^\s*-\s/.test(line)) return `<div class="cl-item">• ${inline(line.replace(/^\s*-\s+/, ''))}</div>`;
      if (/^\s*$/.test(line)) return '';
      return `<p>${inline(line)}</p>`;
    })
    .join('');
}

async function openWhatsNew(version) {
  const body = $('whatsNewBody');
  if (!body.dataset.loaded) {
    try {
      const md = await (await fetch(chrome.runtime.getURL('CHANGELOG.md'))).text();
      body.innerHTML = renderChangelog(md);
      body.dataset.loaded = '1';
    } catch {
      body.textContent = "Couldn't load the changelog.";
    }
  }
  $('whatsNewModal').classList.remove('hidden');
  $('whatsNewDot').classList.add('hidden');
  chrome.storage.local.set({ whatsNewSeen: version });
}

async function initWhatsNew(version) {
  const { whatsNewSeen } = await chrome.storage.local.get('whatsNewSeen');
  $('whatsNewDot').classList.toggle('hidden', whatsNewSeen === version);
  $('whatsNew').onclick = () => openWhatsNew(version);
  $('whatsNewClose').onclick = () => $('whatsNewModal').classList.add('hidden');
  $('whatsNewModal').onclick = (e) => {
    if (e.target === $('whatsNewModal')) $('whatsNewModal').classList.add('hidden');
  };
}

async function init() {
  await initTheme();
  const manifest = chrome.runtime.getManifest();
  $('extensionVersion').textContent = `v${manifest.version}`;
  $('extensionVersion').title = `${manifest.name} v${manifest.version}`;
  initWhatsNew(manifest.version);
  settings = await getSettings();
  client = new StudioClient(settings.studioBaseUrl);
  populateProviderSelect(settings.provider || 'flow');
  $('includeExisting').checked = !!settings.includeExisting;
  $('storyStudioReferencesEnabled').checked = settings.storyStudioReferencesEnabled !== false;
  setEpisodeFilterUI(settings.episodeFilter || 'todo');
  const localState = await chrome.storage.local.get(['settingsSource', 'imageGeneratorStudioConnection']);
  settingsSource = localState.settingsSource || {};
  studioConnection = localState.imageGeneratorStudioConnection || null;
  workMode = (await chrome.storage.local.get('imageGeneratorWorkMode')).imageGeneratorWorkMode === 'standalone'
    ? 'standalone'
    : 'studio';
  renderHumanPace();
  renderCooldownCard();
  renderAppliedSettings();
  renderWorkMode();
  renderStudioConnection();
  await refreshFlowProject();
  wire();
  if (workMode === 'studio') await loadProjects();
  onProviderChange();
  pollQueue();
  setInterval(pollQueue, 1500);
  setInterval(renderLiveStatus, 250);
}

function populateProviderSelect(selected) {
  const select = $('provider');
  select.replaceChildren(
    ...PROVIDERS.map(({ id, label }) => {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = label;
      return option;
    })
  );
  select.value = getProvider(selected) ? selected : 'flow';
}

function wire() {
  $('openOptions').onclick = () => chrome.runtime.openOptionsPage();
  $('workingMode').onchange = () => setWorkMode($('workingMode').value);
  $('reviewStandalone').onclick = reviewStandalonePrompts;
  $('editStandalone').onclick = showStandaloneEditor;
  $('queueStandalone').onclick = queueStandalone;
  $('standalonePrompt').oninput = () => {
    if (standalonePrompts.length) showStandaloneEditor();
  };
  $('openStudioSettings').onclick = () => chrome.runtime.openOptionsPage();
  document.querySelectorAll('.open-options-link').forEach((button) => {
    button.onclick = () => chrome.runtime.openOptionsPage();
  });
  $('humanPacePreset').onchange = selectHumanPacePreset;
  $('humanPaceMin').onchange = saveCustomHumanPace;
  $('humanPaceMax').onchange = saveCustomHumanPace;
  $('cooldownAutoResume').onchange = onCooldownToggle;
  $('cooldownPreset').onchange = onCooldownPreset;
  $('cooldownMinutes').onchange = saveCooldownCustom;
  $('cooldownRetries').onchange = saveCooldownRetries;
  $('project').onchange = onProjectChange;
  $('episode').onchange = () => {
    // A newly visible Done-filter option is intentionally not inserted into
    // the hot-path index. Rebuild only if the user chooses one.
    if (!visibleEpisodeIndex.has($('episode').value)) applyEpisodeFilter();
    clearLoadedEpisodeAssets();
  };
  $('loadScenes').onclick = loadScenes;
  $('refreshScenes').onclick = loadScenes;
  $('selectAll').onchange = (e) => {
    document.querySelectorAll('.scene input[type=checkbox]').forEach((c) => {
      if (!c.disabled) c.checked = e.target.checked;
    });
    updateQueueButton();
  };
  $('batchControls').querySelectorAll('.batch-n').forEach((b) => {
    b.onclick = () => selectNextMissing(Number(b.dataset.n));
  });
  $('selectRemaining').onclick = selectRemaining;
  $('selectCustomBatch').onclick = selectCustomBatch;
  $('customBatchSize').onkeydown = (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    selectCustomBatch();
  };
  $('sceneSearch').oninput = filterScenesList;
  $('selectFailed').onclick = selectFailedScenes;
  $('queueAllPending').onclick = queueAllPending;
  $('queueAllPendingSecondary').onclick = queueAllPending;
  $('queueEpisode').onclick = () => {
    if (!currentEpisode || !currentScenes.length) {
      setStatus('Load this episode’s scenes first.', 'info');
      return;
    }
    selectRemaining();
    if (selectedScenes().length) confirmQueue();
    else setStatus('No missing scenes in this episode.', 'info');
  };
  $('queueSelected').onclick = confirmQueue;
  $('clearQueue').onclick = async () => {
    await chrome.runtime.sendMessage({ type: 'clearQueue' });
    pollQueue();
  };
  $('pauseQueue').onclick = async () => {
    const resuming = $('pauseQueue').dataset.paused === 'true';
    await chrome.runtime.sendMessage({ type: resuming ? 'resumeQueue' : 'pauseQueue' });
    pollQueue();
  };
  $('clearFailed').onclick = async () => {
    const res = await chrome.runtime.sendMessage({ type: 'clearFailed' });
    if (!res?.cleared) setStatus('No failed jobs to clear.', 'info');
    pollQueue();
  };
  $('clearCompleted').onclick = async () => {
    const res = await chrome.runtime.sendMessage({ type: 'clearCompleted' });
    if (!res?.cleared) setStatus('No completed jobs to clear.', 'info');
    if (currentProject) {
      episodeRefreshQueue.add(
        (res?.completedEpisodes || [])
          .filter((episode) => episode.slug === currentProject.slug)
          .map((episode) => episode.code),
      );
    }
    pollQueue();
  };
  $('retryFailed').onclick = async () => {
    const res = await chrome.runtime.sendMessage({ type: 'retryFailed' });
    if (!res?.retried) setStatus('No failed jobs to retry.', 'info');
    pollQueue();
  };
  $('mediaType').onchange = onMediaTypeChange;
  $('provider').onchange = onProviderChange;
  $('openProviderPage').onclick = () => chrome.runtime.sendMessage({ type: 'openProviderPage', provider: $('provider').value });
  $('leoSync').onclick = leoSyncAll;
  $('leoModel').onchange = async () => {
    settings = await saveSettings({ leonardoModel: $('leoModel').value });
    leoCheckModel();
  };
  $('leoStyle').onchange = async () => (settings = await saveSettings({ leonardoStyle: $('leoStyle').value }));
  $('leoMode').onchange = async () => (settings = await saveSettings({ leonardoMode: $('leoMode').value }));
  $('leoSize').onchange = async () => (settings = await saveSettings({ leonardoSize: $('leoSize').value }));
  $('leoCount').onchange = async () => (settings = await saveSettings({ leonardoCount: Number($('leoCount').value) }));
  $('flowImageModel').onchange = () => persistSelectedFlowModel();
  $('refreshFlowModels').onclick = refreshFlowModels;
  $('flowAspect').onchange = async () => (settings = await saveSettings({ aspectRatio: $('flowAspect').value }));
  $('flowRecaptchaMaxAttempts').onchange = async () => {
    settings = await saveSettings({ flowRecaptchaMaxAttempts: $('flowRecaptchaMaxAttempts').value });
    $('flowRecaptchaMaxAttempts').value = settings.flowRecaptchaMaxAttempts;
  };
  $('storyStudioReferencesEnabled').onchange = async () => {
    settings = await saveSettings({ storyStudioReferencesEnabled: $('storyStudioReferencesEnabled').checked });
    flashSaved();
  };
  $('qwenAspect').onchange = async () => (settings = await saveSettings({ qwenAspectRatio: $('qwenAspect').value }));
  $('aistudioAspect').onchange = async () => (settings = await saveSettings({ aistudioAspectRatio: $('aistudioAspect').value }));
  $('chatgptAspect').onchange = async () => (settings = await saveSettings({ chatgptAspectRatio: $('chatgptAspect').value }));
  $('chatgptMaxWait').onchange = async () => {
    const min = Math.min(15, Math.max(1, Math.round(Number($('chatgptMaxWait').value) || 8)));
    $('chatgptMaxWait').value = min;
    settings = await saveSettings({ chatgptMaxWaitSec: min * 60 });
  };
  $('includeExisting').onchange = () => {
    saveSettings({ includeExisting: $('includeExisting').checked });
    if (currentScenes.length) renderScenes();
    flashSaved();
  };
  $('episodeFilter').querySelectorAll('.seg').forEach((b) => {
    b.onclick = async () => {
      setEpisodeFilterUI(b.dataset.f);
      settings = await saveSettings({ episodeFilter: b.dataset.f });
      applyEpisodeFilter();
    };
  });
  $('useCurrentProject').onclick = useCurrentFlowProject;
  $('newFlowProject').onclick = newFlowProject;
  $('flowAutoNewProject').onchange = async () => {
    settings = await saveSettings({ flowAutoNewProject: $('flowAutoNewProject').checked });
  };
  $('flowNewProjectEvery').onchange = async () => {
    const v = Math.max(1, Math.round(Number($('flowNewProjectEvery').value) || 300));
    $('flowNewProjectEvery').value = v;
    settings = await saveSettings({ flowNewProjectEvery: v });
  };
  $('testConn').onclick = testConnection;
  $('confirmCancel').onclick = () => $('confirm').classList.add('hidden');
}

function renderWorkMode() {
  const studioMode = workMode === 'studio';
  $('studioWorkflow').classList.toggle('hidden', !studioMode);
  $('scenesCard').classList.toggle('hidden', !studioMode);
  $('standaloneWorkflow').classList.toggle('hidden', studioMode);
  $('saveDestination').textContent = studioMode ? 'Story Studio KH' : 'Downloads';
  $('workingMode').value = workMode;
}

async function setWorkMode(mode) {
  workMode = mode === 'standalone' ? 'standalone' : 'studio';
  await chrome.storage.local.set({ imageGeneratorWorkMode: workMode });
  renderWorkMode();
  if (workMode === 'studio') await loadProjects();
  else setStatus('Standalone mode uses a local prompt and Downloads.', 'info');
}

async function queueStandalone() {
  if (!standalonePrompts.length) return reviewStandalonePrompts();
  const provider = $('provider').value;
  if (provider === 'flow' && !hasSelectedFlowModel()) {
    setStatus('Select a current Flow model, refresh the signed-in Flow workspace, and re-queue.', 'err');
    return;
  }
  if (provider === 'flow' && !settings.flowProjectId) {
    setStatus('Select a generation workspace before queuing with this provider.', 'err');
    return;
  }
  const payload = captureStandaloneEnqueueContext({
    prompts: standalonePrompts,
    label: $('standaloneLabel').value,
    provider,
  });
  const button = $('queueStandalone');
  button.disabled = true;
  try {
    if (provider === 'flow' && !await persistSelectedFlowModel()) {
      setStatus('Select a current Flow model, refresh the signed-in Flow workspace, and re-queue.', 'err');
      return;
    }
    const res = await chrome.runtime.sendMessage({
      type: 'enqueueStandalone',
      payload,
    });
    if (!res?.ok) throw new Error(res?.error || 'Could not queue the images.');
    $('standalonePrompt').value = '';
    standalonePrompts = [];
    showStandaloneEditor();
    setStatus(`Queued ${res.added} standalone image${res.added === 1 ? '' : 's'} to Downloads${res.skipped ? `; skipped ${res.skipped}` : ''}.`, 'done');
    pollQueue();
  } catch (error) {
    setStatus(String(error?.message || error), 'err');
  } finally {
    button.disabled = false;
  }
}

function parseStandalonePrompts(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, ''))
    .filter(Boolean);
}

function showStandaloneEditor() {
  $('standaloneEditor').classList.remove('hidden');
  $('standaloneReview').classList.add('hidden');
}

function reviewStandalonePrompts() {
  const prompts = parseStandalonePrompts($('standalonePrompt').value);
  if (!prompts.length) {
    setStatus('Paste at least one image prompt first.', 'err');
    $('standalonePrompt').focus();
    return;
  }
  if (prompts.length > 100) {
    setStatus('Review up to 100 prompts at a time.', 'err');
    return;
  }
  standalonePrompts = prompts;
  const list = $('standaloneReviewList');
  list.replaceChildren();
  prompts.forEach((prompt, index) => {
    const item = document.createElement('li');
    const number = document.createElement('span');
    number.className = 'standalone-review-index';
    number.textContent = String(index + 1);
    const text = document.createElement('span');
    text.className = 'standalone-review-prompt';
    text.textContent = prompt;
    item.append(number, text);
    list.appendChild(item);
  });
  $('standaloneReviewCount').textContent = `${prompts.length} task${prompts.length === 1 ? '' : 's'}`;
  $('queueStandalone').textContent = `Queue ${prompts.length} image${prompts.length === 1 ? '' : 's'}`;
  $('standaloneEditor').classList.add('hidden');
  $('standaloneReview').classList.remove('hidden');
  setStatus('Review the split, then queue the approved tasks.', 'info');
}

function testedLabel(at) {
  if (!at) return '';
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  return `tested ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function renderStudioConnection() {
  const card = $('studioWorkflow').querySelector('.studio-connection');
  const out = $('connStatus');
  const state = studioConnection?.state || 'untested';
  card.dataset.state = state;
  $('openStudioSettings').classList.toggle('hidden', state !== 'failed');
  out.title = '';
  if (state === 'testing') {
    out.textContent = 'Testing Story Studio…';
    return;
  }
  if (state === 'connected') {
    out.textContent = `Connected${studioConnection.projects != null ? ` · ${studioConnection.projects} project${studioConnection.projects === 1 ? '' : 's'}` : ''}${testedLabel(studioConnection.at) ? ` · ${testedLabel(studioConnection.at)}` : ''}`;
    return;
  }
  if (state === 'failed') {
    out.textContent = `Connection failed${testedLabel(studioConnection.at) ? ` · ${testedLabel(studioConnection.at)}` : ''}`;
    out.title = studioConnection.message || '';
    return;
  }
  out.textContent = '';
}

async function saveStudioConnection(next) {
  studioConnection = next;
  renderStudioConnection();
  await chrome.storage.local.set({ imageGeneratorStudioConnection: next });
}

// Keep the indicator current when Settings is edited in another extension tab.
// Who last set pacing / cooldown — this machine (local) or the Fleet Hub.
let settingsSource = {};

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync' && changes.settings?.newValue && settings) {
    // A change here can come from a Fleet Hub push (applySettings) — reflect it.
    settings = { ...settings, ...changes.settings.newValue };
    renderHumanPace();
    renderCooldownCard();
    renderAppliedSettings();
  }
  if (areaName === 'local' && changes.settingsSource) {
    settingsSource = changes.settingsSource.newValue || {};
    renderAppliedSettings();
  }
});

// Compact "what's actually applied right now, and who set it" line below the
// header — so it stays visible independently of the current batch state.
function renderAppliedSettings() {
  const el = $('appliedSettings');
  if (!el || !settings) return;
  const min = Number(settings.humanDelayMinSec) || 0;
  const max = Number(settings.humanDelayMaxSec) || 0;
  const cd = providerCooldown(settings, settings.provider);
  const prov = PROVIDER_LABEL[settings.provider] || settings.provider || 'provider';
  const cdText = cd.autoResume ? `auto-resume ${cooldownMinutesLabel(cd.minutes)}` : 'stops on limit';
  const tag = (grp) => {
    const by = settingsSource[grp]?.by;
    return by ? ` <span class="src ${by === 'hub' ? 'hub' : 'local'}">${by === 'hub' ? 'Fleet Hub' : 'local'}</span>` : '';
  };
  el.innerHTML = `<span>⚙ Pacing ${min}–${max}s${tag('pace')}</span><span>${prov} cooldown: ${cdText}${tag('cooldown')}</span>`;
}

// Note that THIS machine (not the hub) last set a settings group.
async function markSource(group) {
  settingsSource = { ...settingsSource, [group]: { by: 'local', at: Date.now() } };
  await chrome.storage.local.set({ settingsSource });
}

// ── Flow project ──────────────────────────────────────────────────────────
async function refreshFlowProject() {
  if (settings.flowProjectId) {
    $('flowProjectName').textContent =
      settings.flowProjectName || settings.flowProjectId.slice(0, 8) + '…';
  } else {
    $('flowProjectName').textContent = 'none selected';
  }
  $('flowAutoNewProject').checked = settings.flowAutoNewProject === true;
  $('flowNewProjectEvery').value = settings.flowNewProjectEvery || 300;
  const stored = await chrome.storage.local.get('flowProjectImageCount');
  const n = Number(stored.flowProjectImageCount) || 0;
  $('flowProjectCount').textContent = n ? `· ${n} so far` : '';
}

async function newFlowProject() {
  $('newFlowProject').disabled = true;
  setStatus('Starting a new Flow project…', 'info');
  try {
    const r = await chrome.runtime.sendMessage({ type: 'flow:newProject' });
    if (!r?.ok) throw new Error(r?.error || 'Could not start a new project.');
    settings = await getSettings();
    await refreshFlowProject();
    setStatus('New Flow project started.', 'done');
  } catch (e) {
    setStatus(String(e.message || e), 'err');
  } finally {
    $('newFlowProject').disabled = false;
  }
}

async function useCurrentFlowProject() {
  $('useCurrentProject').disabled = true;
  try {
    const ctx = await chrome.runtime.sendMessage({ type: 'flowContext' });
    if (!ctx?.ok) throw new Error(ctx?.error || 'Could not reach a Flow tab.');
    $('flowSignin').classList.toggle('hidden', !!ctx.signedIn);
    if (!ctx.projectId) {
      setStatus('Open a Flow project tab first (a /project/… URL), then try again.', 'err');
      return;
    }
    settings = await saveSettings({ flowProjectId: ctx.projectId, flowProjectName: '' });
    await refreshFlowProject();
    setStatus('Flow project captured.', 'done');
  } catch (e) {
    setStatus(String(e.message || e), 'err');
  } finally {
    $('useCurrentProject').disabled = false;
  }
}

// ── Story Studio connection test ────────────────────────────────────────────
// Verifies the whole chain from where you actually work: for a remote/Tailscale
// URL it first checks host access was granted (Settings), then reaches the API.
async function testConnection() {
  $('testConn').disabled = true;
  await saveStudioConnection({ state: 'testing' });
  try {
    const url = settings.studioBaseUrl || '';
    const local = /localhost|127\.0\.0\.1/.test(url);
    if (!local) {
      let pat = null;
      try {
        const u = new URL(url);
        pat = `${u.protocol}//${u.hostname}/*`;
      } catch {
        /* invalid url */
      }
      const granted = pat ? await chrome.permissions.contains({ origins: [pat] }).catch(() => false) : false;
      if (!granted) {
        await saveStudioConnection({ state: 'failed', at: Date.now(), message: 'No host access — open Settings → Grant access to this server.' });
        return;
      }
    }
    const projects = await client.listProjects();
    const n = Array.isArray(projects) ? projects.length : (projects.projects || []).length;
    await saveStudioConnection({ state: 'connected', at: Date.now(), projects: n });
    await loadProjects(); // refresh the dropdown now that we're reachable
  } catch (e) {
    const local = /localhost|127\.0\.0\.1/.test(settings.studioBaseUrl || '');
    await saveStudioConnection({
      state: 'failed',
      at: Date.now(),
      message: `${e.message}. ${local ? 'Is Story Studio running?' : "Check it's running, access granted, and you're logged in."}`,
    });
  } finally {
    $('testConn').disabled = false;
  }
}

// ── projects / episodes ─────────────────────────────────────────────────────
async function loadProjects() {
  try {
    const projects = await client.listProjects();
    const sel = $('project');
    sel.innerHTML = '<option value="">— pick a project —</option>';
    for (const p of projects) {
      const opt = document.createElement('option');
      opt.value = p.slug;
      opt.textContent = p.name || p.slug;
      opt.dataset.name = p.name || p.slug;
      sel.appendChild(opt);
    }
    if (settings.lastProject) {
      sel.value = settings.lastProject;
      if (sel.value) await onProjectChange();
    }
  } catch (e) {
    const local = /localhost|127\.0\.0\.1/.test(settings.studioBaseUrl || '');
    const hint = local ? 'is it running?' : 'is it running, did you Grant access + log in (Settings)?';
    setStatus(`Can't reach Story Studio at ${settings.studioBaseUrl} — ${hint} (${e.message})`, 'err');
  }
}

function setEpisodeFilterUI(mode) {
  $('episodeFilter')
    .querySelectorAll('.seg')
    .forEach((b) => b.classList.toggle('active', b.dataset.f === mode));
}

const episodeNum = (code) => {
  const m = String(code).match(/\d+/);
  return m ? parseInt(m[0], 10) : Number.MAX_SAFE_INTEGER;
};

// Show/hide episode options using the aggregate for the selected asset kind.
function applyEpisodeFilter() {
  const filter = settings.episodeFilter || 'todo';
  const esel = $('episode');
  const kind = currentKind();
  const state = episodeFilterState(allEpisodes, {
    kind,
    filter,
    selectedCode: esel.value,
  });
  const visible = new Set(state.visibleCodes);
  for (const opt of esel.options) {
    const progress = state.progressByCode[opt.value];
    const title = opt.dataset.title;
    opt.hidden = !visible.has(opt.value);
    const progressText = episodeProgressLabel(progress);
    opt.textContent = `${opt.value}${title ? ' — ' + title : ''} · ${progressText}`;
  }
  visibleEpisodeIndex.reset(state.visibleCodes);
  const noun = kind === 'thumbnail' ? 'thumbnail images' : 'scene images';
  $('episodeFilter').querySelector('[data-f="todo"]').title = `Episodes that still need ${noun}`;
  $('episodeFilter').querySelector('[data-f="done"]').title = `Episodes whose ${noun} are done`;
  $('episodeFilter').querySelector('[data-f="all"]').title = `Every episode with ${kind === 'thumbnail' ? 'Thumbnail Prompts' : 'a Scene Plan'}`;
  $('includeExistingLabel').textContent = `Include ${kind === 'thumbnail' ? 'thumbnails' : 'scenes'} that already have an image`;
  $('queueAllPending').title = `Queue every missing ${kind === 'thumbnail' ? 'thumbnail' : 'scene'} across all “To do” episodes in this project`;
  esel.value = state.selectedCode;
  if (currentEpisode && currentEpisode.code !== state.selectedCode) clearLoadedEpisodeAssets();
  return state;
}

function noEpisodeStatus(kind) {
  if (kind !== 'thumbnail') return 'No episodes have a Scene Plan.';
  const availability = thumbnailAvailability(allEpisodes);
  if (availability.withoutPrompts) {
    return `${availability.done} thumbnail episode${availability.done === 1 ? '' : 's'} marked done. ` +
      `${availability.withoutPrompts} episode${availability.withoutPrompts === 1 ? '' : 's'} do not have Thumbnail Prompts in Story Studio yet.`;
  }
  return 'No pending Thumbnail Prompts match this filter.';
}

function clearLoadedEpisodeAssets() {
  episodeAssetLoad.cancel();
  currentEpisode = null;
  currentScenes = [];
  renderScenes();
  $('scenesSummary').textContent = '';
  $('loadScenes').disabled = false;
  $('refreshScenes').disabled = false;
}

// Queue every missing image for the selected asset kind across pending episodes.
async function queueAllPending() {
  if (!currentProject) return setStatus('Pick a project first.', 'err');
  const kind = currentKind();
  const provider = $('provider').value;
  const initial = captureQueueAllContext({
    project: currentProject,
    provider,
    kind,
    episodes: [],
    flowModelApproval: provider === 'flow' ? selectedFlowModelApproval() : null,
  });
  const project = initial.project;
  if (provider === 'flow' && !initial.flowModelApproval) return setStatus('Select a current Flow model, refresh the signed-in Flow workspace, and re-queue.', 'err');
  if (provider === 'flow' && !settings.flowProjectId) return setStatus('Set a Flow project first.', 'err');
  let rows;
  try {
    rows = await client.listEpisodes(project.slug);
  } catch (e) {
    return setStatus(`Couldn't list episodes: ${e.message}`, 'err');
  }
  const episodes = Array.isArray(rows) ? rows : rows.episodes || [];
  const eligible = episodes.filter((e) => kind === 'thumbnail'
    ? !!(e.status || {}).thumb_prompts
    : !!(e.status || {}).scene_plan);
  if (!eligible.length) {
    const source = kind === 'thumbnail' ? 'Thumbnail Prompts' : 'Scene Plans';
    return setStatus(`No ${source} found. Create them in Story Studio, then try again.`, 'err');
  }
  const pending = pendingEpisodeRows(episodes, kind);
  if (!pending.length) {
    if (kind === 'thumbnail') {
      const availability = thumbnailAvailability(episodes);
      if (availability.withoutPrompts) {
        return setStatus(
          `No pending Thumbnail Prompts to queue. ${availability.withoutPrompts} episode${availability.withoutPrompts === 1 ? '' : 's'} do not have Thumbnail Prompts in Story Studio yet.`,
          'info',
        );
      }
    }
    return setStatus('No pending episodes — everything is done. 🎉', 'info');
  }
  const approved = captureQueueAllContext({
    project,
    provider,
    kind,
    episodes: pending,
    flowModelApproval: initial.flowModelApproval,
  });
  const dlg = $('confirm');
  $('confirmTitle').textContent = `Queue all pending on ${PROVIDER_LABEL[approved.provider] || approved.provider}?`;
  const flowApproval = approved.flowModelApproval;
  const assetLabel = approved.kind === 'thumbnail' ? 'thumbnail' : 'scene';
  const modelNote = flowApproval
    ? ` Images use ${flowApproval.modelLabel} (${flowApproval.modelSource === 'live' ? 'live workspace' : 'tested fallback'}).`
    : '';
  $('confirmBody').textContent =
    `Loads ${approved.episodes.length} pending episode${approved.episodes.length > 1 ? 's' : ''} and queues every missing ${assetLabel} image via ` +
    `${PROVIDER_LABEL[approved.provider] || approved.provider} → Story Studio folders. ` +
    `Already-queued images are skipped.${modelNote} This can be a lot of images — continue?`;
  $('confirmOk').textContent = 'Queue all pending';
  dlg.classList.remove('hidden');
  $('confirmOk').onclick = async () => {
    dlg.classList.add('hidden');
    setStatus(`Queuing ${approved.episodes.length} episode${approved.episodes.length > 1 ? 's' : ''}…`, 'running');
    if (approved.provider === 'flow' && !await persistFlowModelApproval(approved.flowModelApproval)) {
      setStatus('Select a current Flow model, refresh the signed-in Flow workspace, and re-queue.', 'err');
      return;
    }
    const result = await queuePendingEpisodes({
      context: approved,
      loadAssets: async ({ kind: assetKind, slug, episode }) => assetKind === 'thumbnail'
        ? { scenes: await loadThumbnails(slug, episode), source: 'prompts' }
        : loadScenePlan(slug, episode),
      enqueue: (payload) => chrome.runtime.sendMessage({ type: 'enqueueScenes', payload }),
    });
    const summary = summarizeQueueAll(result);
    setStatus(summary.text, summary.kind);
    pollQueue();
  };
}

async function onProjectChange() {
  const sel = $('project');
  const slug = sel.value;
  episodeListRevision++;
  episodeRefreshQueue.clear();
  currentProject = null;
  allEpisodes = [];
  episodeRowsByCode.clear();
  episodeOptionsByCode.clear();
  visibleEpisodeIndex.reset([]);
  clearLoadedEpisodeAssets();
  $('episode').innerHTML = '';
  if (!slug) return;
  currentProject = { slug, name: sel.selectedOptions[0]?.dataset.name || slug };
  await saveSettings({ lastProject: slug });
  try {
    await refreshEpisodeOptions(slug);
  } catch (e) {
    setStatus(`Couldn't load episodes: ${e.message}`, 'err');
  }
}

async function refreshEpisodeOptions(slug) {
  const revision = ++episodeListRevision;
  const selectedCode = $('episode').value || settings.lastEpisode;
  const rows = await client.listEpisodes(slug);
  if (revision !== episodeListRevision || currentProject?.slug !== slug || $('project').value !== slug) return false;
  // Normalize the aggregate row once; loading a Scene Review stays an explicit
  // selected-episode or queue-all operation rather than a project-load cost.
  allEpisodes = (Array.isArray(rows) ? rows : rows.episodes || [])
    .map(normalizeEpisodeRow)
    .filter((e) => e.st.scene_plan || e.st.scene_prompts || e.st.thumb_prompts)
    .sort((a, b) => episodeNum(a.code) - episodeNum(b.code) || String(a.code).localeCompare(String(b.code)));
  episodeRowsByCode = new Map(allEpisodes.map((episode) => [episode.code, episode]));
  renderEpisodeOptions(selectedCode);
  return true;
}

function normalizeEpisodeRow(episode) {
  return {
    code: episode.episode_code || episode.code,
    title: episode.title || '',
    st: episode.status || {},
    scene_images: episode.scene_images,
    thumbnail_images: episode.thumbnail_images,
  };
}

function renderEpisodeOptions(selectedCode) {
  const esel = $('episode');
  esel.innerHTML = '';
  episodeOptionsByCode.clear();
  for (const episode of allEpisodes) {
    const option = document.createElement('option');
    option.value = episode.code;
    option.dataset.title = episode.title;
    esel.appendChild(option);
    episodeOptionsByCode.set(episode.code, option);
  }
  if (selectedCode && allEpisodes.some((episode) => episode.code === selectedCode)) esel.value = selectedCode;
  const filterState = applyEpisodeFilter();
  if (!filterState.selectedCode) setStatus(noEpisodeStatus(currentKind()), 'info');
}

function updateEpisodeOption(option, episode) {
  const state = episodeFilterState([episode], {
    kind: currentKind(),
    filter: settings.episodeFilter || 'todo',
    selectedCode: episode.code,
  });
  const progress = state.progressByCode[episode.code];
  option.dataset.title = episode.title;
  option.textContent = `${episode.code}${episode.title ? ' — ' + episode.title : ''} · ${episodeProgressLabel(progress)}`;
  option.hidden = !state.visibleCodes.includes(episode.code);
}

function updateEpisodeOptions(codes) {
  const esel = $('episode');
  const selectedCode = esel.value;
  let selectedSuccessor = null;
  for (const code of codes) {
    const episode = episodeRowsByCode.get(code);
    const option = episodeOptionsByCode.get(code);
    if (!episode || !option) continue;
    const wasVisible = !option.hidden;
    updateEpisodeOption(option, episode);
    if (wasVisible && option.hidden) {
      const successor = visibleEpisodeIndex.remove(code);
      if (code === selectedCode || code === selectedSuccessor) selectedSuccessor = successor;
    }
  }
  if (selectedSuccessor === null) return;

  const nextCode = visibleEpisodeIndex.has(selectedSuccessor)
    ? selectedSuccessor
    : visibleEpisodeIndex.first();
  esel.value = nextCode;
  if (currentEpisode?.code !== esel.value) clearLoadedEpisodeAssets();
  if (!nextCode) setStatus(noEpisodeStatus(currentKind()), 'info');
}

async function refreshSettledEpisodes(slug, codes) {
  const revision = episodeListRevision;
  const refreshed = await Promise.allSettled(
    codes.map((code) => client.episodeStatus(slug, code)),
  );
  if (revision !== episodeListRevision || currentProject?.slug !== slug || $('project').value !== slug) {
    return { stale: true, completed: [], failed: [] };
  }
  const updatedCodes = [];
  const completed = [];
  const failed = [];
  let firstError = null;
  refreshed.forEach((result, index) => {
    const requestedCode = codes[index];
    if (result.status === 'rejected') {
      failed.push(requestedCode);
      firstError ||= result.reason;
      return;
    }
    const episode = normalizeEpisodeRow(result.value);
    const code = episode.code || requestedCode;
    completed.push(requestedCode);
    const existing = episodeRowsByCode.get(code);
    if (!existing) return;
    Object.assign(existing, episode, { code });
    updatedCodes.push(code);
  });
  updateEpisodeOptions(updatedCodes);
  return { stale: false, completed, failed, firstError };
}

async function flushEpisodeRefreshQueue() {
  if (episodeRefreshInFlight || !currentProject) return;
  const codes = episodeRefreshQueue.snapshot();
  if (!codes.length) return;

  const slug = currentProject.slug;
  episodeRefreshInFlight = true;
  try {
    const result = await refreshSettledEpisodes(slug, codes);
    if (result.stale) return;
    episodeRefreshQueue.complete(result.completed);
    episodeRefreshQueue.defer(result.failed, EPISODE_REFRESH_RETRY_MS);
    if (result.failed.length) {
      setStatus(
        `Images were saved, but ${result.failed.length} episode status refresh${result.failed.length === 1 ? '' : 'es'} will retry: ${result.firstError?.message || result.firstError}`,
        'err',
      );
    }
  } catch (error) {
    episodeRefreshQueue.defer(codes, EPISODE_REFRESH_RETRY_MS);
    setStatus(`Images were saved, but episode status couldn't refresh: ${error.message}`, 'err');
  } finally {
    episodeRefreshInFlight = false;
  }
}

// ── scenes ──────────────────────────────────────────────────────────────────
async function loadScenes() {
  const slug = $('project').value;
  const esel = $('episode');
  const code = esel.value;
  if (!slug || !code) {
    clearLoadedEpisodeAssets();
    setStatus('Pick a project and episode first.', 'err');
    return;
  }
  const kind = currentKind();
  const episode = { code, title: esel.selectedOptions[0]?.dataset.title || '' };
  await episodeAssetLoad.run(
    async () => {
      await saveSettings({ lastEpisode: code });
      if (kind === 'thumbnail') {
        return { scenes: await loadThumbnails(slug, episode), source: 'prompts', label: 'Thumbnail Prompts' };
      }
      const result = await loadScenePlan(slug, episode);
      return { scenes: result.scenes, source: 'plan', label: 'Scene Plan' };
    },
    {
      onStart() {
        currentEpisode = episode;
        currentScenes = [];
        renderScenes();
        $('scenesSummary').textContent = '';
        $('loadScenes').disabled = true;
        $('refreshScenes').disabled = true;
        setStatus(`Loading ${kind === 'thumbnail' ? 'thumbnails' : 'scenes'}…`, 'running');
      },
      onSuccess({ scenes, source, label }) {
        currentSource = source;
        currentScenes = scenes;
        loadedKind = kind;
        renderScenes();
        const done = scenes.filter((s) => s.hasImage).length;
        const noun = kind === 'thumbnail' ? 'Thumbnails' : 'Scenes';
        $('scenesSummary').textContent = `${noun} (${label}) — ${done}/${scenes.length} have images`;
        const emptyMsg = `No ${noun.toLowerCase()} found for this episode.`;
        setStatus(scenes.length ? '' : emptyMsg, scenes.length ? 'info' : 'err');
      },
      onError(error) {
        setStatus(`Couldn't load: ${error.message}`, 'err');
      },
      onFinish() {
        $('loadScenes').disabled = false;
        // Refresh stays live once an episode is loaded, so a cut-off run can
        // be re-pulled in place without touching the tab.
        $('refreshScenes').disabled = false;
      },
    },
  );
}

// Thumbnails always come from the Image Prompts generator's `thumbnails` array
// (04 Thumbnail Prompts) and save to 06 Thumbnail Images as {CODE}_Thumb{NN}_v1.png.
async function loadThumbnails(slug, ep) {
  const data = await client.imagePrompts(slug, ep.code, ep.title);
  const thumbs = data?.thumbnails || [];
  const status = await client.imageStatus(slug, ep.code);
  if (!status?.thumbnails || !Array.isArray(status.thumbnails.missing)) {
    throw new Error(`Story Studio did not return verifiable thumbnail status for ${ep.code}. No images were queued.`);
  }
  const present = new Set();
  const missing = new Set(status.thumbnails.missing.map(Number));
  const total = status.thumbnails.total || thumbs.length;
  for (let n = 1; n <= total; n++) if (!missing.has(n)) present.add(n);
  return thumbs.map((t) => ({
    source: 'prompts',
    kind: 'thumbnail',
    key: t.number,
    label: `Thumb ${t.number}${t.title ? ` — ${t.title}` : ''}`,
    prompt: t.prompt || '',
    hasImage: present.has(Number(t.number)),
    stale: false,
  }));
}

// Scene images save through Scene Review and therefore require stable plan IDs.
async function loadScenePlan(slug, ep) {
  try {
    const data = await client.sceneReview(slug, ep.code);
    if (data?.scenes?.length) {
      return {
        source: 'plan',
        scenes: data.scenes.map((s) => ({
          source: 'plan',
          kind: 'scene',
          key: s.id,
          sceneNumber: Number(s.scene_index),
          label: `Scene ${s.scene_index}`,
          prompt: s.visual_prompt || '',
          hasImage: !!s.image_filename,
          stale: !!s.stale,
        })),
      };
    }
  } catch (e) {
    if (e.status && e.status !== 404) throw e;
  }
  throw new Error(`${ep.code} has no usable Scene Plan. Create or load a Scene Plan in Story Studio, then retry.`);
}

const PROVIDER_LABEL = Object.freeze(Object.fromEntries(PROVIDERS.map(({ id, label }) => [id, label])));

// Double-click a prompt to edit it in place; the edit is used when queued.
function startEditPrompt(prm, scene) {
  prm.classList.add('expanded', 'editing');
  prm.contentEditable = 'true';
  prm.focus();
  const done = () => {
    prm.contentEditable = 'false';
    prm.classList.remove('editing');
    prm.onblur = null;
    prm.onkeydown = null;
    scene.prompt = prm.textContent.trim();
    prm.textContent = scene.prompt || '(no prompt)';
    updateQueueButton();
  };
  prm.onblur = done;
  prm.onkeydown = (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      prm.blur();
    }
  };
}

function filterScenesList() {
  const q = $('sceneSearch').value.trim().toLowerCase();
  document.querySelectorAll('#scenes .scene').forEach((row) => {
    row.style.display = !q || row.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
}

function renderScenes() {
  const includeExisting = $('includeExisting').checked;
  const wrap = $('scenes');
  wrap.innerHTML = '';
  for (const s of currentScenes) {
    const has = s.hasImage;
    const div = document.createElement('div');
    div.className = 'scene';
    div.dataset.key = String(s.key);
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.key = String(s.key);
    cb.checked = includeExisting || !has;
    cb.disabled = has && !includeExisting;
    cb.onchange = updateQueueButton;
    const meta = document.createElement('div');
    meta.className = 'meta';
    const idx = document.createElement('div');
    idx.className = 'idx';
    idx.textContent = s.label;
    const prm = document.createElement('div');
    prm.className = 'prompt';
    prm.textContent = s.prompt || '(no prompt)';
    prm.title = 'Click to expand · double-click to edit';
    prm.onclick = () => {
      if (prm.classList.contains('editing')) return;
      prm.classList.toggle('expanded');
    };
    prm.ondblclick = () => startEditPrompt(prm, s);
    meta.append(idx, prm);
    div.append(cb, meta);
    if (has) {
      const b = document.createElement('span');
      b.className = 'badge ' + (s.stale ? 'stale' : 'has');
      b.textContent = s.stale ? 'stale' : 'has image';
      div.appendChild(b);
    }
    wrap.appendChild(div);
  }
  updateQueueButton();
  filterScenesList();
}

function selectedScenes() {
  const keys = new Set(
    [...document.querySelectorAll('.scene input[type=checkbox]')]
      .filter((c) => c.checked && !c.disabled)
      .map((c) => c.dataset.key)
  );
  return currentScenes.filter((s) => keys.has(String(s.key)) && (s.prompt || '').trim());
}

// Batch quick-select. "Missing" = still needs the asset (!hasImage) and is
// queueable (checkbox not disabled). Preset buttons check the FIRST n missing in
// display order and clear the rest — so after a batch generates + the list is
// reloaded, those drop out and the next click grabs the following n.
function missingCheckboxes() {
  const done = new Set(currentScenes.filter((s) => s.hasImage).map((s) => String(s.key)));
  return [...document.querySelectorAll('.scene input[type=checkbox]')].filter(
    (c) => !c.disabled && !done.has(c.dataset.key)
  );
}

function selectNextMissing(n) {
  document.querySelectorAll('.scene input[type=checkbox]').forEach((c) => {
    if (!c.disabled) c.checked = false;
  });
  missingCheckboxes()
    .slice(0, n)
    .forEach((c) => (c.checked = true));
  $('selectAll').checked = false;
  updateQueueButton();
}

function selectCustomBatch() {
  const input = $('customBatchSize');
  const quantity = input.valueAsNumber;
  if (!input.checkValidity() || !Number.isInteger(quantity) || quantity < 1) {
    input.reportValidity();
    return;
  }
  selectNextMissing(quantity);
}

// Reset to "only what's left": every missing scene checked, done ones cleared.
function selectRemaining() {
  const done = new Set(currentScenes.filter((s) => s.hasImage).map((s) => String(s.key)));
  document.querySelectorAll('.scene input[type=checkbox]').forEach((c) => {
    if (!c.disabled) c.checked = !done.has(c.dataset.key);
  });
  $('selectAll').checked = false;
  updateQueueButton();
}

function updateQueueButton() {
  const n = selectedScenes().length;
  const btn = $('queueSelected');
  btn.disabled = n === 0;
  btn.textContent = n ? `Queue selected (${n})` : 'Queue selected';
}

// Annotate each loaded scene row with its live queue status (done/running/
// failed) by matching queue items for this episode on sceneKey. Also toggles
// the "Select failed" button. Called every poll.
function updateSceneQueueStatus(queue) {
  const rows = document.querySelectorAll('#scenes .scene');
  if (!rows.length || !currentEpisode) return;
  const byKey = new Map();
  for (const it of queue) {
    if (it.episodeCode === currentEpisode.code && it.sceneKey != null) byKey.set(String(it.sceneKey), it);
  }
  let anyFailed = false;
  const glyph = { done: '✓', running: '⟳', pending: '⋯', failed: '✗' };
  rows.forEach((row) => {
    row.classList.remove('q-done', 'q-running', 'q-pending', 'q-failed');
    const it = byKey.get(String(row.dataset.key));
    let badge = row.querySelector('.qbadge');
    if (!it) {
      if (badge) badge.remove();
      return;
    }
    row.classList.add('q-' + it.status);
    if (it.status === 'failed') anyFailed = true;
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'qbadge';
      row.appendChild(badge);
    }
    badge.textContent = glyph[it.status] || '';
    badge.title = `Queue: ${it.status}${it.failure ? ` — ${it.failure.title}` : ''}`;
  });
  $('selectFailed').classList.toggle('hidden', !anyFailed);
}

async function selectFailedScenes() {
  if (!currentEpisode) return;
  const { queue = [] } = (await chrome.runtime.sendMessage({ type: 'getQueue' })) || {};
  const failed = new Set(
    queue.filter((it) => it.status === 'failed' && it.episodeCode === currentEpisode.code && it.sceneKey != null).map((it) => String(it.sceneKey))
  );
  document.querySelectorAll('.scene input[type=checkbox]').forEach((c) => {
    if (!c.disabled) c.checked = failed.has(String(c.dataset.key));
  });
  $('selectAll').checked = false;
  updateQueueButton();
}

// ── Leonardo in-panel controls ──────────────────────────────────────────────
// Model + per-model options live in the panel so tuning doesn't need Options
// round-trips. "Sync" reads the real catalogue and the selected model's actual
// control set from the logged-in Leonardo tab; controls a model doesn't offer
// are disabled here and skipped by the generator (adaptive on both ends).

const LEO_MODES = [
  ['FAST', 'Fast'],
  ['QUALITY', 'Quality'],
  ['ULTRA', 'Ultra'],
];
const LEO_SIZES = [
  ['SMALL', 'Small'],
  ['MEDIUM', 'Medium'],
  ['LARGE', 'Large'],
];

function leoFill(sel, entries, value) {
  sel.innerHTML = '';
  for (const [v, t] of entries) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = t;
    sel.appendChild(opt);
  }
  const has = entries.some(([v]) => v === value);
  if (!has && value) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = value;
    sel.appendChild(opt);
  }
  sel.value = value || entries[0]?.[0] || '';
  sel.disabled = entries.length === 0;
  sel.title = entries.length === 0 ? 'Not offered by this model' : '';
}

// Baseline fill from settings + cached model list (no Leonardo tab needed).
async function leoPopulate() {
  const models = await getLeonardoModels();
  const entries = models.map((m) => [m.id, m.badge === 'Unlimited' ? `${m.label} — Unlimited` : m.label]);
  leoFill($('leoModel'), entries, settings.leonardoModel);
  leoFill($('leoStyle'), [settings.leonardoStyle || 'Dynamic', 'None'].filter((v, i, a) => a.indexOf(v) === i).map((v) => [v, v]), settings.leonardoStyle);
  leoFill($('leoMode'), LEO_MODES, settings.leonardoMode);
  leoFill($('leoSize'), LEO_SIZES, settings.leonardoSize);
  leoFill($('leoCount'), Array.from({ length: 8 }, (_, i) => [String(i + 1), String(i + 1)]), String(settings.leonardoCount || 1));
  $('leoStatus').textContent = models.length ? '' : 'Hit “Sync from Leonardo” to open the generator and load its models + options.';
  leoRefState(null);
}

// Narrow every dependent select to what the selected model really offers.
// If the saved value is no longer offered, move to the first real choice and
// save it — the panel must show what the generator will actually do.
async function leoApplyControls(c) {
  const patch = {};
  leoFill($('leoMode'), LEO_MODES.filter(([v]) => c.modes.includes(v)), settings.leonardoMode);
  leoFill($('leoSize'), LEO_SIZES.filter(([v]) => c.sizes.includes(v)), settings.leonardoSize);
  leoFill($('leoCount'), Array.from({ length: c.maxCount || 1 }, (_, i) => [String(i + 1), String(i + 1)]), String(settings.leonardoCount || 1));
  leoFill($('leoStyle'), (c.styles || []).map((s) => [s, s]), settings.leonardoStyle);
  if (!$('leoMode').disabled && $('leoMode').value !== settings.leonardoMode) patch.leonardoMode = $('leoMode').value;
  if (!$('leoSize').disabled && $('leoSize').value !== settings.leonardoSize) patch.leonardoSize = $('leoSize').value;
  if (!$('leoStyle').disabled && $('leoStyle').value !== settings.leonardoStyle) patch.leonardoStyle = $('leoStyle').value;
  if (Number($('leoCount').value) !== Number(settings.leonardoCount)) patch.leonardoCount = Number($('leoCount').value);
  if (Object.keys(patch).length) settings = await saveSettings(patch);
  const noRef = c.supportsReference === false;
  leoRefState(noRef ? 'unsupported' : c.referenceAttached ? 'attached' : 'none');
  const off = [$('leoMode').disabled && 'mode', $('leoSize').disabled && 'size', $('leoStyle').disabled && 'style'].filter(Boolean);
  $('leoStatus').textContent = off.length ? `This model has no ${off.join(' / ')} control — skipped automatically.` : '';
}

// Reference status reflects what's attached in the Leonardo tab (a reference
// there persists across the whole batch). Updated by the model probe; before a
// probe we show a neutral prompt.
function leoRefState(state) {
  const el = $('leoRefState');
  if (state === 'attached') {
    el.textContent = '✓ attached in Leonardo — applies to all scenes';
    el.style.color = 'var(--ok)';
  } else if (state === 'unsupported') {
    el.textContent = 'not supported by this model';
    el.style.color = 'var(--muted)';
  } else if (state === 'none') {
    el.textContent = 'none attached (optional)';
    el.style.color = 'var(--muted)';
  } else {
    el.textContent = 'Sync to check';
    el.style.color = 'var(--muted)';
  }
}

async function leoCheckModel() {
  $('leoStatus').textContent = 'Reading this model’s options…';
  try {
    const c = await chrome.runtime.sendMessage({ type: 'leonardoModelControls', model: settings.leonardoModel });
    if (!c?.ok) throw new Error(c?.error || 'no response');
    await leoApplyControls(c);
  } catch (e) {
    $('leoStatus').textContent = `Couldn't read options (${e.message}). Sync again to reconnect the Leonardo generator.`;
  }
}

async function leoSyncAll() {
  const btn = $('leoSync');
  btn.disabled = true;
  $('leoStatus').textContent = 'Reading models from Leonardo…';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'listLeonardoModels' });
    if (!res?.ok) throw new Error(res?.error || 'no response');
    await saveLeonardoModels([...(await getLeonardoModels()), ...(res.models || [])]);
    await leoPopulate();
    await leoCheckModel();
  } catch (e) {
    $('leoStatus').textContent = `Sync failed: ${e.message}. Check the Leonardo generator for a sign-in or verification prompt, then sync again.`;
  } finally {
    btn.disabled = false;
  }
}

function flowModels() {
  return (PROVIDERS.find(({ id }) => id === 'flow')?.models || []).map(({ internalId, label }) => ({
    modelId: internalId,
    modelLabel: label,
  }));
}

function flowModelSettings(model, source) {
  const fallback = source === 'fallback'
    ? PROVIDERS.find(({ id }) => id === 'flow')?.models.find(({ internalId }) => internalId === model.modelId)
    : null;
  const imageModel = fallback?.id || model.modelId;
  return {
    imageModel,
    flowModelId: model.modelId,
    flowModelLabel: model.modelLabel,
    flowModelSource: source,
    flowModelSelection: imageModel,
  };
}

function selectedFlowModelId() {
  return resolveStoredFlowModelId(settings, currentFlowModels);
}

function selectedFlowModelApproval() {
  const select = $('flowImageModel');
  const model = select?.value && select.selectedIndex >= 0
    ? currentFlowModels.find((entry) => entry.modelId === select.value) || null
    : null;
  return model ? {
    modelId: model.modelId,
    modelLabel: model.modelLabel,
    modelSource: currentFlowModelSource,
  } : null;
}

function hasSelectedFlowModel() {
  return Boolean(selectedFlowModelApproval());
}

function emptyFlowModelSettings() {
  return {
    imageModel: '',
    flowModelId: '',
    flowModelLabel: '',
    flowModelSource: currentFlowModelSource,
    flowModelSelection: '',
  };
}

function persistFlowModelApproval(approval) {
  const save = flowModelSaveTail.then(async () => {
    const savedSettings = await saveSettings(
      approval ? flowModelSettings(approval, approval.modelSource) : emptyFlowModelSettings()
    );
    settings = savedSettings;
    return Boolean(approval);
  });
  flowModelSaveTail = save.catch(() => {});
  return save;
}

function persistSelectedFlowModel() {
  return persistFlowModelApproval(selectedFlowModelApproval());
}

async function refreshFlowModels() {
  const button = $('refreshFlowModels');
  const select = $('flowImageModel');
  const provenance = $('flowModelSource');
  button.disabled = true;
  select.disabled = true;
  try {
    await flowModelSaveTail;
    const renderedSelection = select?.value && select.selectedIndex >= 0 && currentFlowModels.some((model) => model.modelId === select.value)
      ? select.value
      : null;
    const response = await chrome.runtime.sendMessage({ type: 'refreshFlowModels' }).catch(() => null);
    const source = response?.ok && response.source === 'live' ? 'live' : 'fallback';
    const models = response?.ok && Array.isArray(response.models) ? response.models : flowModels();
    currentFlowModels = models.map(({ modelId, modelLabel }) => ({ modelId, modelLabel }));
    currentFlowModelSource = source;
    const previous = renderedSelection || selectedFlowModelId();
    select.replaceChildren(...currentFlowModels.map(({ modelId, modelLabel }) => {
      const option = document.createElement('option');
      option.value = modelId;
      option.textContent = modelLabel;
      return option;
    }));
    provenance.dataset.source = source;
    provenance.textContent = source === 'live'
      ? 'Live from this signed-in Flow workspace'
      : 'Tested fallback catalog; live discovery unavailable';
    if (!currentFlowModels.length) {
      select.selectedIndex = -1;
    } else {
      const selected = currentFlowModels.find(({ modelId }) => modelId === previous);
      if (!selected) select.selectedIndex = -1;
      else select.value = selected.modelId;
    }
    await persistSelectedFlowModel();
  } finally {
    select.disabled = currentFlowModels.length === 0;
    button.disabled = false;
  }
}

function flowPopulate() {
  void refreshFlowModels();
  $('flowAspect').value = settings.aspectRatio || '16:9';
  $('flowRecaptchaMaxAttempts').value = settings.flowRecaptchaMaxAttempts || 4;
}

function qwenPopulate() {
  $('qwenAspect').value = settings.qwenAspectRatio || '16:9';
}

function aistudioPopulate() {
  $('aistudioAspect').value = settings.aistudioAspectRatio || '16:9';
}

function chatgptPopulate() {
  $('chatgptAspect').value = settings.chatgptAspectRatio || '16:9';
  $('chatgptMaxWait').value = Math.round((Number(settings.chatgptMaxWaitSec) || 480) / 60);
}

function onProviderChange() {
  const provider = $('provider').value;
  saveSettings({ provider });
  $('flowProjectCard').classList.toggle('hidden', provider !== 'flow');
  $('flowOptsCard').classList.toggle('hidden', provider !== 'flow');
  $('aistudioCard').classList.toggle('hidden', provider !== 'aistudio');
  $('qwenCard').classList.toggle('hidden', provider !== 'qwen');
  $('leonardoCard').classList.toggle('hidden', provider !== 'leonardo');
  $('chatgptCard').classList.toggle('hidden', provider !== 'chatgpt');
  const openBtn = $('openProviderPage');
  openBtn.classList.remove('hidden');
  openBtn.textContent = '↗ Open workspace';
  $('providerOptionsTitle').textContent = 'Provider settings';
  $('providerOptionsHint').textContent = provider === 'flow'
    ? 'Model · ratio · reference'
    : provider === 'leonardo'
      ? 'Model · style · reference'
      : 'Generation preferences';
  const referenceCapability = getProvider(provider)?.capabilities;
  const canUseStoryStudioReferences = !!referenceCapability?.storyStudioReferences;
  $('charRefCard').classList.remove('hidden');
  $('storyStudioReferencesEnabled').disabled = !canUseStoryStudioReferences;
  $('storyStudioReferencesHint').textContent = canUseStoryStudioReferences
    ? `Uses Story Studio episode, scene, character, composition, and style assets when available (up to ${referenceCapability.maxReferences} per image).`
    : 'Story Studio auto-ingest is unavailable for Leonardo. Manage references directly in its generator tab.';
  if (provider === 'leonardo') leoPopulate();
  if (provider === 'flow') flowPopulate();
  if (provider === 'qwen') qwenPopulate();
  if (provider === 'aistudio') aistudioPopulate();
  if (provider === 'chatgpt') chatgptPopulate();
  renderCooldownCard();
  renderAppliedSettings();
  onMediaTypeChange();
  if (provider !== 'flow') checkWebGenerator(provider);
  else setStatus('', 'info');
}

async function checkWebGenerator(provider) {
  const name = PROVIDER_LABEL[provider] || provider;
  setStatus(`Checking ${name}…`, 'running');
  try {
    const ctx = await chrome.runtime.sendMessage({ type: 'webGeneratorContext', provider });
    if (!ctx?.ok) throw new Error(ctx?.error || `Could not reach ${name}.`);
    if (ctx.signedIn === false) {
      setStatus(`${name}: not signed in — open its tab and sign in.`, 'err');
      return;
    }
    if (!ctx.ready) {
      setStatus(`${name}: open the image generator, complete any sign-in/browser check, and leave the tab open.`, 'err');
      return;
    }
    const quota =
      provider === 'leonardo'
        ? 'Free accounts currently produce four images per prompt and deduct the displayed token cost.'
        : provider === 'qwen'
          ? 'Web image generation ready. Qwen publishes no numeric web quota; an explicit limit pauses the queue.'
        : 'Free web generation ready.';
    setStatus(`${name} ready. ${quota}`, 'done');
  } catch (e) {
    setStatus(`${name} check failed: ${e.message}`, 'err');
  }
}

// Reload the list when switching between scene and thumbnail image prompts.
async function onMediaTypeChange() {
  const hadLoadedEpisode = currentEpisode !== null;
  applyEpisodeFilter();
  if (!$('episode').value) {
    clearLoadedEpisodeAssets();
    loadedKind = currentKind();
    setStatus(noEpisodeStatus(loadedKind), 'info');
    return;
  }
  if (hadLoadedEpisode) {
    await loadScenes();
  }
}

// ── confirm + enqueue ───────────────────────────────────────────────────────
function confirmQueue() {
  const scenes = selectedScenes();
  if (!scenes.length) return;
  const provider = $('provider').value;
  const isFlow = provider === 'flow';
  const kind = currentKind();
  const noun = kind === 'thumbnail' ? 'thumbnail' : 'scene';
  const folder = kind === 'thumbnail' ? 'Thumbnail Images folder' : 'scene folder';
  const target = 'project';
  if (!currentProject) return;
  const flowModelApproval = isFlow ? selectedFlowModelApproval() : null;
  if (isFlow && !flowModelApproval) {
    setStatus('Select a current Flow model, refresh the signed-in Flow workspace, and re-queue.', 'err');
    return;
  }
  if (isFlow && !settings.flowProjectId) {
    setStatus('Set a Flow project first (use “Use current tab”).', 'err');
    return;
  }
  const context = captureSceneEnqueueContext({
    project: currentProject,
    episode: currentEpisode,
    source: currentSource,
    scenes,
    kind,
    target,
    provider,
    flowModelApproval,
  });
  const n = `${scenes.length} ${noun}${scenes.length > 1 ? 's' : ''}`;
  if (isFlow) {
    const modelLabel = context.flowModelApproval.modelLabel;
    const provenance = context.flowModelApproval.modelSource === 'live' ? 'live workspace' : 'tested fallback';
    $('confirmTitle').textContent = `Queue these ${noun}s?`;
    $('confirmBody').textContent =
      `${n} from ${context.episodeCode} → ` +
      `Story Studio ${folder}. ` +
      `Images use ${modelLabel} (${provenance}). One at a time.`;
    $('confirmOk').textContent = 'Queue';
  } else if (provider === 'aistudio') {
    $('confirmTitle').textContent = `Queue these ${noun}s on AI Studio?`;
    $('confirmBody').textContent =
      `${n} from ${context.episodeCode} via Google AI Studio → ` +
      `Story Studio ${folder}. Keep the AI Studio tab open in ` +
      `image mode. Uses your FREE DAILY image quota — the queue pauses when it's hit; press Resume after reset. ` +
      `${humanDelayLabel()} between each. Continue?`;
    $('confirmOk').textContent = 'Queue on AI Studio';
  } else if (provider === 'qwen') {
    $('confirmTitle').textContent = `Queue these ${noun}s on Qwen Studio?`;
    $('confirmBody').textContent =
      `${n} from ${context.episodeCode} via Qwen Studio (${settings.qwenAspectRatio || '16:9'}) → ` +
      `Story Studio ${folder}. Keep the Qwen tab open. ` +
      `Qwen uses one submission per scene, ratio is best-effort, and explicit usage limits pause the queue. ` +
      `${humanDelayLabel()} between each. Continue?`;
    $('confirmOk').textContent = 'Queue on Qwen';
  } else {
    const name = PROVIDER_LABEL[provider] || provider;
    const ratioNote =
      provider === 'aistudio'
        ? ` Ratio ${settings.aistudioAspectRatio || '16:9'} (via the prompt).`
        : provider === 'chatgpt'
          ? ` Ratio ${settings.chatgptAspectRatio || '16:9'} (via the prompt).`
          : '';
    const chatNote =
      provider === 'chatgpt' ? ' Runs on chatgpt.com — keep that tab visible.' : '';
    $('confirmTitle').textContent = `Queue these ${noun}s on ${name}?`;
    $('confirmBody').textContent =
      `${n} from ${context.episodeCode} via the ${name} website → ` +
      `Story Studio ${folder}. ` +
      `Keep the generator tab open; jobs run one at a time with a ${humanDelayLabel()} gap.${ratioNote}${chatNote}`;
    $('confirmOk').textContent = `Queue on ${name}`;
  }
  const dlg = $('confirm');
  dlg.classList.remove('hidden');
  $('confirmOk').onclick = async () => {
    dlg.classList.add('hidden');
    await doEnqueue(context);
  };
}

async function doEnqueue(payload) {
  try {
    if (payload.provider === 'flow' && !await persistFlowModelApproval(payload.flowModelApproval)) {
      setStatus('Select a current Flow model, refresh the signed-in Flow workspace, and re-queue.', 'err');
      return;
    }
    const res = await chrome.runtime.sendMessage({
      type: 'enqueueScenes',
      payload,
    });
    if (!res?.ok) throw new Error(res?.error || 'enqueue failed');
    setStatus(`Queued ${res.added}${res.skipped ? `, skipped ${res.skipped} already queued` : ''}.`, 'done');
    pollQueue();
  } catch (e) {
    setStatus(String(e.message || e), 'err');
  }
}

// ── queue view ──────────────────────────────────────────────────────────────
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

function itemQueuedAt(item) {
  if (Number.isFinite(item.queuedAt)) return item.queuedAt;
  const legacy = Number(String(item.id || '').split('_')[0]);
  return Number.isFinite(legacy) ? legacy : null;
}

function renderQueueTiming(queue) {
  const el = $('queueTiming');
  if (!queue.length) {
    el.textContent = '';
    return;
  }
  const starts = queue.map(itemQueuedAt).filter(Number.isFinite);
  const sessionStart = starts.length ? Math.min(...starts) : Date.now();
  const active = queue.some((i) => i.status === 'pending' || i.status === 'running');
  const finishes = queue.map((i) => i.finishedAt).filter(Number.isFinite);
  const sessionEnd = active ? Date.now() : finishes.length ? Math.max(...finishes) : Date.now();
  const done = queue.filter((i) => i.status === 'done');
  const measured = done.map((i) => i.durationMs).filter((n) => Number.isFinite(n) && n >= 0);
  const avg = measured.length ? measured.reduce((sum, n) => sum + n, 0) / measured.length : null;
  const remaining = queue.filter((i) => i.status === 'pending' || i.status === 'running').length;
  const episodes = [...new Set(queue.map((i) => i.episodeCode).filter(Boolean))];
  const scope = episodes.length === 1 ? episodes[0] : `${episodes.length} episodes`;
  const parts = [scope, `${done.length}/${queue.length} done`, `${active ? 'elapsed' : 'total'} ${formatDuration(sessionEnd - sessionStart)}`];
  if (avg != null) parts.push(`avg ${formatDuration(avg)}/asset`);
  if (active && avg != null && remaining) parts.push(`ETA ~${formatDuration(avg * remaining)}`);
  el.textContent = parts.join(' · ');
}

// The active-batch card is the panel's live operational view. Its state classes
// deliberately distinguish work in flight, human pacing/cooldown, completion,
// and failure; CSS applies the restrained spectrum sweep only to active work.
function updateGenStatus(queue, paused) {
  const bar = $('genStatusBar');
  if (!bar) return;
  const panel = $('activeBatch');
  const done = queue.filter((i) => i.status === 'done').length;
  const failed = queue.filter((i) => i.status === 'failed').length;
  const left = queue.filter((i) => i.status === 'pending' || i.status === 'running').length;
  const active = queue.find((i) => i.status === 'running');
  const running = !!active;
  const pending = queue.find((i) => i.status === 'pending');
  const displayItem = active || pending;
  let state = 'Idle';
  let cls = 'idle';
  if (paused) {
    state = 'Paused';
    cls = 'paused';
  } else if (left > 0) {
    state = running ? 'Generating scene images' : 'Waiting for human pace';
    cls = running ? 'running' : 'waiting';
  } else if (queue.length) {
    state = failed ? 'Finished with failures' : 'Batch complete';
    cls = failed ? 'failed' : 'done';
  }
  bar.className = 'genstatus ' + cls;
  panel.className = 'active-batch ' + cls;
  $('gsStateText').textContent = state;
  $('gsDone').textContent = `${done} done`;
  $('gsFailed').textContent = `${failed} failed`;
  $('gsLeft').textContent = `${left} left`;
  bar.querySelector('.gs-counts').classList.toggle('hidden', queue.length === 0);

  const pill = $('batchStatePill');
  pill.textContent = running ? 'Live' : paused ? 'Paused' : left ? 'Waiting' : failed ? 'Needs review' : queue.length ? 'Complete' : 'Idle';
  const task = $('activeTask');
  task.textContent = active
    ? `Generating ${active.label}`
    : pending
      ? `Up next — ${pending.label}`
      : queue.length
        ? (failed ? 'Review failed scenes or retry them.' : 'All queued assets are saved.')
        : 'No batch is running.';
  task.classList.toggle('muted', !displayItem);
  const meta = $('activeMeta');
  if (displayItem) {
    const provider = PROVIDER_LABEL[displayItem.provider] || displayItem.provider || 'Google Flow';
    const snapshot = displayItem.modelSnapshot;
    const model = queuedModelLabel({ modelSnapshot: snapshot });
    const ratio = displayItem.generationSettings?.aspectRatio || displayItem.aspectRatio || '16:9';
    meta.textContent = `${provider} · ${model} · ${ratio}`;
    meta.classList.remove('hidden');
  } else {
    meta.classList.add('hidden');
  }
  const total = queue.length;
  const progress = total ? Math.round(((done + failed + (running ? .35 : 0)) / total) * 100) : 0;
  $('batchProgressFill').style.width = `${Math.min(100, Math.max(0, progress))}%`;
}

function queuedModelLabel(item) {
  return modelSnapshotDiagnostic(item?.modelSnapshot);
}

let lastQueueSig = '';
let previousQueue = null;
async function pollQueue() {
  const [{ queue = [], paused = false } = {}, st] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'getQueue' }).then((r) => r || {}),
    chrome.storage.local.get('lastStatus'),
  ]);
  renderQueueTiming(queue);
  const s = st.lastStatus;
  liveStatus = s && Date.now() - s.ts < 600000 ? s : null;
  if (liveStatus) {
    if (Number.isFinite(liveStatus.countdownUntil)) renderLiveStatus();
    else setStatus(liveStatus.text, liveStatus.kind);
  }
  // Pause/Resume only matters while there is still work to do.
  const hasWork = queue.some((i) => i.status === 'pending' || i.status === 'running');
  const hasPending = queue.some((i) => i.status === 'pending');
  const hasFailed = queue.some((i) => i.status === 'failed');
  const hasCompleted = queue.some((i) => i.status === 'done');
  const pause = $('pauseQueue');
  pause.classList.toggle('hidden', !hasWork && !paused);
  pause.dataset.paused = String(paused);
  pause.textContent = paused ? '▶ Resume' : '❚❚ Pause';
  $('retryFailed').disabled = !hasFailed;
  $('clearQueue').disabled = !hasPending;
  $('clearFailed').disabled = !hasFailed;
  $('clearCompleted').disabled = !hasCompleted;
  updateGenStatus(queue, paused);
  // Live per-scene status + tab-visibility reminder — run every tick, even when
  // the queue-list DOM itself is unchanged.
  updateSceneQueueStatus(queue);
  const prov = $('provider').value;
  const needsTab = hasWork;
  $('tabReminder').classList.toggle('hidden', !needsTab);
  if (needsTab)
    $('tabReminder').textContent = `Keep the ${PROVIDER_LABEL[prov] || prov} tab visible (active tab, not minimized) while this runs — hidden tabs get throttled.`;
  const settledEpisodes = currentProject
    ? newlySettledEpisodeCodes(previousQueue, queue, currentProject.slug)
    : [];
  previousQueue = queue.map(({ id, slug, episodeCode, status }) => ({ id, slug, episodeCode, status }));
  episodeRefreshQueue.add(settledEpisodes);
  await flushEpisodeRefreshQueue();
  // Only rebuild the list when its contents actually change. A blind 1.5 s
  // re-render would wipe an open "Technical details" panel (and any text the
  // user is mid-selection on) — the raw error would flash for one tick and vanish.
  const sig = JSON.stringify(
    queue.map((it) => [it.id, it.status, it.durationMs, it.savedAs, it.error, it.failure?.code])
  );
  if (sig === lastQueueSig) return;
  lastQueueSig = sig;
  const wrap = $('queue');
  wrap.innerHTML = '';
  for (const it of queue) {
    const row = document.createElement('div');
    row.className = 'qitem' + (it.status === 'failed' ? ' has-failure' : '');
    const info = document.createElement('div');
    info.className = 'qinfo';
    const label = document.createElement('div');
    label.className = 'qlabel';
    const timing = Number.isFinite(it.durationMs) ? ` · ${formatDuration(it.durationMs)}` : '';
    label.textContent = it.label + (it.savedAs ? ` → ${it.savedAs}` : '') + timing;
    label.title = label.textContent;
    info.appendChild(label);
    if (it.status === 'failed' && it.failure) {
      const diagnosis = document.createElement('div');
      diagnosis.className = 'failure-diagnosis';
      const title = document.createElement('strong');
      title.textContent = it.failure.title;
      const hint = document.createElement('span');
      hint.textContent = ` — ${it.failure.hint}`;
      diagnosis.append(title, hint);
      const details = document.createElement('details');
      details.className = 'failure-details';
      const summary = document.createElement('summary');
      summary.textContent = 'Technical details';
      const raw = document.createElement('div');
      raw.textContent = it.failure.raw || it.error || 'No raw error was provided.';
      details.append(summary, raw);
      info.append(diagnosis, details);
    } else if (it.error) {
      const raw = document.createElement('div');
      raw.className = 'failure-diagnosis';
      raw.textContent = it.error;
      info.appendChild(raw);
    }
    const stat = document.createElement('span');
    stat.className = 'qstatus ' + it.status;
    stat.textContent = it.status === 'failed' && it.failure ? it.failure.code : it.status;
    row.append(info, stat);
    if (it.status === 'pending') {
      const x = document.createElement('button');
      x.className = 'x';
      x.textContent = '×';
      x.title = 'Remove';
      x.onclick = async () => {
        await chrome.runtime.sendMessage({ type: 'removeItem', id: it.id });
        pollQueue();
      };
      row.appendChild(x);
    } else if (it.status === 'failed') {
      const retry = document.createElement('button');
      retry.className = 'retry';
      retry.textContent = '↻';
      retry.title = 'Retry this failed job';
      retry.onclick = async () => {
        await chrome.runtime.sendMessage({ type: 'retryFailed', id: it.id });
        pollQueue();
      };
      row.appendChild(retry);
    }
    wrap.appendChild(row);
  }
}

// Brief confirmation when a panel setting changes (pollQueue restores the live
// queue status on its next tick, ~1.5 s later).
function flashSaved() {
  setStatus('Saved ✓', 'done');
}

function renderLiveStatus() {
  renderCooldownState(); // keep the provider-cooldown chip ticking
  if (!liveStatus || !Number.isFinite(liveStatus.countdownUntil)) return;
  const seconds = Math.max(0, Math.ceil((liveStatus.countdownUntil - Date.now()) / 1000));
  if (liveStatus.countdownReason === 'cooldown') {
    const name = PROVIDER_LABEL[liveStatus.countdownProvider] || liveStatus.countdownProvider || 'Provider';
    const text = seconds > 0
      ? `${name} cooldown — resuming automatically in ${formatDuration(seconds * 1000)}, or press Resume to override.`
      : `${name} cooldown finished — resuming now.`;
    setStatus(text, liveStatus.kind);
    return;
  }
  const provider = liveStatus.countdownProvider || 'provider';
  const label = liveStatus.countdownLabel || '';
  const text = seconds > 0 ? `Waiting ${seconds}s before ${provider} request: ${label}` : `Starting ${provider} request: ${label}`;
  setStatus(text, liveStatus.kind);
}

function setStatus(text, kind = 'info') {
  const el = $('status');
  el.textContent = text;
  el.className = 'status ' + (kind === 'running' ? 'running' : kind === 'done' ? 'done' : kind === 'err' ? 'err' : '');
}

init();
