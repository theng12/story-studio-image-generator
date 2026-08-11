const provider = (value) => Object.freeze(value);

export const FLOW_FALLBACK_MODELS = Object.freeze([
  Object.freeze({ id: 'nano-banana-2', internalId: 'NARWHAL', label: 'Nano Banana 2', source: 'fallback' }),
  Object.freeze({ id: 'nano-banana-2-lite', internalId: 'HARBOR_SEAL', label: 'Nano Banana 2 Lite', source: 'fallback' }),
  Object.freeze({ id: 'nano-banana-pro', internalId: 'GEM_PIX_2', label: 'Nano Banana Pro', source: 'fallback' }),
]);

export function getFlowModel(id) {
  return FLOW_FALLBACK_MODELS.find((model) => model.id === id || model.internalId === id);
}

export const PROVIDERS = Object.freeze([
  provider({
    id: 'flow',
    label: 'Google Flow',
    models: FLOW_FALLBACK_MODELS,
    workspace: { url: 'https://labs.google/fx/tools/flow', match: 'https://labs.google/fx/*' },
    scripts: null,
    contextMessage: 'flow:getContext',
    downloadHosts: [],
    settings: ['flowProjectId', 'flowProjectName', 'flowAutoNewProject', 'flowNewProjectEvery', 'imageModel', 'aspectRatio', 'flowRecaptchaMaxAttempts'],
    capabilities: {
      characterReferences: true,
      storyStudioReferences: true,
      maxReferences: 4,
      cooldown: true,
      visibleTab: true,
      modelDiscovery: false,
    },
  }),
  provider({
    id: 'aistudio',
    label: 'Google AI Studio',
    workspace: { url: 'https://aistudio.google.com/prompts/new_chat', match: 'https://aistudio.google.com/*' },
    scripts: null,
    contextMessage: 'aistudio:getContext',
    downloadHosts: [],
    settings: ['aistudioAspectRatio'],
    capabilities: {
      characterReferences: true,
      storyStudioReferences: true,
      maxReferences: 4,
      cooldown: true,
      visibleTab: true,
      modelDiscovery: false,
    },
  }),
  provider({
    id: 'qwen',
    label: 'Qwen Studio',
    workspace: { url: 'https://chat.qwen.ai/', match: 'https://chat.qwen.ai/*' },
    scripts: { main: 'src/content/qwen-main.js', isolated: 'src/content/qwen.js', mainWorld: false },
    contextMessage: 'qwen:getContext',
    downloadHosts: ['cdn.qwenlm.ai'],
    settings: ['qwenAspectRatio'],
    capabilities: {
      characterReferences: true,
      storyStudioReferences: true,
      maxReferences: 1,
      cooldown: true,
      visibleTab: true,
      modelDiscovery: false,
    },
  }),
  provider({
    id: 'leonardo',
    label: 'Leonardo AI',
    workspace: { url: 'https://app.leonardo.ai/generate', match: 'https://app.leonardo.ai/*' },
    scripts: { main: 'src/content/leonardo-main.js', isolated: 'src/content/leonardo.js', mainWorld: false },
    contextMessage: 'leonardo:getContext',
    downloadHosts: ['leonardo.ai'],
    settings: ['leonardoModel', 'leonardoStyle', 'leonardoMode', 'leonardoSize', 'leonardoCount'],
    capabilities: {
      characterReferences: true,
      storyStudioReferences: false,
      maxReferences: 0,
      cooldown: true,
      visibleTab: true,
      modelDiscovery: true,
    },
  }),
  provider({
    id: 'chatgpt',
    label: 'ChatGPT',
    workspace: { url: 'https://chatgpt.com/', match: 'https://chatgpt.com/*' },
    scripts: { main: 'src/content/chatgpt-main.js', isolated: 'src/content/chatgpt.js', mainWorld: false },
    contextMessage: 'chatgpt:getContext',
    downloadHosts: ['oaiusercontent.com'],
    settings: ['chatgptAspectRatio', 'chatgptMaxWaitSec'],
    capabilities: {
      characterReferences: true,
      storyStudioReferences: true,
      maxReferences: 4,
      cooldown: true,
      visibleTab: true,
      modelDiscovery: false,
    },
  }),
]);

export const PROVIDER_IDS = Object.freeze(PROVIDERS.map(({ id }) => id));
export const DEFAULT_PROVIDER_ID = 'flow';

export function isMaintainedProvider(id) {
  return PROVIDER_IDS.includes(id);
}

export function normalizeSelectedProvider(id) {
  return isMaintainedProvider(id) ? id : DEFAULT_PROVIDER_ID;
}

export function getProvider(id) {
  return PROVIDERS.find((provider) => provider.id === id);
}

// Keep provider limits at the worker boundary: no adapter should receive, or
// trigger downloads for, more Story Studio references than it can handle.
export function limitProviderReferences(id, references) {
  const maxReferences = getProvider(id)?.capabilities?.maxReferences || 0;
  return Array.isArray(references) ? references.slice(0, maxReferences) : [];
}
