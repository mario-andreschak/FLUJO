// Disposable source-process probe. This does not exercise an installed Next artifact.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require(process.argv[3]);
const sourceRoot = process.argv[2];
const resolve = Module._resolveFilename;
Module._resolveFilename = function (specifier, ...args) {
  return resolve.call(this, specifier.startsWith('@/')
    ? path.join(sourceRoot, specifier.slice(2)) : specifier, ...args);
};
require.extensions['.ts'] = (module, filename) => {
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  module._compile(compiled.outputText, filename);
};
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const secure = require(path.join(sourceRoot, 'utils/encryption/secure.ts'));
secure.encryptWithPassword(input.value).then(ciphertext => {
  if (!ciphertext) throw new Error();
  process.stdout.write(`\nSOURCE_RESULT:${JSON.stringify({ ciphertext })}\n`);
}).catch(() => {
  process.stderr.write('SOURCE_PROBE_FAILED');
  process.exitCode = 1;
});
