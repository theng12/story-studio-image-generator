import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import {
  ambiguousLeonardoQueueItem,
  isAmbiguousLeonardoFailure,
  isKnownPreSubmitLimit,
  providerLabelForItem,
} from '../src/lib/failure-policy.js';
import { summarizeQueueAll } from '../src/lib/queue-all.js';

const root = path.resolve(import.meta.dirname, '..');
const source = (file) => readFileSync(path.join(root, file), 'utf8');

test('Leonardo ambiguity policy blocks post-submit and unknown outcomes but distinguishes pre-submit errors', () => {
  assert.equal(isAmbiguousLeonardoFailure('leonardo', true, { submitted: true }), true);
  assert.equal(isAmbiguousLeonardoFailure('leonardo', true, {}), true);
  assert.equal(isAmbiguousLeonardoFailure('leonardo', true, { submitted: null }), true);
  assert.equal(isAmbiguousLeonardoFailure('leonardo', true, { submitted: false }), false);
  assert.equal(isAmbiguousLeonardoFailure('leonardo', false, { submitted: true }), false);
  assert.equal(isAmbiguousLeonardoFailure('flow', true, { submitted: true }), false);
});

test('only explicit pre-submit Leonardo limits retain the pause and re-pend path', () => {
  assert.equal(isKnownPreSubmitLimit('leonardo', { limit: true, submitted: false }), true);
  assert.equal(isKnownPreSubmitLimit('leonardo', { limit: true, submitted: true }), false);
  assert.equal(isKnownPreSubmitLimit('leonardo', { limit: true }), false);
  assert.equal(isKnownPreSubmitLimit('flow', { limit: true }), true);
  assert.equal(isKnownPreSubmitLimit('leonardo', { submitted: false }), false);
});

test('Leonardo ambiguous failures become terminal and Fleet-unsafe with paid-work recovery guidance', () => {
  const failed = ambiguousLeonardoQueueItem(
    { provider: 'leonardo', status: 'running', startedAt: 100 },
    new Error('The message port closed.'),
    175
  );

  assert.equal(failed.status, 'failed');
  assert.equal(failed.failure.code, 'ambiguous');
  assert.match(failed.failure.title, /Leonardo AI/i);
  assert.match(failed.failure.hint, /inspect|check/i);
  assert.match(failed.failure.hint, /manually retry|manual retry/i);
  assert.equal(failed.fleetRetrySafe, false);
  assert.equal(failed.finishedAt, 175);
  assert.equal(failed.durationMs, 75);
});

test('failure labels preserve maintained names, retired ids, and neutral absence', () => {
  assert.equal(providerLabelForItem({ provider: 'leonardo' }), 'Leonardo AI');
  assert.equal(providerLabelForItem({ provider: 'grok' }), 'grok');
  assert.equal(providerLabelForItem({ provider: 'piclumen' }), 'piclumen');
  assert.equal(providerLabelForItem({}), 'provider');
});

test('queue-all summary reports partial failures, successful counts, episode codes, and bounded first error', () => {
  const summary = summarizeQueueAll({
    queued: 7,
    episodes: 2,
    failures: [
      { code: 'EP003', error: `Sign in again. ${'x'.repeat(1000)}` },
      { code: 'EP004', error: 'Scene plan is missing.' },
    ],
  });

  assert.equal(summary.kind, 'err');
  assert.match(summary.text, /Queued 7 scenes across 2 episodes/i);
  assert.match(summary.text, /EP003/);
  assert.match(summary.text, /EP004/);
  assert.match(summary.text, /Sign in again/);
  assert.ok(summary.text.length < 500, `summary should be bounded, got ${summary.text.length} characters`);
  assert.doesNotMatch(summary.text, /everything is done|all done/i);
});

test('queue-all summary reports success only when no episode failed', () => {
  assert.deepEqual(summarizeQueueAll({ queued: 3, episodes: 1, failures: [] }), {
    kind: 'done',
    text: 'Queued 3 scenes across 1 episode.',
  });
});

async function leonardoBridgeResponse(error) {
  let listener;
  const context = {
    globalThis: null,
    chrome: { runtime: { onMessage: { addListener(value) { listener = value; } } } },
    setTimeout() { return 0; },
  };
  context.globalThis = context;
  context.__STORY_STUDIO_LEONARDO_CALL__ = async () => { throw error; };
  runInNewContext(source('src/content/leonardo.js'), context);
  return new Promise((resolve) => listener(
    { type: 'leonardo:generateImage', params: {} },
    {},
    resolve
  ));
}

test('Leonardo bridge returns true, false, and unknown submission states', async () => {
  const submitted = new Error('post-submit failure');
  submitted.submitted = true;
  const notSubmitted = new Error('pre-submit failure');
  notSubmitted.submitted = false;

  assert.equal((await leonardoBridgeResponse(submitted)).submitted, true);
  assert.equal((await leonardoBridgeResponse(notSubmitted)).submitted, false);
  assert.equal((await leonardoBridgeResponse(new Error('transport unknown'))).submitted, null);
});

