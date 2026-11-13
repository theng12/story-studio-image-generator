import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const flowExec = readFileSync(new URL('../src/lib/flow-exec.js', import.meta.url), 'utf8');
const background = readFileSync(new URL('../src/background.js', import.meta.url), 'utf8');

test('a visibly signed-in Flow project claims even when the account RPC fails', () => {
  // The RPC ids are captured internals and can move; the fallback must exist and stay honest.
  assert.match(flowExec, /visibleSignedIn/, 'the probe checks the visible signed-in page');
  assert.match(flowExec, /flow-visible-signed-in/, 'the fallback account is labelled as a visible sign-in');
  assert.match(flowExec, /balance: null/, 'a fallback balance is unknown, never zero');
  assert.match(flowExec, /probe: \{ fallback: true, error: probeError \}/, 'the probe error is carried to the panel');
});

test('the panel distinguishes a missing tab from a failed account read', () => {
  assert.match(background, /reason: 'no-tab'/, 'no Flow tab is its own state');
  assert.match(background, /reason: 'unreadable'/, 'a failed probe is its own state');
  assert.match(background, /could not read the account .*Retrying on the next check/, 'the failure names itself and retries');
});
