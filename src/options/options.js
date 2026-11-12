import {
  requestSettings as getSettings,
  saveSettings,
  getCredentials,
  saveCredentials,
} from '../lib/config.js';
import { StudioClient } from '../lib/story-studio.js';
import { initTheme, setTheme } from '../lib/theme.js';
import { createImageGatewayWorkerId } from '../lib/gateway-worker.js';
import { FLOW_FALLBACK_MODELS } from '../lib/providers.js';

const $ = (id) => document.getElementById(id);
const FIELDS = [
  'theme',
  'studioBaseUrl',
  'flowWorkspaceUrl',
  'gatewayUrl',
  'gatewayToken',
  'gatewayWorkerId',
];
const CHECKBOX_FIELDS = ['gatewayModeEnabled'];

async function load() {
  await initTheme();
  const s = await getSettings();
  for (const f of FIELDS) if ($(f)) $(f).value = s[f] ?? '';
  for (const f of CHECKBOX_FIELDS) if ($(f)) $(f).checked = !!s[f];
  const creds = await getCredentials();
  $('studioUsername').value = creds.username || '';
  refreshGrantStatus();
  refreshFlowGrant();
  refreshGatewayFields();
  renderGatewayPrices(s);
}

// One price per Flow model. Blank means unknown, and unknown never generates.
function renderGatewayPrices(settings) {
  const box = $('gatewayPrices');
  if (!box) return;
  box.textContent = '';
  for (const model of FLOW_FALLBACK_MODELS) {
    const field = document.createElement('label');
    field.className = 'field';
    field.textContent = model.label;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.step = '1';
    input.dataset.model = model.internalId;
    input.placeholder = 'unknown';
    const stored = settings.gatewayImageCreditCosts?.[model.internalId] ?? settings.gatewayImageCreditCosts?.[model.id];
    input.value = Number.isFinite(stored) ? String(stored) : '';
    input.addEventListener('input', () => { refreshPriceStatus(); autoSave(); });
    field.appendChild(input);
    box.appendChild(field);
  }
  refreshPriceStatus();
}

// The rule we enforce is the rule we show: an unset price is free, not unpriced.
function refreshPriceStatus() {
  const status = $('gatewayPriceStatus');
  if (!status) return;
  const declared = Object.entries(gatewayPricePatch());
  if (!declared.length) {
    status.textContent = 'Priced as free: no price is set, so every image job quotes 0 credits and can claim.';
    return;
  }
  const label = (id) => FLOW_FALLBACK_MODELS.find((model) => model.internalId === id)?.label || id;
  status.textContent = `Priced from your settings, not from Flow: ${declared.map(([id, credits]) => `${label(id)} = ${credits} credits`).join(', ')}.`;
}

function gatewayPricePatch() {
  const costs = {};
  for (const input of document.querySelectorAll('#gatewayPrices input[data-model]')) {
    const raw = input.value.trim();
    if (raw === '') continue;
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0) costs[input.dataset.model] = value;
  }
  return costs;
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
  if ($('gatewayPrices')) patch.gatewayImageCreditCosts = gatewayPricePatch();
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

async function refreshFlowGrant() {
  const el = $('flowGrantStatus');
  const pat = originPattern($('flowWorkspaceUrl').value.trim());
  if (!pat) {
    el.textContent = 'Enter a full https:// address.';
    el.style.color = 'var(--warn)';
    return;
  }
  const granted = await chrome.permissions.contains({ origins: [pat] }).catch(() => false);
  el.textContent = granted ? '✓ Access granted' : 'Not granted — click to grant.';
  el.style.color = granted ? 'var(--ok)' : 'var(--warn)';
}

async function grantFlow() {
  const el = $('flowGrantStatus');
  const pat = originPattern($('flowWorkspaceUrl').value.trim());
  if (!pat) return refreshFlowGrant();
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
$('testConnection').onclick = testConnection;
$('grantFlow').onclick = grantFlow;
$('flowWorkspaceUrl').addEventListener('input', refreshFlowGrant);
$('studioBaseUrl').addEventListener('input', refreshGrantStatus);

// ── Gateway Studio image worker settings ────────────────────────────────────
function refreshGatewayFields() {
 const enabled = $('gatewayModeEnabled')?.checked;
 const fields = $('gatewayFields');
 if (fields) fields.classList.toggle('hidden', !enabled);
}

async function generateGatewayId() {
 const id = createImageGatewayWorkerId();
 if ($('gatewayWorkerId')) $('gatewayWorkerId').value = id;
 await autoSave();
}

async function testGatewayConnection() {
 const status = $('gatewayTestStatus');
 if (!status) return;
 status.textContent = 'Testing Gateway connection…';
 status.style.color = 'var(--muted)';
 await save();
 try {
 const result = await chrome.runtime.sendMessage({ type: 'gateway:testConnection' });
 if (result?.ok) {
 status.textContent = `Gateway connected. ${Number.isFinite(result.balance?.value) ? `${result.balance.value} credits remaining.` : 'Remaining credits unknown.'} Upload limit: ${result.maxResultBytes} bytes. Select Gateway Studio in the side panel to receive jobs.`;
 status.style.color = 'var(--ok)';
 } else {
 status.textContent = result?.error || 'Couldn’t connect to Gateway.';
 status.style.color = 'var(--err)';
 }
 } catch (error) {
 status.textContent = `Couldn’t connect: ${error.message}`;
 status.style.color = 'var(--err)';
 }
}

if ($('gatewayModeEnabled')) $('gatewayModeEnabled').addEventListener('change', () => { refreshGatewayFields(); autoSave(); });
if ($('generateGatewayWorkerId')) $('generateGatewayWorkerId').onclick = generateGatewayId;
if ($('testGateway')) $('testGateway').onclick = testGatewayConnection;
if ($('grantGateway')) $('grantGateway').onclick = async () => {
  const status = $('gatewayTestStatus');
  const pattern = originPattern($('gatewayUrl').value.trim());
  if (!pattern || !/^https?:/.test(pattern)) { status.textContent = 'Enter an HTTP or HTTPS Gateway address first.'; return; }
  try {
    const granted = await chrome.permissions.request({ origins: [pattern] });
    status.textContent = granted ? 'Access granted. Test the connection next.' : 'Access was not granted.';
  } catch { status.textContent = 'Could not grant access. Check the Gateway address.'; }
};
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
