// Side-panel controller.
//
// The panel reads projects/episodes/scenes straight from the Story Studio
// server (it's an extension page, so it has host-permission to localhost), and
// hands batches to the background worker, which owns the Flow generation + the
// persistent queue. A confirmation step guards every batch so an accidental
// click can't burn work/credits.

import { getSettings, saveSettings, getLeonardoModels, saveLeonardoModels, providerCooldown } from '../lib/config.js';
import { StudioClient } from '../lib/story-studio.js';

const $ = (id) => document.getElementById(id);
let settings = null;
let client = null;
// Normalized items: { source, kind, key, label, prompt, hasImage, stale }
let currentScenes = [];
let currentSource = 'plan'; // 'plan' (scene_plan.json) | 'prompts' (03/04 prompts)
let loadedKind = 'scene'; // 'scene' | 'thumbnail' — what's currently loaded
let currentEpisode = null; // { code, title }
let currentProject = null; // { slug, name }
let allEpisodes = []; // [{ code, title, st, done: true|false|null }] — done null until counted
let liveStatus = null;

const HUMAN_PACE_PRESETS = {
  off: { label: 'Off', min: 0, max: 0 },
  quick: { label: 'Quick', min: 5, max: 15 },
  balanced: { label: 'Balanced', min: 15, max: 45 },
  cautious: { label: 'Cautious', min: 30, max: 90 },
  'very-cautious': { label: 'Very cautious', min: 60, max: 180 },
};

// The "Make:" selector encodes both the asset kind and media type.
const currentKind = () => ($('mediaType').value.startsWith('thumbnail') ? 'thumbnail' : 'scene');
const isVideoSel = () => $('mediaType').value === 'scene-video';
// Combined selection identity: 'scene' | 'video' | 'thumbnail'.
const selKind = () => (isVideoSel() ? 'video' : currentKind());
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
const COOLDOWN_SUPPORTED = new Set(['flow', 'qwen', 'aistudio', 'grok', 'leonardo', 'freegen', 'piclumen', 'chatgpt']);

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
  const manifest = chrome.runtime.getManifest();
  $('extensionVersion').textContent = `v${manifest.version}`;
  $('extensionVersion').title = `${manifest.name} v${manifest.version}`;
  initWhatsNew(manifest.version);
  settings = await getSettings();
  client = new StudioClient(settings.studioBaseUrl);
  $('saveTarget').value = settings.saveTarget;
  $('provider').value = settings.provider || 'flow';
  $('includeExisting').checked = !!settings.includeExisting;
  $('charRefEnabled').checked = settings.characterRefEnabled !== false;
  $('flowCharacterRef').disabled = !$('charRefEnabled').checked;
  setEpisodeFilterUI(settings.episodeFilter || 'todo');
  settingsSource = (await chrome.storage.local.get('settingsSource')).settingsSource || {};
  renderHumanPace();
  renderCooldownCard();
  renderAppliedSettings();
  await refreshFlowProject();
  await loadProjects();
  wire();
  onProviderChange();
  pollQueue();
  setInterval(pollQueue, 1500);
  setInterval(renderLiveStatus, 250);
}

