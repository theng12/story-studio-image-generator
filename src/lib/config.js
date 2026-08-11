// Central defaults + settings access for the extension.
//
// The extension reads a Story Studio episode's scene plan (the per-scene image
// prompts) and generates one image per scene on a maintained web provider, then
// saves each with the correct scene-derived name. All live values come from
// chrome.storage.sync and are edited on the Options page / side panel.

import { normalizeSelectedProvider } from './providers.js';

export const DEFAULTS = {
  // Shared presentation preference across the Story Studio generators.
  theme: 'system',

  // Story Studio server. Default port 8766, but fully editable — set this to a
  // localhost URL (any port; loopback bypasses auth) or a remote/Tailscale URL
  // like http://mac-mini.tailXXXX.ts.net:8766 (needs Grant access + login).
  studioBaseUrl: 'http://localhost:8766',

  // The Google Flow project that generations are filed into. Flow's generate
  // endpoint is /v1/projects/{projectId}/... — every image needs a project.
  // Captured automatically when you open a Flow project tab (see the panel),
  // or paste a project UUID in Settings.
  flowProjectId: '',
  flowProjectName: '',

  // A Flow project accumulates every generated image and gets heavy over time, so
  // roll over to a fresh project automatically after this many images (0 or the
  // toggle off = never; the panel also has a manual "New project" button).
  flowAutoNewProject: false,
  flowNewProjectEvery: 300,

  // Use the Story Studio reference resolver for queued image generations.
  storyStudioReferencesEnabled: true,

  // Generation provider. Every provider in this extension is image-only.
  provider: 'flow',

  // Qwen has no reliable ratio control in its chat UI. Keep its preferred
  // shape separate and reinforce it with numeric + natural-language prompting.
  qwenAspectRatio: '16:9',
  // AI Studio and ChatGPT are chat-driven with no on-page ratio control, so the
  // ratio is reinforced in the prompt ("Create a 16:9 landscape image of …").
  // Each keeps its own preferred shape (same option set as Qwen).
  aistudioAspectRatio: '16:9',
  chatgptAspectRatio: '16:9',
  // How long to wait for one ChatGPT image before giving up. The wait is
  // progress-aware (it won't cut off while ChatGPT is actively generating), so
  // this is the hard ceiling for a genuinely slow-but-working image. Minutes ×60.
  chatgptMaxWaitSec: 480,

  // Leonardo controls vary by model and account tier. These defaults are
  // available on the free plan and minimize token use per generated image.
  leonardoModel: 'phoenix-v1.0',
  leonardoStyle: 'Dynamic',
  leonardoMode: 'FAST',
  leonardoSize: 'SMALL',
  // Images generated per scene. Free plans are locked to 4 (we keep only the
  // first anyway); paid plans allow 1–8. Default 1 so metered premium models
  // aren't charged 4× for images we discard. Applied only when the control is
  // available — skipped silently when the plan locks it.
  leonardoCount: 1,

  // Human-paced gap between provider requests. A fresh random value in this
  // inclusive range is persisted after every attempt, surviving worker death.
  humanDelayMinSec: 5,
  humanDelayMaxSec: 60,

  // Flow remints a fresh reCAPTCHA token this many times within a single
  // generation before giving up. Distinct from the per-provider auto-resume
  // cooldown below (which governs the queue after a limit/failure).
  flowRecaptchaMaxAttempts: 4,

  // Per-provider auto-resume. Default OFF everywhere (manual Resume = prior
  // behavior). `minutes` is the recommended cooldown shown when a toggle is
  // switched on — editable by the user. `retries` = queue-level re-attempts on
  // a non-limit failure before the item is marked failed (only while autoResume
  // is on). Only providers with real limit detection are listed.
  providerCooldowns: {
    flow: { autoResume: false, minutes: 15, retries: 2 },
    qwen: { autoResume: false, minutes: 480, retries: 2 },
    aistudio: { autoResume: false, minutes: 720, retries: 2 },
    leonardo: { autoResume: false, minutes: 720, retries: 2 },
    chatgpt: { autoResume: false, minutes: 1440, retries: 2 },
  },

  // Image model + aspect ratio. Nano Banana 2 is free (0 credits).
  imageModel: 'nano-banana-2', // -> internal "NARWHAL"
  aspectRatio: '16:9',

  // Re-generate scenes that already have an image? Off by default.
  includeExisting: false,

  // Episode-list filter: 'todo' (still need scene images — the default so the
  // dropdown only shows work), 'done' (all images present), or 'all'. Lets you
  // tell finished episodes from pending ones without loading each to check.
  episodeFilter: 'todo',

  // Last-used selections, restored when the panel reopens.
  lastProject: '',
  lastEpisode: '',

  // Fleet Hub v2: identity and secrets stay local; this synced portion contains
  // only the user's explicit participation/consent choices and display name.
  // The Hub may observe the queue only when telemetry consent is on, and may
  // request the small safe-control set only when queue-control consent is on.
  fleetAgentEnabled: false,
  fleetTelemetryEnabled: false,
  fleetQueueControlEnabled: false,
  fleetHubUrl: '',
  fleetAgentName: '',
};

