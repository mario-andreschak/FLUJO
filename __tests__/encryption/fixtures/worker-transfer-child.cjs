// Cold Source worker; authenticated production restore, no model/provider call.
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
  const { restoreConfiguredWorkerSnapshot, unlockWorkerSnapshot } = require(path.join(process.argv[2], 'src/backend/services/workspace/snapshotRestore.ts'));
  const secure = require(path.join(process.argv[2], 'src/utils/encryption/secure.ts'));
  const { getServerDek } = require(path.join(process.argv[2], 'src/utils/encryption/session.ts'));
  const { runWithWorkspace, getWorkspaceDataDir } = require(path.join(process.argv[2], 'src/utils/workspace.ts'));
  const { loadItem } = require(path.join(process.argv[2], 'src/utils/storage/backend.ts'));
  const { decryptApiKey } = require(path.join(process.argv[2], 'src/backend/services/model/encryption.ts'));
  const { readOAuthTokens } = require(path.join(process.argv[2], 'src/backend/services/mcp/oauthCredentialStorage.ts'));
  const result = await restoreConfiguredWorkerSnapshot();
  await runWithWorkspace(result.workspace, async () => {
    if (!await secure.isEncryptionLocked()) throw new Error('Cold worker must start locked');
    await unlockWorkerSnapshot(result);
    // N owns switching this validated restore hook to the dedicated API.
    await secure.unlockValidatedWorkerTransfer(getServerDek(), { workspace: result.workspace, root: getWorkspaceDataDir() });
    if (await secure.isEncryptionLocked()) throw new Error('Validated transfer remained locked');
    const models = await loadItem('models', []);
    if (await decryptApiKey(models[0].ApiKey) !== 'synthetic-model-secret') throw new Error('Model credential mismatch');
    const configs = await loadItem('mcp_servers', {});
    const tokens = await readOAuthTokens(configs.offline);
    if (tokens.access_token !== 'synthetic-oauth') throw new Error('OAuth credential mismatch');
    const ciphertext = await secure.encryptWithPassword('cold-worker-new-secret');
    if (await secure.decryptWithPassword(ciphertext) !== 'cold-worker-new-secret') throw new Error('Worker encryption mismatch');
  });
  process.stdout.write('WORKER_TRANSFER_SOURCE_PASS\n');
})().catch(() => { process.stderr.write('Worker transfer Source probe failed.\n'); process.exitCode = 1; });
