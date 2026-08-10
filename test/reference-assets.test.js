import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeReferenceContext, resolveReferenceDescriptors } from '../src/lib/reference-assets.js';
import { StudioClient } from '../src/lib/story-studio.js';

const listing = {
  master: { url: '/refs/master.png' },
  thumbnail: { url: '/refs/thumbnail.png' },
  style: { url: '/refs/style.png' },
  composition: { url: '/refs/composition.png' },
  scenes: [{ number: 6, url: '/refs/scene-06.png' }],
};

const characters = [
  { id: 'aria', name: 'Aria', references: { images: [{ filename: 'aria-front.png', url: '/characters/aria-front.png' }, { filename: 'aria-side.png', url: '/characters/aria-side.png' }] } },
  { id: 'brick', name: 'Brick', references: { images: [{ filename: 'brick.png', url: '/characters/brick.png' }] } },
  { id: 'marian', name: 'Marian', references: { images: [{ filename: 'marian.png', url: '/characters/marian.png' }] } },
];

const enabledContinuity = {
  config: {
    anchor_character_ids: ['brick'],
    use_episode_sheet: true,
    references: { sheet: true, characters: true, style: true, composition: true },
  },
};

function context(overrides = {}) {
  return normalizeReferenceContext({ continuity: enabledContinuity, listing, characters, ...overrides });
}

test('uses only the thumbnail reference for thumbnail assets', () => {
  const resolved = resolveReferenceDescriptors({ kind: 'thumbnail', sceneKey: 1, prompt: 'A title card', context: context(), maxReferences: 4 });
  assert.deepEqual(resolved, [{ source: 'thumbnail', label: 'Thumbnail reference', url: '/refs/thumbnail.png', filename: 'thumbnail.png' }]);
});

test('orders scene references as master, matching scene, matching and anchor characters, composition, then style', () => {
  const resolved = resolveReferenceDescriptors({
    kind: 'scene',
    sceneKey: 6,
    prompt: 'Aria and Brick explore the cave.',
    context: context(),
    maxReferences: 10,
  });

  assert.deepEqual(resolved.map((reference) => [reference.source, reference.characterId || reference.filename]), [
    ['master', 'master.png'],
    ['scene', 'scene-06.png'],
    ['character', 'aria'],
    ['character', 'aria'],
    ['character', 'brick'],
    ['composition', 'composition.png'],
    ['style', 'style.png'],
  ]);
});

test('honors continuity reference toggles', () => {
  const disabled = context({
    continuity: { config: { anchor_character_ids: ['brick'], use_episode_sheet: false, references: { sheet: false, characters: false, style: false, composition: false } } },
  });
  const resolved = resolveReferenceDescriptors({ kind: 'scene', sceneKey: 6, prompt: 'Aria and Brick', context: disabled, maxReferences: 10 });
  assert.deepEqual(resolved.map((reference) => reference.source), ['scene']);
});

test('matches character names as case-insensitive whole phrases, never substrings', () => {
  const resolved = resolveReferenceDescriptors({ kind: 'scene', sceneKey: 1, prompt: 'ARIA walks beside Marian, not Arianna.', context: context(), maxReferences: 10 });
  assert.deepEqual(resolved.filter((reference) => reference.source === 'character').map((reference) => reference.characterId), ['aria', 'aria', 'marian', 'brick']);
});

test('deduplicates by URL and caps in order', () => {
  const duplicated = context({
    listing: { ...listing, composition: { url: '/refs/master.png' }, scenes: [{ number: 6, url: '/refs/master.png' }] },
  });
  const resolved = resolveReferenceDescriptors({ kind: 'scene', sceneKey: 6, prompt: 'Aria', context: duplicated, maxReferences: 3 });
  assert.deepEqual(resolved.map((reference) => reference.url), ['/refs/master.png', '/characters/aria-front.png', '/characters/aria-side.png']);
});

test('normalizes malformed optional responses without mutating inputs', () => {
  const raw = { continuity: { config: { anchor_character_ids: 'not-an-array' } }, listing: { scenes: [{}], master: { url: '' } }, characters: [{ id: 'x', name: 42, references: { images: [null] } }] };
  const normalized = normalizeReferenceContext(raw);
  assert.deepEqual(normalized.assets, { master: null, thumbnail: null, style: null, composition: null, scenes: [] });
  assert.deepEqual(normalized.characters, []);
  assert.deepEqual(raw.listing.scenes, [{}]);
});

test('loads one Story Studio reference context with character file URLs', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    if (String(url).includes('/continuity/')) return Response.json({ config: {} });
    if (String(url).includes('/img2img-references')) return Response.json({ scenes: [] });
    return Response.json([{ id: 'aria', name: 'Aria', references: { images: ['sheet.png'] } }]);
  };
  try {
    const result = await new StudioClient('http://studio.test').referenceAssets('project', 'EP001', 'Pilot Episode');
    assert.equal(requests.length, 3);
    assert.match(requests[1], /img2img-references\?title=Pilot%20Episode/);
    assert.equal(result.characters[0].references.images[0].url, '/api/projects/project/characters/aria/reference-image/sheet.png');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('makes advertised reference download failures actionable', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ detail: 'Reference not found' }, { status: 404 });
  try {
    await assert.rejects(
      new StudioClient('http://studio.test').referenceAssetBase64({ label: 'Episode master reference', url: '/api/projects/project/episodes/EP001/img2img-references/file/master.png' }),
      /could not serve Episode master reference \(404\).*Reference not found/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rejects reference descriptors outside the configured Story Studio API', async () => {
  await assert.rejects(
    new StudioClient('http://studio.test').referenceAssetBase64({ label: 'Unexpected reference', url: 'https://example.com/image.png' }),
    /invalid download URL/i,
  );
});
