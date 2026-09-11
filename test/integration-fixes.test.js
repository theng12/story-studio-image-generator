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
import { pendingEpisodeRows, queuePendingEpisodes, summarizeQueueAll } from '../src/lib/queue-all.js';
import { captureQueueAllContext } from '../src/lib/enqueue-context.js';

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

test('thumbnail queue-all executes only prompt-ready unmarked episodes with captured context', async () => {
  const rows = [
    { episode_code: 'EP0120', title: 'Done', status: { thumb_prompts: true, thumbnails: true } },
    { episode_code: 'EP0121', title: 'Pending', status: { thumb_prompts: true, thumbnails: false } },
    { episode_code: 'EP0122', title: 'No prompts', status: { thumb_prompts: false, thumbnails: false } },
  ];
  const project = { slug: 'capi', name: 'Capi' };
  const pending = pendingEpisodeRows(rows, 'thumbnail');
  const context = captureQueueAllContext({ project, provider: 'flow', kind: 'thumbnail', episodes: pending });
  project.slug = 'changed';
  rows[1].episode_code = 'changed';
  const loaded = [];
  const payloads = [];

  const result = await queuePendingEpisodes({
    context,
    loadAssets: async (request) => {
      loaded.push(request);
      return {
        source: 'prompts',
        scenes: [
          { key: 1, prompt: 'Missing thumbnail', hasImage: false },
          { key: 2, prompt: 'Existing thumbnail', hasImage: true },
        ],
      };
    },
    enqueue: async (payload) => { payloads.push(payload); return { ok: true, added: 1 }; },
  });

  assert.deepEqual(loaded, [{ kind: 'thumbnail', slug: 'capi', episode: { code: 'EP0121', title: 'Pending' } }]);
  assert.equal(payloads.length, 1);
  assert.deepEqual(payloads[0], {
    slug: 'capi',
    episodeCode: 'EP0121',
    episodeTitle: 'Pending',
    scenes: [{ key: 1, prompt: 'Missing thumbnail', hasImage: false }],
    source: 'prompts',
    kind: 'thumbnail',
    target: 'project',
    provider: 'flow',
  });
  assert.deepEqual(result, { queued: 1, episodes: 1, failures: [], kind: 'thumbnail' });
  assert.equal(summarizeQueueAll(result).text, 'Queued 1 thumbnail across 1 episode.');
});

test('queue-all enqueues newly selected episodes from earliest to latest', async () => {
  const rows = [
    { episode_code: 'SS0176', status: { thumb_prompts: true, thumbnails: false } },
    { episode_code: 'SS0157', status: { thumb_prompts: true, thumbnails: false } },
    { episode_code: 'SS0153', status: { thumb_prompts: true, thumbnails: false } },
  ];
  const context = captureQueueAllContext({
    project: { slug: 'story-sprout', name: 'Story Sprout' },
    provider: 'flow',
    kind: 'thumbnail',
    episodes: pendingEpisodeRows(rows, 'thumbnail'),
  });
  const enqueued = [];

  await queuePendingEpisodes({
    context,
    loadAssets: async () => ({
      source: 'prompts',
      scenes: [{ key: 1, prompt: 'Thumbnail prompt', hasImage: false }],
    }),
    enqueue: async (payload) => {
      enqueued.push(payload.episodeCode);
      return { ok: true, added: 1 };
    },
  });

  assert.deepEqual(enqueued, ['SS0153', 'SS0157', 'SS0176']);
});

