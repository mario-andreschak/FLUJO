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
let stage = 'restore';
(async () => {
  const { restoreConfiguredWorkerSnapshot, unlockWorkerSnapshot } = require(path.join(process.argv[2], 'src/backend/services/workspace/snapshotRestore.ts'));
  const secure = require(path.join(process.argv[2], 'src/utils/encryption/secure.ts'));
  const { getServerDek } = require(path.join(process.argv[2], 'src/utils/encryption/session.ts'));
  const { runWithWorkspace, getWorkspaceDataDir } = require(path.join(process.argv[2], 'src/utils/workspace.ts'));
  const { loadItem } = require(path.join(process.argv[2], 'src/utils/storage/backend.ts'));
  const { decryptApiKey } = require(path.join(process.argv[2], 'src/backend/services/model/encryption.ts'));
  const { readOAuthTokens } = require(path.join(process.argv[2], 'src/backend/services/mcp/oauthCredentialStorage.ts'));
  const result = await restoreConfiguredWorkerSnapshot();
  stage = 'initial-lock';
  await runWithWorkspace(result.workspace, async () => {
    if (!await secure.isEncryptionLocked()) throw new Error('Cold worker must start locked');
    stage = 'bootstrap';
    await unlockWorkerSnapshot(result);
    // N owns switching this validated restore hook to the dedicated API.
    stage = 'validate-transfer';
    await secure.unlockValidatedWorkerTransfer(getServerDek(), { workspace: result.workspace, root: getWorkspaceDataDir() });
    stage = 'model';
    if (await secure.isEncryptionLocked()) throw new Error('Validated transfer remained locked');
    const models = await loadItem('models', []);
    if (await decryptApiKey(models[0].ApiKey) !== 'synthetic-model-secret') throw new Error('Model credential mismatch');
    stage = 'oauth';
    const configs = await loadItem('mcp_servers', {});
    const tokens = await readOAuthTokens(configs.offline);
    if (tokens.access_token !== 'synthetic-oauth') throw new Error('OAuth credential mismatch');
    stage = 'encrypt';
    const ciphertext = await secure.encryptWithPassword('cold-worker-new-secret');
    if (await secure.decryptWithPassword(ciphertext) !== 'cold-worker-new-secret') throw new Error('Worker encryption mismatch');
    process.env.FLUJO_WORKER_SNAPSHOT_SOURCE = '1';
    process.env.FLUJO_WORKER_SNAPSHOT_KEY = require('node:crypto').randomBytes(32).toString('base64');
    // Source transpilation emits require; load genuine import-only namespaces
    // through Node's native ESM loader, without substituting their behavior.
    stage = 'load-snapshot-source';
    const native = new Map();
    for (const name of [
      'mcp-stdio-oauth/protocol', 'mcp-stdio-oauth/client', 'mcp-stdio-oauth/client/transport',
      '@modelcontextprotocol/ext-tasks/core', '@modelcontextprotocol/ext-tasks/core/v2', '@modelcontextprotocol/ext-tasks/client',
    ]) {
      native.set(name, await import(name));
    }
    const load = Module._load;
    Module._load = function (name, ...rest) { return native.has(name) ? native.get(name) : load.call(this, name, ...rest); };
    const { captureWorkspaceSnapshot, writeWorkspaceSnapshotArchive } = require(path.join(process.argv[2], 'src/backend/services/workspace/snapshotArchive.ts'));
    stage = 'recapture';
    const captured = await captureWorkspaceSnapshot(result.workspace, 2);
    let reexported;
    let primaryError;
    try {
      stage = 'rewrite';
      reexported = await writeWorkspaceSnapshotArchive(captured);
      stage = 'verify-reexport';
      if (!reexported.encrypted || !reexported.plaintextSha256) throw new Error('Worker re-export must be encrypted');
      const wire = fs.readFileSync(reexported.archivePath);
      const envelope = JSON.parse(wire.toString('utf8'));
      if (envelope.version !== 2 || reexported.encryptionVersion !== 2
        || require('node:crypto').createHash('sha256').update(wire).digest('hex') !== reexported.sha256) {
        throw new Error('Worker re-export version or wire digest mismatch');
      }
      const decipher = require('node:crypto').createDecipheriv('aes-256-gcm', Buffer.from(process.env.FLUJO_WORKER_SNAPSHOT_KEY, 'base64'), Buffer.from(envelope.iv, 'base64'));
      decipher.setAAD(Buffer.from('flujo:workspace-snapshot:v2', 'utf8'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
      if (require('node:crypto').createHash('sha256').update(plaintext).digest('hex') !== reexported.plaintextSha256) {
        throw new Error('Worker re-export plaintext digest mismatch');
      }
      const zip = await require('jszip').loadAsync(plaintext);
      const { workspaceDek } = JSON.parse(await zip.file('db/worker-bootstrap-secrets.json').async('string'));
      if (workspaceDek !== getServerDek()) throw new Error('Worker re-export key mismatch');
    } catch (error) { primaryError = error; throw error; }
    finally {
      const cleanup = await Promise.allSettled([captured.dispose?.(),
        reexported && require('node:fs/promises').rm(reexported.stagingDir, { recursive: true, force: true })]);
      if (!primaryError) { const failed = cleanup.find(result => result.status === 'rejected'); if (failed) throw failed.reason; }
    }
  });
  process.stdout.write('WORKER_TRANSFER_SOURCE_PASS\n');
})().catch(error => { process.stderr.write(`Worker transfer Source probe failed at ${stage} (${typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'FAILED'}).\n`); process.exitCode = 1; });
