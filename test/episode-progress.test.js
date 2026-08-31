import assert from 'node:assert/strict';
import test from 'node:test';

import * as episodeProgress from '../src/lib/episode-progress.js';

const { sceneImageProgress } = episodeProgress;

test('scene image completion accepts the Story Studio aggregate independently of approval state', () => {
  const progress = sceneImageProgress({
    status: { images: false },
    scene_images: { total: 6, present: 6, complete: true },
    scene_review: { approved: false },
  });

  assert.deepEqual(progress, { total: 6, present: 6, complete: true });
});

test('scene image progress does not infer completion when Story Studio has not accepted it', () => {
  const progress = sceneImageProgress({
    status: { images: true },
    scene_images: { total: 6, present: 6, complete: false },
  });

  assert.deepEqual(progress, { total: 6, present: 6, complete: false });
});

test('thumbnail progress honors Story Studio marked done even when files are missing', () => {
  assert.equal(typeof episodeProgress.thumbnailImageProgress, 'function');
  const progress = episodeProgress.thumbnailImageProgress({
    status: { thumbnails: true },
    thumbnail_images: { total: 3, present: 1, complete: false },
  });

  assert.deepEqual(progress, { total: 3, present: 1, complete: true, markedDone: true });
});

test('thumbnail progress reads marked done from normalized episode rows', () => {
  const progress = episodeProgress.thumbnailImageProgress({
    st: { thumbnails: true },
  });

  assert.deepEqual(progress, { total: 0, present: 0, complete: true, markedDone: true });
});

test('thumbnail availability separates queueable work from episodes without prompts', () => {
  assert.deepEqual(episodeProgress.thumbnailAvailability([
    { status: { thumb_prompts: true, thumbnails: true } },
    { status: { thumb_prompts: true, thumbnails: false } },
    { status: { thumb_prompts: false, thumbnails: false } },
  ]), {
    withPrompts: 2,
    done: 1,
    pending: 1,
    withoutPrompts: 1,
  });
});

test('thumbnail todo selects the first episode with a missing thumbnail asset', () => {
  assert.equal(typeof episodeProgress.episodeFilterState, 'function');
  const episodes = [
    {
      code: 'EP0000',
      st: { scene_plan: true, thumb_prompts: false },
      scene_images: { total: 8, present: 0, complete: false },
    },
    {
      code: 'EP0001',
      st: { scene_plan: true, thumb_prompts: true },
      scene_images: { total: 8, present: 8, complete: true },
      thumbnail_images: { total: 2, present: 2, complete: true },
    },
    {
      code: 'EP0002',
      st: { scene_plan: true, thumb_prompts: true },
      scene_images: { total: 8, present: 8, complete: true },
      thumbnail_images: { total: 2, present: 0, complete: false },
    },
    {
      code: 'EP0003',
      st: { scene_plan: true, thumb_prompts: true, thumbnails: true },
      thumbnail_images: { total: 2, present: 0, complete: false },
    },
  ];

  assert.deepEqual(
    episodeProgress.episodeFilterState(episodes, { kind: 'thumbnail', filter: 'todo', selectedCode: 'EP0001' }),
    {
      visibleCodes: ['EP0002'],
      selectedCode: 'EP0002',
      progressByCode: {
        EP0000: { total: 0, present: 0, complete: false, markedDone: false },
        EP0001: { total: 2, present: 2, complete: true, markedDone: false },
        EP0002: { total: 2, present: 0, complete: false, markedDone: false },
        EP0003: { total: 2, present: 0, complete: true, markedDone: true },
      },
    },
  );
});

test('episode asset loads clear old rows and only the newest request may commit', async () => {
  assert.equal(typeof episodeProgress.createEpisodeAssetLoadRunner, 'function');
  const runner = episodeProgress.createEpisodeAssetLoadRunner();
  let rows = ['old scene'];
  let resolveScene;
  let resolveThumbnail;
  const handlers = {
    onStart: () => { rows = []; },
    onSuccess: (value) => { rows = value; },
  };

  const scene = runner.run(
    () => new Promise((resolve) => { resolveScene = resolve; }),
    handlers,
  );
  assert.deepEqual(rows, []);
  const thumbnail = runner.run(
    () => new Promise((resolve) => { resolveThumbnail = resolve; }),
    handlers,
  );

  resolveThumbnail(['new thumbnail']);
  await thumbnail;
  resolveScene(['stale scene']);
  await scene;

  assert.deepEqual(rows, ['new thumbnail']);
});

test('a failed current episode asset load keeps cleared rows empty', async () => {
  assert.equal(typeof episodeProgress.createEpisodeAssetLoadRunner, 'function');
  const runner = episodeProgress.createEpisodeAssetLoadRunner();
  let rows = ['old scene'];
  let failure = '';

  await runner.run(
    async () => { throw new Error('thumbnail status unavailable'); },
    {
      onStart: () => { rows = []; },
      onSuccess: (value) => { rows = value; },
      onError: (error) => { failure = error.message; },
    },
  );

  assert.deepEqual(rows, []);
  assert.equal(failure, 'thumbnail status unavailable');
});
