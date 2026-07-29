import {
  getSettings,
  saveSettings,
  getCredentials,
  saveCredentials,
  getLeonardoModels,
  saveLeonardoModels,
} from '../lib/config.js';
import { StudioClient } from '../lib/story-studio.js';

const $ = (id) => document.getElementById(id);
const FIELDS = [
  'studioBaseUrl',
  'flowProjectId',
  'perchanceStyle',
  'leonardoModel',
  'leonardoStyle',
  'leonardoMode',
  'leonardoSize',
  'leonardoCount',
  'humanDelayMinSec',
  'humanDelayMaxSec',
  'flowRecaptchaMaxAttempts',
  'imageModel',
  'aspectRatio',
  'saveTarget',
  'downloadSubdir',
  'filenameTemplate',
  'fleetHubUrl',
  'fleetAgentName',
  'fleetSharedSecret',
];
const CHECKBOX_FIELDS = ['fleetAgentEnabled'];

// Append any model ids not already in the <select>, keeping the curated static
// options (and their friendlier labels) as-is. Returns how many were added.
function addModelOptions(models) {
  const sel = $('leonardoModel');
  if (!sel) return 0;
  const have = new Set([...sel.options].map((o) => o.value));
  let added = 0;
  for (const m of models) {
    if (!m?.id || have.has(m.id)) continue;
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.badge ? `${m.label} — ${m.badge}` : m.label;
    sel.appendChild(opt);
    have.add(m.id);
    added++;
  }
  return added;
}

async function load() {
  const s = await getSettings();
  // Seed cached live models before restoring the saved value, so a saved model
  // that isn't in the static list still resolves to a real option.
  addModelOptions(await getLeonardoModels());
  for (const f of FIELDS) if ($(f)) $(f).value = s[f] ?? '';
  for (const f of CHECKBOX_FIELDS) if ($(f)) $(f).checked = !!s[f];
  const creds = await getCredentials();
  $('studioUsername').value = creds.username || '';
  refreshGrantStatus();
  refreshFleetGrant();
}

async function refreshLeonardoModels() {
  const status = $('leonardoModelsStatus');
  const btn = $('refreshLeonardoModels');
  btn.disabled = true;
  status.textContent = 'Reading models from a logged-in Leonardo tab…';
  status.style.color = 'var(--muted)';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'listLeonardoModels' });
    if (!res?.ok) throw new Error(res?.error || 'Could not read the model list.');
    const models = res.models || [];
    const added = addModelOptions(models);
    // Cache everything found so the additions survive an options-page reload.
    await saveLeonardoModels([...(await getLeonardoModels()), ...models]);
    status.textContent = added
      ? `Added ${added} new model${added === 1 ? '' : 's'} — ${models.length} found on Leonardo.`
      : `Up to date — ${models.length} found, nothing new.`;
    status.style.color = 'var(--ok)';
  } catch (e) {
    status.textContent = `Couldn't refresh: ${e.message}`;
    status.style.color = 'var(--err)';
  } finally {
    btn.disabled = false;
  }
}

let savedTimer = null;
function showSaved(msg = '✓ Saved') {
  const el = $('saved');
  el.textContent = msg;
  el.style.color = 'var(--ok)';
  el.style.fontWeight = '600';
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => (el.textContent = ''), 2500);
}

async function save() {
  const patch = {};
  for (const f of FIELDS) if ($(f)) patch[f] = typeof $(f).value === 'string' ? $(f).value.trim() : $(f).value;
  for (const f of CHECKBOX_FIELDS) if ($(f)) patch[f] = $(f).checked;
  await saveSettings(patch);
  showSaved();
}

// Auto-save each field as you edit, so there's never a "did it save?" doubt.
let autoTimer = null;
function autoSave() {
  clearTimeout(autoTimer);
  autoTimer = setTimeout(save, 400);
}

async function login() {
  const url = $('studioBaseUrl').value.trim();
  const username = $('studioUsername').value.trim();
  const password = $('studioPassword').value;
  $('loginStatus').textContent = 'Logging in…';
  try {
    await new StudioClient(url).login(username, password);
    await saveCredentials({ username, password });
    $('loginStatus').textContent = 'Logged in — session cookie set.';
    $('studioPassword').value = '';
  } catch (e) {
    $('loginStatus').textContent = `Login failed: ${e.message}`;
  }
}

