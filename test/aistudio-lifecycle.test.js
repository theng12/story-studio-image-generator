import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const adapterSource = readFileSync(path.join(root, 'src/content/aistudio-main.js'), 'utf8');
const bridgeSource = readFileSync(path.join(root, 'src/content/aistudio.js'), 'utf8');

function adapterHarness({ historicalErrors = [], newErrorAfterClick = '', returnImage = true } = {}) {
  let clock = 0;
  let clicks = 0;
  let generatedImage = null;
  const errorElements = historicalErrors.map(errorElement);
  const visible = {
    getBoundingClientRect: () => ({ width: 120, height: 32 }),
  };

  class TextArea {
    dispatchEvent() {}
    focus() {}
    getBoundingClientRect() { return visible.getBoundingClientRect(); }
  }
  Object.defineProperty(TextArea.prototype, 'value', {
    get() { return this._value || ''; },
    set(value) { this._value = value; },
  });

  const textarea = new TextArea();
  const run = {
    ...visible,
    textContent: 'Run',
    getAttribute() { return ''; },
    click() {
      clicks++;
      if (newErrorAfterClick) errorElements.push(errorElement(newErrorAfterClick));
      if (returnImage) {
        generatedImage = {
          src: 'data:image/png;base64,AQID',
          naturalWidth: 512,
        };
      }
    },
  };
  const model = {
    ...visible,
    textContent: 'AI Studio Image',
    getAttribute(name) {
      if (name === 'data-model-id') return 'ai-image';
      return '';
    },
  };
  const document = {
    body: { innerText: '' },
    get images() { return generatedImage ? [generatedImage] : []; },
    querySelector(selector) {
      if (selector === 'textarea[aria-label="Enter a prompt"]') return textarea;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'textarea') return [textarea];
      if (selector === 'button') return [run];
      if (selector === 'button, [role="button"]') return [run];
      if (selector.includes('[data-model-id]')) return [model];
      if (selector.includes('.chat-turn-container.model')) return errorElements;
      return [];
    },
  };
  const context = {
    document,
    globalThis: null,
    HTMLTextAreaElement: TextArea,
    Event: class Event { constructor(type) { this.type = type; } },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    Date: { now: () => clock },
    setTimeout(callback, ms) {
      clock += ms;
      queueMicrotask(callback);
      return 0;
    },
    queueMicrotask,
  };
  context.globalThis = context;
  context.__STORY_STUDIO_AISTUDIO_CHECKPOINT__ = async () => {};
  runInNewContext(adapterSource, context);

  return {
    clicks: () => clicks,
    generate: () => context.__STORY_STUDIO_AISTUDIO_CALL__('generateImage', {
      prompt: 'A quiet mountain lake',
      aspectRatio: '16:9',
      references: [],
      expectedModel: {
        modelId: 'ai-image',
        modelLabel: 'AI Studio Image',
        modelSource: 'live',
      },
      submissionToken: 'submission-token',
    }),
  };
}

function errorElement(text) {
  return {
    textContent: text,
    closest() { return null; },
    getBoundingClientRect() { return { width: 120, height: 32 }; },
  };
}

test('AI Studio ignores a stale historical quota message after the new click', async () => {
  const adapter = adapterHarness({ historicalErrors: ['Quota exceeded yesterday'] });

  const result = await adapter.generate();

  assert.equal(result.mime, 'image/png');
  assert.equal(adapter.clicks(), 1);
});

test('AI Studio marks only a new attempt-scoped quota rejection as safe', async () => {
  const adapter = adapterHarness({
    historicalErrors: ['Quota exceeded yesterday'],
    newErrorAfterClick: 'Resource exhausted for this request',
    returnImage: false,
  });

  await assert.rejects(adapter.generate(), (error) => {
    assert.equal(error.limit, true);
    assert.equal(error.providerRejectedBeforeGeneration, true);
    return true;
  });
  assert.equal(adapter.clicks(), 1);
});

test('AI Studio bridge forwards explicit provider rejection proof', async () => {
  let listener;
  const context = {
    globalThis: null,
    chrome: {
      runtime: {
        onMessage: { addListener(value) { listener = value; } },
        sendMessage: async () => ({ ok: true }),
      },
    },
    setTimeout() { return 0; },
  };
  context.globalThis = context;
  context.__STORY_STUDIO_AISTUDIO_CALL__ = async () => {
    throw Object.assign(new Error('AI Studio rejected this request'), {
      limit: true,
      providerRejectedBeforeGeneration: true,
    });
  };
  runInNewContext(bridgeSource, context);

  const response = await new Promise((resolve) => {
    listener({ type: 'aistudio:generateImage', params: {} }, {}, resolve);
  });

  assert.equal(response.ok, false);
  assert.equal(response.limit, true);
  assert.equal(response.providerRejectedBeforeGeneration, true);
});
