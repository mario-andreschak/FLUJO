'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const { canonicalTextHash, sourceManifestHash, inside } = require('./profile.cjs');
function dependencyManifest(root, dependencies) {
  const dependencyRequire = Module.createRequire(path.join(dependencies, 'package.json'));
  const lockSha256 = canonicalTextHash(fs.readFileSync(path.join(root, 'package-lock.json')));
  assert.equal(lockSha256, canonicalTextHash(fs.readFileSync(path.join(dependencies, 'package-lock.json'))),
    'Dependency lock does not match source');
  return { typescript: dependencyRequire('typescript/package.json').version,
    openaiEntrySha256: canonicalTextHash(fs.readFileSync(dependencyRequire.resolve('openai'))), lockSha256 };
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
  const dependencyRequire = Module.createRequire(path.join(dependencies, 'package.json'));
  const ts = dependencyRequire('typescript');
  const original = Module._resolveFilename;
  const loaded = new Map();
  Module._resolveFilename = function(request, parent, ...rest) {
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
module.exports = { installSourceLoader, verifySourceManifest };
