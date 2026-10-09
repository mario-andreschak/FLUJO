import assert from 'node:assert/strict';
import test from 'node:test';
import { codexExternalFactories } from './verify-codex-built-import.mjs';

test('recognizes actual minified native SDK external factories', () => {
  assert.deepEqual(codexExternalFactories('276153:a=>{a.exports=import("@openai/codex-sdk")}'), ['a=>{a.exports=import("@openai/codex-sdk")}']);
});

test('rejects the published Linux build-host URL on every platform', () => {
  assert.throws(() => codexExternalFactories('createRequire("file:///home/runner/work/FLUJO/FLUJO/node_modules/@openai/codex-sdk/dist/index.js")'), /build-host/);
  assert.throws(() => codexExternalFactories('createRequire("C:/builder/node_modules/@openai/codex-sdk/dist/index.js")'), /build-host/);
});
