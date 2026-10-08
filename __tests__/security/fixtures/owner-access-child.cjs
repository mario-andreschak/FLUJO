// Disposable source-process probe, not an installed Next/app artifact.
const fs = require('node:fs');
const ts = require(process.argv[3]);
require.extensions['.ts'] = (module, filename) => {
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  module._compile(compiled.outputText, filename);
};
const { assertOwnerRequest } = require(process.argv[2]);
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
if (input.pair === true) {
  const path = require('node:path');
  const { pairFirstOwner } = require(path.join(path.dirname(process.argv[2]), 'ownerBootstrap.ts'));
  try {
    pairFirstOwner(new Request('http://localhost:4200/api/owner/bootstrap', { method: 'POST',
      headers: { host: 'localhost:4200', origin: 'http://localhost:4200', authorization: `Bearer ${input.token}` } }), true);
    process.stdout.write('PAIRED');
  } catch { process.stdout.write('REFUSED'); }
} else {
const denied = assertOwnerRequest(new Request('http://localhost:4200/v1/models', {
  headers: { authorization: `Bearer ${input.token}` },
}));
process.stdout.write(String(denied?.status ?? 200));

}