const STORAGE_KEY = 'settings';
const PROVIDER_SECRETS_KEY = 'providerSecrets';
const QWEN_ASPECT_RATIOS = new Set(['16:9', '9:16', '1:1', '4:3', '3:4']);

function normalizeDelay(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(3600, Math.max(0, Math.round(number)));
}

function normalizeCooldownMinutes(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(1440, Math.max(1, Math.round(number)));
}

function normalizeRecaptchaAttempts(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(10, Math.max(1, Math.round(number)));
}

function normalizeRetries(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(10, Math.max(0, Math.round(number)));
}

// Per-provider auto-resume config. Ensures every covered provider exists and is
// clamped. Auto-resume defaults off (manual-first) and the recommended minutes
// come from DEFAULTS; the user tunes them per provider when they opt in.
function normalizeProviderCooldowns(settings) {
  const stored = settings.providerCooldowns || {};
  const out = {};
  for (const [provider, def] of Object.entries(DEFAULTS.providerCooldowns)) {
    const cur = stored[provider] || {};
    out[provider] = {
      autoResume: cur.autoResume === true,
      minutes: normalizeCooldownMinutes(cur.minutes, def.minutes),
      retries: normalizeRetries(cur.retries, def.retries),
    };
  }
  settings.providerCooldowns = out;
  // Drop the retired flat keys so they don't linger in sync storage.
  delete settings.flowRecaptchaAutoPause;
  delete settings.flowRecaptchaCooldownMin;
  delete settings.qwenAutoResume;
  delete settings.qwenQuotaCooldownHours;
}

export function normalizeSettings(settings) {
  settings = { ...settings };
  settings.provider = normalizeSelectedProvider(settings.provider);
  if (settings.characterRefEnabled === false) settings.storyStudioReferencesEnabled = false;
  else if (settings.storyStudioReferencesEnabled !== false) settings.storyStudioReferencesEnabled = true;
  delete settings.characterRefEnabled;
  delete settings.characterRefId;
  delete settings.pollinationsToken;
  delete settings.pollinationsModel;
  delete settings.pollinationsSeed;
  delete settings.piclumenModel;
  delete settings.perchanceStyle;
  delete settings.perchanceCount;
  settings.flowProjectId = normalizeFlowProjectId(settings.flowProjectId);
  if (!QWEN_ASPECT_RATIOS.has(settings.qwenAspectRatio)) settings.qwenAspectRatio = DEFAULTS.qwenAspectRatio;
  if (!QWEN_ASPECT_RATIOS.has(settings.aistudioAspectRatio)) settings.aistudioAspectRatio = DEFAULTS.aistudioAspectRatio;
  if (!QWEN_ASPECT_RATIOS.has(settings.chatgptAspectRatio)) settings.chatgptAspectRatio = DEFAULTS.chatgptAspectRatio;
  {
    const n = Math.round(Number(settings.chatgptMaxWaitSec));
    // Clamp 60s–900s (1–15 min); the bridge safety-net timeout sits above this.
    settings.chatgptMaxWaitSec = Number.isFinite(n) ? Math.min(900, Math.max(60, n)) : DEFAULTS.chatgptMaxWaitSec;
  }
  const first = normalizeDelay(settings.humanDelayMinSec, DEFAULTS.humanDelayMinSec);
  const second = normalizeDelay(settings.humanDelayMaxSec, DEFAULTS.humanDelayMaxSec);
  settings.humanDelayMinSec = Math.min(first, second);
  settings.humanDelayMaxSec = Math.max(first, second);
  settings.flowRecaptchaMaxAttempts = normalizeRecaptchaAttempts(
    settings.flowRecaptchaMaxAttempts,
    DEFAULTS.flowRecaptchaMaxAttempts
  );
  normalizeProviderCooldowns(settings);
  return settings;
}

