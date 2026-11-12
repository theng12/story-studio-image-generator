import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, getSettings, normalizeSettings, normalizeFlowWorkspaceUrl, flowWorkspace } from '../src/lib/config.js';

test('pacing defaults to 5–15s while normalization preserves custom values and explicit zero', () => {
  const defaults = normalizeSettings({});
  assert.deepEqual([defaults.humanDelayMinSec, defaults.humanDelayMaxSec], [5, 15]);
  for (const [min, max, expected] of [[0, 0, [0, 0]], [5, 60, [5, 60]], [23, 7, [7, 23]], ['0', '0', [0, 0]], [0.25, 0.75, [0.25, 0.75]], [7200, 7200, [7200, 7200]]]) {
    const settings = normalizeSettings({ ...DEFAULTS, humanDelayMinSec: min, humanDelayMaxSec: max });
    assert.deepEqual([settings.humanDelayMinSec, settings.humanDelayMaxSec], expected);
  }
});

test('normalizes removed provider selections to Flow', () => {
  const settings = normalizeSettings({ ...DEFAULTS, provider: 'piclumen' });

  assert.equal(settings.provider, 'flow');
});

test('preserves maintained provider settings while removing obsolete cooldowns', () => {
  const settings = normalizeSettings({
    ...DEFAULTS,
    provider: 'leonardo',
    leonardoModel: 'custom-model',
    providerCooldowns: {
      grok: { autoResume: true, minutes: 10, retries: 1 },
      flow: { autoResume: true, minutes: 9999, retries: 99 },
      chatgpt: { autoResume: true, minutes: 0, retries: -4 },
    },
  });

  assert.equal(settings.provider, 'leonardo');
  assert.equal(settings.leonardoModel, 'custom-model');
  assert.deepEqual(Object.keys(settings.providerCooldowns), ['flow', 'qwen', 'aistudio', 'leonardo', 'chatgpt']);
  assert.equal(settings.providerCooldowns.flow.minutes, 1440);
  assert.equal(settings.providerCooldowns.flow.retries, 10);
  assert.equal(settings.providerCooldowns.chatgpt.minutes, 1);
  assert.equal(settings.providerCooldowns.chatgpt.retries, 0);
  assert.equal(Object.hasOwn(settings.providerCooldowns, 'grok'), false);
});

test('migrates the legacy character reference toggle to Story Studio references', () => {
  const disabled = normalizeSettings({ ...DEFAULTS, characterRefEnabled: false });
  const enabled = normalizeSettings({ ...DEFAULTS, characterRefEnabled: true });

  assert.equal(disabled.storyStudioReferencesEnabled, false);
  assert.equal(enabled.storyStudioReferencesEnabled, true);
  assert.equal(Object.hasOwn(disabled, 'characterRefEnabled'), false);
  assert.equal(Object.hasOwn(enabled, 'characterRefEnabled'), false);
});

test('does not mutate the input settings during normalization', () => {
  const input = structuredClone({
    ...DEFAULTS,
    provider: 'grok',
    characterRefEnabled: false,
    providerCooldowns: {
      grok: { autoResume: true, minutes: 10, retries: 1 },
      flow: { autoResume: true, minutes: 9999, retries: 99 },
    },
  });
  const before = structuredClone(input);

  const normalized = normalizeSettings(input);

  assert.deepEqual(input, before);
  assert.notEqual(normalized, input);
  assert.equal(normalized.provider, 'flow');
});

test('removes a retired Pollinations token from local storage during settings migration', async () => {
  const synced = { settings: { provider: 'flow' } };
  const local = {
    providerSecrets: { pollinationsToken: 'retired-token' },
  };
  globalThis.chrome = {
    storage: {
      sync: {
        get: async () => synced,
        set: async (value) => Object.assign(synced, value),
      },
      local: {
        get: async () => local,
        set: async (value) => Object.assign(local, value),
      },
    },
  };

  try {
    const settings = await getSettings();

    assert.equal(Object.hasOwn(local.providerSecrets, 'pollinationsToken'), false);
  } finally {
    delete globalThis.chrome;
  }
});

test('the Flow address keeps only an https origin and falls back to the default', () => {
  assert.equal(normalizeFlowWorkspaceUrl('https://flow.google.com/project/abc?x=1'), 'https://flow.google.com');
  assert.equal(normalizeFlowWorkspaceUrl('http://flow.google.com'), 'https://flow.google.com');
  assert.equal(normalizeFlowWorkspaceUrl('not a url'), 'https://flow.google.com');
  const ws = flowWorkspace({ flowWorkspaceUrl: 'https://labs.google/fx/tools/flow' });
  assert.deepEqual([ws.url, ws.match, ws.project('id-1')], ['https://labs.google/', 'https://labs.google/*', 'https://labs.google/project/id-1']);
});