test('Leonardo adapter marks submission immediately before Generate and preserves it on every error', () => {
  const adapter = source('src/content/leonardo-main.js');
  const generate = adapter.slice(adapter.indexOf('async function generateImage'), adapter.indexOf('// Read the model picker'));
  const submittedFalse = generate.indexOf('let submitted = false');
  const submittedTrue = generate.indexOf('submitted = true');
  const click = generate.indexOf('button.click()');
  const catchBlock = generate.indexOf('catch (error)');

  assert.ok(submittedFalse >= 0);
  assert.ok(submittedTrue > submittedFalse);
  assert.ok(click > submittedTrue);
  assert.ok(catchBlock > click);
  assert.match(generate, /error\.submitted = submitted/);
});

test('background preserves submission state and terminalizes Leonardo ambiguity before retry branches', () => {
  const background = source('src/background.js');
  assert.match(background, /submitted:\s*res\?\.submitted/);

  const queue = background.slice(background.indexOf('async function processQueue'), background.indexOf('// Drop everything not yet started'));
  const limit = queue.indexOf('if (isKnownPreSubmitLimit');
  const ambiguous = queue.indexOf('isAmbiguousLeonardoFailure');
  const reload = queue.indexOf('if (isTabReloadError(e))');
  const retry = queue.indexOf('cd.autoResume && cd.retries');
  assert.ok(limit >= 0 && ambiguous > limit, 'known pre-submit limit handling must precede ambiguity');
  assert.ok(reload > ambiguous, 'ambiguity must precede tab reload retry');
  assert.ok(retry > ambiguous, 'ambiguity must precede configured retry');
});

test('queue-all uses a declared project target and records response and thrown failures', () => {
  const popup = source('src/popup/popup.js');
  const queueAll = popup.slice(popup.indexOf('async function queueAllPending'), popup.indexOf('async function onProjectChange'));

  assert.match(queueAll, /target:\s*'project'/);
  assert.doesNotMatch(queueAll, /^\s*target,\s*$/m);
  assert.match(queueAll, /if \(!res\?\.ok\)/);
  assert.match(queueAll, /failures\.push/);
  assert.match(queueAll, /summarizeQueueAll/);
});

test('current and queue-all scene discovery use Scene Review only and require a Scene Plan', () => {
  const popup = source('src/popup/popup.js');
  const loadScenes = popup.slice(popup.indexOf('async function loadScenes()'), popup.indexOf('// Thumbnails always'));
  const sceneLoader = popup.slice(popup.indexOf('async function loadScenePlan'), popup.indexOf('const PROVIDER_LABEL'));
  const queueAll = popup.slice(popup.indexOf('async function queueAllPending'), popup.indexOf('async function onProjectChange'));

  assert.match(loadScenes, /loadScenePlan/);
  assert.doesNotMatch(loadScenes, /loadScenesFromEither/);
  assert.match(sceneLoader, /client\.sceneReview/);
  assert.doesNotMatch(sceneLoader, /client\.imagePrompts/);
  assert.match(sceneLoader, /Create or load a Scene Plan/i);
  assert.match(queueAll, /st\.scene_plan/);
  assert.doesNotMatch(queueAll, /st\.scene_prompts/);
  assert.match(queueAll, /loadScenePlan/);
});

test('direct enqueue rejects non-plan scenes before settings, references, or queue writes', () => {
  const background = source('src/background.js');
  const enqueueScenes = background.slice(background.indexOf('async function enqueueScenes'), background.indexOf('async function enqueueStandalone'));
  const guard = enqueueScenes.indexOf('assertSupportedProjectScene');

  assert.ok(guard >= 0, 'enqueueScenes should enforce the scene source contract');
  assert.doesNotMatch(enqueueScenes, /source\s*\|\|\s*'plan'/);
  assert.ok(guard < enqueueScenes.indexOf('await getSettings()'));
  assert.ok(guard < enqueueScenes.indexOf('referenceAssets'));
  assert.ok(guard < enqueueScenes.indexOf('return enqueue(items)'));
  assert.match(source('src/lib/queue-migration.js'), /Create or load a Scene Plan/i);
});

test('worker preflight rejects unsupported scene sources before opening or submitting to providers', () => {
  const background = source('src/background.js');
  const queue = background.slice(background.indexOf('async function processQueue'), background.indexOf('// Drop everything not yet started'));
  const guard = queue.indexOf('assertSupportedProjectScene(item)');
  const openProvider = queue.indexOf('ensureProviderTab(provider)');
  const generate = queue.indexOf('generateAndSave(item');
  const terminal = queue.indexOf("e?.code === 'scene-source-retired'");

  assert.ok(guard >= 0 && guard < openProvider);
  assert.ok(guard < generate);
  assert.ok(terminal > guard && terminal < queue.indexOf('if (isKnownPreSubmitLimit'));
});

test('save routing keeps thumbnail ingest and Scene Review upload but removes scene image ingest', () => {
  const background = source('src/background.js');
  const generate = background.slice(background.indexOf('async function generateAndSave'), background.indexOf('// ── status'));

  assert.match(generate, /assertSupportedProjectScene\(item\)/);
  assert.match(generate, /ingestImage\(item\.slug, item\.episodeCode, 'thumbnail'/);
  assert.match(generate, /uploadSceneImage\(item\.slug, item\.episodeCode, item\.sceneKey/);
  assert.doesNotMatch(generate, /item\.source === 'prompts'/);
  assert.doesNotMatch(generate, /ingestImage\(item\.slug, item\.episodeCode, 'scene'/);
});