test('thumbnail queue-all fails closed before enqueue when status loading fails', async () => {
  let enqueued = false;
  const result = await queuePendingEpisodes({
    context: {
      project: { slug: 'capi', name: 'Capi' },
      provider: 'flow',
      kind: 'thumbnail',
      episodes: [{ code: 'EP0121', title: 'Pending' }],
    },
    loadAssets: async () => { throw new Error('Thumbnail status unavailable. No images were queued.'); },
    enqueue: async () => { enqueued = true; return { ok: true, added: 1 }; },
  });

  assert.equal(enqueued, false);
  assert.deepEqual(result, {
    queued: 0,
    episodes: 0,
    failures: [{ code: 'EP0121', error: 'Thumbnail status unavailable. No images were queued.' }],
    kind: 'thumbnail',
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

test('every web-provider bridge persists a background checkpoint on request', async () => {
  const bridges = [
    ['aistudio', 'AISTUDIO'],
    ['qwen', 'QWEN'],
    ['leonardo', 'LEONARDO'],
    ['chatgpt', 'CHATGPT'],
  ];
  for (const [file, globalName] of bridges) {
    const messages = [];
    const context = {
      globalThis: null,
      chrome: {
        runtime: {
          onMessage: { addListener() {} },
          async sendMessage(message) {
            messages.push(message);
            return { ok: true };
          },
        },
      },
      setTimeout() { return 0; },
    };
    context.globalThis = context;
    runInNewContext(source(`src/content/${file}.js`), context);

    await context[`__STORY_STUDIO_${globalName}_CHECKPOINT__`]('token-1');

    assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{
      type: 'providerSubmissionCheckpoint',
      token: 'token-1',
    }]);
  }
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

test('background terminalizes every unresolved provider checkpoint before any replay branch', () => {
  const background = source('src/background.js');
  assert.match(background, /submitted:\s*res\?\.submitted/);

  const send = background.slice(background.indexOf('async function send'), background.indexOf('async function refreshFlowModels'));
  const replayGate = send.indexOf('submissionGate.canReplayTransport');
  const restore = send.indexOf('restoreProviderScripts', replayGate);
  assert.ok(replayGate >= 0 && restore > replayGate, 'content-script restoration must stop after a durable checkpoint');

  const queue = background.slice(background.indexOf('async function processQueue'), background.indexOf('// Drop everything not yet started'));
  const ambiguous = queue.indexOf('isAmbiguousProviderFailure');
  const limit = queue.indexOf('isKnownPreSubmitLimit');
  const reload = queue.indexOf('isTabReloadError(e)');
  const retry = queue.indexOf('cd.autoResume && cd.retries');
  assert.ok(ambiguous >= 0 && limit > ambiguous, 'a durable checkpoint must win over provider limit handling');
  assert.ok(reload > ambiguous, 'ambiguity must precede tab reload retry');
  assert.ok(retry > ambiguous, 'ambiguity must precede configured retry');
  assert.match(queue, /!providerAttempted && isTabReloadError/);
  assert.match(queue, /!providerAttempted && !modelVerificationFailed/);
});

test('attempt-scoped conversational limits carry explicit rejection proof', () => {
  for (const file of ['qwen', 'chatgpt']) {
    const adapter = source(`src/content/${file}-main.js`);
    const bridge = source(`src/content/${file}.js`);
    assert.match(adapter, /\.limit = true;[\s\S]{0,120}providerRejectedBeforeGeneration = true/);
    assert.match(bridge, /providerRejectedBeforeGeneration:\s*error\.providerRejectedBeforeGeneration === true/);
  }
});

test('queue-all uses a declared project target and records response and thrown failures', () => {
  const popup = source('src/popup/popup.js');
  const queueAll = popup.slice(popup.indexOf('async function queueAllPending'), popup.indexOf('async function onProjectChange'));
  const queueAllLib = source('src/lib/queue-all.js');

  assert.match(queueAllLib, /target:\s*'project'/);
  assert.doesNotMatch(queueAllLib, /^\s*target,\s*$/m);
  assert.match(queueAllLib, /if \(!response\?\.ok\)/);
  assert.match(queueAllLib, /failures\.push/);
  assert.match(queueAll, /summarizeQueueAll/);
});

test('queue-all batches thumbnail prompts and respects thumbnail completion', () => {
  const popup = source('src/popup/popup.js');
  const queueAll = popup.slice(popup.indexOf('async function queueAllPending'), popup.indexOf('async function onProjectChange'));

  assert.doesNotMatch(queueAll, /Queue all pending[^\n]+is for scene images/);
  assert.match(queueAll, /pendingEpisodeRows/);
  assert.match(queueAll, /thumbnailAvailability/);
  assert.match(queueAll, /do not have Thumbnail Prompts in Story Studio yet/);
  assert.match(queueAll, /loadThumbnails/);
  assert.match(queueAll, /queuePendingEpisodes/);
  assert.match(queueAll, /kind === 'thumbnail'/);
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
  assert.match(queueAll, /pendingEpisodeRows\(episodes, kind\)/);
  assert.doesNotMatch(queueAll, /status\.images/);
  assert.match(queueAll, /loadScenePlan/);
});

test('episode loading keeps Story Studio aggregates instead of recounting every Scene Review', () => {
  const popup = source('src/popup/popup.js');
  const projectChange = popup.slice(popup.indexOf('async function onProjectChange'), popup.indexOf('// ── scenes'));
  const settledRefresh = popup.slice(popup.indexOf('async function refreshSettledEpisodes'), popup.indexOf('// ── scenes'));

  assert.match(projectChange, /scene_images: episode\.scene_images/);
  assert.match(projectChange, /thumbnail_images: episode\.thumbnail_images/);
  assert.doesNotMatch(projectChange, /client\.sceneReview/);
  assert.doesNotMatch(projectChange, /fetchEpisodeCounts|episodeCountRun/);
  assert.match(settledRefresh, /client\.episodeStatus/);
  assert.doesNotMatch(settledRefresh, /client\.listEpisodes/);
  assert.match(settledRefresh, /Promise\.allSettled/);
  assert.match(settledRefresh, /updateEpisodeOptions/);
  assert.doesNotMatch(settledRefresh, /renderEpisodeOptions/);
  assert.doesNotMatch(settledRefresh, /nextElementSibling/);
  assert.match(settledRefresh, /episodeRefreshQueue\.complete\(result\.completed\)/);
  assert.match(settledRefresh, /episodeRefreshQueue\.defer\(result\.failed/);
  assert.equal((projectChange.match(/applyEpisodeFilter\(\)/g) || []).length, 1);
  assert.ok(
    projectChange.indexOf('settings.lastEpisode') < projectChange.indexOf('applyEpisodeFilter()'),
    'the active filter must validate the restored episode selection',
  );
  assert.doesNotMatch(popup, /async function fetchEpisodeCounts|episodeCountRun|allEpisodes\.find|setTimeout\(r, 120\)/);
});

test('thumbnail mode wires the aggregate thumbnail filter without per-episode Scene Review requests', () => {
  const popup = source('src/popup/popup.js');
  const wire = popup.slice(popup.indexOf('function wire()'), popup.indexOf('// ── settings'));
  const projectChange = popup.slice(popup.indexOf('async function onProjectChange'), popup.indexOf('// ── scenes'));
  const filter = popup.slice(popup.indexOf('function applyEpisodeFilter'), popup.indexOf('function clearLoadedEpisodeAssets'));
  const clear = popup.slice(popup.indexOf('function clearLoadedEpisodeAssets'), popup.indexOf('// Queue every missing scene'));
  const mediaChange = popup.slice(popup.indexOf('async function onMediaTypeChange'), popup.indexOf('// ── confirm'));

  assert.match(popup, /episodeFilterState/);
  assert.match(projectChange, /thumbnail_images/);
  assert.match(projectChange, /clearLoadedEpisodeAssets\(\)/);
  assert.match(filter, /currentKind\(\)/);
  assert.match(filter, /progressByCode/);
  assert.match(filter, /episodeProgressLabel\(progress\)/);
  assert.match(mediaChange, /applyEpisodeFilter\(\)/);
  assert.match(mediaChange, /if \(!\$\('episode'\)\.value\)/);
  assert.match(mediaChange, /clearLoadedEpisodeAssets\(\)/);
  assert.match(mediaChange, /noEpisodeStatus\(loadedKind\)/);
  assert.match(projectChange, /setStatus\(noEpisodeStatus\(currentKind\(\)\), 'info'\)/);
  assert.match(mediaChange, /if \(hadLoadedEpisode\) \{/);
  assert.doesNotMatch(mediaChange, /currentKind\(\) !== loadedKind/);
  assert.match(clear, /\$\('loadScenes'\)\.disabled = false/);
  assert.match(clear, /\$\('refreshScenes'\)\.disabled = false/);
  assert.match(wire, /\$\('episode'\)\.onchange = \(\) =>/);
  assert.match(wire, /visibleEpisodeIndex\.has/);
  assert.match(wire, /clearLoadedEpisodeAssets\(\)/);
  assert.match(wire, /res\?\.completedEpisodes/);
  assert.match(wire, /episodeRefreshQueue\.add/);
  assert.doesNotMatch(filter, /client\.(imageStatus|imagePrompts|sceneReview)/);
});

test('one load image prompts action covers scene and thumbnail modes', () => {
  const popupHtml = source('src/popup/popup.html');
  const popup = source('src/popup/popup.js');
  const loader = popup.slice(popup.indexOf('async function loadScenes()'), popup.indexOf('// Thumbnails always'));

  assert.equal((popupHtml.match(/id="loadScenes"/g) || []).length, 1);
  assert.match(popupHtml, /id="loadScenes"[^>]*>Load image prompts<\/button>/);
  assert.doesNotMatch(popupHtml, />Load scenes<\/button>/);
  assert.match(loader, /kind === 'thumbnail'/);
  assert.match(loader, /loadThumbnails/);
  assert.match(loader, /loadScenePlan/);
  const thumbnailLoader = popup.slice(popup.indexOf('async function loadThumbnails'), popup.indexOf('const PROVIDER_LABEL'));
  assert.match(thumbnailLoader, /await client\.imageStatus/);
  assert.match(thumbnailLoader, /did not return verifiable thumbnail status/);
  assert.doesNotMatch(thumbnailLoader, /status optional/);
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
  assert.ok(terminal > guard && terminal < queue.indexOf('isAmbiguousProviderFailure'));
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

test('Flow discovery is read-only and lists only the models the Flow picker shows', () => {
  const flow = source('src/lib/flow-exec.js');
  const list = flow.slice(flow.indexOf('const listImageModels'), flow.indexOf('const preparedRequests'));
  assert.match(list, /KNOWN_MODELS/);
  assert.doesNotMatch(list, /fetch\(|rpc\(/);
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

test('Flow model discovery never touches the network and yields the known picker models', async () => {
  const fetches = [];
  const context = {
    window: {},
    document: { querySelector() { return null; }, querySelectorAll() { return []; } },
    location: { pathname: '/project/12345678-1234-1234-1234-123456789abc', href: 'https://flow.google.com/project/12345678-1234-1234-1234-123456789abc' },
    fetch(...args) {
      fetches.push(args);
      throw new Error('read-only discovery must not fetch');
    },
  };
  const command = runInNewContext(`(${flowCommand.toString()})`, context);
  const listed = await command({ op: 'listImageModels', payload: {} });
  assert.equal(listed.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(flowInventoryResult(listed.result.entries))), {
    source: 'live',
    models: [
      { modelId: 'GEM_PIX_2', modelLabel: 'Nano Banana Pro' },
      { modelId: 'NARWHAL', modelLabel: 'Nano Banana 2' },
      { modelId: 'HARBOR_SEAL', modelLabel: 'Nano Banana 2 Lite' },
    ],
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
  const identity = leonardo.slice(leonardo.indexOf('function selectedModelIdentity'), leonardo.indexOf('function assertExpectedModel'));
  const context = leonardo.slice(leonardo.indexOf('function getContext'), leonardo.indexOf('async function generateImage'));
  assert.match(identity, /searchParams\.get\('model'\)/);
  assert.match(identity, /stable:\s*Boolean\(selectedModel\)/);
  assert.match(context, /const modelIdentity = selectedModelIdentity\(\)/);
  assert.match(context, /^\s*modelIdentity,\s*$/m);
});

test('Flow generation accepts only the queued exact model ID', () => {
  const flow = source('src/lib/flow-exec.js');
  const prepare = flow.slice(flow.indexOf('const prepareGenerateImage'), flow.indexOf('const submitPreparedImage'));
  const submit = flow.slice(flow.indexOf('const submitPreparedImage'), flow.indexOf('const generateImage'));
  assert.match(prepare, /payload\.modelId/);
  assert.match(prepare, /preparedRequests\.set/);
  assert.match(submit, /prepared\.modelId,/);
  assert.doesNotMatch(`${prepare}\n${submit}`, /payload\.model\b/);
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
  assert.equal((background.match(/recoverInterruptedQueue\(/g) || []).length, 1);
  const migration = source('src/lib/queue-migration.js');
  const migrate = migration.slice(migration.indexOf('export function migrateQueue'), migration.indexOf('export function canRetryItem'));
  assert.doesNotMatch(migrate, /recoveryEvidenceQueueItem|ambiguousRecoveryQueueItem/);
});

test('Fleet queue mutations compare revisions inside the atomic queue boundary', () => {
  const background = source('src/background.js');
  const heartbeat = background.slice(background.indexOf('async function fleetHeartbeat'), background.indexOf('async function executeFleetCommand'));
  const command = background.slice(background.indexOf('async function executeFleetCommand'), background.indexOf('setInterval'));
  const pauseResume = background.slice(background.indexOf('async function resumeQueue'), background.indexOf('chrome.runtime.onMessage'));

  assert.match(heartbeat, /queueStore\.snapshot\(\)/);
  assert.doesNotMatch(heartbeat, /getQueueRevision\(\)/);
  assert.ok((background.match(/updateIfRevision/g) || []).length >= 4);
  assert.match(command, /expectedRevision:\s*command\.expectedQueueRevision/);
  assert.match(command, /clearPendingFromFleet\(command\.expectedQueueRevision\)/);
  assert.match(command, /retryFleetSafeFailed\(command\.expectedQueueRevision\)/);
  assert.doesNotMatch(command, /expectedQueueRevision[^\n]+await getQueueRevision/);
  assert.match(pauseResume, /touch:\s*true/);
});

test('popup and options route settings patches through the background owner', () => {
  const background = source('src/background.js');
  const popup = source('src/popup/popup.js');
  const options = source('src/options/options.js');
  const config = source('src/lib/config.js');

  assert.match(background, /createSettingsStore/);
  assert.match(background, /case 'settings:patch'/);
  assert.match(config, /settingsMessage\('settings:patch', patch\)/);
  assert.doesNotMatch(popup, /chrome\.storage\.sync\.set/);
  assert.doesNotMatch(options, /chrome\.storage\.sync\.set/);
});

test('provider generation dispatch carries queued identity and a checkpoint token', () => {
  const background = source('src/background.js');
  const generate = background.slice(background.indexOf('async function generateAndSave'), background.indexOf('// ── status'));

  assert.match(background, /createSubmissionGate/);
  assert.match(background, /providerSubmissionCheckpoint/);
  assert.equal((generate.match(/dispatchProviderGeneration\(/g) || []).length, 4);
  assert.match(generate, /prepareGenerateImage/);
  assert.match(generate, /dispatchFlowGeneration/);
  assert.match(background, /flow:submitGenerateImage/);
});

test('all visible adapters recheck queued identity before checkpoint and click', () => {
  for (const [file, click] of [
    ['src/content/aistudio-main.js', 'run.click()'],
    ['src/content/qwen-main.js', 'send.click()'],
    ['src/content/leonardo-main.js', 'button.click()'],
    ['src/content/chatgpt-main.js', 'button.click()'],
    ['src/content/chatgpt-main.js', "el.dispatchEvent(new KeyboardEvent('keydown'"],
  ]) {
    const adapter = source(file);
    assert.match(adapter, /params\.expectedModel/);
    assert.match(adapter, /CHECKPOINT/);
    const clickAt = adapter.indexOf(click);
    const checkpoint = adapter.lastIndexOf('await requestSubmissionCheckpoint', clickAt);
    const precheck = adapter.lastIndexOf('assertExpectedModel', checkpoint);
    const finalCheck = adapter.indexOf('assertExpectedModel', checkpoint);
    assert.ok(precheck >= 0 && precheck < checkpoint, `${file} verifies before checkpoint`);
    assert.ok(finalCheck > checkpoint && finalCheck < clickAt, `${file} rechecks after checkpoint`);
    assert.doesNotMatch(adapter.slice(finalCheck, clickAt), /\bawait\b/, `${file} final recheck is synchronous with click`);
  }
});

test('modal enqueue callbacks consume captured project and episode payloads', () => {
  const popup = source('src/popup/popup.js');
  const confirm = popup.slice(popup.indexOf('function confirmQueue'), popup.indexOf('// ── queue view'));
  const queueAll = popup.slice(popup.indexOf('async function queueAllPending'), popup.indexOf('async function onProjectChange'));

  assert.match(popup, /captureSceneEnqueueContext/);
  assert.match(popup, /captureQueueAllContext/);
  assert.doesNotMatch(confirm, /payload:\s*\{[\s\S]*currentProject\./);
  assert.doesNotMatch(confirm, /payload:\s*\{[\s\S]*currentEpisode\./);
  assert.doesNotMatch(queueAll, /currentProject\.slug/);
});

test('Flow confirmation names the selected model and its actual provenance', () => {
  const popup = source('src/popup/popup.js');
  const confirm = popup.slice(popup.indexOf('function confirmQueue'), popup.indexOf('async function doEnqueue'));
  const enqueue = popup.slice(popup.indexOf('async function doEnqueue'), popup.indexOf('// ── queue view'));
  const background = source('src/background.js');

  assert.match(confirm, /modelLabel/);
  assert.match(confirm, /flowModelApproval\.modelSource/);
  assert.match(confirm, /flowModelApproval/);
  assert.match(enqueue, /persistFlowModelApproval\(payload\.flowModelApproval\)/);
  assert.match(background, /assertFlowModelApproval\(flowModelApproval, modelSnapshot\)/);
  assert.doesNotMatch(confirm, /Nano Banana 2 \(free\)/);
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

function flowRpcBody(rpcId, result) {
  const row = JSON.stringify([['wrb.fr', rpcId, JSON.stringify(result), null, null, null, 'generic']]);
  return `)]}'\n\n${row.length}\n${row}\n`;
}
const flowGeneration = [[['media-id', null, 'workflow-id', null, null, null, [[null, 7, null, null, null, null, 1, 'A moonlit lake', 25, null, null, 'workflow-id', null, 'https://flow-content.google/image/media-id?sig=1', 3]], null, [1376, 768]]]];
function flowContext(events, { rpcStatus = 200 } = {}) {
  return {
    window: {
      WIZ_global_data: { SNlM0e: 'anti-forgery', FdrFJe: 'session-id', cfb2h: 'build' },
      grecaptcha: {
        enterprise: {
          ready(callback) { callback(); },
          execute() {
            events.push('recaptcha');
            return Promise.resolve('fresh-token');
          },
        },
      },
    },
    document: { querySelector() { return null; }, querySelectorAll() { return []; } },
    location: { pathname: '', href: 'https://flow.google.com/' },
    crypto,
    Math,
    Date,
    URL,
    URLSearchParams,
    Uint8Array,
    btoa,
    setTimeout,
    fetch: async (url, init) => {
      if (String(url).includes('/batchexecute?')) {
        events.push('generation-request');
        assert.equal(init.headers['X-Same-Domain'], '1');
        assert.match(String(init.body), /^f\.req=.*&at=anti-forgery$/);
        if (rpcStatus !== 200) return { ok: false, status: rpcStatus, text: async () => 'reCAPTCHA evaluation failed' };
        return { ok: true, status: 200, text: async () => flowRpcBody('ogiZ0b', flowGeneration) };
      }
      if (String(url).startsWith('https://flow-content.google/image/media-id')) {
        events.push('download');
        return {
          ok: true,
          headers: { get: (name) => name === 'content-type' ? 'image/png' : null },
          arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  };
}

test('Flow prepares read-only state before persisting ambiguity and submits only afterward', async () => {
  const events = [];
  const execute = runInNewContext(`(${flowCommand.toString()})`, flowContext(events));
  const payload = {
    projectId: '12345678-1234-1234-1234-123456789abc',
    prompt: 'A moonlit lake',
    modelId: 'NARWHAL',
    aspectRatio: '16:9',
    recaptchaMaxAttempts: 4,
  };

  const prepared = await execute({ op: 'prepareGenerateImage', payload });
  assert.equal(prepared.ok, true);
  assert.deepEqual(events, ['recaptcha']);

  events.push('persist-checkpoint');
  const submitted = await execute({
    op: 'submitGenerateImage',
    payload: { preparationId: prepared.result.preparationId },
  });

  assert.equal(submitted.ok, true, submitted.error);
  assert.equal(submitted.result.mediaId, 'media-id');
  assert.deepEqual([submitted.result.width, submitted.result.height], [1376, 768]);
  assert.deepEqual(events, ['recaptcha', 'persist-checkpoint', 'generation-request', 'download']);
});

test('Flow marks an explicit reCAPTCHA rejection as proven safe to re-pend', async () => {
  const events = [];
  const execute = runInNewContext(`(${flowCommand.toString()})`, flowContext(events, { rpcStatus: 403 }));
  const prepared = await execute({
    op: 'prepareGenerateImage',
    payload: {
      projectId: '12345678-1234-1234-1234-123456789abc',
      prompt: 'A moonlit lake',
      modelId: 'NARWHAL',
      aspectRatio: '16:9',
      recaptchaMaxAttempts: 1,
    },
  });
  const result = await execute({
    op: 'submitGenerateImage',
    payload: { preparationId: prepared.result.preparationId },
  });

  assert.equal(result.ok, false);
  assert.equal(result.providerRejectedBeforeGeneration, true);
  assert.match(result.error, /reCAPTCHA failed/i);

  const background = source('src/background.js');
  const process = background.slice(background.indexOf('async function processQueue'), background.indexOf('// Drop everything not yet started'));
  const proof = process.indexOf("provider !== 'leonardo' && providerAttempted && e?.providerRejectedBeforeGeneration");
  const clear = process.indexOf('delete current.providerAttempted', proof);
  const ambiguity = process.indexOf('isAmbiguousProviderFailure', clear);
  assert.ok(proof >= 0 && clear > proof && ambiguity > clear);
  assert.match(background, /providerRejectedBeforeGeneration:\s*res\?\.providerRejectedBeforeGeneration === true/);
  assert.doesNotMatch(background, /providerRejectedBeforeGeneration:\s*!!res\?\.limit/);
  assert.match(process, /if \(providerActionAttempted\) await setNextProviderRun/);
});

test('active metadata reads the queued snapshot', () => {
  const popup = source('src/popup/popup.js');
  const status = popup.slice(popup.indexOf('function updateGenStatus'), popup.indexOf('let lastQueueSig'));
  assert.match(status, /displayItem\.modelSnapshot/);
  assert.match(status, /modelSnapshotDiagnostic/);
  assert.doesNotMatch(status, /settings\?\.imageModel/);
});

test('Flow model options refresh from the runtime inventory', () => {
  const popup = source('src/popup/popup.js');
  const flow = popup.slice(popup.indexOf('async function refreshFlowModels'), popup.indexOf('function qwenPopulate'));
  const html = source('src/popup/popup.html');

  assert.match(flow, /type:\s*'refreshFlowModels'/);
  assert.match(flow, /option\.value = modelId/);
  assert.match(flow, /option\.textContent = modelLabel/);
  assert.match(flow, /flowModelSource/);
  assert.match(html, /id="refreshFlowModels"/);
  assert.doesNotMatch(html, /value="nano-banana-2"/);
});

test('Flow persists a live-only rendered selection with its exact identity', () => {
  const popup = source('src/popup/popup.js');
  const change = popup.slice(popup.indexOf("$('flowImageModel').onchange"), popup.indexOf("$('refreshFlowModels').onclick"));
  const refresh = popup.slice(popup.indexOf('async function refreshFlowModels'), popup.indexOf('function flowPopulate'));
  const selection = popup.slice(popup.indexOf('function selectedFlowModelApproval'), popup.indexOf('function emptyFlowModelSettings'));
  const persist = popup.slice(popup.indexOf('function persistFlowModelApproval'), popup.indexOf('async function refreshFlowModels'));

  assert.match(popup, /let currentFlowModels = \[\]/);
  assert.match(popup, /let currentFlowModelSource = 'fallback'/);
  assert.match(change, /persistSelectedFlowModel/);
  assert.match(selection, /currentFlowModels\.find/);
  assert.doesNotMatch(selection, /flowModels\(\)\.find/);
  assert.match(refresh, /currentFlowModels = models\.map/);
  assert.match(selection, /modelSource: currentFlowModelSource/);
  assert.match(persist, /flowModelSettings\(approval, approval\.modelSource\)/);
  assert.match(persist, /persistFlowModelApproval\(selectedFlowModelApproval\(\)\)/);
});

test('every Flow enqueue waits for the serialized selection boundary', () => {
  const popup = source('src/popup/popup.js');
  const standalone = popup.slice(popup.indexOf('async function queueStandalone'), popup.indexOf('function parseStandalonePrompts'));
  const queueAll = popup.slice(popup.indexOf('async function queueAllPending'), popup.indexOf('async function onProjectChange'));
  const enqueue = popup.slice(popup.indexOf('async function doEnqueue'), popup.indexOf('// ── queue view'));

  assert.ok(standalone.indexOf('await persistSelectedFlowModel()') < standalone.indexOf('chrome.runtime.sendMessage'));
  assert.ok(enqueue.indexOf('await persistFlowModelApproval(payload.flowModelApproval)') < enqueue.indexOf('chrome.runtime.sendMessage'));
  assert.ok(queueAll.indexOf('await persistFlowModelApproval(approved.flowModelApproval)') < queueAll.indexOf('queuePendingEpisodes'));
});

test('Flow refresh preserves a rendered live selection after a delayed save', () => {
  const popup = source('src/popup/popup.js');
  const refresh = popup.slice(popup.indexOf('async function refreshFlowModels'), popup.indexOf('function flowPopulate'));
  const wait = refresh.indexOf('await flowModelSaveTail');
  const rendered = refresh.indexOf('const renderedSelection =');
  const previous = refresh.indexOf('const previous =');
  const inventory = refresh.indexOf('currentFlowModels = models.map');
  const replace = refresh.indexOf('select.replaceChildren');

  assert.ok(wait >= 0 && wait < rendered, 'refresh waits for B before reading the rendered selection');
  assert.match(refresh, /currentFlowModels\.some\(\(model\) => model\.modelId === select\.value\)/);
  assert.match(refresh, /const previous = renderedSelection \|\| selectedFlowModelId\(\)/);
  assert.ok(inventory < previous, 'legacy friendly IDs resolve against the newly returned inventory');
  assert.ok(previous < replace, 'refresh preserves B before rendering the returned inventory');
});

test('README documents Flow and Leonardo live discovery where applicable', () => {
  const readme = source('README.md');
  assert.match(readme, /Flow and Leonardo are live-discovered where applicable/i);
});

test('Flow disables model selection throughout refresh and leaves an empty inventory disabled', () => {
  const popup = source('src/popup/popup.js');
  const refresh = popup.slice(popup.indexOf('async function refreshFlowModels'), popup.indexOf('function flowPopulate'));
  const disable = refresh.indexOf('select.disabled = true');
  const request = refresh.indexOf("chrome.runtime.sendMessage({ type: 'refreshFlowModels' })");
  const render = refresh.indexOf('select.replaceChildren');
  const persist = refresh.indexOf('await persistSelectedFlowModel()');

  assert.ok(disable >= 0 && disable < request && request < render && render < persist);
  assert.match(refresh, /select\.disabled = currentFlowModels\.length === 0/);
  assert.match(refresh, /if \(!currentFlowModels\.length\)\s*\{\s*select\.selectedIndex = -1/);
});
