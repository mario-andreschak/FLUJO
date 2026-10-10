import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { claudeExternalFactories, codexExternalFactories, verifyClaudeBuiltImport, verifyCodexBuiltImport } from './verify-codex-built-import.mjs';

test('recognizes actual minified native SDK external factories', () => {
  assert.deepEqual(codexExternalFactories('276153:a=>{a.exports=import("@openai/codex-sdk")}'), ['a=>{a.exports=import("@openai/codex-sdk")}']);
});

test('rejects the published Linux build-host URL on every platform', () => {
  assert.throws(() => codexExternalFactories('createRequire("file:///home/runner/work/FLUJO/FLUJO/node_modules/@openai/codex-sdk/dist/index.js")'), /build-host/);
  assert.throws(() => codexExternalFactories('createRequire("C:/builder/node_modules/@openai/codex-sdk/dist/index.js")'), /build-host/);
});

test('recognizes native Claude SDK imports separately from Codex imports', () => {
  const emitted = '276153:a=>{a.exports=import("@openai/codex-sdk")},251631:b=>{b.exports=import("@anthropic-ai/claude-agent-sdk")}';
  assert.deepEqual(claudeExternalFactories(emitted), ['b=>{b.exports=import("@anthropic-ai/claude-agent-sdk")}']);
  assert.deepEqual(codexExternalFactories(emitted), ['a=>{a.exports=import("@openai/codex-sdk")}']);
});

test('rejects the original bundled Claude executable lookup and other build-host paths', () => {
  // Original Windows production chunk: query() anchors native-package lookup
  // on this inlined SDK URL, rather than the installed application's location.
  const original = 'let a=(0,Y.fileURLToPath)("file:///C:/Users/Moe/.codex/worktrees/skillspector-review/FLUJO/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"),b=(0,X.createRequire)(a);';
  assert.throws(() => claudeExternalFactories(original), /Claude SDK contains a build-host file URL/);
  for (const filename of [
    'file:///home/runner/work/FLUJO/FLUJO/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',
    '/home/runner/work/FLUJO/FLUJO/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',
    'C:/builder/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',
    'C:\\builder\\node_modules\\@anthropic-ai\\claude-agent-sdk\\sdk.mjs',
  ]) {
    assert.throws(() => claudeExternalFactories(`createRequire(${JSON.stringify(filename)})`), /build-host/);
    assert.throws(() => claudeExternalFactories(`(0,X.createRequire)(${JSON.stringify(filename)})`), /build-host/);
  }
});

test('production guards reject a build with no native SDK factory before attempting imports', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'flujo-native-import-missing-'));
  try {
    await mkdir(path.join(root, '.next/server/chunks'), { recursive: true });
    await writeFile(path.join(root, '.next/server/chunks/plain.js'), 'exports.modules = {};');
    // No installed dependencies: the reported failure must be the missing
    // emitted import, rather than an import error or native process launch.
    await assert.rejects(verifyClaudeBuiltImport(root), /does not contain a native Claude SDK import/);
    await assert.rejects(verifyCodexBuiltImport(root), /does not contain a native Codex SDK import/);
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('flujo-native-import-missing-'));
    await rm(root, { recursive: true, force: true });
  }
});
