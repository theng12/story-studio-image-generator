// Side-panel controller.
//
// Standalone pastes prompts and hands them to the background worker, which owns
// the Flow generation + persistent queue and saves each image to Downloads.
// Gateway Studio claims image jobs from the configured Gateway server.

import {
  requestSettings as getSettings,
  saveSettings,
  getLeonardoModels,
  saveLeonardoModels,
  providerCooldown,
} from '../lib/config.js';
import { PROVIDERS, getProvider } from '../lib/providers.js';
import { initTheme } from '../lib/theme.js';
import { modelSnapshotDiagnostic, resolveStoredFlowModelId } from '../lib/model-identity.js';
import { createImageGatewayWorkerId } from '../lib/gateway-worker.js';
import { readWorkMode, writeWorkMode } from '../lib/work-mode.js';

const $ = (id) => document.getElementById(id);
let settings = null;
let liveStatus = null;
let workMode = 'standalone';
let standalonePrompts = [];
let currentFlowModels = [];
let currentFlowModelSource = 'fallback';
let flowModelSaveTail = Promise.resolve();

const HUMAN_PACE_PRESETS = {
  off: { label: 'Off', min: 0, max: 0 },
  quick: { label: 'Quick', min: 5, max: 15 },
  balanced: { label: 'Balanced', min: 15, max: 45 },
  cautious: { label: 'Cautious', min: 30, max: 90 },
  'very-cautious': { label: 'Very cautious', min: 60, max: 180 },
};

// The "Make:" selector chooses scene or thumbnail images.
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
  populateProviderSelect(settings.provider || 'flow');
  const localState = await chrome.storage.local.get('settingsSource');
  settingsSource = localState.settingsSource || {};
  workMode = await readWorkMode();
  await refreshGatewayConnection();
  renderHumanPace();
  renderCooldownCard();
  renderAppliedSettings();
  renderWorkMode();
  await refreshFlowProject();
  wire();
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
  $('humanPacePreset').onchange = selectHumanPacePreset;
  $('humanPaceMin').onchange = saveCustomHumanPace;
  $('humanPaceMax').onchange = saveCustomHumanPace;
  $('cooldownAutoResume').onchange = onCooldownToggle;
  $('cooldownPreset').onchange = onCooldownPreset;
  $('cooldownMinutes').onchange = saveCooldownCustom;
  $('cooldownRetries').onchange = saveCooldownRetries;
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
    pollQueue();
  };
  $('retryFailed').onclick = async () => {
    const res = await chrome.runtime.sendMessage({ type: 'retryFailed' });
    if (!res?.retried) setStatus('No failed jobs to retry.', 'info');
    pollQueue();
  };
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
  $('qwenAspect').onchange = async () => (settings = await saveSettings({ qwenAspectRatio: $('qwenAspect').value }));
  $('aistudioAspect').onchange = async () => (settings = await saveSettings({ aistudioAspectRatio: $('aistudioAspect').value }));
  $('chatgptAspect').onchange = async () => (settings = await saveSettings({ chatgptAspectRatio: $('chatgptAspect').value }));
  $('chatgptMaxWait').onchange = async () => {
    const min = Math.min(15, Math.max(1, Math.round(Number($('chatgptMaxWait').value) || 8)));
    $('chatgptMaxWait').value = min;
    settings = await saveSettings({ chatgptMaxWaitSec: min * 60 });
  };
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
  $('gatewayUrl').onchange = () => saveGatewayField({ gatewayUrl: $('gatewayUrl').value.trim() });
  $('gatewayToken').onchange = () => saveGatewayField({ gatewayToken: $('gatewayToken').value.trim() });
  $('gatewayWorkerId').onchange = () => saveGatewayField({ gatewayWorkerId: $('gatewayWorkerId').value.trim() });
  $('gatewayModeEnabled').onchange = () => saveGatewayField({ gatewayModeEnabled: $('gatewayModeEnabled').checked });
  $('generateGatewayWorkerId').onclick = async () => {
    $('gatewayWorkerId').value = createImageGatewayWorkerId();
    await saveGatewayField({ gatewayWorkerId: $('gatewayWorkerId').value });
  };
  $('testGateway').onclick = testGatewayConnection;
  $('gatewayClaim').onclick = async () => {
    const status = $('gatewayPanelStatus');
    status.textContent = 'Requesting a claim…';
    try {
      await chrome.runtime.sendMessage({ type: 'gateway:claimNow' });
      status.textContent = 'Claim requested. Gateway jobs appear in the queue below.';
    } catch (error) {
      status.textContent = error.message;
    }
  };
}

