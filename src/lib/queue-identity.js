const GENERATION_SETTING_FIELDS = ['modelId', 'aspectRatio', 'style', 'mode', 'size', 'count'];

export function normalizePrompt(prompt) {
  return String(prompt || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function generationSettingsKey(settings = {}) {
  return JSON.stringify(GENERATION_SETTING_FIELDS.map((field) => settings[field]));
}

export function projectWorkKey(item = {}) {
  return item.episodeCode && item.sceneKey != null
    ? `${item.provider || 'flow'}::${item.episodeCode}::${item.kind}::${item.source}::${item.sceneKey}`
    : null;
}

export function standaloneWorkKey(item = {}) {
  const settings = item.generationSettings ?? {
    modelId: item.modelId ?? item.model,
    aspectRatio: item.aspectRatio,
    style: item.style,
    mode: item.mode,
    size: item.size,
    count: item.count,
  };
  return `${item.provider || 'flow'}::${normalizePrompt(item.prompt)}::${item.kind}::${generationSettingsKey(settings)}`;
}

export function activeWorkKey(item = {}) {
  return item.source === 'standalone' ? standaloneWorkKey(item) : projectWorkKey(item);
}
