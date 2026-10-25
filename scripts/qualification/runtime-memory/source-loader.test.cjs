'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const { declaredImportBridge } = require('./source-loader.cjs');
const directory = () => fs.mkdtempSync(path.join(process.env.FLUJO_QUALIFICATION_TEST_EVIDENCE ?? os.tmpdir(), 'flujo-import-bridge-'));

test('declared import bridge loads real installed ESM exports through the TypeScript adapter without service calls', () => {
  const dependencies = path.resolve(__dirname, '../../..'), root = directory();
  fs.mkdirSync(path.join(root, 'src'));
  fs.copyFileSync(path.join(dependencies, 'package-lock.json'), path.join(root, 'package-lock.json'));
  fs.writeFileSync(path.join(root, 'src/probe.ts'), `
    import { isJsonValue } from '@modelcontextprotocol/ext-tasks/core';
    import { CreateTaskResultV2Schema } from '@modelcontextprotocol/ext-tasks/core/v2';
    import { JsonRpcResponseError } from '@modelcontextprotocol/ext-tasks/client';
    export const kinds = [typeof isJsonValue, typeof CreateTaskResultV2Schema, typeof JsonRpcResponseError];
  `);
  const script = `const assert=require('node:assert/strict');
    const loader=require(process.argv[1]).installSourceLoader(process.argv[2],process.argv[3]);
    assert.deepEqual(loader.load('probe.ts').kinds,['function','object','function']);
    assert.throws(()=>require('@modelcontextprotocol/ext-tasks/not-exported'),{code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});
    console.log(JSON.stringify(loader.verify().importBridge));`;
  const record = JSON.parse(execFileSync(process.execPath, ['-e', script, path.join(__dirname, 'source-loader.cjs'), root, dependencies],
    { cwd: dependencies, timeout: 20_000, maxBuffer: 64 * 1024, encoding: 'utf8' }));
  assert.deepEqual(record, declaredImportBridge(dependencies).manifest);
});

test('bridge refuses undeclared, absent, nonregular and escaping targets without internal path fallback', () => {
  const root = directory(), pkg = path.join(root, 'node_modules/@modelcontextprotocol/ext-tasks');
  fs.mkdirSync(pkg, { recursive: true });
  const metadata = { name: '@modelcontextprotocol/ext-tasks', version: '0.2.2', type: 'module',
    exports: Object.fromEntries(['core', 'core/v2', 'client'].map(key => ['./' + key, { import: './entry.js' }])) };
  fs.writeFileSync(path.join(pkg, 'entry.js'), 'export const value = 1;\n');
  const write = value => fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify(value));
  write(metadata); assert.equal(Object.keys(declaredImportBridge(root).targets).length, 3);
  for (const target of [undefined, '../outside.js', './nested/../../outside.js', './absent.js', './directory', './linked/entry.js']) {
    fs.mkdirSync(path.join(pkg, 'directory'), { recursive: true });
    if (target === './linked/entry.js') {
      const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'entry.js'), 'export const value = 2;\n');
      fs.symlinkSync(outside, path.join(pkg, 'linked'), 'junction');
    }
    write({ ...metadata, exports: { ...metadata.exports, './core': { import: target } } });
    assert.throws(() => declaredImportBridge(root));
  }
  write({ ...metadata, version: '0.2.3' }); assert.throws(() => declaredImportBridge(root), /version changed/);
});
