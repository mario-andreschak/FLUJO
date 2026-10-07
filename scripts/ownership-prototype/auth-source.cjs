'use strict';
// Prototype only: load the real pinned Security issuance/verifier, without
// copying its implementation or claiming this is a built FLUJO artifact.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const source = path.resolve(__dirname, '../../src/backend/services/security/ownerCredentials.ts');
const loaded = new Module(source, module);
loaded.filename = source;
loaded.paths = Module._nodeModulePaths(path.dirname(source));
loaded._compile(ts.transpileModule(fs.readFileSync(source, 'utf8'), { fileName: source,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, source);
// Use the same semantic revision function as actual owner stream witnesses.
const policySource = path.resolve(__dirname, '../../src/backend/services/security/ownerPolicy.ts');
const policyModule = new Module(policySource, module);
policyModule.filename = policySource;
policyModule.paths = Module._nodeModulePaths(path.dirname(policySource));
const nativeRequire = policyModule.require.bind(policyModule);
policyModule.require = name => name === './ownerCredentials' ? loaded.exports : nativeRequire(name);
policyModule._compile(ts.transpileModule(fs.readFileSync(policySource, 'utf8'), { fileName: policySource,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, policySource);
module.exports = { ...loaded.exports, ownerPolicyRevision: policyModule.exports.ownerPolicyRevision };
