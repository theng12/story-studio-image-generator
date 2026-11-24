// Central defaults + settings access for the extension.
//
// The extension reads a Story Studio episode's scene plan (the per-scene image
// prompts) and generates one image per scene on a maintained web provider, then
// saves each with the correct scene-derived name. All live values come from
// chrome.storage.sync and are edited on the Options page / side panel.

import { normalizeSelectedProvider } from './providers.js';

// Google Flow's address is fixed; the setting key stays readable for compatibility.
export const FLOW_WORKSPACE_URL = 'https://flow.google.com';

// Known-good Flow RPC ids: a fallback data value, editable in Settings, never a code constant.
// Only the ids the resolver reads (see rpc-ids.js RPC_NAMES) belong here.
export const FLOW_RPC_DEFAULTS = {
  generate: 'ogiZ0b',
  upload: 'maseQ',
};

export const DEFAULTS = {
  // Shared presentation preference across the Story Studio generators.
  theme: 'system',

  // The Google Flow project that generations are filed into. Flow's generate
  // endpoint is /v1/projects/{projectId}/... — every image needs a project.
  // Captured automatically when you open a Flow project tab (see the panel),
  // or paste a project UUID in Settings.
  flowProjectId: '',
  flowProjectName: '',
  // Where Google Flow lives. Google moved it once already (labs.google/fx →
  // flow.google.com); the next move is a Settings edit, not a release.
  flowWorkspaceUrl: FLOW_WORKSPACE_URL,

  // A Flow project accumulates every generated image and gets heavy over time, so
  // roll over to a fresh project automatically after this many images (0 or the
  // toggle off = never; the panel also has a manual "New project" button).
  flowAutoNewProject: false,
  flowNewProjectEvery: 300,

  // Generation provider. Every provider in this extension is image-only.
  provider: 'flow',
  rpcIds: { ...FLOW_RPC_DEFAULTS },

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
  humanDelayMaxSec: 15,

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
  imageModel: 'nano-banana-2', // -> internal "BELUGA"
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

  // Gateway Studio image worker (second mode beside Standalone). Off by default;
  // the user opts in by filling URL + token + worker id. Health test is
  // user-triggered only.
  gatewayModeEnabled: false,
  gatewayUrl: '',
  gatewayToken: '',
  gatewayWorkerId: '',
  // What the user says one image costs, keyed by Flow model id. Flow images are
  // free, so an unset model is quoted at 0 credits — a real price, not "unknown".
  // Set a model here only to declare something else.
  gatewayImageCreditCosts: {},
};

const STORAGE_KEY = 'settings';
const PROVIDER_SECRETS_KEY = 'providerSecrets';
const GATEWAY_CONNECTION_KEY = 'gatewayConnection';
const GATEWAY_LOCAL_FIELDS = ['gatewayModeEnabled', 'gatewayUrl', 'gatewayToken', 'gatewayWorkerId'];
const QWEN_ASPECT_RATIOS = new Set(['16:9', '9:16', '1:1', '4:3', '3:4']);

function normalizeDelay(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, number);
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

function normalizeRpcIds(value) {
  const next = { ...FLOW_RPC_DEFAULTS };
  for (const name of Object.keys(FLOW_RPC_DEFAULTS)) {
    const id = typeof value?.[name] === 'string' ? value[name].trim() : '';
    if (id) next[name] = id.slice(0, 32);
  }
  return next;
}
export function normalizeSettings(settings) {
  settings = { ...settings };
  settings.provider = normalizeSelectedProvider(settings.provider);
  // Studio mode was removed; drop its settings instead of carrying them forward.
  delete settings.studioBaseUrl;
  delete settings.storyStudioReferencesEnabled;
  delete settings.characterRefEnabled;
  delete settings.characterRefId;
  delete settings.pollinationsToken;
  delete settings.pollinationsModel;
  delete settings.pollinationsSeed;
  delete settings.piclumenModel;
  delete settings.perchanceStyle;
  delete settings.perchanceCount;
  const costs = settings.gatewayImageCreditCosts && typeof settings.gatewayImageCreditCosts === 'object'
    ? settings.gatewayImageCreditCosts : {};
  settings.gatewayImageCreditCosts = Object.fromEntries(Object.entries(costs)
    .filter(([key, value]) => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(key) && Number.isFinite(Number(value)) && Number(value) >= 0)
    .map(([key, value]) => [key, Number(value)]));
  settings.flowProjectId = normalizeFlowProjectId(settings.flowProjectId);
  settings.flowWorkspaceUrl = normalizeFlowWorkspaceUrl(settings.flowWorkspaceUrl);
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
  settings.rpcIds = normalizeRpcIds(settings.rpcIds);
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

// The Flow address is fixed; the stored key stays readable for compatibility.
export function normalizeFlowWorkspaceUrl() {
  return FLOW_WORKSPACE_URL;
}
export function flowWorkspace() {
  const origin = FLOW_WORKSPACE_URL;
  return { origin, url: `${origin}/`, match: `${origin}/*`, project: (id) => `${origin}/project/${id}` };
}

export async function getSettings() {
  const [synced, local] = await Promise.all([
    chrome.storage.sync.get(STORAGE_KEY),
    chrome.storage.local.get([PROVIDER_SECRETS_KEY, GATEWAY_CONNECTION_KEY]),
  ]);
  const storedSettings = { ...(synced[STORAGE_KEY] || {}) };
  const gateway = { ...(local[GATEWAY_CONNECTION_KEY] || {}) };
  for (const key of GATEWAY_LOCAL_FIELDS) {
    if (!Object.hasOwn(gateway, key) && Object.hasOwn(storedSettings, key)) gateway[key] = storedSettings[key];
    delete storedSettings[key];
  }
  if (JSON.stringify(gateway) !== JSON.stringify(local[GATEWAY_CONNECTION_KEY] || {})) {
    await chrome.storage.local.set({ [GATEWAY_CONNECTION_KEY]: gateway });
  }
  const secrets = { ...(local[PROVIDER_SECRETS_KEY] || {}) };
  if (Object.hasOwn(secrets, 'pollinationsToken')) {
    delete secrets.pollinationsToken;
    await chrome.storage.local.set({ [PROVIDER_SECRETS_KEY]: secrets });
  }
  const next = normalizeSettings({ ...DEFAULTS, ...storedSettings, ...gateway });
  const syncNext = { ...next };
  for (const key of GATEWAY_LOCAL_FIELDS) delete syncNext[key];
  if (JSON.stringify(syncNext) !== JSON.stringify(synced[STORAGE_KEY] || {})) {
    await chrome.storage.sync.set({ [STORAGE_KEY]: syncNext });
  }
  // Retired Story Studio connection data is never read again.
  await chrome.storage.local.remove?.(['studioCredentials', 'imageGeneratorStudioConnection']);
  return next;
}

export async function persistSettings(next) {
  next = normalizeSettings({ ...DEFAULTS, ...next });
  const syncNext = { ...next };
  const gateway = {};
  for (const key of GATEWAY_LOCAL_FIELDS) {
    gateway[key] = next[key];
    delete syncNext[key];
  }
  await chrome.storage.local.set({ [GATEWAY_CONNECTION_KEY]: gateway });
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
