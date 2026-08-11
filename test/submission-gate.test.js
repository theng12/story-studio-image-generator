import assert from 'node:assert/strict';
import test from 'node:test';

import { createSubmissionGate } from '../src/lib/submission-gate.js';

test('submission checkpoint is persisted only at the final provider-action boundary', async () => {
  const events = [];
  const gate = createSubmissionGate({
    createToken: () => 'checkpoint-token',
    persist: async ({ itemId, provider }) => {
      events.push(`persist:${itemId}:${provider}`);
    },
  });
  const request = gate.arm({ itemId: 'item-1', provider: 'qwen', tabId: 42 });

  events.push('read-context');
  events.push('download-reference');
  events.push('validate-model');
  assert.equal(request.checkpointed, false);
  assert.deepEqual(events, ['read-context', 'download-reference', 'validate-model']);

  await gate.checkpoint({ token: request.token, tabId: 42 });
  events.push('click');

  assert.equal(request.checkpointed, true);
  assert.deepEqual(events, [
    'read-context',
    'download-reference',
    'validate-model',
    'persist:item-1:qwen',
    'click',
  ]);
});

test('submission checkpoint rejects an unarmed or wrong-tab request without persisting', async () => {
  let writes = 0;
  const gate = createSubmissionGate({
    createToken: () => 'checkpoint-token',
    persist: async () => { writes++; },
  });
  gate.arm({ itemId: 'item-1', provider: 'chatgpt', tabId: 7 });

  await assert.rejects(gate.checkpoint({ token: 'missing', tabId: 7 }), /not armed/i);
  await assert.rejects(gate.checkpoint({ token: 'checkpoint-token', tabId: 8 }), /provider tab/i);
  assert.equal(writes, 0);
});

test('checkpointed provider transport cannot be replayed after a disconnect', async () => {
  const gate = createSubmissionGate({
    createToken: () => 'checkpoint-token',
    persist: async () => {},
  });
  const request = gate.arm({ itemId: 'item-1', provider: 'aistudio', tabId: 9 });

  assert.equal(gate.canReplayTransport(request.token), true);
  await gate.checkpoint({ token: request.token, tabId: 9 });
  assert.equal(gate.canReplayTransport(request.token), false);
});
