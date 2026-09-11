import assert from 'node:assert/strict';
import test from 'node:test';

import { StudioClient } from '../src/lib/story-studio.js';

test('single-episode status refresh invalidates only that cached episode', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return { ok: true, json: async () => ({ episode_code: 'EP 0001' }) };
  };
  try {
    const client = new StudioClient('http://localhost:8000');
    await client.episodeStatus('my project', 'EP 0001');
    assert.equal(
      requestedUrl,
      'http://localhost:8000/api/projects/my%20project/episodes/EP%200001/status?invalidate=1',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
