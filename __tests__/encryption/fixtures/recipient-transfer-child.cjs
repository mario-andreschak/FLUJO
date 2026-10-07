// Disposable Source process: no installed-runtime acceptance claim.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require(process.argv[3]);
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return resolve.call(this, request.startsWith('@/') ? path.join(process.argv[2], 'src', request.slice(2)) : request, ...rest);
};
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
(async () => {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (input.operation === 'restore') {
    const { restoreCredentialTransfer } = require(path.join(process.argv[2], 'src/backend/services/workspace/credentialTransfer.ts'));
    await restoreCredentialTransfer(fs.readFileSync(input.file), input.transferPassphrase, input.workspace, input.localPassphrase);
    process.stdout.write('RECIPIENT_SOURCE_PASS\n');
  } else {
    const { runWithWorkspace, getWorkspaceDir } = require(path.join(process.argv[2], 'src/utils/workspace.ts'));
    const secure = require(path.join(process.argv[2], 'src/utils/encryption/secure.ts'));
    await runWithWorkspace(input.workspace, async () => {
      if (!await secure.authenticate(input.localPassphrase)) throw new Error();
      const models = JSON.parse(fs.readFileSync(path.join(getWorkspaceDir(input.workspace), 'db/models.json'), 'utf8'));
      const values = await Promise.all(models.map(model => secure.decryptWithPassword(model.ApiKey.slice('encrypted:'.length))));
      if (JSON.stringify(values) !== JSON.stringify(input.expected)) throw new Error();
      process.stdout.write('RECIPIENT_SOURCE_PASS\n');
    });
  }
})().catch(() => { process.stderr.write('Recipient source probe failed.\n'); process.exitCode = 1; });
