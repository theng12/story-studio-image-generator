import { getSettings, saveSettings, getCredentials, saveCredentials } from '../lib/config.js';
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
  'humanDelayMinSec',
  'humanDelayMaxSec',
  'imageModel',
  'videoModel',
  'videoSource',
  'aspectRatio',
  'saveTarget',
  'downloadSubdir',
  'filenameTemplate',
];

async function load() {
  const s = await getSettings();
  for (const f of FIELDS) if ($(f)) $(f).value = s[f] ?? '';
  const creds = await getCredentials();
  $('studioUsername').value = creds.username || '';
  refreshGrantStatus();
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

$('save').onclick = save;
$('login').onclick = login;
$('grantAccess').onclick = grantAccess;
$('studioBaseUrl').addEventListener('input', refreshGrantStatus);
// Wire auto-save: text fields on input, selects on change.
for (const f of FIELDS) {
  const el = $(f);
  if (!el) continue;
  el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', autoSave);
}
load();
