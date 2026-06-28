// Central defaults + settings access for the extension.
//
// The extension reads a Story Studio episode's scene plan (the per-scene image
// prompts) and generates one image per scene on Google Flow, then saves each
// with the correct scene-derived name. All live values come from
// chrome.storage.sync and are edited on the Options page / side panel.

export const DEFAULTS = {
  // Story Studio server. Server-mode default port is 8766 (auth-gated); the
  // plain desktop app serves the same API on 8000 (no auth). localhost loopback
  // bypasses auth either way, so no login is needed for a local studio.
  studioBaseUrl: 'http://localhost:8766',

  // The Google Flow project that generations are filed into. Flow's generate
  // endpoint is /v1/projects/{projectId}/... — every image needs a project.
  // Captured automatically when you open a Flow project tab (see the panel),
  // or paste a project UUID in Settings.
  flowProjectId: '',
  flowProjectName: '',

  // Generation provider: 'flow' (Google Flow) or 'grok' (xAI Grok Imagine).
  // Both are driven from a logged-in web session; Flow's Nano Banana 2 is free
  // and effectively unlimited, Grok's free Imagine has a daily limit.
  provider: 'flow',

  // Image model + aspect ratio. Nano Banana 2 is free (0 credits).
  imageModel: 'nano-banana-2', // -> internal "NARWHAL"
  aspectRatio: '16:9',

  // Video model (Veo). Costs credits (~20/clip for Fast). Used when the panel's
  // media type is "Video". Always saved to Downloads in v1.
  videoModel: 'veo-3.1-fast', // -> internal "veo_3_1_t2v_fast"

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

  // Episode-list filter: by default hide episodes whose scene images are all
  // done, so the dropdown only shows episodes that still need work. Toggle on
  // to show completed episodes too.
  showDoneEpisodes: false,

  // Last-used selections, restored when the panel reopens.
  lastProject: '',
  lastEpisode: '',
};

const STORAGE_KEY = 'settings';

export async function getSettings() {
  const stored = await chrome.storage.sync.get(STORAGE_KEY);
  return { ...DEFAULTS, ...(stored[STORAGE_KEY] || {}) };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.sync.set({ [STORAGE_KEY]: next });
  return next;
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
