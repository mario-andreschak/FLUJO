'use strict';
// Prototype only: load the real pinned Security issuance/verifier, without
// copying its implementation or claiming this is a built FLUJO artifact.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

function loadSource(relative, provided = {}) {
  const source = path.resolve(__dirname, '../../src', relative);
  const loaded = new Module(source, module);
  loaded.filename = source;
  loaded.paths = Module._nodeModulePaths(path.dirname(source));
  const nativeRequire = loaded.require.bind(loaded);
  loaded.require = name => Object.hasOwn(provided, name) ? provided[name] : nativeRequire(name);
  loaded._compile(ts.transpileModule(fs.readFileSync(source, 'utf8'), { fileName: source,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, source);
  return loaded.exports;
}

const credentials = loadSource('backend/services/security/ownerCredentials.ts');
// Use the same semantic revision function as actual owner stream witnesses.
const policy = loadSource('backend/services/security/ownerPolicy.ts', {
  './ownerCredentials': credentials,
  '../../../utils/realpath': loadSource('utils/realpath.ts'),
  '../../../utils/transientFileRetry': loadSource('utils/transientFileRetry.ts'),
});
module.exports = { ...credentials, ownerPolicyRevision: policy.ownerPolicyRevision };
