import { getSettings, saveSettings, getCredentials, saveCredentials } from '../lib/config.js';
import { StudioClient } from '../lib/story-studio.js';

const $ = (id) => document.getElementById(id);
const FIELDS = [
  'studioBaseUrl',
  'flowProjectId',
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

$('save').onclick = save;
$('login').onclick = login;
// Wire auto-save: text fields on input, selects on change.
for (const f of FIELDS) {
  const el = $(f);
  if (!el) continue;
  el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', autoSave);
}
load();
