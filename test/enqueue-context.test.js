import assert from 'node:assert/strict';
import test from 'node:test';

import {
  captureQueueAllContext,
  captureSceneEnqueueContext,
  captureStandaloneEnqueueContext,
} from '../src/lib/enqueue-context.js';
import { assertFlowModelApproval } from '../src/lib/model-identity.js';

test('scene enqueue context survives selection changes during awaited settings persistence', async () => {
  const project = { slug: 'project-a', name: 'Project A' };
  const episode = { code: 'TN0001', title: 'Episode One' };
  const scenes = [{ key: 'scene-a', prompt: 'Original prompt', source: 'plan' }];
  let selectedProvider = 'flow';
  const payload = captureSceneEnqueueContext({
    project,
    episode,
    source: 'plan',
    scenes,
    kind: 'scene',
    target: 'project',
    provider: selectedProvider,
  });
  const sent = [];
  const chrome = { runtime: { sendMessage: async (message) => { sent.push(message); return { ok: true }; } } };

  await Promise.resolve().then(() => {
    project.slug = 'project-b';
    episode.code = 'TN9999';
    scenes[0].prompt = 'Changed prompt';
    selectedProvider = 'chatgpt';
  });
  await chrome.runtime.sendMessage({ type: 'enqueueScenes', payload });

  assert.equal(selectedProvider, 'chatgpt');
  assert.deepEqual(sent[0].payload, {
    slug: 'project-a',
    episodeCode: 'TN0001',
    episodeTitle: 'Episode One',
    scenes: [{ key: 'scene-a', prompt: 'Original prompt', source: 'plan' }],
    source: 'plan',
    kind: 'scene',
    target: 'project',
    provider: 'flow',
  });
});

test('queue-all captures one project/provider and immutable episode records', () => {
  const project = { slug: 'project-a', name: 'Project A' };
  const episodes = [
    { episode_code: 'TN0001', title: 'One' },
    { code: 'TN0002', title: 'Two' },
  ];
  const captured = captureQueueAllContext({ project, provider: 'qwen', episodes, kind: 'thumbnail' });

  project.slug = 'project-b';
  episodes[0].episode_code = 'TN9999';
  episodes.push({ code: 'TN0003', title: 'Three' });

  assert.deepEqual(captured, {
    project: { slug: 'project-a', name: 'Project A' },
    provider: 'qwen',
    kind: 'thumbnail',
    episodes: [
      { code: 'TN0001', title: 'One' },
      { code: 'TN0002', title: 'Two' },
    ],
  });
});

test('standalone capture is not redirected while Flow selection persistence is awaited', () => {
  const prompts = ['First prompt', 'Second prompt'];
  const captured = captureStandaloneEnqueueContext({ prompts, label: 'Batch A', provider: 'flow' });

  prompts[0] = 'Changed prompt';
  assert.deepEqual(captured, {
    prompts: ['First prompt', 'Second prompt'],
    label: 'Batch A',
    provider: 'flow',
  });
});

test('Flow confirmation provenance stays immutable and rejects changed discovery at enqueue', () => {
  const approval = {
    modelId: 'NARWHAL',
    modelLabel: 'Nano Banana 2',
    modelSource: 'live',
  };
  const payload = captureSceneEnqueueContext({
    project: { slug: 'project-a' },
    episode: { code: 'TN0001', title: 'Episode One' },
    source: 'plan',
    scenes: [{ key: 'scene-a', prompt: 'Original prompt' }],
    kind: 'scene',
    target: 'project',
    provider: 'flow',
    flowModelApproval: approval,
  });

  approval.modelId = 'HARBOR_SEAL';
  approval.modelLabel = 'Nano Banana 2 Lite';
  approval.modelSource = 'fallback';

  assert.deepEqual(payload.flowModelApproval, {
    modelId: 'NARWHAL',
    modelLabel: 'Nano Banana 2',
    modelSource: 'live',
  });
  assert.doesNotThrow(() => assertFlowModelApproval(payload.flowModelApproval, {
    modelId: 'NARWHAL',
    modelLabel: 'Nano Banana 2',
    modelSource: 'live',
  }));
  for (const current of [
    { modelId: 'HARBOR_SEAL', modelLabel: 'Nano Banana 2', modelSource: 'live' },
    { modelId: 'NARWHAL', modelLabel: 'Renamed Model', modelSource: 'live' },
    { modelId: 'NARWHAL', modelLabel: 'Nano Banana 2', modelSource: 'fallback' },
  ]) {
    assert.throws(
      () => assertFlowModelApproval(payload.flowModelApproval, current),
      /changed after confirmation/i,
    );
  }
});
