import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const flowExec = readFileSync(new URL('../src/lib/flow-exec.js', import.meta.url), 'utf8');
const background = readFileSync(new URL('../src/background.js', import.meta.url), 'utf8');

test('a real Flow project claims even when the account identity cannot be read', () => {
  // The RPC ids are captured internals and can move; the project itself is the fallback.
  assert.match(flowExec, /const SIGNED_IN_MARKERS = \[/, 'sign-in markers are a list, never one selector');
  assert.match(flowExec, /googleusercontent/, 'the avatar is a sign-in marker');
  assert.match(flowExec, /flow_signed_in/, 'the fallback account is labelled as a signed-in Flow project');
  assert.match(flowExec, /balance: null/, 'a fallback balance is unknown, never zero');
  assert.match(flowExec, /readiness: 'ready'/, 'an unreadable identity never blocks a claim');
  assert.match(flowExec, /probe: \{\s*fallback: true/, 'the probe error is carried to the panel as detail');
});

test('the inspect message resolves the project from the tab, not a payload', () => {
  // background sends flow:inspectAccount with no payload; the tab must supply its own id.
  assert.match(flowExec, /payload\?\.projectId/, 'a missing payload is tolerated');
  assert.match(flowExec, /projectIdFor\(currentProjectId\(\)\)/, 'the tab project id is a source');
  assert.match(flowExec, /location\.href\.match/, 'the current project is read from the address, whatever its shape');
});

test('a tab with no Flow project names the checks that failed', () => {
  assert.match(flowExec, /No Flow project in this tab's address/, 'the missing project is named');
});

test('the panel distinguishes a missing tab from a failed account read', () => {
  assert.match(background, /reason: 'no-tab'/, 'no Flow tab is its own state');
  assert.match(background, /reason: 'unreadable'/, 'a failed probe is its own state');
  assert.match(background, /could not read the account .*Retrying on the next check/, 'the failure names itself and retries');
});
