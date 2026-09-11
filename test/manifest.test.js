import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { PROVIDERS } from '../src/lib/providers.js';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const removed = /grok|perchance|freegen|pollinations|piclumen/i;

test('release version includes the queue-all control cleanup', () => {
  const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  assert.equal(manifest.version, '0.50.9');
  assert.match(changelog, /## 0\.50\.9 - One queue-all action/);
});

test('manifest contains no retired provider hosts or content scripts', () => {
  assert.equal(JSON.stringify(manifest).match(removed), null);
});

test('manifest declares every maintained provider content script and its workspace host', () => {
  const scripts = manifest.content_scripts.flatMap((entry) => entry.js);
  const permissions = manifest.host_permissions.join('\n');

  for (const provider of PROVIDERS) {
    for (const script of Object.values(provider.scripts || {}).filter(Boolean)) {
      assert.ok(scripts.includes(script), `${provider.id} script is declared`);
      assert.ok(existsSync(path.join(root, script)), `${script} exists`);
    }
    const host = new URL(provider.workspace.url).hostname.replace(/^www\./, '');
    assert.match(permissions, new RegExp(host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('every manifest content script exists', () => {
  for (const script of manifest.content_scripts.flatMap((entry) => entry.js)) {
    assert.ok(existsSync(path.join(root, script)), `${script} exists`);
  }
});