// ── Host-permission self-grant (so a remote/Tailscale server works without a
// hardcoded whitelist — the user authorizes their own server URL at runtime). ──
function originPattern(url) {
  try {
    const u = new URL(url);
    // Match patterns are host-level (no port) — this covers any port on the host.
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}
function isLocalUrl(url) {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
  } catch {
    return false;
  }
}

async function refreshGrantStatus() {
  const el = $('grantStatus');
  const btn = $('grantAccess');
  const url = $('studioBaseUrl').value.trim();
  const pat = originPattern(url);
  if (!pat) {
    el.textContent = '';
    return;
  }
  if (isLocalUrl(url)) {
    el.textContent = 'Local — no grant needed.';
    el.style.color = 'var(--muted)';
    btn.disabled = true;
    return;
  }
  btn.disabled = false;
  const granted = await chrome.permissions.contains({ origins: [pat] }).catch(() => false);
  el.textContent = granted ? '✓ Access granted' : 'Not granted — click to grant.';
  el.style.color = granted ? 'var(--ok)' : 'var(--warn)';
}

async function grantAccess() {
  const url = $('studioBaseUrl').value.trim();
  const pat = originPattern(url);
  const el = $('grantStatus');
  if (!pat) {
    el.textContent = 'Enter a valid Server URL first.';
    el.style.color = 'var(--err)';
    return;
  }
  if (isLocalUrl(url)) return refreshGrantStatus();
  try {
    const granted = await chrome.permissions.request({ origins: [pat] });
    if (!granted) {
      el.textContent = 'Permission declined.';
      el.style.color = 'var(--err)';
      return;
    }
    // Quick reachability test so the user knows the URL/permission combo works.
    el.textContent = '✓ Granted — testing…';
    el.style.color = 'var(--ok)';
    try {
      await new StudioClient(url).listProjects();
      el.textContent = '✓ Access granted, server reachable.';
    } catch (e) {
      el.textContent = `✓ Granted, but server not reachable yet (${e.message}). Check it's running + you're logged in.`;
      el.style.color = 'var(--warn)';
    }
  } catch (e) {
    el.textContent = `Grant failed: ${e.message}`;
    el.style.color = 'var(--err)';
  }
}

async function refreshFleetGrant() {
  const el = $('fleetGrantStatus');
  const url = $('fleetHubUrl').value.trim();
  const pat = originPattern(url);
  if (!pat) {
    el.textContent = '';
    return;
  }
  if (isLocalUrl(url)) {
    el.textContent = 'Local — no grant needed.';
    el.style.color = 'var(--muted)';
    return;
  }
  const granted = await chrome.permissions.contains({ origins: [pat] }).catch(() => false);
  el.textContent = granted ? '✓ Access granted' : 'Not granted — click to grant.';
  el.style.color = granted ? 'var(--ok)' : 'var(--warn)';
}

async function grantFleet() {
  const url = $('fleetHubUrl').value.trim();
  const pat = originPattern(url);
  const el = $('fleetGrantStatus');
  if (!pat) {
    el.textContent = 'Enter a valid Hub URL first.';
    el.style.color = 'var(--err)';
    return;
  }
  if (isLocalUrl(url)) return refreshFleetGrant();
  try {
    const granted = await chrome.permissions.request({ origins: [pat] });
    el.textContent = granted ? '✓ Access granted.' : 'Permission declined.';
    el.style.color = granted ? 'var(--ok)' : 'var(--err)';
  } catch (e) {
    el.textContent = `Grant failed: ${e.message}`;
    el.style.color = 'var(--err)';
  }
}

$('save').onclick = save;
$('login').onclick = login;
$('grantAccess').onclick = grantAccess;
$('grantFleet').onclick = grantFleet;
$('fleetHubUrl').addEventListener('input', refreshFleetGrant);
$('refreshLeonardoModels').onclick = refreshLeonardoModels;
$('studioBaseUrl').addEventListener('input', refreshGrantStatus);
// Wire auto-save: text fields on input, selects on change.
for (const f of FIELDS) {
  const el = $(f);
  if (!el) continue;
  el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', autoSave);
}
for (const f of CHECKBOX_FIELDS) {
  const el = $(f);
  if (!el) continue;
  el.addEventListener('change', autoSave);
}
load();
