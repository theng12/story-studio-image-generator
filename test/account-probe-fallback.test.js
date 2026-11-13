import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { observedAccount } from '../src/lib/gateway-account.js';

const flowExec = readFileSync(new URL('../src/lib/flow-exec.js', import.meta.url), 'utf8');
const background = readFileSync(new URL('../src/background.js', import.meta.url), 'utf8');

test('the tab URL is the only account source; there is no in-page identity probe', () => {
  assert.match(background, /const FLOW_PROJECT_URL/, 'the project url pattern is defined');
  assert.match(background, /projectIdFromUrl/, 'the tab url is read directly');
  assert.match(background, /source: 'flow\.url'/, 'the URL account is labelled honestly');
  assert.match(background, /accountId: 'flow_signed_in'/, 'the synthesized account passes the validator');
  assert.match(background, /complete\.find\(\(entry\) => projectIdFromUrl/, 'a project tab is preferred over a home tab');
  assert.doesNotMatch(background, /flow:inspectAccount/, 'no account probe is sent to the page');
  assert.doesNotMatch(flowExec, /visibleSignedIn|SIGNED_IN_MARKERS|inspectAccount/, 'the page has no account/sign-in logic');
  assert.doesNotMatch(flowExec, /'account', 'credits'/, 'the account/credits RPC ids are gone');
});

test('a home tab is no_project, not an unreadable account', () => {
  assert.match(background, /reason: 'no_project'/, 'the missing project has its own state');
  assert.match(background, /not on a project/, 'the panel names the real condition');
});

test('every synthesized account survives the app validator', () => {
  // A fallback the validator drops looks fixed and still never claims; run each through it.
  const ids = [...background.matchAll(/accountId: '([^']+)'/g)].map((match) => match[1]);
  assert.ok(ids.includes('flow_signed_in'));
  for (const accountId of ids) {
    const account = observedAccount({
      schema: 1, provider: 'flow', accountId, source: 'flow.url',
      observedAt: new Date().toISOString(), connection: 'connected', signIn: 'signed_in',
      readiness: 'ready', balance: null,
    }, 90);
    assert.ok(account, `account ${accountId} survives observedAccount`);
  }
});

test('one readiness object feeds the panel and Relay', () => {
  assert.match(background, /gatewayReadiness/, 'the background writes the shared readiness object');
  assert.match(background, /state: inspected\.account \? 'connected' : 'blocked'/, 'state is explicit');
  const popup = readFileSync(new URL('../src/popup/popup.js', import.meta.url), 'utf8');
  assert.match(popup, /gatewayReadiness/, 'the panel reads the same object');
  assert.match(popup, /gatewayReadiness\.reason/, 'a blocked readiness shows its reason');
});
