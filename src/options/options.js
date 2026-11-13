import {
  requestSettings as getSettings,
  saveSettings,
  flowWorkspace,
} from '../lib/config.js';
import { initTheme } from '../lib/theme.js';
import { createImageGatewayWorkerId } from '../lib/gateway-worker.js';
import { FLOW_FALLBACK_MODELS } from '../lib/providers.js';
import { readWorkMode, writeWorkMode } from '../lib/work-mode.js';

const $ = (id) => document.getElementById(id);
const FIELDS = ['gatewayUrl', 'gatewayToken', 'gatewayWorkerId'];
const CHECKBOX_FIELDS = ['gatewayModeEnabled'];
// Advanced fallback ids; discovery on the live page wins, these only fill a miss.
const RPC_FIELDS = { rpcIdAccount: 'account', rpcIdCredits: 'credits', rpcIdGenerate: 'generate', rpcIdUpload: 'upload' };

async function load() {
  await initTheme();
  const s = await getSettings();
  for (const f of FIELDS) if ($(f)) $(f).value = s[f] ?? '';
  for (const f of CHECKBOX_FIELDS) if ($(f)) $(f).checked = !!s[f];
  for (const [id, name] of Object.entries(RPC_FIELDS)) if ($(id)) $(id).value = s.rpcIds?.[name] || '';
  await loadMode();
  refreshVisibility();
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
  const rpcIds = {};
  for (const [id, name] of Object.entries(RPC_FIELDS)) {
    const value = ($(id)?.value || '').trim();
    if (value) rpcIds[name] = value;
  }
  patch.rpcIds = { ...(await getSettings()).rpcIds, ...rpcIds };
  await saveSettings(patch);
  showSaved();
}

// Auto-save each field as you edit, so there's never a "did it save?" doubt.
let autoTimer = null;
function autoSave() {
  clearTimeout(autoTimer);
  autoTimer = setTimeout(save, 400);
}

// ── Host-permission self-grant (so a remote Gateway works without a hardcoded whitelist) ──
function originPattern(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

const MODE_KEY = 'imageGeneratorWorkMode';

async function loadMode() {
  if ($('workingMode')) $('workingMode').value = await readWorkMode();
}

function refreshVisibility() {
  const fields = $('gatewayFields');
  if (fields) fields.classList.toggle('hidden', !$('gatewayModeEnabled')?.checked);
}

async function saveMode() {
  if ($('workingMode')) await writeWorkMode($('workingMode').value);
  refreshVisibility();
  await requestFlowAccess();
}

async function requestFlowAccess() {
  // The Flow address is fixed, so its host permission is asked for here instead
  // of from a separate address field and grant button.
  await chrome.permissions.request({ origins: [`${flowWorkspace().origin}/*`] }).catch(() => false);
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

if ($('workingMode')) $('workingMode').addEventListener('change', () => { saveMode(); });
if ($('gatewayModeEnabled')) $('gatewayModeEnabled').addEventListener('change', () => { refreshVisibility(); requestFlowAccess(); autoSave(); });
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
    autoSave();
  });
}
for (const f of CHECKBOX_FIELDS) {
  const el = $(f);
  if (!el) continue;
  el.addEventListener('change', autoSave);
}
load();
