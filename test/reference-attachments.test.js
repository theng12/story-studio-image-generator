import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { limitProviderReferences } from '../src/lib/providers.js';

const root = path.resolve(import.meta.dirname, '..');
const source = (file) => readFileSync(path.join(root, file), 'utf8');

const references = Array.from({ length: 6 }, (_, index) => ({
  base64: `image-${index + 1}`,
  mime: 'image/png',
  name: `reference-${index + 1}.png`,
  label: `Reference ${index + 1}`,
}));

test('bounds reference bytes to each provider capability before an adapter receives them', () => {
  assert.deepEqual(limitProviderReferences('flow', references), references.slice(0, 4));
  assert.deepEqual(limitProviderReferences('aistudio', references), references.slice(0, 4));
  assert.deepEqual(limitProviderReferences('qwen', references), references.slice(0, 1));
  assert.deepEqual(limitProviderReferences('leonardo', references), []);
  assert.deepEqual(limitProviderReferences('chatgpt', references), references.slice(0, 4));
  assert.deepEqual(limitProviderReferences('removed-provider', references), []);
});

test('the worker caps resolved references before maintained adapters receive bytes', () => {
  const background = source('src/background.js');
  assert.match(background, /limitProviderReferences\(\s*provider,/);
  assert.match(background, /references:\s*await resolveReferenceImages\(item, settings, provider\)/);
});

test('Flow maps every bounded reference to Flow reference image inputs', () => {
  const background = source('src/background.js');
  assert.match(background, /referenceIds\.map\(\(name\) => \(\{ imageInputType: 'IMAGE_INPUT_TYPE_REFERENCE', name \}\)\)/);
});

test('AI Studio and ChatGPT clear then attach every reference and verify their final attachment count', () => {
  for (const file of ['src/content/aistudio-main.js', 'src/content/chatgpt-main.js']) {
    const adapter = source(file);
    assert.match(adapter, /async function attachReferences\(references\)/);
    assert.match(adapter, /await clearReferences\(\)/);
    assert.match(adapter, /for \(const reference of valid\)/);
    assert.match(adapter, /attachment count/i);
    assert.match(adapter, /params\.references/);
  }
});

test('Qwen accepts only the first bounded reference and retains its one-chip guard', () => {
  const adapter = source('src/content/qwen-main.js');
  assert.match(adapter, /const reference = Array\.isArray\(params\.references\) \? params\.references\[0\] : null/);
  assert.match(adapter, /settleToOneChip/);
});
