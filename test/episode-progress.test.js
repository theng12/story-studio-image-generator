import assert from 'node:assert/strict';
import test from 'node:test';

import { sceneImageProgress } from '../src/lib/episode-progress.js';

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
