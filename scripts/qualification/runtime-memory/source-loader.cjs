'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const { canonicalTextHash, sourceManifestHash, inside } = require('./profile.cjs');
const EXT_TASKS_REQUESTS = ['@modelcontextprotocol/ext-tasks/core', '@modelcontextprotocol/ext-tasks/core/v2', '@modelcontextprotocol/ext-tasks/client'];
function declaredImportBridge(dependencies) {
  const packageRoot = fs.realpathSync(path.join(dependencies, 'node_modules/@modelcontextprotocol/ext-tasks'));
  assert(inside(fs.realpathSync(dependencies), packageRoot), 'Import bridge package escaped dependencies');
  const metadataPath = fs.realpathSync(path.join(packageRoot, 'package.json'));
  assert(inside(packageRoot, metadataPath), 'Import bridge metadata escaped package');
  assert(fs.statSync(metadataPath).isFile() && fs.statSync(metadataPath).size <= 1024 ** 2, 'Invalid import bridge package metadata');
  const metadataBytes = fs.readFileSync(metadataPath);
  const metadata = JSON.parse(metadataBytes.toString('utf8'));
  assert.equal(metadata.name, '@modelcontextprotocol/ext-tasks');
  assert.equal(metadata.version, '0.2.2', 'Import bridge package version changed');
  assert.equal(metadata.type, 'module');
  const entries = {}, targets = {};
  for (const request of EXT_TASKS_REQUESTS) {
    const subpath = './' + request.slice('@modelcontextprotocol/ext-tasks/'.length);
    const target = metadata.exports?.[subpath]?.import;
    assert(typeof target === 'string' && target.length <= 512 && target.startsWith('./') && !/[\\:\0]/.test(target)
      && target.slice(2).split('/').every(part => part && part !== '.' && part !== '..'), 'Invalid declared import target: ' + request);
    const real = fs.realpathSync(path.join(packageRoot, target));
    assert(inside(packageRoot, real), 'Declared import target escaped package');
    const stat = fs.statSync(real);
    assert(stat.isFile() && stat.size <= 1024 ** 2, 'Declared import target is not a bounded regular file');
    entries[request] = { target, sha256: canonicalTextHash(fs.readFileSync(real)) };
    targets[request] = real;
  }
  return { targets, manifest: { format: 'declared-import-exports-v1', package: metadata.name, version: metadata.version,
    packageJsonSha256: canonicalTextHash(metadataBytes), exportsSha256: canonicalTextHash(JSON.stringify(metadata.exports)), entries } };
}
function dependencyManifest(root, dependencies) {
  const dependencyRequire = Module.createRequire(path.join(dependencies, 'package.json'));
  const lockSha256 = canonicalTextHash(fs.readFileSync(path.join(root, 'package-lock.json')));
  assert.equal(lockSha256, canonicalTextHash(fs.readFileSync(path.join(dependencies, 'package-lock.json'))),
    'Dependency lock does not match source');
  const typescript = dependencyRequire('typescript/package.json').version;
  assert(typeof typescript === 'string' && typescript.length > 0 && typescript.length <= 64, 'Invalid installed TypeScript version');
  return { typescript,
    openaiEntrySha256: canonicalTextHash(fs.readFileSync(dependencyRequire.resolve('openai'))), lockSha256,
    importBridge: declaredImportBridge(dependencies).manifest };
}
function verifySourceManifest(root, dependencies, expected) {
  sourceManifestHash(expected);
  const files = {};
  for (const file of Object.keys(expected.files)) {
    const real = fs.realpathSync(path.join(root, file));
    assert(inside(fs.realpathSync(path.join(root, 'src')), real), 'Source manifest escaped source root');
    files[file] = canonicalTextHash(fs.readFileSync(real));
  }
  assert.equal(sourceManifestHash({ format: 'source-lf-v1', files, ...dependencyManifest(root, dependencies) }),
    sourceManifestHash(expected), 'Pilot source/dependencies do not match launch files');
}
function installSourceLoader(root, dependencies) {
  root = fs.realpathSync(root); dependencies = fs.realpathSync(dependencies);
  const dependenciesAtStart = dependencyManifest(root, dependencies);
  const importBridge = declaredImportBridge(dependencies);
  assert.deepEqual(importBridge.manifest, dependenciesAtStart.importBridge, 'Import bridge changed during setup');
  const dependencyRequire = Module.createRequire(path.join(dependencies, 'package.json'));
  const ts = dependencyRequire('typescript');
  const original = Module._resolveFilename;
  const loaded = new Map();
  Module._resolveFilename = function(request, parent, ...rest) {
    // Only these installed, explicitly declared ESM exports bridge the CJS adapter.
    // Node 22 loads their actual ESM; all other package requests retain Node resolution.
    if (Object.hasOwn(importBridge.targets, request)) request = importBridge.targets[request];
    if (request.startsWith('@/')) request = path.join(root, 'src', request.slice(2));
    if (request.endsWith('.js') && request.startsWith('.') && parent) {
      const candidate = path.resolve(path.dirname(parent.filename), request.slice(0, -3) + '.ts');
      if (fs.existsSync(candidate)) request = candidate;
    }
    if (/^mcp-stdio-oauth\/(client|protocol)$/.test(request)) {
      request = path.join(dependencies, 'node_modules/mcp-stdio-oauth/dist', request.split('/')[1], 'index.js');
    }
    if (request === 'mcp-stdio-oauth/client/transport') request = path.join(dependencies, 'node_modules/mcp-stdio-oauth/dist/client/transport.js');
    try { return original.call(this, request, parent, ...rest); }
    catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND' || request.startsWith('.') || path.isAbsolute(request)
          || (parent?.filename && inside(dependencies, parent.filename))) throw error;
      return dependencyRequire.resolve(request);
    }
  };
  for (const extension of ['.ts', '.tsx']) require.extensions[extension] = (module, file) => {
    const real = fs.realpathSync(file);
    assert(inside(path.join(root, 'src'), real), 'Unexpected TypeScript source: ' + real);
    const source = fs.readFileSync(real, 'utf8');
    loaded.set(path.relative(root, real).replaceAll('\\', '/'), canonicalTextHash(source));
    assert(loaded.size <= 4096, 'Loaded source manifest limit');
    module._compile(ts.transpileModule(source, { fileName: real, compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
    } }).outputText, real);
  };
  return { load: relative => require(path.join(root, 'src', relative)), verify: () => {
    for (const [file, sha] of loaded) assert.equal(canonicalTextHash(fs.readFileSync(path.join(root, file))), sha, 'Source changed during qualification');
    assert.deepEqual(dependencyManifest(root, dependencies), dependenciesAtStart, 'Dependencies changed during qualification');
    return { format: 'source-lf-v1', files: Object.fromEntries([...loaded].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
      ...dependenciesAtStart };
  } };
}
module.exports = { installSourceLoader, verifySourceManifest, dependencyManifest, declaredImportBridge };
