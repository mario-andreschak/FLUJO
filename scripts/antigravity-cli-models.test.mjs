import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseNativeModels } = require('../packages/antigravity-cli/models.cjs');

test('projects the actual native TSV and retains custom slugs without granting entitlement', () => {
  assert.deepEqual(parseNativeModels('gemini-3.8-flash-high\tGemini 3.8 Flash (High)\r\ncustom/model-v2\tCustom label\n'), [
    { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' }, { id: 'custom/model-v2', name: 'Custom label' },
  ]);
});
test('rejects drift, empty/error output, duplicates, controls and oversized catalogs', () => {
  for (const output of ['', 'Error: authentication failed', 'id\tLabel\textra', 'id\tLabel\nid\tLabel', 'id\tBad\x00label', 'a'.repeat(1024*1024+1)]) {
    assert.throws(() => parseNativeModels(output), /Antigravity/);
  }
});