function wire() {
  $('openOptions').onclick = () => chrome.runtime.openOptionsPage();
  $('humanPacePreset').onchange = selectHumanPacePreset;
  $('humanPaceMin').onchange = saveCustomHumanPace;
  $('humanPaceMax').onchange = saveCustomHumanPace;
  $('cooldownAutoResume').onchange = onCooldownToggle;
  $('cooldownPreset').onchange = onCooldownPreset;
  $('cooldownMinutes').onchange = saveCooldownCustom;
  $('cooldownRetries').onchange = saveCooldownRetries;
  $('project').onchange = onProjectChange;
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
  $('queueSelected').onclick = confirmQueue;
  $('clearQueue').onclick = async () => {
    await chrome.runtime.sendMessage({ type: 'clearQueue' });
    pollQueue();
  };
  $('pauseQueue').onclick = async () => {
    const resuming = $('pauseQueue').textContent === 'Resume';
    await chrome.runtime.sendMessage({ type: resuming ? 'resumeQueue' : 'pauseQueue' });
    pollQueue();
  };
  $('retryFailed').onclick = async () => {
    const res = await chrome.runtime.sendMessage({ type: 'retryFailed' });
    if (res?.skippedPaid) setStatus(`Retrying ${res.retried}; ${res.skippedPaid} paid video needs its row Retry button.`, 'info');
    else if (!res?.retried) setStatus('No failed jobs to retry.', 'info');
    pollQueue();
  };
  $('saveTarget').onchange = () => {
    saveSettings({ saveTarget: $('saveTarget').value });
    flashSaved();
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
  $('flowImageModel').onchange = async () => (settings = await saveSettings({ imageModel: $('flowImageModel').value }));
  $('flowAspect').onchange = async () => (settings = await saveSettings({ aspectRatio: $('flowAspect').value }));
  $('flowCharacterRef').onchange = async () => (settings = await saveSettings({ characterRefId: $('flowCharacterRef').value }));
  $('charRefEnabled').onchange = async () => {
    settings = await saveSettings({ characterRefEnabled: $('charRefEnabled').checked });
    $('flowCharacterRef').disabled = !$('charRefEnabled').checked;
  };
  $('flowVideoModel').onchange = async () => (settings = await saveSettings({ videoModel: $('flowVideoModel').value }));
  $('flowVideoSource').onchange = async () => (settings = await saveSettings({ videoSource: $('flowVideoSource').value }));
  $('freegenAspect').onchange = async () => (settings = await saveSettings({ aspectRatio: $('freegenAspect').value }));
  $('perchanceStyleInput').onchange = async () => (settings = await saveSettings({ perchanceStyle: $('perchanceStyleInput').value.trim() || 'No style' }));
  $('perchanceAspect').onchange = async () => (settings = await saveSettings({ aspectRatio: $('perchanceAspect').value }));
  $('perchanceCount').onchange = async () => (settings = await saveSettings({ perchanceCount: Number($('perchanceCount').value) }));
  $('pollModel').onchange = async () => (settings = await saveSettings({ pollinationsModel: $('pollModel').value.trim() || 'flux' }));
  $('pollSeed').onchange = async () => (settings = await saveSettings({ pollinationsSeed: $('pollSeed').value.replace(/[^0-9]/g, '') }));
  $('pollToken').onchange = async () => (settings = await saveSettings({ pollinationsToken: $('pollToken').value.trim() }));
  $('qwenAspect').onchange = async () => (settings = await saveSettings({ qwenAspectRatio: $('qwenAspect').value }));
  $('aistudioAspect').onchange = async () => (settings = await saveSettings({ aistudioAspectRatio: $('aistudioAspect').value }));
  $('chatgptAspect').onchange = async () => (settings = await saveSettings({ chatgptAspectRatio: $('chatgptAspect').value }));
  $('chatgptNewChatEvery').onchange = async () => {
    const custom = $('chatgptNewChatEvery').value === 'custom';
    $('chatgptNewChatEveryCustomWrap').classList.toggle('hidden', !custom);
    if (custom) {
      $('chatgptNewChatEveryCustom').focus();
      return; // wait for the custom value before saving
    }
    settings = await saveSettings({ chatgptNewChatEvery: Number($('chatgptNewChatEvery').value) });
  };
  $('chatgptNewChatEveryCustom').onchange = async () => {
    const v = Math.min(1000, Math.max(1, Math.round(Number($('chatgptNewChatEveryCustom').value) || 50)));
    $('chatgptNewChatEveryCustom').value = v;
    settings = await saveSettings({ chatgptNewChatEvery: v });
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

// Compact "what's actually applied right now, and who set it" line under the
// status bar — so you can tell your local settings from a Fleet Hub push.
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
  const out = $('connStatus');
  const setConn = (t, color) => {
    out.textContent = t;
    out.style.color = color;
  };
  $('testConn').disabled = true;
  setConn('Testing…', 'var(--muted)');
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
        setConn('✗ No host access — open Settings → Grant access to this server.', 'var(--err)');
        return;
      }
    }
    const projects = await client.listProjects();
    const n = Array.isArray(projects) ? projects.length : (projects.projects || []).length;
    setConn(`✓ Connected — ${n} project${n !== 1 ? 's' : ''}.`, 'var(--ok)');
    await loadProjects(); // refresh the dropdown now that we're reachable
  } catch (e) {
    const local = /localhost|127\.0\.0\.1/.test(settings.studioBaseUrl || '');
    setConn(
      `✗ ${e.message}. ${local ? 'Is Story Studio running?' : "Check it's running, access granted, and you're logged in."}`,
      'var(--err)'
    );
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

// Show/hide episode options for the active filter, using the accurate
// done/total when known and defaulting to "show" while a count still loads.
function applyEpisodeFilter() {
  const filter = settings.episodeFilter || 'todo';
  const esel = $('episode');
  const doneByCode = new Map(allEpisodes.map((e) => [e.code, e.done]));
  let firstVisible = '';
  for (const opt of esel.options) {
    const done = doneByCode.get(opt.value);
    const show = filter === 'all' ? true : filter === 'done' ? done === true : done !== true;
    opt.hidden = !show;
    if (show && !firstVisible) firstVisible = opt.value;
  }
  if (firstVisible && (esel.selectedOptions[0]?.hidden || !esel.value)) esel.value = firstVisible;
}

// Lazily fill in each episode's done/total count in the dropdown label, so you
// can see progress without loading each. Throttled + abortable (a new project
// or filter bumps the run token).
let episodeCountRun = 0;
async function fetchEpisodeCounts(slug, codes) {
  const run = ++episodeCountRun;
  for (const code of codes) {
    if (run !== episodeCountRun) return;
    try {
      const data = await client.sceneReview(slug, code);
      const scenes = data?.scenes || [];
      if (scenes.length) {
        const done = scenes.filter((s) => s.image_filename).length;
        const complete = done === scenes.length;
        const ep = allEpisodes.find((e) => e.code === code);
        if (ep) ep.done = complete;
        const opt = [...$('episode').options].find((o) => o.value === code);
        if (opt) {
          const title = opt.dataset.title || '';
          opt.textContent = `${code}${title ? ' — ' + title : ''} · ${done}/${scenes.length}${complete ? ' ✓' : ''}`;
        }
        applyEpisodeFilter(); // re-hide episodes now known complete/incomplete
      }
    } catch {
      /* episode without a scene plan, etc. — skip */
    }
    await new Promise((r) => setTimeout(r, 120));
  }
}

// Queue every missing scene image across all pending episodes in the project.
async function queueAllPending() {
  if (!currentProject) return setStatus('Pick a project first.', 'err');
  if (isVideoSel() || currentKind() === 'thumbnail')
    return setStatus('“Queue all pending” is for scene images — switch “Make” to Scene images.', 'err');
  const provider = $('provider').value;
  const target = $('saveTarget').value;
  if (provider === 'flow' && !settings.flowProjectId) return setStatus('Set a Flow project first.', 'err');
  let rows;
  try {
    rows = await client.listEpisodes(currentProject.slug);
  } catch (e) {
    return setStatus(`Couldn't list episodes: ${e.message}`, 'err');
  }
  const pending = (Array.isArray(rows) ? rows : rows.episodes || []).filter((e) => {
    const st = e.status || {};
    return (st.scene_plan || st.scene_prompts) && !st.images;
  });
  if (!pending.length) return setStatus('No pending episodes — everything is done. 🎉', 'info');
  const dlg = $('confirm');
  $('confirmTitle').textContent = `Queue all pending on ${PROVIDER_LABEL[provider] || provider}?`;
  $('confirmBody').textContent =
    `Loads ${pending.length} pending episode${pending.length > 1 ? 's' : ''} and queues every missing scene image via ` +
    `${PROVIDER_LABEL[provider] || provider} → ${target === 'project' ? 'Story Studio folders' : 'Downloads'}. ` +
    `Already-queued scenes are skipped. This can be a lot of scenes — continue?`;
  $('confirmOk').textContent = 'Queue all pending';
  dlg.classList.remove('hidden');
  $('confirmOk').onclick = async () => {
    dlg.classList.add('hidden');
    setStatus(`Queuing ${pending.length} episode${pending.length > 1 ? 's' : ''}…`, 'running');
    let queued = 0;
    let eps = 0;
    for (const e of pending) {
      const code = e.episode_code || e.code;
      try {
        const r = await loadScenesFromEither(currentProject.slug, { code, title: e.title || '' });
        const missing = (r.scenes || []).filter((s) => !s.hasImage && (s.prompt || '').trim());
        if (!missing.length) continue;
        const res = await chrome.runtime.sendMessage({
          type: 'enqueueScenes',
          payload: {
            slug: currentProject.slug,
            episodeCode: code,
            episodeTitle: e.title || '',
            projectName: currentProject.name,
            scenes: missing,
            source: r.source,
            kind: 'scene',
            target,
            assetType: 'image',
            provider,
            characterRef: getCharacterRef(),
          },
        });
        if (res?.ok) {
          queued += res.added || 0;
          eps++;
        }
      } catch {
        /* skip this episode */
      }
    }
    setStatus(`Queued ${queued} scene${queued === 1 ? '' : 's'} across ${eps} episode${eps === 1 ? '' : 's'}.`, 'done');
    pollQueue();
  };
}

async function onProjectChange() {
  const sel = $('project');
  const slug = sel.value;
  $('episode').innerHTML = '';
  if (!slug) return;
  currentProject = { slug, name: sel.selectedOptions[0]?.dataset.name || slug };
  await saveSettings({ lastProject: slug });
  try {
    const rows = await client.listEpisodes(slug);
    // Every episode with a prompt source, sorted numerically by code. The filter
    // (To do / Done / All) is then applied by hiding options — reactively, once
    // the accurate per-scene counts load, since st.images can be stale.
    allEpisodes = (Array.isArray(rows) ? rows : rows.episodes || [])
      .map((e) => ({ code: e.episode_code || e.code, title: e.title || '', st: e.status || {} }))
      .filter((e) => e.st.scene_plan || e.st.scene_prompts || e.st.thumb_prompts)
      .sort((a, b) => episodeNum(a.code) - episodeNum(b.code) || String(a.code).localeCompare(String(b.code)));
    for (const e of allEpisodes) e.done = e.st.images ? true : null; // hint; count overrides
    const esel = $('episode');
    esel.innerHTML = '';
    for (const e of allEpisodes) {
      const opt = document.createElement('option');
      opt.value = e.code;
      opt.dataset.title = e.title;
      opt.textContent = `${e.code}${e.title ? ' — ' + e.title : ''}${e.done ? ' ✓' : ''}`;
      esel.appendChild(opt);
    }
    applyEpisodeFilter();
    if (settings.lastEpisode && [...esel.options].some((o) => o.value === settings.lastEpisode)) esel.value = settings.lastEpisode;
    fetchEpisodeCounts(slug, allEpisodes.map((e) => e.code));
    loadCharacters(slug);
  } catch (e) {
    setStatus(`Couldn't load episodes: ${e.message}`, 'err');
  }
}

// Populate the Flow "Character reference" dropdown from the project's characters
// (only those that actually have a reference image). Selection persists.
async function loadCharacters(slug) {
  const sel = $('flowCharacterRef');
  if (!sel) return;
  sel.innerHTML = '<option value="">None</option>';
  if (!slug) return;
  try {
    const data = await client.listCharacters(slug);
    const list = Array.isArray(data) ? data : data.characters || [];
    for (const c of list) {
      const imgs = (c.references && c.references.images) || c.reference_images || [];
      const first = imgs[0];
      const filename = typeof first === 'string' ? first : first?.filename || first?.name;
      if (!filename) continue; // skip characters with no reference sheet
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.dataset.filename = filename;
      opt.textContent = c.name || c.id;
      sel.appendChild(opt);
    }
    if (settings.characterRefId && [...sel.options].some((o) => o.value === settings.characterRefId)) {
      sel.value = settings.characterRefId;
    }
  } catch {
    /* characters are optional — leave "None" */
  }
}

// The current character reference selection → { characterId, filename } or null.
function getCharacterRef() {
  if (!$('charRefEnabled')?.checked) return null; // per-run off toggle
  const sel = $('flowCharacterRef');
  if (!sel || !sel.value) return null;
  const opt = sel.selectedOptions[0];
  const filename = opt?.dataset.filename;
  return filename ? { characterId: sel.value, filename } : null;
}

// ── scenes ──────────────────────────────────────────────────────────────────
async function loadScenes() {
  const slug = $('project').value;
  const esel = $('episode');
  const code = esel.value;
  if (!slug || !code) {
    setStatus('Pick a project and episode first.', 'err');
    return;
  }
  currentEpisode = { code, title: esel.selectedOptions[0]?.dataset.title || '' };
  await saveSettings({ lastEpisode: code });
  const kind = currentKind();
  const video = isVideoSel();
  $('loadScenes').disabled = true;
  $('refreshScenes').disabled = true;
  setStatus(`Loading ${video ? 'scene clips' : kind === 'thumbnail' ? 'thumbnails' : 'scenes'}…`, 'running');
  try {
    let scenes;
    let label;
    if (video) {
      scenes = await loadSceneVideos(slug, currentEpisode);
      currentSource = 'plan';
      label = 'Scene Plan · motion';
    } else if (kind === 'thumbnail') {
      scenes = await loadThumbnails(slug, currentEpisode);
      currentSource = 'prompts';
      label = 'Thumbnail Prompts';
    } else {
      const r = await loadScenesFromEither(slug, currentEpisode);
      scenes = r.scenes;
      currentSource = r.source;
      label = r.source === 'plan' ? 'Scene Plan' : 'Scene Prompts';
    }
    currentScenes = scenes;
    loadedKind = selKind();
    renderScenes();
    const done = scenes.filter((s) => s.hasImage).length;
    const noun = video ? 'Clips' : kind === 'thumbnail' ? 'Thumbnails' : 'Scenes';
    const have = video ? 'have clips' : 'have images';
    $('scenesSummary').textContent = `${noun} (${label}) — ${done}/${scenes.length} ${have}`;
    const emptyMsg = video
      ? 'No animatable scenes. A scene must be approved, have an image, a motion prompt, and meet the minimum duration.'
      : `No ${noun.toLowerCase()} found for this episode.`;
    setStatus(scenes.length ? '' : emptyMsg, scenes.length ? 'info' : 'err');
  } catch (e) {
    setStatus(`Couldn't load: ${e.message}`, 'err');
  } finally {
    $('loadScenes').disabled = false;
    // Refresh stays live once an episode is loaded, so a cut-off run can be
    // re-pulled in place without touching the tab.
    $('refreshScenes').disabled = false;
  }
}

// Scene video (image-to-video). The SPEND GATE (enforced here — Story Studio
// can't block an external Veo spend after the fact): only show scenes that are
//   approved === true, motion_prompt non-empty, image exists, and
//   (end_sec − start_sec) >= animate_min_seconds.
// Among those, "done" = a fresh clip already exists; stale = clip rendered from a
// now-changed motion prompt (the soft gate — re-renderable via "include existing").
async function loadSceneVideos(slug, ep) {
  const data = await client.sceneReview(slug, ep.code);
  const scenes = data?.scenes || [];
  const minSec = Number(data?.animate_min_seconds) || 0;
  return scenes
    .filter(
      (s) =>
        s.approved === true &&
        (s.motion_prompt || '').trim() &&
        s.image_filename != null &&
        Number(s.end_sec) - Number(s.start_sec) >= minSec
    )
    .map((s) => ({
      source: 'plan',
      kind: 'scene',
      key: s.id,
      label: `Scene ${s.scene_index}`,
      prompt: s.motion_prompt || '', // motion prompt drives image-to-video
      imagePrompt: s.visual_prompt || '', // used only in "generate fresh image" mode
      durationSec: Math.max(0, Number(s.end_sec) - Number(s.start_sec)), // request clip ≈ scene window
      hasImage: !!s.clip_exists && !s.clip_stale, // "done" = a fresh clip exists
      stale: !!s.clip_stale,
    }));
}

// Thumbnails always come from the Image Prompts generator's `thumbnails` array
// (04 Thumbnail Prompts) and save to 06 Thumbnail Images as {CODE}_Thumb{NN}_v1.png.
async function loadThumbnails(slug, ep) {
  const data = await client.imagePrompts(slug, ep.code, ep.title);
  const thumbs = data?.thumbnails || [];
  const present = new Set();
  try {
    const st = await client.imageStatus(slug, ep.code);
    const missing = new Set((st?.thumbnails?.missing || []).map(Number));
    const total = st?.thumbnails?.total || thumbs.length;
    for (let n = 1; n <= total; n++) if (!missing.has(n)) present.add(n);
  } catch {
    /* status optional */
  }
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

// An episode has EITHER a scene plan OR scene prompts (mutually exclusive).
// Try scene_plan first; fall back to the Scene Prompts generator. Normalize both.
async function loadScenesFromEither(slug, ep) {
  // 1) Scene Plan
  try {
    const data = await client.sceneReview(slug, ep.code);
    if (data?.scenes?.length) {
      return {
        source: 'plan',
        scenes: data.scenes.map((s) => ({
          source: 'plan',
          kind: 'scene',
          key: s.id,
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
  // 2) Scene Prompts ("03 Scene Prompts")
  const data = await client.imagePrompts(slug, ep.code, ep.title);
  const promptScenes = data?.scenes || [];
  let present = new Set();
  try {
    const st = await client.imageStatus(slug, ep.code);
    const missing = new Set((st?.scenes?.missing || st?.missing || []).map(Number));
    const total = st?.scenes?.total || promptScenes.length;
    for (let n = 1; n <= total; n++) if (!missing.has(n)) present.add(n);
  } catch {
    /* status optional */
  }
  return {
    source: 'prompts',
    scenes: promptScenes.map((s) => ({
      source: 'prompts',
      kind: 'scene',
      key: s.number,
      label: `Scene ${s.number}${s.title ? ` — ${s.title}` : ''}`,
      prompt: s.prompt || '',
      hasImage: present.has(Number(s.number)),
      stale: false,
    })),
  };
}

const PROVIDER_LABEL = {
  flow: 'Google Flow',
  aistudio: 'AI Studio',
  qwen: 'Qwen Studio',
  grok: 'Grok',
  perchance: 'Perchance',
  freegen: 'FreeGen',
  leonardo: 'Leonardo',
  pollinations: 'Pollinations',
  piclumen: 'PicLumen',
  chatgpt: 'ChatGPT',
};

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
  const video = loadedKind === 'video';
  const wrap = $('scenes');
  wrap.innerHTML = '';
  for (const s of currentScenes) {
    const has = s.hasImage; // image (image modes) or fresh clip (video)
    const div = document.createElement('div');
    div.className = 'scene';
    div.dataset.key = String(s.key);
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.key = String(s.key);
    // Pre-select scenes that still need the asset. For video, a fresh clip is
    // HARD-skipped (re-render by editing the motion prompt → it becomes stale →
    // eligible) — so "include existing" doesn't re-enable fresh clips, only the
    // image modes honour it.
    cb.checked = video ? !has : includeExisting || !has;
    cb.disabled = video ? has : has && !includeExisting;
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
      b.textContent = s.stale ? 'stale' : loadedKind === 'video' ? 'has clip' : 'has image';
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

// Google Flow options in the panel (mirrors the Options page). The video row
// only matters when the "Make" selector is on scene video.
function flowPopulate() {
  $('flowImageModel').value = settings.imageModel || 'nano-banana-2';
  $('flowAspect').value = settings.aspectRatio || '16:9';
  $('flowVideoModel').value = settings.videoModel || 'veo-3.1-fast';
  $('flowVideoSource').value = settings.videoSource || 'existing';
  $('flowVideoRow').classList.toggle('hidden', !isVideoSel());
  // Character reference is an image-only feature.
  $('charRefCard').classList.toggle('hidden', isVideoSel());
}

function freegenPopulate() {
  $('freegenAspect').value = settings.aspectRatio || '16:9';
}

function pollinationsPopulate() {
  $('pollModel').value = settings.pollinationsModel || 'flux';
  $('pollSeed').value = settings.pollinationsSeed || '';
  $('pollToken').value = settings.pollinationsToken || '';
}

function qwenPopulate() {
  $('qwenAspect').value = settings.qwenAspectRatio || '16:9';
}

function perchancePopulate() {
  $('perchanceStyleInput').value = settings.perchanceStyle || 'No style';
  $('perchanceAspect').value = settings.aspectRatio || '16:9';
  $('perchanceCount').value = String(settings.perchanceCount || 1);
}

function aistudioPopulate() {
  $('aistudioAspect').value = settings.aistudioAspectRatio || '16:9';
}

function chatgptPopulate() {
  $('chatgptAspect').value = settings.chatgptAspectRatio || '16:9';
  const every = Number(settings.chatgptNewChatEvery) || 50;
  const presets = new Set([10, 20, 30, 50, 100, 200, 300]);
  if (presets.has(every)) {
    $('chatgptNewChatEvery').value = String(every);
    $('chatgptNewChatEveryCustomWrap').classList.add('hidden');
  } else {
    $('chatgptNewChatEvery').value = 'custom';
    $('chatgptNewChatEveryCustom').value = every;
    $('chatgptNewChatEveryCustomWrap').classList.remove('hidden');
  }
}

// Only Flow supports video; all other providers use their image-generator UI.
function onProviderChange() {
  const provider = $('provider').value;
  const imageOnly = provider !== 'flow';
  saveSettings({ provider });
  const videoOpt = $('mediaType').querySelector('option[value="scene-video"]');
  if (videoOpt) videoOpt.disabled = imageOnly;
  if (imageOnly && isVideoSel()) $('mediaType').value = 'scene-image';
  $('flowProjectCard').classList.toggle('hidden', provider !== 'flow');
  $('flowOptsCard').classList.toggle('hidden', provider !== 'flow');
  $('freegenCard').classList.toggle('hidden', provider !== 'freegen');
  $('perchanceCard').classList.toggle('hidden', provider !== 'perchance');
  $('grokCard').classList.toggle('hidden', provider !== 'grok');
  $('aistudioCard').classList.toggle('hidden', provider !== 'aistudio');
  $('qwenCard').classList.toggle('hidden', provider !== 'qwen');
  $('pollinationsCard').classList.toggle('hidden', provider !== 'pollinations');
  $('leonardoCard').classList.toggle('hidden', provider !== 'leonardo');
  $('piclumenCard').classList.toggle('hidden', provider !== 'piclumen');
  $('chatgptCard').classList.toggle('hidden', provider !== 'chatgpt');
  // "↗ Open provider" shortcut — hidden for tabless providers (no page).
  const openBtn = $('openProviderPage');
  const hasPage = provider !== 'pollinations';
  openBtn.classList.toggle('hidden', !hasPage);
  openBtn.textContent = `↗ Open ${PROVIDER_LABEL[provider] || provider}`;
  const wantsChar = provider === 'flow' || provider === 'qwen' || provider === 'chatgpt';
  $('charRefCard').classList.toggle('hidden', !wantsChar);
  if (wantsChar)
    $('charRefHint').textContent =
      provider === 'qwen'
        ? 'Uploaded to Qwen as an img2img reference before each character scene — Qwen consumes it per generation, so it re-uploads every time.'
        : provider === 'chatgpt'
          ? 'Pasted into the ChatGPT /images composer as a reference before each character scene — re-attached every time.'
          : 'Uploaded to Flow once and applied as a reference on character scenes.';
  if (provider === 'leonardo') leoPopulate();
  if (provider === 'flow') flowPopulate();
  if (provider === 'freegen') freegenPopulate();
  if (provider === 'perchance') perchancePopulate();
  if (provider === 'pollinations') pollinationsPopulate();
  if (provider === 'qwen') qwenPopulate();
  if (provider === 'aistudio') aistudioPopulate();
  if (provider === 'chatgpt') chatgptPopulate();
  renderCooldownCard();
  renderAppliedSettings();
  onMediaTypeChange();
  if (provider === 'grok') checkGrok();
  else if (provider === 'pollinations') setStatus('Pollinations runs in the background — no tab needed.', 'info');
  else if (provider !== 'flow') checkWebGenerator(provider);
  else setStatus('', 'info');
}

async function checkGrok() {
  setStatus('Checking Grok…', 'running');
  try {
    const ctx = await chrome.runtime.sendMessage({ type: 'grokContext' });
    if (!ctx?.ok) throw new Error(ctx?.error || 'no Grok tab');
    if (!ctx.signedIn) setStatus('Grok: not signed in — open grok.com and sign in.', 'err');
    else if (!ctx.hasTemplate)
      setStatus('Grok: sign-in OK. Generate ONE image at grok.com/imagine (free daily quota) so the extension can learn the API, then batch here.', 'err');
    else setStatus('Grok ready (template captured). A daily-limit message pauses the queue until you Resume.', 'done');
  } catch (e) {
    setStatus(`Grok check failed: ${e.message}`, 'err');
  }
}

async function checkWebGenerator(provider) {
  const names = { aistudio: 'AI Studio', qwen: 'Qwen Studio', perchance: 'Perchance', freegen: 'FreeGen', leonardo: 'Leonardo AI', piclumen: 'PicLumen', chatgpt: 'ChatGPT' };
  const name = names[provider] || provider;
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

// Reload the list when the selection kind changes (scene image / scene video /
// thumbnail all read different prompts). Save target stays user-controlled —
// video now writes clips back via upload-clip too.
async function onMediaTypeChange() {
  $('saveTarget').disabled = false;
  if ($('provider').value === 'flow') {
    $('flowVideoRow').classList.toggle('hidden', !isVideoSel());
    $('charRefCard').classList.toggle('hidden', isVideoSel());
  }
  if (currentEpisode && currentScenes.length && selKind() !== loadedKind) {
    await loadScenes();
  }
}

// ── confirm + enqueue ───────────────────────────────────────────────────────
function confirmQueue() {
  const scenes = selectedScenes();
  if (!scenes.length) return;
  const provider = $('provider').value;
  const isGrok = provider === 'grok';
  const isFlow = provider === 'flow';
  const kind = currentKind();
  const isVideo = isFlow && isVideoSel();
  const noun = kind === 'thumbnail' ? 'thumbnail' : 'scene';
  const folder = kind === 'thumbnail' ? 'Thumbnail Images folder' : 'scene folder';
  const target = $('saveTarget').value;
  if (target === 'project' && !currentProject) return;
  if (isFlow && !settings.flowProjectId) {
    setStatus('Set a Flow project first (use “Use current tab”).', 'err');
    return;
  }
  const n = `${scenes.length} ${noun}${scenes.length > 1 ? 's' : ''}`;
  if (isGrok) {
    $('confirmTitle').textContent = `Queue these ${noun}s on Grok?`;
    $('confirmBody').textContent =
      `${n} from ${currentEpisode.code} via Grok Imagine → ` +
      `${target === 'project' ? `Story Studio ${folder}` : 'Downloads'}. Free tier has a DAILY LIMIT — ` +
      `the queue pauses when it's hit; press Resume after it resets. ${humanDelayLabel()} between each. Continue?`;
    $('confirmOk').textContent = 'Queue on Grok';
  } else if (isFlow) {
    $('confirmTitle').textContent = isVideo ? '⚠︎ Generate video — uses credits' : `Queue these ${noun}s?`;
    $('confirmBody').textContent = isVideo
      ? `${scenes.length} clip${scenes.length > 1 ? 's' : ''} from ${currentEpisode.code} — image-to-video ` +
        `(${settings.videoSource === 'generate' ? 'fresh image' : 'existing image'} + motion prompt) → ` +
        `${target === 'project' ? '“11 Video Assets”' : 'Downloads'}. Each clip costs credits ` +
        `(Veo ~20, Omni Flash ~7). One at a time, ~1–3 min each. Continue?`
      : `${n} from ${currentEpisode.code} → ` +
        `${target === 'project' ? `Story Studio ${folder}` : 'Downloads'}. ` +
        `Images use Nano Banana 2 (free). One at a time.`;
    $('confirmOk').textContent = isVideo ? 'Spend credits & generate' : 'Queue';
  } else if (provider === 'aistudio') {
    $('confirmTitle').textContent = `Queue these ${noun}s on AI Studio?`;
    $('confirmBody').textContent =
      `${n} from ${currentEpisode.code} via Google AI Studio → ` +
      `${target === 'project' ? `Story Studio ${folder}` : 'Downloads'}. Keep the AI Studio tab open in ` +
      `image mode. Uses your FREE DAILY image quota — the queue pauses when it's hit; press Resume after reset. ` +
      `${humanDelayLabel()} between each. Continue?`;
    $('confirmOk').textContent = 'Queue on AI Studio';
  } else if (provider === 'qwen') {
    $('confirmTitle').textContent = `Queue these ${noun}s on Qwen Studio?`;
    $('confirmBody').textContent =
      `${n} from ${currentEpisode.code} via Qwen Studio (${settings.qwenAspectRatio || '16:9'}) → ` +
      `${target === 'project' ? `Story Studio ${folder}` : 'Downloads'}. Keep the Qwen tab open. ` +
      `Qwen uses one submission per scene, ratio is best-effort, and explicit usage limits pause the queue. ` +
      `${humanDelayLabel()} between each. Continue?`;
    $('confirmOk').textContent = 'Queue on Qwen';
  } else if (provider === 'pollinations') {
    $('confirmTitle').textContent = `Queue these ${noun}s on Pollinations?`;
    $('confirmBody').textContent =
      `${n} from ${currentEpisode.code} via Pollinations (${settings.pollinationsModel || 'flux'}) → ` +
      `${target === 'project' ? `Story Studio ${folder}` : 'Downloads'}. ` +
      `Runs in the background — no tab needed. One at a time with a ${humanDelayLabel()} gap` +
      `${settings.pollinationsToken ? '' : ' (free tier is watermarked and rate-limited ~1 image/15s)'}.`;
    $('confirmOk').textContent = 'Queue on Pollinations';
  } else {
    const names = { perchance: 'Perchance', freegen: 'FreeGen', leonardo: 'Leonardo AI', piclumen: 'PicLumen', chatgpt: 'ChatGPT' };
    const name = names[provider] || provider;
    const ratioNote =
      provider === 'aistudio'
        ? ` Ratio ${settings.aistudioAspectRatio || '16:9'} (via the prompt).`
        : provider === 'chatgpt'
          ? ` Ratio ${settings.chatgptAspectRatio || '16:9'} (via the prompt).`
          : '';
    const chatNote =
      provider === 'chatgpt' ? ' Runs on chatgpt.com/images — keep that tab visible.' : '';
    $('confirmTitle').textContent = `Queue these ${noun}s on ${name}?`;
    $('confirmBody').textContent =
      `${n} from ${currentEpisode.code} via the ${name} website → ` +
      `${target === 'project' ? `Story Studio ${folder}` : 'Downloads'}. ` +
      `Keep the generator tab open; jobs run one at a time with a ${humanDelayLabel()} gap.${ratioNote}${chatNote}`;
    $('confirmOk').textContent = `Queue on ${name}`;
  }
  const dlg = $('confirm');
  dlg.classList.remove('hidden');
  $('confirmOk').onclick = async () => {
    dlg.classList.add('hidden');
    await doEnqueue(scenes, target, isVideo ? 'video' : 'image', provider, kind);
  };
}

async function doEnqueue(scenes, target, assetType, provider, kind) {
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'enqueueScenes',
      payload: {
        slug: currentProject.slug,
        episodeCode: currentEpisode.code,
        episodeTitle: currentEpisode.title,
        projectName: currentProject.name,
        scenes,
        source: currentSource,
        kind,
        target,
        assetType,
        provider,
        characterRef: getCharacterRef(),
      },
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

// Prominent generation status above the Queue: green + glowing while running,
// orange while paused, with running success/failed/remaining counts.
function updateGenStatus(queue, paused) {
  const bar = $('genStatusBar');
  if (!bar) return;
  const done = queue.filter((i) => i.status === 'done').length;
  const failed = queue.filter((i) => i.status === 'failed').length;
  const left = queue.filter((i) => i.status === 'pending' || i.status === 'running').length;
  const running = queue.some((i) => i.status === 'running');
  let state = 'Idle';
  let cls = 'idle';
  if (paused) {
    state = 'Paused';
    cls = 'paused';
  } else if (left > 0) {
    state = running ? 'Generating' : 'Queued';
    cls = 'running';
  } else if (queue.length) {
    state = 'Finished';
    cls = 'done';
  }
  bar.className = 'genstatus ' + cls;
  $('gsStateText').textContent = state;
  $('gsDone').textContent = `${done} done`;
  $('gsFailed').textContent = `${failed} failed`;
  $('gsLeft').textContent = `${left} left`;
  bar.querySelector('.gs-counts').classList.toggle('hidden', queue.length === 0);
}

let lastQueueSig = '';
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
  const pause = $('pauseQueue');
  pause.classList.toggle('hidden', !hasWork && !paused);
  pause.textContent = paused ? 'Resume' : 'Pause';
  updateGenStatus(queue, paused);
  // Live per-scene status + tab-visibility reminder — run every tick, even when
  // the queue-list DOM itself is unchanged.
  updateSceneQueueStatus(queue);
  const prov = $('provider').value;
  const needsTab = hasWork && prov !== 'pollinations';
  $('tabReminder').classList.toggle('hidden', !needsTab);
  if (needsTab)
    $('tabReminder').textContent = `Keep the ${PROVIDER_LABEL[prov] || prov} tab visible (active tab, not minimized) while this runs — hidden tabs get throttled.`;
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
        const ambiguousPaid = it.assetType === 'video' && it.phase === 'submitting' && !it.videoMediaId;
        if (ambiguousPaid) {
          const dlg = $('confirm');
          $('confirmTitle').textContent = 'Retry paid video submission?';
          $('confirmBody').textContent =
            'Flow may have accepted the previous request before the page refreshed. Retrying could spend credits twice.';
          $('confirmOk').textContent = 'Retry and accept risk';
          dlg.classList.remove('hidden');
          $('confirmOk').onclick = async () => {
            dlg.classList.add('hidden');
            await chrome.runtime.sendMessage({ type: 'retryFailed', id: it.id });
            pollQueue();
          };
          return;
        }
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
