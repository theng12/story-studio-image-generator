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

test('real serialized Flow helper reports bundled provenance regardless of open or signed-in tab', async () => {
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
    assert.equal(result.result.entries.find(({ id }) => id === 'HARBOR_SEAL').label, 'Nano Banana 2 Lite');
    assert.equal(flowInventoryResult(result.result.entries, result.result.source).source, 'fallback');
    assert.equal(reads, 0);
  }
});
