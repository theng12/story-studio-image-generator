import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { flowCommand } from '../src/lib/flow-exec.js';
import { flowInventoryResult, snapshotProviderModel } from '../src/lib/model-identity.js';

const entries = [{ id: 'FLOW_CAPTURED_01', label: 'Provider capture' }];

test('unattributed, bundled and cached records cannot promote themselves to live inventory', () => {
  for (const source of [undefined, 'fallback', 'cached', 'unknown']) {
    const inventory = flowInventoryResult(entries, source);
    assert.equal(inventory.source, 'fallback');
    assert.equal(inventory.models.some(({ modelId }) => modelId === 'FLOW_CAPTURED_01'), false);
    assert.equal(inventory.models.find(({ modelId }) => modelId === 'HARBOR_SEAL').modelLabel, 'Nano Banana 2 Lite');
  }
});

test('explicit captured inventory keeps exact IDs and labels; an empty capture is fallback', () => {
  const captured = flowInventoryResult([...entries, ...entries, { id: 'Display label', label: 'invalid' }], 'live');
  assert.deepEqual(captured, { source: 'live', models: [{ modelId: 'FLOW_CAPTURED_01', modelLabel: 'Provider capture' }] });
  assert.equal(snapshotProviderModel({ provider: 'flow', configuredModel: 'FLOW_CAPTURED_01', flowInventory: captured }).modelSource, 'live');
  assert.equal(flowInventoryResult([], 'live').source, 'fallback');
});

test('real serialized Flow helper never calls the provider for inventory and stays fallback without a visible page', async () => {
  for (const signedIn of [false, true]) {
    let reads = 0;
    const command = runInNewContext(`(${flowCommand.toString()})`, {
      window: signedIn ? { WIZ_global_data: { SNlM0e: 'fixture-only' } } : {},
      location: { pathname: '/project/12345678-1234-1234-1234-123456789abc' },
      fetch() { reads++; throw new Error('Inventory must not call the provider.'); },
    });
    const result = await command({ op: 'listImageModels' });
    assert.equal(result.ok, true);
    assert.equal(result.result.source, 'fallback');
    assert.equal(result.result.entries.length, 0);
    assert.equal(flowInventoryResult(result.result.entries, result.result.source).source, 'fallback');
    assert.equal(reads, 0);
  }
});

test('a bundled model counts as live only while the signed-in page shows its exact label', async () => {
  const locate = { pathname: '/project/12345678-1234-1234-1234-123456789abc' };
  const body = { innerText: 'New project\nNano Banana 2 Lite\nNano Banana Pro\nCreate\nNano Banana 2 Lite' };
  const signedIn = runInNewContext(`(${flowCommand.toString()})`, {
    window: { WIZ_global_data: { SNlM0e: 'fixture-only' } }, location: locate, document: { body },
  });
  const result = await signedIn({ op: 'listImageModels' });
  assert.equal(result.result.source, 'live');
  assert.equal(result.result.projectId, '12345678-1234-1234-1234-123456789abc');
  // Observed labels only, in catalog order, with our own keys.
  assert.deepEqual(Array.from(result.result.entries, ({ id }) => id), ['GEM_PIX_2', 'HARBOR_SEAL']);
  assert.equal(flowInventoryResult(result.result.entries, result.result.source).source, 'live');

  const signedOut = runInNewContext(`(${flowCommand.toString()})`, { window: {}, location: locate, document: { body } });
  const outResult = await signedOut({ op: 'listImageModels' });
  assert.equal(outResult.result.source, 'fallback');
  assert.equal(outResult.result.entries.length, 0);
});