function renderWorkMode() {
  const gatewayMode = workMode === 'gateway';
  $('gatewayCard').classList.toggle('hidden', !gatewayMode);
  $('standaloneWorkflow').classList.toggle('hidden', gatewayMode);
  // In Gateway mode "Save to: Gateway Studio" only repeats the Mode control.
  $('saveDestinationField').classList.toggle('hidden', gatewayMode);
  $('workingMode').value = workMode;
  if (gatewayMode) renderGatewayConnection();
}

async function setWorkMode(mode) {
  workMode = await writeWorkMode(mode);
  renderWorkMode();
  if (workMode === 'gateway') setStatus('Gateway mode claims image jobs from the configured Gateway server. Images are priced as free (0 credits); any other price is one you set in Settings.', 'info');
  else setStatus('Standalone mode uses a local prompt and Downloads.', 'info');
}

let gatewayRelayMachineId = '';
let gatewayReadiness = null;

async function refreshGatewayConnection() {
  settings = await getSettings();
  const stored = await chrome.storage.local.get(['gatewayRelayMachineId', 'gatewayReadiness']);
  gatewayRelayMachineId = stored.gatewayRelayMachineId || '';
  gatewayReadiness = stored.gatewayReadiness || null;
  populateGatewayPanel();
  renderGatewayConnection();
}

// Relay seeds the connection while this panel may already be open; follow it live.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (!changes.gatewayConnection && !changes.gatewayRelayMachineId && !changes.imageGeneratorWorkMode && !changes.gatewayReadiness) return;
  if (changes.gatewayRelayMachineId) gatewayRelayMachineId = changes.gatewayRelayMachineId.newValue || '';
  if (changes.gatewayReadiness) gatewayReadiness = changes.gatewayReadiness.newValue || null;
  if (changes.gatewayConnection) settings = { ...settings, ...(changes.gatewayConnection.newValue || {}) };
  populateGatewayPanel();
  renderGatewayConnection();
});

function renderGatewayConnection() {
  const connected = !!(settings.gatewayUrl && settings.gatewayToken && settings.gatewayWorkerId);
  const state = $('gatewayRelayState');
  // A connected connection with a blocked Flow project says why; never a bare success line.
  const blocked = connected && gatewayReadiness && gatewayReadiness.ready === false;
  state.textContent = blocked
    ? `Connected through Relay · ${gatewayReadiness.reason || 'Flow is not ready'}`
    : connected
      ? `Connected${gatewayRelayMachineId ? ` through Relay · ${gatewayRelayMachineId}` : ''}`
      : (gatewayReadiness?.ready === false && gatewayReadiness.reason) || 'Not connected';
  state.classList.toggle('ok', connected && !blocked);
  // Fields are one click away when connected; open by default when nothing is connected.
  $('gatewayDetails').open = !connected;
  if (connected) {
    $('gatewayPanelStatus').textContent = '';
  } else if (!$('gatewayPanelStatus').textContent.trim()) {
    // Never blame the person for a blank form Relay can fill: name the real retry.
    $('gatewayPanelStatus').textContent = 'Relay has not finished connecting this browser. Open the account from Relay again to retry.';
  }
}

function populateGatewayPanel() {
  $('gatewayUrl').value = settings.gatewayUrl || '';
  $('gatewayToken').value = settings.gatewayToken || '';
  $('gatewayWorkerId').value = settings.gatewayWorkerId || '';
  $('gatewayModeEnabled').checked = settings.gatewayModeEnabled === true;
}

async function saveGatewayField(patch) {
  settings = await saveSettings(patch);
  renderGatewayConnection();
  flashSaved();
}

async function testGatewayConnection() {
  const status = $('gatewayPanelStatus');
  status.textContent = 'Testing Gateway connection…';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'gateway:testConnection' });
    if (!result?.ok) throw new Error(result?.error || 'Couldn’t connect to Gateway.');
    status.textContent = `Gateway connected. ${Number.isFinite(result.balance?.value) ? `${result.balance.value} credits remaining.` : 'Remaining credits unknown.'} Upload limit: ${result.maxResultBytes} bytes.`;
  } catch (error) {
    status.textContent = `Couldn’t connect: ${error.message}`;
  }
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
  const payload = {
    prompts: [...standalonePrompts],
    label: $('standaloneLabel').value,
    provider,
  };
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

