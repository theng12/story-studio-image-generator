import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyExchange, resolveRpcIds } from '../src/lib/rpc-ids.js';

const randomId = () => 'id' + Math.random().toString(36).slice(2, 8);

test('ids are discovered from observed exchanges, never assumed', () => {
  const accountId = randomId();
  const generateId = randomId();
  const observations = [
    { rpcid: accountId, request: '[["me"],[[["person.photo","person.name"]],null,[1,7,10]]]', response: '[]' },
    { rpcid: generateId, request: '[["a prompt",1]]', response: '[[["https://flow-content.google/x"]]]' },
  ];
  const { ids, sources, problems } = resolveRpcIds({ observations, fallback: {} });
  assert.equal(ids.account, accountId);
  assert.equal(ids.generate, generateId);
  assert.equal(sources.account, 'discovered');
  assert.equal(sources.generate, 'discovered');
  assert.deepEqual(problems.filter((p) => p.startsWith('account') || p.startsWith('generate')), []);
});

test('a changed id is discovered from the new page, not from the old constant', () => {
  const changed = randomId();
  const { ids, sources } = resolveRpcIds({
    observations: [{ rpcid: changed, request: '[["me"],[[["person.photo"]],null,[1]]]', response: '[]' }],
    fallback: { account: 'oldAccountId' },
  });
  assert.equal(ids.account, changed);
  assert.equal(sources.account, 'discovered');
});

test('when discovery fails the configured fallback is used and named', () => {
  const fallback = { account: randomId(), credits: randomId(), generate: randomId(), upload: randomId() };
  const { ids, sources, problems } = resolveRpcIds({ observations: [], fallback });
  assert.deepEqual(ids, fallback);
  assert.ok(Object.values(sources).every((source) => source === 'fallback'));
  assert.deepEqual(problems, []);
});

test('when both fail every missing id is named', () => {
  const { problems } = resolveRpcIds({ observations: [], fallback: { account: randomId() } });
  assert.ok(problems.some((p) => p.startsWith('generate:')));
  assert.ok(problems.some((p) => p.startsWith('upload:')));
  assert.ok(problems.some((p) => p.startsWith('credits:')));
  assert.ok(!problems.some((p) => p.startsWith('account:')));
});

test('classification does not depend on any fixed id', () => {
  assert.equal(classifyExchange({ rpcid: randomId(), request: 'person.photo' }), 'account');
  assert.equal(classifyExchange({ rpcid: randomId(), request: 'x', response: 'flow-content.google' }), 'generate');
  assert.equal(classifyExchange({ rpcid: randomId(), request: 'a'.repeat(500) }), 'upload');
  assert.equal(classifyExchange({ rpcid: randomId(), request: '', response: '[[123]]' }), 'credits');
  assert.equal(classifyExchange({ rpcid: randomId(), request: 'unremarkable' }), null);
});

import { readFileSync } from 'node:fs';
const backgroundSource = readFileSync(new URL('../src/background.js', import.meta.url), 'utf8');
const flowExecSource = readFileSync(new URL('../src/lib/flow-exec.js', import.meta.url), 'utf8');

test('the page receives the configured fallback and the start probe names a failure', () => {
  assert.match(backgroundSource, /rpcFallback: flowSettings\.rpcIds/, 'configured ids travel to the page');
  assert.match(backgroundSource, /Account probe failed:/, 'a failed probe names itself at start');
  assert.match(flowExecSource, /no id was observed on the page and no fallback is configured/, 'an unresolved id reports what was tried');
  assert.doesNotMatch(flowExecSource, /const RPC = \{ generate: '/, 'no RPC map is hard-coded in the page command');
});
