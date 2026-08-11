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
import { flowCommand } from '../src/lib/flow-exec.js';
import * as modelIdentity from '../src/lib/model-identity.js';
import { flowInventoryResult, generationParamsFor } from '../src/lib/model-identity.js';
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
  assert.match(queueAll, /\(e\.status \|\| \{\}\)\.scene_plan/);
  assert.doesNotMatch(queueAll, /st\.scene_prompts/);
  assert.match(queueAll, /sceneImageProgress\(e\)\.complete/);
  assert.doesNotMatch(queueAll, /status\.images/);
  assert.match(queueAll, /loadScenePlan/);
});

test('episode loading uses Story Studio aggregate scene progress instead of recounting every Scene Review', () => {
  const popup = source('src/popup/popup.js');
  const projectChange = popup.slice(popup.indexOf('async function onProjectChange'), popup.indexOf('// ── scenes'));

  assert.match(projectChange, /sceneImageProgress\(e\)/);
  assert.doesNotMatch(projectChange, /client\.sceneReview/);
  assert.doesNotMatch(projectChange, /fetchEpisodeCounts|episodeCountRun/);
  assert.equal((projectChange.match(/applyEpisodeFilter\(\)/g) || []).length, 1);
  assert.ok(
    projectChange.indexOf('settings.lastEpisode') < projectChange.indexOf('applyEpisodeFilter()'),
    'the active filter must validate the restored episode selection',
  );
  assert.doesNotMatch(popup, /async function fetchEpisodeCounts|episodeCountRun|allEpisodes\.find|setTimeout\(r, 120\)/);
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
  const policy = source('src/lib/queue-migration.js');
  const queue = background.slice(background.indexOf('async function processQueue'), background.indexOf('// Drop everything not yet started'));
  const guard = queue.indexOf('assertSupportedProjectScene(item)');
  const openProvider = queue.indexOf('ensureProviderTab(provider)');
  const generate = queue.indexOf('generateAndSave(item');
  const terminal = queue.indexOf("e?.code === 'scene-source-retired'");

  assert.ok(guard >= 0 && guard < openProvider);
  assert.ok(guard < generate);
  assert.ok(terminal > guard && terminal < queue.indexOf('if (isKnownPreSubmitLimit'));
  assert.match(policy, /item\?\.target !== 'download'/);
  assert.doesNotMatch(policy, /item\?\.target === 'project'/);
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

test('worker verifies the queued model before provider-attempted and generation', () => {
  const background = source('src/background.js');
  const process = background.slice(background.indexOf('async function processQueue'), background.indexOf('// Drop everything not yet started'));
  assert.ok(process.indexOf('verifyQueuedModel') < process.indexOf('providerAttempted = true'));
  assert.ok(process.indexOf('verifyQueuedModel') < process.indexOf('generateAndSave(item'));
  assert.match(background, /modelSnapshot/);
  assert.match(background, /generationSettings/);
});

test('worker rejects queue identity drift before provider verification or Flow reference upload', () => {
  const background = source('src/background.js');
  const verify = background.slice(background.indexOf('async function verifyQueuedModel'), background.indexOf('async function responseToPayload'));
  const generate = background.slice(background.indexOf('async function generateAndSave'), background.indexOf('// ── status'));
  assert.ok(verify.indexOf('assertQueuedModelIdentity') >= 0);
  assert.ok(generate.indexOf('assertQueuedModelIdentity') >= 0);
  assert.ok(verify.indexOf('assertQueuedModelIdentity') < verify.indexOf('requireCurrentFlowModel'));
  assert.ok(verify.indexOf('assertQueuedModelIdentity') < verify.indexOf('config.contextMessage'));
  assert.ok(generate.indexOf('assertQueuedModelIdentity') < generate.indexOf('resolveReferenceMediaIds'));
  assert.ok(generate.indexOf("generationParamsFor('flow'") < generate.indexOf('resolveReferenceMediaIds'));
});

test('Flow generation identity drift performs zero fetch, upload, or generation work', async () => {
  const background = source('src/background.js');
  const body = background.slice(background.indexOf('async function generateAndSave'), background.indexOf('// ── status')).trim();
  const calls = { fetch: 0, upload: 0, generation: 0 };
  const context = {
    assertSupportedProjectScene() {},
    DEFAULT_PROVIDER_ID: 'flow',
    normalizeFlowProjectId: (value) => value,
    assertQueuedModelIdentity: modelIdentity.assertQueuedModelIdentity,
    generationParamsFor,
    resolveReferenceMediaIds: async () => { calls.upload++; return ['media/reference']; },
    send: async () => { calls.generation++; return {}; },
    fetchImagePayload: async () => { calls.fetch++; return {}; },
  };
  const generateAndSave = runInNewContext(`(${body})`, context);
  const snapshot = { modelId: 'NARWHAL', modelLabel: 'Nano Banana 2', modelSource: 'live' };

  for (const modelId of ['GEM_PIX_2', 'malformed model id']) {
    await assert.rejects(
      generateAndSave({
        provider: 'flow',
        target: 'download',
        prompt: 'A moonlit lake',
        projectId: 'flow-project',
        modelSnapshot: snapshot,
        generationSettings: { ...snapshot, modelId, aspectRatio: '16:9' },
      }, { flowRecaptchaMaxAttempts: 4 }, { id: 7 }),
      (error) => error.code === 'model-selection-changed',
    );
  }

  assert.deepEqual(calls, { fetch: 0, upload: 0, generation: 0 });
});

test('every provider handler dispatches through immutable generation parameter construction', () => {
  const background = source('src/background.js');
  const generate = background.slice(background.indexOf('async function generateAndSave'), background.indexOf('// ── status'));
  assert.equal((generate.match(/generationParamsFor\(/g) || []).length, 5);
  assert.doesNotMatch(generate, /item\.generationSettings\.(?:aspectRatio|modelId|style|mode|size|count|maxWaitSec)/);
  assert.doesNotMatch(generate, /settings\.(?:aspectRatio|aistudioAspectRatio|qwenAspectRatio|chatgptAspectRatio|chatgptMaxWaitSec|leonardoModel|leonardoStyle|leonardoMode|leonardoSize|leonardoCount)/);
  assert.match(generate, /recaptchaMaxAttempts:\s*settings\.flowRecaptchaMaxAttempts/);
});

test('Flow discovery is read-only, provider-owned, and never display-text inferred', () => {
  const flow = source('src/lib/flow-exec.js');
  const list = flow.slice(flow.indexOf('const listImageModels'), flow.indexOf('const generateImage'));
  assert.match(list, /listImageModels/);
  assert.match(list, /imageModelConfigs/);
  assert.match(list, /data-image-model-key/);
  assert.doesNotMatch(list, /batchGenerateImages/);
  assert.doesNotMatch(list, /transportKey/);
  assert.doesNotMatch(list, /script\[type=.*application\/json/);
  assert.doesNotMatch(flow, /IMAGE_MODELS\[.*\]\s*\|\|/);
});

test('Flow queue execution rechecks the exact live snapshot before POST', () => {
  const background = source('src/background.js');
  assert.match(background, /refreshFlowModels/);
  assert.match(background, /flowModelSource/);
  assert.match(background, /modelSnapshot\.modelId/);
  assert.ok(background.indexOf('requireCurrentFlowModel') < background.indexOf('providerAttempted = true'));
  assert.ok(background.indexOf('requireCurrentFlowModel') < background.indexOf('generateAndSave(item'));
  assert.match(background, /model-selection-changed|model-unknown/);
});

test('Flow model discovery falls back only when provider-owned records are invalid', async () => {
  const fetches = [];
  const execute = (nextData, options = []) => {
    const context = {
      window: { __NEXT_DATA__: nextData },
      document: {
        querySelector() { return null; },
        querySelectorAll(selector) {
          assert.equal(selector, '[role="option"][data-image-model-key]');
          return options;
        },
      },
      fetch(...args) {
        fetches.push(args);
        throw new Error('read-only discovery must not fetch');
      },
    };
    const command = runInNewContext(`(${flowCommand.toString()})`, context);
    return command({ op: 'listImageModels', payload: {} });
  };

  const invalid = await execute({ props: { pageProps: { imageModelConfigs: [{ imageModelKey: 'Same', displayName: 'Same' }] } } });
  assert.equal(invalid.ok, true);
  assert.deepEqual(flowInventoryResult(invalid.result.entries), {
    source: 'fallback',
    models: [
      { modelId: 'NARWHAL', modelLabel: 'Nano Banana 2' },
      { modelId: 'HARBOR_SEAL', modelLabel: 'Nano Banana 2 Lite' },
      { modelId: 'GEM_PIX_2', modelLabel: 'Nano Banana Pro' },
    ],
  });

  const live = await execute({ props: { pageProps: { imageModelConfigs: [{ imageModelKey: 'FLOW_NEW_01', displayName: 'Provider Model' }] } } });
  assert.equal(live.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(flowInventoryResult(live.result.entries))), {
    source: 'live',
    models: [{ modelId: 'FLOW_NEW_01', modelLabel: 'Provider Model' }],
  });
  assert.equal(fetches.length, 0);
});

test('web contexts expose only semantic visible model identity', () => {
  for (const file of ['src/content/aistudio-main.js', 'src/content/qwen-main.js', 'src/content/chatgpt-main.js']) {
    const adapter = source(file);
    const identity = adapter.slice(adapter.indexOf('function selectedModelIdentity'), adapter.indexOf('function getContext'));
    assert.match(identity, /data-model-id/);
    assert.match(identity, /data-model/);
    assert.match(identity, /data-testid/);
    assert.match(identity, /model-/);
    assert.match(identity, /Select model|Choose model/);
    assert.match(adapter, /modelIdentity:\s*selectedModelIdentity\(\)/);
  }

  const leonardo = source('src/content/leonardo-main.js');
  const context = leonardo.slice(leonardo.indexOf('function getContext'), leonardo.indexOf('async function generateImage'));
  assert.match(context, /modelIdentity:\s*\{\s*id:\s*selectedModel/);
  assert.match(context, /stable:\s*Boolean\(selectedModel\)/);
});

test('Flow generation accepts only the queued exact model ID', () => {
  const flow = source('src/lib/flow-exec.js');
  const generate = flow.slice(flow.indexOf('const generateImage'), flow.indexOf('const uploadImage'));
  assert.match(generate, /payload\.modelId/);
  assert.match(generate, /imageModelName:\s*modelId/);
  assert.doesNotMatch(generate, /payload\.model\b/);
  assert.doesNotMatch(flow, /const IMAGE_MODELS/);
});

test('both Flow enqueue paths refresh live inventory before snapshotting', () => {
  const background = source('src/background.js');
  for (const [start, end] of [
    ['async function enqueueScenes', 'async function enqueueStandalone'],
    ['async function enqueueStandalone', 'async function processQueue'],
  ]) {
    const enqueue = background.slice(background.indexOf(start), background.indexOf(end));
    const refresh = enqueue.indexOf('refreshFlowModels');
    const snapshot = enqueue.indexOf('snapshotProviderModelAtEnqueue');
    assert.ok(refresh >= 0 && refresh < snapshot);
    assert.doesNotMatch(enqueue, /flowInventoryForEnqueue/);
    assert.match(enqueue, /flowModelSelection:\s*settings\.imageModel/);
  }
});

test('startup recovery delegates to evidence-aware queue recovery', () => {
  const background = source('src/background.js');
  const startup = background.slice(background.indexOf('// Resume only work'), background.indexOf('chrome.alarms?.onAlarm'));
  assert.match(startup, /recoverInterruptedQueue/);
  assert.doesNotMatch(startup, /item\.status = 'pending'/);
});

test('Flow command rejects missing and malformed exact model IDs without network work', async () => {
  for (const modelId of [undefined, 'unknown model id']) {
    const requests = [];
    const uploads = [];
    const generations = [];
    let tokens = 0;
    const context = {
      window: {
        grecaptcha: {
          enterprise: {
            ready(callback) { callback(); },
            execute() { tokens++; return Promise.resolve('token'); },
          },
        },
      },
      document: { querySelector() { return null; }, querySelectorAll() { return []; } },
      location: { pathname: '', href: 'https://labs.google/fx/tools/flow' },
      fetch(...args) {
        requests.push(args);
        if (String(args[0]).includes('/uploadImage')) uploads.push(args);
        if (String(args[0]).includes('batchGenerateImages')) generations.push(args);
        throw new Error('network work must not start');
      },
    };
    const command = runInNewContext(`(${flowCommand.toString()})`, context);
    const result = await command({
      op: 'generateImage',
      payload: {
        projectId: '12345678-1234-1234-1234-123456789abc',
        prompt: 'A moonlit lake',
        modelId,
        aspectRatio: '16:9',
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /model ID is malformed/i);
    assert.equal(tokens, 0);
    assert.equal(requests.length, 0);
    assert.equal(uploads.length, 0);
    assert.equal(generations.length, 0);
  }
});
