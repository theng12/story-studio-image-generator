import {
  requestSettings as getSettings,
  saveSettings,
  getCredentials,
  saveCredentials,
} from '../lib/config.js';
import { StudioClient } from '../lib/story-studio.js';
import { initTheme, setTheme } from '../lib/theme.js';

const $ = (id) => document.getElementById(id);
const FIELDS = [
  'theme',
  'studioBaseUrl',
  'fleetHubUrl',
  'fleetAgentName',
  'fleetSharedSecret',
];
const CHECKBOX_FIELDS = ['fleetAgentEnabled', 'fleetTelemetryEnabled', 'fleetQueueControlEnabled'];

async function load() {
  await initTheme();
  const s = await getSettings();
  for (const f of FIELDS) if ($(f)) $(f).value = s[f] ?? '';
  for (const f of CHECKBOX_FIELDS) if ($(f)) $(f).checked = !!s[f];
  const creds = await getCredentials();
  $('studioUsername').value = creds.username || '';
  refreshGrantStatus();
  refreshFleetGrant();
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
  $('loginStatus').textContent = 'Signing in…';
  try {
    await new StudioClient(url).login(username, password);
    await saveCredentials({ username, password });
    $('loginStatus').textContent = '✓ Signed in — this browser session is ready.';
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

async function testConnection() {
  const url = $('studioBaseUrl').value.trim();
  const status = $('testStatus');
  status.textContent = 'Testing connection…';
  status.style.color = 'var(--muted)';
  if (!url) {
    status.textContent = 'Enter a Server URL first.';
    status.style.color = 'var(--err)';
    return;
  }
  if (!isLocalUrl(url)) {
    const pat = originPattern(url);
    const granted = pat && await chrome.permissions.contains({ origins: [pat] }).catch(() => false);
    if (!granted) {
      status.textContent = 'Grant access to this server first, then test again.';
      status.style.color = 'var(--warn)';
      return;
    }
  }
  try {
    const projects = await new StudioClient(url).listProjects();
    const count = Array.isArray(projects) ? projects.length : (projects?.projects || []).length;
    status.textContent = `✓ Connected — ${count} project${count === 1 ? '' : 's'} found.`;
    status.style.color = 'var(--ok)';
  } catch (error) {
    status.textContent = `Couldn’t connect: ${error.message}. ${isLocalUrl(url) ? 'Is Story Studio running?' : 'Check the server, access grant, and sign-in.'}`;
    status.style.color = 'var(--err)';
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

async function testFleet() {
  const status = $('fleetTestStatus');
  status.textContent = 'Testing Hub connection…';
  status.style.color = 'var(--muted)';
  // Persist the form first: the worker deliberately reads only local settings
  // when constructing the authenticated test heartbeat.
  await save();
  try {
    const result = await chrome.runtime.sendMessage({ type: 'fleet:testConnection' });
    if (result?.ok) {
      status.textContent = `✓ Authenticated Hub connection${result.commands ? ` (${result.commands} command${result.commands === 1 ? '' : 's'} ignored during test)` : ''}.`;
      status.style.color = 'var(--ok)';
    } else {
      status.textContent = result?.error || 'Couldn’t connect to the Hub.';
      status.style.color = 'var(--err)';
    }
  } catch (error) {
    status.textContent = `Couldn’t connect: ${error.message}`;
    status.style.color = 'var(--err)';
  }
}

$('save').onclick = save;
$('login').onclick = login;
$('grantAccess').onclick = grantAccess;
$('testConnection').onclick = testConnection;
$('grantFleet').onclick = grantFleet;
$('testFleet').onclick = testFleet;
$('fleetHubUrl').addEventListener('input', refreshFleetGrant);
$('studioBaseUrl').addEventListener('input', refreshGrantStatus);
// Wire auto-save: text fields on input, selects on change.
for (const f of FIELDS) {
  const el = $(f);
  if (!el) continue;
  el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => {
    if (f === 'theme') setTheme(el.value);
    autoSave();
  });
}
for (const f of CHECKBOX_FIELDS) {
  const el = $(f);
  if (!el) continue;
  el.addEventListener('change', autoSave);
}
load();