export function providerCooldown(settings, provider) {
  return settings?.providerCooldowns?.[provider] || { autoResume: false, minutes: 15, retries: 0 };
}

// Accept either the bare UUID or a copied Flow project URL. Keeping this at
// the settings boundary prevents a URL from becoming part of the API path.
export function normalizeFlowProjectId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const match = raw.match(/(?:\/project\/)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i);
  return match ? match[1].toLowerCase() : raw;
}

export async function getSettings() {
  const [synced, local] = await Promise.all([
    chrome.storage.sync.get(STORAGE_KEY),
    chrome.storage.local.get(PROVIDER_SECRETS_KEY),
  ]);
  const storedSettings = { ...(synced[STORAGE_KEY] || {}) };
  const secrets = { ...(local[PROVIDER_SECRETS_KEY] || {}) };
  if (Object.hasOwn(secrets, 'pollinationsToken')) {
    delete secrets.pollinationsToken;
    await chrome.storage.local.set({ [PROVIDER_SECRETS_KEY]: secrets });
  }
  delete storedSettings.fleetSharedSecret;
  const next = normalizeSettings({ ...DEFAULTS, ...storedSettings });
  const syncNext = { ...next };
  if (JSON.stringify(syncNext) !== JSON.stringify(synced[STORAGE_KEY] || {})) {
    await chrome.storage.sync.set({ [STORAGE_KEY]: syncNext });
  }
  return {
    ...next,
    fleetSharedSecret: secrets.fleetSharedSecret || '',
  };
}

export async function persistSettings(next, patch = {}) {
  next = normalizeSettings({ ...DEFAULTS, ...next });
  if (Object.prototype.hasOwnProperty.call(patch, 'fleetSharedSecret')) {
    const local = await chrome.storage.local.get(PROVIDER_SECRETS_KEY);
    const secrets = { ...(local[PROVIDER_SECRETS_KEY] || {}) };
    const secret = String(patch.fleetSharedSecret || '').trim();
    if (secret) secrets.fleetSharedSecret = secret;
    else delete secrets.fleetSharedSecret;
    await chrome.storage.local.set({ [PROVIDER_SECRETS_KEY]: secrets });
  }
  const syncNext = { ...next };
  delete syncNext.fleetSharedSecret;
  await chrome.storage.sync.set({ [STORAGE_KEY]: syncNext });
  return next;
}

async function settingsMessage(type, patch) {
  const response = await chrome.runtime.sendMessage({ type, ...(patch ? { patch } : {}) });
  if (!response?.ok) throw new Error(response?.error || 'The background settings owner did not respond.');
  return response.settings;
}

export const requestSettings = () => settingsMessage('settings:get');
export const saveSettings = (patch) => settingsMessage('settings:patch', patch);

// Leonardo's model catalogue, read live from the site (Options → "Refresh
// models") so new models appear without a code change. Kept in LOCAL storage:
// it's regenerable derived data, not a user setting, and account-specific.
// Shape: [{ id, label, badge }] where id is Leonardo's own model data-testid.
const LEONARDO_MODELS_KEY = 'leonardoModels';

export async function getLeonardoModels() {
  const stored = await chrome.storage.local.get(LEONARDO_MODELS_KEY);
  return stored[LEONARDO_MODELS_KEY] || [];
}

export async function saveLeonardoModels(models) {
  const byId = new Map();
  for (const m of models) if (m?.id) byId.set(m.id, { id: m.id, label: m.label || m.id, badge: m.badge || '' });
  await chrome.storage.local.set({ [LEONARDO_MODELS_KEY]: [...byId.values()] });
}

// Story Studio login, stored in LOCAL storage (not synced across machines).
// Only needed for a remote/tailnet server — localhost bypasses auth entirely.
const CRED_KEY = 'studioCredentials';

export async function getCredentials() {
  const stored = await chrome.storage.local.get(CRED_KEY);
  return stored[CRED_KEY] || { username: '', password: '' };
}

export async function saveCredentials({ username, password }) {
  await chrome.storage.local.set({ [CRED_KEY]: { username, password } });
}