// Keep the indicator current when Settings is edited in another extension tab.
// Who last set pacing / cooldown on this machine.
let settingsSource = {};

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync' && changes.settings?.newValue && settings) {
    // A change here can arrive from another browser context — reflect it.
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
    return by ? ' <span class="src local">local</span>' : '';
  };
  el.innerHTML = `<span>⚙ Pacing ${min}–${max}s${tag('pace')}</span><span>${prov} cooldown: ${cdText}${tag('cooldown')}</span>`;
}

// Note that THIS machine last set a settings group.
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

const PROVIDER_LABEL = Object.freeze(Object.fromEntries(PROVIDERS.map(({ id, label }) => [id, label])));

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
      : 'Bundled model catalog; current availability not checked';
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
  openBtn.title = `Open the ${provider === 'flow' ? 'Flow' : provider} workspace in this browser`;
  $('providerOptionsTitle').textContent = 'Provider settings';
  $('providerOptionsHint').textContent = provider === 'flow'
    ? 'Model · ratio · reference'
    : provider === 'leonardo'
      ? 'Model · style · reference'
      : 'Generation preferences';
  if (provider === 'leonardo') leoPopulate();
  if (provider === 'flow') flowPopulate();
  if (provider === 'qwen') qwenPopulate();
  if (provider === 'aistudio') aistudioPopulate();
  if (provider === 'chatgpt') chatgptPopulate();
  renderCooldownCard();
  renderAppliedSettings();
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
async function pollQueue() {
  const [{ queue = [], paused = false } = {}, st, tickStore] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'getQueue' }).then((r) => r || {}),
    chrome.storage.local.get('lastStatus'),
    chrome.storage.local.get('gatewayLastTickAt'),
  ]);
  renderQueueTiming(queue);
  const s = st.lastStatus;
  liveStatus = s && Date.now() - s.ts < 600000 ? s : null;
  if (liveStatus) {
    if (Number.isFinite(liveStatus.countdownUntil)) renderLiveStatus();
    else setStatus(liveStatus.text, liveStatus.kind);
  }
  // A saved connection with the mode not selected looks paired and never claims; say so.
  if (workMode !== 'gateway' && !liveStatus) {
    const connection = (await chrome.storage.local.get('gatewayConnection')).gatewayConnection || {};
    if (connection.gatewayWorkerId && connection.gatewayToken) {
      setStatus('Gateway connection is saved, but Gateway mode is not selected. Choose Gateway Studio above to claim jobs.', 'err');
    }
  }
  // An armed but silent worker must never look merely absent: say whether the claim loop ticks.
  if (workMode === 'gateway' && !liveStatus) {
    const connection = (await chrome.storage.local.get('gatewayConnection')).gatewayConnection || {};
    if (connection.gatewayWorkerId && connection.gatewayModeEnabled !== true) {
      setStatus('Gateway mode is selected, but the connection is not enabled on the Settings page.', 'err');
      return;
    }
    const tick = Number(tickStore.gatewayLastTickAt) || 0;
    if (!tick || Date.now() - tick > 90000) setStatus('Gateway claim loop is not ticking. Reload this extension or restart Chrome so it can pick up jobs.', 'err');
    else setStatus(`Gateway claim loop ticking · last check ${new Date(tick).toLocaleTimeString()}`, 'info');
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
  // Tab-visibility reminder — run every tick, even when the queue DOM is unchanged.
  const prov = $('provider').value;
  const needsTab = hasWork;
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
    if (it.status === 'pending' && it.target !== 'gateway') {
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
      const gateway = it.target === 'gateway';
      retry.textContent = gateway ? 'Deliver again' : '↻';
      retry.title = gateway ? 'Upload retained bytes only; never generate again' : 'Retry this failed job';
      retry.disabled = gateway && it.gatewayAcknowledged === true;
      retry.onclick = async () => {
        const response = await chrome.runtime.sendMessage({ type: gateway ? 'gateway:retryDelivery' : 'retryFailed', id: it.id });
        if (response?.ok === false) setStatus(response.error || 'Delivery is still held.', 'err');
        else await pollQueue();
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
