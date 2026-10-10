import { promises as fs } from 'node:fs';
import Module, { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadSource(filename) {
  const require = createRequire(import.meta.url);
  // The normal production build emits exactly these fixed modules. Prefer the
  // built issuer/ACL helper so image qualification needs no source or compiler.
  const names = new Set(['ownerCredentials.ts', 'windowsPrivateAuthority.ts']);
  const name = path.basename(filename);
  if (!names.has(name) || path.dirname(filename) !== path.join(sourceRoot, 'src/backend/services/security')) throw new Error('Unsupported smoke security module.');
  const compiled = path.join(sourceRoot, 'scripts', 'compiled-security', name.replace(/\.ts$/, '.cjs'));
  try {
    await fs.access(compiled);
    return require(compiled);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Unbuilt developer checkout only; production images fail if their required
  // compiled artifact is absent instead of manufacturing a credential issuer.
  const ts = require('typescript');
  const loaded = new Module(filename);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, filename);
  return loaded.exports;
}

/** Test equipment issues through the production issuer; tokens stay in RAM. */
export async function createSmokeOperator() {
  const filename = path.join(sourceRoot, 'src/backend/services/security/ownerCredentials.ts');
  const issuer = await loadSource(filename);
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
    const issued = issuer.issueOwnerCredential(['control:admin', 'mcp:access', 'secrets:read'], Date.now() + 15 * 60_000);
    const policy = issuer.ownerPolicySchema.parse({ schemaVersion: 1, ownerId: 'packed-smoke-operator', credentials: [issued.record] });
    const ownerFile = path.join(directory, 'owner.json');
    await fs.writeFile(ownerFile, JSON.stringify(policy), { flag: 'wx', mode: 0o600 });
    if (process.platform === 'win32') {
      const authority = await loadSource(path.join(sourceRoot, 'src/backend/services/security/windowsPrivateAuthority.ts'));
      try { await authority.windowsPrivateAuthorityStampAsync(ownerFile); }
      catch (error) { throw new Error('Disposable smoke operator native ACL qualification failed.', { cause: error }); }
    }
    return { token: issued.token, expiresAt: issued.record.expiresAt, env: { FLUJO_OWNER_AUTH_FILE: ownerFile,
      FLUJO_MCP_TRUSTED_HOST_FILE: path.join(directory, 'approval.json') }, restore };
  } catch (error) {
    try { await restore(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Smoke operator setup and cleanup failed.', { cause: error }); }
    throw error;
  }
}

export async function approveSmokeServer(baseUrl, name, token, timeoutMs, { workspace, expiresAt = Date.now() + 120_000 } = {}) {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 15 * 60_000) throw new Error('Invalid smoke consent expiry.');
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  if (workspace !== undefined) {
    if (typeof workspace !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(workspace)) throw new Error('Invalid smoke workspace.');
    headers['x-flujo-workspace'] = workspace;
  }
  const url = new URL(`/api/mcp/servers/${encodeURIComponent(name)}/host-consent`, baseUrl);
  url.searchParams.set('runtimeHome', 'host');
  const preview = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!preview.ok) throw new Error(`Installed ${name} consent preview returned ${preview.status}.`);
  const reviewed = await preview.json();
  if (reviewed.serverName !== name || !/^[a-f0-9]{64}$/.test(reviewed.policyDigest)) throw new Error('Invalid installed package consent preview.');
  const approval = await fetch(url, { method: 'POST', headers, signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({ runtimeHome: 'host', reviewedDigest: reviewed.policyDigest, expiresAt }) });
  if (!approval.ok || (await approval.json()).approved !== true) throw new Error(`Installed ${name} consent approval returned ${approval.status}.`);
}

/** Disposable read-only metadata bridge; the MCP child never receives the owner token. */
export async function createSmokeMetadataBff(baseUrl, token) {
  const upstream = new URL(baseUrl);
  if (upstream.protocol !== 'http:' || upstream.hostname !== '127.0.0.1'
      || upstream.username || upstream.password || upstream.pathname !== '/'
      || upstream.search || upstream.hash) throw new Error('Loopback smoke application required.');
  // Select a complete fixed upstream URL. Request bytes are used only as an
  // allowlist key and an encoded cursor, never as a relative fetch destination.
  const endpoints = new Map([
    ['/api/mcp/flujo/tools', new URL('/api/mcp/flujo/tools', upstream)],
    ['/api/mcp/flujo/resources', new URL('/api/mcp/flujo/resources', upstream)],
    ['/api/mcp/flujo/resource-templates', new URL('/api/mcp/flujo/resource-templates', upstream)],
    ['/api/mcp/flujo/skills', new URL('/api/mcp/flujo/skills', upstream)],
  ]);
  const server = createServer(async (request, response) => {
    if (request.method !== 'GET' || (request.url?.length ?? 0) > 2048
        || !/^\/api\/mcp\/flujo\/(?:tools|resources|resource-templates|skills)(?:\?[^\r\n]*)?$/.test(request.url ?? '')) {
      response.writeHead(404); response.end(); return;
    }
    try {
      const requested = new URL(request.url, 'http://metadata.invalid');
      const endpoint = endpoints.get(requested.pathname);
      if (!endpoint || requested.hash || [...requested.searchParams.keys()].some(name => name !== 'cursor')
          || requested.searchParams.getAll('cursor').length > 1) {
        response.writeHead(404); response.end(); return;
      }
      const target = new URL(endpoint);
      const cursor = requested.searchParams.get('cursor');
      if (cursor !== null) target.searchParams.set('cursor', cursor);
      const result = await fetch(target, {
        headers: { authorization: `Bearer ${token}`, 'x-flujo-workspace': 'default-workspace' },
        redirect: 'error', signal: AbortSignal.timeout(30_000),
      });
      const reader = result.body?.getReader();
      const chunks = []; let size = 0;
      if (reader) try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > 4 * 1024 * 1024) throw new Error('Metadata exceeds smoke bounds.');
          chunks.push(Buffer.from(value));
        }
      } finally { await reader.cancel(); }
      response.writeHead(result.status, { 'content-type': 'application/json' });
      response.end(Buffer.concat(chunks));
    } catch { response.writeHead(502); response.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve, reject) => {
    server.closeAllConnections(); server.close(error => error ? reject(error) : resolve());
  }) };
}
