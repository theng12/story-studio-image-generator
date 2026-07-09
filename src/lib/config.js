// Central defaults + settings access for the extension.
//
// The extension reads a Story Studio episode's scene plan (the per-scene image
// prompts) and generates one image per scene on Google Flow, then saves each
// with the correct scene-derived name. All live values come from
// chrome.storage.sync and are edited on the Options page / side panel.

export const DEFAULTS = {
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

  // Selected character whose reference sheet is attached to Flow character-scene
  // image generations (imageInputs REFERENCE). '' = none. Per project.
  characterRefId: '',
  // Quick per-run on/off for the character reference, without losing the picked
  // character. When off, no reference is applied even if one is selected.
  characterRefEnabled: true,

  // Generation provider. All providers use their visible web session/UI; only
  // Flow supports video in addition to image generation.
  provider: 'flow',

  // Pollinations: a keyless image URL API (image.pollinations.ai). It needs no
  // tab — the background worker fetches it directly, so it runs fully headless.
  // Model list changes over time (see image.pollinations.ai/models); flux is the
  // quality default and still works even when not in the anonymous list. Seed
  // blank = random per scene; a fixed number makes results reproducible. Token
  // (optional, from auth.pollinations.ai) removes the watermark + raises the
  // rate limit.
  pollinationsModel: 'flux',
  pollinationsSeed: '',
  pollinationsToken: '',

  // PicLumen (piclumen.com) — API-driven, ~10 free "Lumens"/day (1 per image).
  // Default model is "PicLumen Art V1"; its id is sent to /api/gen/create.
  piclumenModel: '23887bba-507e-4249-a0e3-6951e4027f2b',

  // Qwen has no reliable ratio control in its chat UI. Keep its preferred
  // shape separate and reinforce it with numeric + natural-language prompting.
  qwenAspectRatio: '16:9',
  // AI Studio and ChatGPT are chat-driven with no on-page ratio control, so the
  // ratio is reinforced in the prompt ("Create a 16:9 landscape image of …").
  // Each keeps its own preferred shape (same option set as Qwen).
  aistudioAspectRatio: '16:9',
  chatgptAspectRatio: '16:9',

  // Perchance remembers the last website style, which can silently contaminate
  // a batch. Force an explicit style for every queued image instead.
  perchanceStyle: 'No style',
  // Images per Perchance job. We keep only the first, so 1 is fastest; Perchance
  // is free so this is about speed, not cost. Snapped to the nearest option the
  // site offers.
  perchanceCount: 1,

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
    grok: { autoResume: false, minutes: 720, retries: 2 },
    leonardo: { autoResume: false, minutes: 720, retries: 2 },
    freegen: { autoResume: false, minutes: 60, retries: 2 },
    piclumen: { autoResume: false, minutes: 1440, retries: 2 },
    chatgpt: { autoResume: false, minutes: 1440, retries: 2 },
  },

  // Image model + aspect ratio. Nano Banana 2 is free (0 credits).
  imageModel: 'nano-banana-2', // -> internal "NARWHAL"
  aspectRatio: '16:9',

  // Video model (Veo). Costs credits. Used when the panel makes "Scene video".
  videoModel: 'veo-3.1-fast', // -> internal "veo_3_1_i2v_fast"

  // How scene video gets its still image to animate:
  //   "existing" — upload the scene's already-generated {scene_id}.png to Flow.
  //   "generate" — generate a fresh image on Flow first, then animate it.
  videoSource: 'existing',

  // Where generated scene images go:
  //   "project"  — POST back to Story Studio so the file lands in the episode's
  //                real "05 Scene Images" folder with the canonical name and the
  //                scene_plan.json is updated. Companion mode only (needs the
  //                image-ingest endpoint in story-studio-kh).
  //   "download" — save into the browser Downloads folder (works always).
  // Default to the project folder: the free image flow (Nano Banana 2 ->
  // upload-image) is verified end-to-end and is the point of the integration.
  saveTarget: 'project',

  // Downloads layout (relative to the browser Downloads dir).
  // Tokens: {project} {episodeCode} {episodeTitle} {sceneId} {sceneIndex}
  downloadSubdir: 'StoryStudioScenes/{project}/{episodeCode}',
  // Filename template (extension appended automatically).
  filenameTemplate: '{episodeCode}_{sceneId}',

  // Re-generate scenes that already have an image? Off by default (saves work
  // and, for video, credits). Scene-level (within a loaded episode).
  includeExisting: false,

  // Episode-list filter: 'todo' (still need scene images — the default so the
  // dropdown only shows work), 'done' (all images present), or 'all'. Lets you
  // tell finished episodes from pending ones without loading each to check.
  episodeFilter: 'todo',

  // Last-used selections, restored when the panel reopens.
  lastProject: '',
  lastEpisode: '',

  // Fleet Hub agent: when enabled, the background worker reports this machine's
  // queue status to the hub and obeys commands it returns (pause/resume/retry/
  // clear). agentName must be unique per machine — it's the fleet identity.
  fleetAgentEnabled: false,
  fleetHubUrl: '',
  fleetAgentName: '',
};

const STORAGE_KEY = 'settings';
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

function normalizeSettings(settings) {
  settings.flowProjectId = normalizeFlowProjectId(settings.flowProjectId);
  if (!QWEN_ASPECT_RATIOS.has(settings.qwenAspectRatio)) settings.qwenAspectRatio = DEFAULTS.qwenAspectRatio;
  if (!QWEN_ASPECT_RATIOS.has(settings.aistudioAspectRatio)) settings.aistudioAspectRatio = DEFAULTS.aistudioAspectRatio;
  if (!QWEN_ASPECT_RATIOS.has(settings.chatgptAspectRatio)) settings.chatgptAspectRatio = DEFAULTS.chatgptAspectRatio;
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
  const stored = await chrome.storage.sync.get(STORAGE_KEY);
  const original = { ...DEFAULTS, ...(stored[STORAGE_KEY] || {}) };
  const next = normalizeSettings({ ...original });
  if (JSON.stringify(next) !== JSON.stringify(original)) {
    await chrome.storage.sync.set({ [STORAGE_KEY]: next });
  }
  return next;
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = normalizeSettings({ ...current, ...patch });
  await chrome.storage.sync.set({ [STORAGE_KEY]: next });
  return next;
}

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
