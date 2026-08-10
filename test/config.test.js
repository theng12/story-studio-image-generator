import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, normalizeSettings } from '../src/lib/config.js';

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
