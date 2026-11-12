import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('the retired Fleet Hub feature leaves no code behind', () => {
  const files = readdirSync(path.join(root, 'src'), { recursive: true })
    .map((file) => String(file))
    .filter((file) => /\.(js|html|css)$/.test(file));
  for (const file of files) {
    const text = readFileSync(path.join(root, 'src', file), 'utf8');
    assert.doesNotMatch(text, /fleet/i, `${file} still mentions the retired feature`);
  }
});
