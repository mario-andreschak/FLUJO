import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import Module, { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensurePrivateDirectory } from './local-instance.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Test equipment issues through the production issuer; tokens stay in RAM. */
export async function createSmokeOperator() {
  const require = createRequire(import.meta.url);
  const filename = path.join(sourceRoot, 'src/backend/services/security/ownerCredentials.ts');
  let source;
  try { source = await fs.readFile(filename, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let issuer, issuerSourceSha256, issuerCompiledSha256, issuerEquipment;
  if (source !== undefined) {
    const ts = require('typescript');
    const loaded = new Module(filename);
    loaded.filename = filename;
    loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    loaded._compile(ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText, filename);
    issuer = loaded.exports;
    issuerSourceSha256 = createHash('sha256').update(source).digest('hex');
    issuerEquipment = 'production-source';
  } else {
    const compiledFilename = path.join(sourceRoot, 'scripts/generated-smoke-owner-issuer.cjs');
    const bytes = await fs.readFile(compiledFilename);
    const binding = JSON.parse(await fs.readFile(path.join(sourceRoot, 'scripts/generated-smoke-owner-issuer.json'), 'utf8'));
    issuerSourceSha256 = binding.sourceSha256;
    issuerCompiledSha256 = createHash('sha256').update(bytes).digest('hex');
    if (binding.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(issuerSourceSha256)
        || issuerCompiledSha256 !== binding.compiledSha256) throw new Error('Compiled owner issuer binding mismatch.');
    const loaded = new Module(compiledFilename);
    loaded.filename = compiledFilename;
    loaded.paths = Module._nodeModulePaths(path.dirname(compiledFilename));
    loaded._compile(bytes.toString('utf8'), compiledFilename);
    issuer = loaded.exports;
    issuerEquipment = 'compiled-production-source';
  }
  const parent = await fs.realpath(process.platform === 'win32' ? process.env.LOCALAPPDATA : os.tmpdir());
  const directory = await fs.mkdtemp(path.join(parent, 'flujo-smoke-operator-'));
  const restore = async () => {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.dirname(directory) !== parent
      || !/^flujo-smoke-operator-[A-Za-z0-9]+$/.test(path.basename(directory))
      || await fs.realpath(directory) !== directory) throw new Error('Unsafe smoke operator cleanup.');
    await fs.rm(directory, { recursive: true, force: true });
  };
  try {
    await ensurePrivateDirectory(directory);
    const issued = issuer.issueOwnerCredential(['control:admin', 'mcp:access', 'secrets:read'], Date.now() + 15 * 60_000);
    const policy = issuer.ownerPolicySchema.parse({ schemaVersion: 1, ownerId: 'packed-smoke-operator', credentials: [issued.record] });
    const ownerFile = path.join(directory, 'owner.json');
    await fs.writeFile(ownerFile, JSON.stringify(policy), { flag: 'wx', mode: 0o600 });
    return { token: issued.token, issuerSourceSha256, issuerCompiledSha256, issuerEquipment, env: { FLUJO_OWNER_AUTH_FILE: ownerFile,
      FLUJO_MCP_TRUSTED_HOST_FILE: path.join(directory, 'approval.json') }, restore };
  } catch (error) {
    try { await restore(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Smoke operator setup and cleanup failed.', { cause: error }); }
    throw error;
  }
}

export async function approveSmokeServer(baseUrl, name, token, timeoutMs, workspace) {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const url = new URL(`/api/mcp/servers/${encodeURIComponent(name)}/host-consent`, baseUrl);
  url.searchParams.set('runtimeHome', 'host');
  if (workspace !== undefined) url.searchParams.set('workspace', workspace);
  const preview = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!preview.ok) throw new Error(`Installed ${name} consent preview returned ${preview.status}.`);
  const reviewed = await preview.json();
  if (reviewed.serverName !== name || !/^[a-f0-9]{64}$/.test(reviewed.policyDigest)) throw new Error('Invalid installed package consent preview.');
  const approval = await fetch(url, { method: 'POST', headers, signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({ runtimeHome: 'host', reviewedDigest: reviewed.policyDigest, expiresAt: Date.now() + 10 * 60_000 }) });
  if (!approval.ok || (await approval.json()).approved !== true) throw new Error(`Installed ${name} consent approval returned ${approval.status}.`);
}
