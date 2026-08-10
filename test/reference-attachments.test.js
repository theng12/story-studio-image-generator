import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';

import { limitProviderReferences } from '../src/lib/providers.js';

const root = path.resolve(import.meta.dirname, '..');
const source = (file) => readFileSync(path.join(root, file), 'utf8');

const references = Array.from({ length: 6 }, (_, index) => ({
  base64: `image-${index + 1}`,
  mime: 'image/png',
  name: `reference-${index + 1}.png`,
  label: `Reference ${index + 1}`,
}));

test('bounds reference bytes to each provider capability before an adapter receives them', () => {
  assert.deepEqual(limitProviderReferences('flow', references), references.slice(0, 4));
  assert.deepEqual(limitProviderReferences('aistudio', references), references.slice(0, 4));
  assert.deepEqual(limitProviderReferences('qwen', references), references.slice(0, 1));
  assert.deepEqual(limitProviderReferences('leonardo', references), []);
  assert.deepEqual(limitProviderReferences('chatgpt', references), references.slice(0, 4));
  assert.deepEqual(limitProviderReferences('removed-provider', references), []);
});

test('the worker caps resolved references before maintained adapters receive bytes', () => {
  const background = source('src/background.js');
  assert.match(background, /limitProviderReferences\(\s*provider,/);
  assert.match(background, /references:\s*await resolveReferenceImages\(item, settings, provider\)/);
});

test('Flow maps every bounded reference to Flow reference image inputs', () => {
  const background = source('src/background.js');
  assert.match(background, /referenceIds\.map\(\(name\) => \(\{ imageInputType: 'IMAGE_INPUT_TYPE_REFERENCE', name \}\)\)/);
});

test('AI Studio and ChatGPT clear then attach every reference and verify their final attachment count', () => {
  for (const file of ['src/content/aistudio-main.js', 'src/content/chatgpt-main.js']) {
    const adapter = source(file);
    assert.match(adapter, /async function attachReferences\(references\)/);
    assert.match(adapter, /await clearReferences\(\)/);
    assert.match(adapter, /for \(const reference of valid\)/);
    assert.match(adapter, /attachment count/i);
    assert.match(adapter, /params\.references/);
  }
});

test('Qwen accepts only the first bounded reference and retains its one-chip guard', () => {
  const adapter = source('src/content/qwen-main.js');
  assert.match(adapter, /const reference = Array\.isArray\(params\.references\) \? params\.references\[0\] : null/);
  assert.match(adapter, /settleToOneChip/);
});

function qwenAdapterHarness({ initialChips = [], onSleep, throwOnPaste = false } = {}) {
  let sendClicks = 0;
  let pasteEvents = 0;
  const visible = { getBoundingClientRect: () => ({ width: 100, height: 30 }) };
  const chips = [...initialChips];
  const makeChip = (removable = true) => {
    const chip = { ...visible };
    chip.querySelector = (selector) => {
      if (selector !== '.close-button') return null;
      return {
        click() {
          if (removable) chips.splice(chips.indexOf(chip), 1);
        },
      };
    };
    return chip;
  };
  for (let index = 0; index < chips.length; index++) chips[index] = makeChip(chips[index]);
  class FakeTextarea {
    constructor() {
      this._value = '';
      this.placeholder = '';
    }

    get value() {
      return this._value;
    }
    set value(value) {
      this._value = value;
    }
    focus() {}
    dispatchEvent(event) {
      if (event?.type !== 'paste') return;
      pasteEvents++;
      if (throwOnPaste) throw new Error('paste should not run');
      chips.push(makeChip(true));
    }
    getBoundingClientRect() {
      return { width: 100, height: 30 };
    }
  }
  const textarea = new FakeTextarea();
  let sendChecks = 0;
  const sendButton = {
    ...visible,
    classList: { contains: () => false },
    click() {
      sendClicks++;
    },
  };
  Object.defineProperty(sendButton, 'disabled', { get: () => sendChecks++ === 0 });
  const document = {
    body: {},
    querySelector(selector) {
      return selector === 'textarea.message-input-textarea' ? textarea : null;
    },
    querySelectorAll(selector) {
      if (selector === '.vision-item-container') return chips;
      if (selector === 'button.send-button') return [sendButton];
      return [];
    },
  };
  const context = {
    document,
    HTMLTextAreaElement: FakeTextarea,
    Event: class Event {},
    File: class File {},
    DataTransfer: class DataTransfer {
      constructor() {
        this.items = { add() {} };
      }
    },
    ClipboardEvent: class ClipboardEvent {
      constructor(type) {
        this.type = type;
      }
    },
    MutationObserver: class MutationObserver {
      observe() {}
      disconnect() {}
    },
    atob,
    URL,
    Date,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    setTimeout(callback, ms) {
      onSleep?.(ms, chips, makeChip);
      if (ms < 2000) queueMicrotask(callback);
      return 0;
    },
    clearTimeout() {},
    setInterval() {
      return 0;
    },
    clearInterval() {},
    queueMicrotask,
  };
  context.globalThis = context;
  runInNewContext(source('src/content/qwen-main.js'), context);
  return {
    generate: (params) => context.__STORY_STUDIO_QWEN_CALL__('generateImage', params),
    sendClicks: () => sendClicks,
    pasteEvents: () => pasteEvents,
  };
}

test('Qwen rejects an unremovable stale chip before sending a no-reference generation', async () => {
  const adapter = qwenAdapterHarness({ initialChips: [false] });
  const outcome = await Promise.race([
    adapter.generate({ prompt: 'A cave at dusk', references: [] }).then(
      () => ({ kind: 'resolved' }),
      (error) => ({ kind: 'rejected', error })
    ),
    delay(100).then(() => ({ kind: 'timed-out' })),
  ]);

  assert.equal(outcome.kind, 'rejected');
  assert.match(outcome.error.message, /could not clear.*reference/i);
  assert.equal(adapter.sendClicks(), 0);
});

test('Qwen rejects a stale chip that appears while Send becomes ready', async () => {
  let addedLateChip = false;
  const adapter = qwenAdapterHarness({
    onSleep(ms, chips, makeChip) {
      if (ms === 300 && !addedLateChip) {
        addedLateChip = true;
        chips.push(makeChip(false));
      }
    },
  });
  const outcome = await Promise.race([
    adapter.generate({ prompt: 'A cave at dusk', references: [] }).then(
      () => ({ kind: 'resolved' }),
      (error) => ({ kind: 'rejected', error })
    ),
    delay(100).then(() => ({ kind: 'timed-out' })),
  ]);

  assert.equal(outcome.kind, 'rejected');
  assert.match(outcome.error.message, /attachment count mismatch/i);
  assert.equal(adapter.sendClicks(), 0);
});

test('Qwen rejects an unremovable stale chip before pasting a reference', async () => {
  const adapter = qwenAdapterHarness({ initialChips: [false], throwOnPaste: true });
  const outcome = await Promise.race([
    adapter.generate({ prompt: 'A cave at dusk', references: [{ base64: 'aGVsbG8=', mime: 'image/png', name: 'reference.png' }] }).then(
      () => ({ kind: 'resolved' }),
      (error) => ({ kind: 'rejected', error })
    ),
    delay(100).then(() => ({ kind: 'timed-out' })),
  ]);

  assert.equal(outcome.kind, 'rejected');
  assert.match(outcome.error.message, /could not clear.*reference/i);
  assert.equal(adapter.pasteEvents(), 0);
  assert.equal(adapter.sendClicks(), 0);
});
