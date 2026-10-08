import { promises as fs } from 'node:fs';
import Module, { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Test equipment issues through the production issuer; tokens stay in RAM. */
export async function createSmokeOperator() {
  const require = createRequire(import.meta.url);
  const ts = require('typescript');
  const filename = path.join(sourceRoot, 'src/backend/services/security/ownerCredentials.ts');
  const issuer = new Module(filename);
  issuer.filename = filename;
  issuer.paths = Module._nodeModulePaths(path.dirname(filename));
  issuer._compile(ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, filename);
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
    await fs.chmod(directory, 0o700);
    const issued = issuer.exports.issueOwnerCredential(['control:admin', 'mcp:access', 'secrets:read'], Date.now() + 15 * 60_000);
    const policy = issuer.exports.ownerPolicySchema.parse({ schemaVersion: 1, ownerId: 'packed-smoke-operator', credentials: [issued.record] });
    const ownerFile = path.join(directory, 'owner.json');
    await fs.writeFile(ownerFile, JSON.stringify(policy), { flag: 'wx', mode: 0o600 });
    return { token: issued.token, env: { FLUJO_OWNER_AUTH_FILE: ownerFile,
      FLUJO_MCP_TRUSTED_HOST_FILE: path.join(directory, 'approval.json') }, restore };
  } catch (error) {
    try { await restore(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Smoke operator setup and cleanup failed.', { cause: error }); }
    throw error;
  }
}

export async function approveSmokeServer(baseUrl, name, token, timeoutMs) {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const url = new URL(`/api/mcp/servers/${encodeURIComponent(name)}/host-consent`, baseUrl);
  url.searchParams.set('runtimeHome', 'host');
  const preview = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!preview.ok) throw new Error(`Installed ${name} consent preview returned ${preview.status}.`);
  const reviewed = await preview.json();
  if (reviewed.serverName !== name || !/^[a-f0-9]{64}$/.test(reviewed.policyDigest)) throw new Error('Invalid installed package consent preview.');
  const approval = await fetch(url, { method: 'POST', headers, signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({ runtimeHome: 'host', reviewedDigest: reviewed.policyDigest, expiresAt: Date.now() + 120_000 }) });
  if (!approval.ok || (await approval.json()).approved !== true) throw new Error(`Installed ${name} consent approval returned ${approval.status}.`);
}
