import { getSettings, saveSettings, getCredentials, saveCredentials } from '../lib/config.js';
import { StudioClient } from '../lib/story-studio.js';

const $ = (id) => document.getElementById(id);
const FIELDS = [
  'studioBaseUrl',
  'flowProjectId',
  'imageModel',
  'videoModel',
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

async function save() {
  const patch = {};
  for (const f of FIELDS) if ($(f)) patch[f] = $(f).value.trim();
  await saveSettings(patch);
  $('saved').textContent = 'Saved.';
  setTimeout(() => ($('saved').textContent = ''), 1500);
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
load();
