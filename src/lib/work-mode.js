// Exactly two shipped modes. Stored values are local-storage data from older
// releases, so 'studio' and anything unknown move to Standalone (the default).
export const WORK_MODES = Object.freeze(['standalone', 'gateway']);
export const DEFAULT_WORK_MODE = 'standalone';
export const WORK_MODE_KEY = 'imageGeneratorWorkMode';

export function normalizeWorkMode(value) {
  return value === 'gateway' ? 'gateway' : DEFAULT_WORK_MODE;
}

export async function readWorkMode() {
  const stored = (await chrome.storage.local.get(WORK_MODE_KEY))[WORK_MODE_KEY];
  const mode = normalizeWorkMode(stored);
  if (stored !== mode) await chrome.storage.local.set({ [WORK_MODE_KEY]: mode });
  return mode;
}

export async function writeWorkMode(value) {
  const mode = normalizeWorkMode(value);
  await chrome.storage.local.set({ [WORK_MODE_KEY]: mode });
  return mode;
}
