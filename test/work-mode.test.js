import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { DEFAULT_WORK_MODE, WORK_MODES, normalizeWorkMode, readWorkMode } from '../src/lib/work-mode.js';

const root = path.resolve(import.meta.dirname, '..');

test('only Standalone and Gateway Studio are shipped modes', () => {
  assert.deepEqual(WORK_MODES, ['standalone', 'gateway']);
  assert.equal(DEFAULT_WORK_MODE, 'standalone');
});

test('a stored studio or unknown mode migrates to Standalone', async () => {
  assert.equal(normalizeWorkMode('studio'), 'standalone');
  assert.equal(normalizeWorkMode('not-a-mode'), 'standalone');
  assert.equal(normalizeWorkMode(undefined), 'standalone');
  assert.equal(normalizeWorkMode('gateway'), 'gateway');
  assert.equal(normalizeWorkMode('standalone'), 'standalone');

  for (const stored of ['studio', 'unknown']) {
    const local = { imageGeneratorWorkMode: stored };
    globalThis.chrome = { storage: { local: {
      get: async () => ({ ...local }),
      set: async (value) => Object.assign(local, value),
    } } };
    try {
      assert.equal(await readWorkMode(), 'standalone');
      assert.equal(local.imageGeneratorWorkMode, 'standalone');
    } finally {
      delete globalThis.chrome;
    }
  }
});

test('shipped mode controls offer exactly the two modes', () => {
  for (const file of ['src/popup/popup.html', 'src/options/options.html']) {
    const html = readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(html, /value="studio"/);
    assert.match(html, /value="standalone"/);
    assert.match(html, /value="gateway"/);
  }
});
