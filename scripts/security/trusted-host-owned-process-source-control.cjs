'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const sourceRoot = path.resolve(process.argv[2] || path.join(__dirname, '../..'));
const ts = require(path.join(sourceRoot, 'node_modules/typescript'));
const resolve = Module._resolveFilename;
Module._resolveFilename = function (name, ...args) {
  // This Source-only CJS transpilation selects the package's documented import
  // entry for its ESM-only exports. It does not modify the installed package.
  if (name === 'mcp-stdio-oauth' || name.startsWith('mcp-stdio-oauth/')) {
    const packageRoot = path.join(sourceRoot, 'node_modules/mcp-stdio-oauth');
    const spec = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    const key = name === 'mcp-stdio-oauth' ? '.' : `./${name.slice('mcp-stdio-oauth/'.length)}`;
    return resolve.call(this, path.join(packageRoot, spec.exports[key].import), ...args);
  }
  return resolve.call(this, name.startsWith('@/') ? path.join(sourceRoot, 'src', name.slice(2)) : name, ...args);
};
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
const base = process.platform === 'win32' ? process.env.LOCALAPPDATA : require('node:os').tmpdir();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const directory = fs.mkdtempSync(path.join(base, 'flujo-async-host-process-'));
  let transport;
  try {
  process.env.FLUJO_DATA_DIR = path.join(directory, 'data');
  delete process.env.FLUJO_PARENT_DATA_DIR;
  delete process.env.FLUJO_ENCRYPTION_SECRET_FILE;
  delete process.env.FLUJO_MCP_ISOLATION_FILE;
  process.env.FLUJO_OWNER_AUTH_FILE = path.join(directory, 'owner.json');
  process.env.FLUJO_MCP_TRUSTED_HOST_FILE = path.join(directory, 'grant.json');
  process.env.LOG_LEVEL = 'error';
  process.env.HOST_PRIVATE_SYNTHETIC_SECRET = 'must-not-reach-child';
  fs.writeFileSync(process.env.FLUJO_OWNER_AUTH_FILE, JSON.stringify({ schemaVersion: 1, ownerId: 'synthetic-owner', credentials: [] }), { mode: 0o600 });
  const policy = require(path.join(sourceRoot, 'src/backend/services/security/trustedHostMcp.ts'));
  const workspace = require(path.join(sourceRoot, 'src/utils/workspace.ts'));
  const fixture = require(path.join(sourceRoot, '__tests__/utils/privateProfileFixture.ts'));
  await fixture.unlockPrivateFixtureInCurrentWorkspace();
  const stored = require(path.join(sourceRoot, 'src/backend/services/mcp/config.ts'));
  const ordinary = require(path.join(sourceRoot, 'src/backend/services/mcp/connection.ts'));
  const beta = require(path.join(sourceRoot, 'src/backend/services/mcp/betaClient.ts'));
  const dispatch = require(path.join(sourceRoot, 'src/backend/services/mcp/isolation.ts'));
  const tools = require(path.join(sourceRoot, 'src/backend/services/mcp/tools.ts'));
  const packageRoot = path.join(workspace.getWorkspaceDataDir(), 'mcp-servers', 'controlled-node');
  fs.mkdirSync(packageRoot, { recursive: true });
  const entry = path.join(packageRoot, 'server.cjs');
  fs.writeFileSync(entry, `const fs=require('node:fs');fs.writeFileSync(process.env.WITNESS_PATH,JSON.stringify({pid:process.pid,token:process.env.APPROVED_TOKEN,secret:process.env.HOST_PRIVATE_SYNTHETIC_SECRET,home:process.env.HOME,nodeOptions:process.env.NODE_OPTIONS}));require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);if(q.id===undefined)return;let result;if(q.method==='initialize')result={protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'controlled-synthetic',version:'1'}};if(q.method==='tools/list')result={tools:[{name:'probe',inputSchema:{type:'object'}}]};if(q.method==='tools/call')result={content:[{type:'text',text:JSON.stringify(q.params.arguments)}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');});process.stdin.on('end',()=>process.exit(0));`);
    for (const era of ['v1', 'beta']) {
      const witness = path.join(directory, `${era}-witness.json`);
      const env = { APPROVED_TOKEN: 'synthetic-scoped-token', WITNESS_PATH: witness, ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot || 'C:\\Windows' } : {}) };
      const config = { name: `controlled-${era}`, transport: 'stdio', command: process.execPath, args: [entry], cwd: packageRoot,
        disabled: false, rootPath: '', roots: [], env, _buildCommand: '', _installCommand: '', source: { type: 'local' },
        trustedHost: { schemaVersion: 1, kind: 'trusted-host', privileges: 'owner-account', runtime: 'node', entryPoint: entry,
          sourceRoot: packageRoot, sourceDigest: policy.fingerprintTrustedHostSource(packageRoot),
          executableDigest: policy.fingerprintTrustedHostExecutable(process.execPath), environmentNames: Object.keys(env) } };
      const grant = { schemaVersion: 1, ownerId: 'synthetic-owner', approvals: [{ workspace: workspace.getCurrentWorkspace(), serverName: config.name,
        policyDigest: policy.trustedHostMcpPolicyDigest(config), expiresAt: Date.now() + 120000 }] };
      fs.writeFileSync(process.env.FLUJO_MCP_TRUSTED_HOST_FILE, JSON.stringify(grant), { mode: 0o600 });
      assert.equal((await stored.saveConfig(new Map([[config.name, config]]))).success, true);
      const persisted = await stored.loadServerConfigs();
      assert.ok(Array.isArray(persisted));
      assert.equal(policy.trustedHostMcpPolicyDigest(persisted[0]), grant.approvals[0].policyDigest);
      transport = era === 'v1' ? ordinary.createStdioTransport(config) : beta.createBetaTransport(config);
      const client = era === 'v1' ? ordinary.createNewClient(config) : beta.createNewBetaClient(config);
      await client.connect(transport);
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(witness) && Date.now() < deadline) await sleep(20);
      assert.ok(fs.existsSync(witness), 'Owned child did not publish its synthetic startup witness');
      const child = JSON.parse(fs.readFileSync(witness, 'utf8'));
      assert.equal(child.token, 'synthetic-scoped-token');
      assert.equal(child.secret, undefined);
      assert.ok(!child.home);
      assert.ok(!child.nodeOptions);
      assert.equal(transport.pid, child.pid);
      const response = await tools.callTool(client, config.name, 'probe', { literal: 'approved synthetic input' }, 5);
      assert.equal(response.success, true);
      assert.equal(response.data.content[0].text, JSON.stringify({ literal: 'approved synthetic input' }));
      const secretAttempt = await tools.callTool(client, config.name, 'probe', { value: '${global:HOST_PRIVATE_SYNTHETIC_SECRET}' }, 5);
      assert.equal(secretAttempt.success, false);
      assert.equal(secretAttempt.error, 'HOST_POLICY_INVALID');
      let entered;
      let release;
      const checking = new Promise(resolve => { entered = resolve; });
      const barrier = new Promise(resolve => { release = resolve; });
      const originalOpen = fs.promises.open;
      fs.promises.open = async function (...args) {
        const handle = await originalOpen.apply(this, args);
        if (String(args[0]) === config.command) {
          const read = handle.read.bind(handle);
          handle.read = async (...readArgs) => { entered(); await barrier; return read(...readArgs); };
        }
        return handle;
      };
      try {
        const pending = tools.callTool(client, config.name, 'probe', {}, 5);
        await Promise.race([checking, pending.then(result => { throw new Error(`Dispatch ended before fingerprint barrier: ${JSON.stringify(result)}`); })]);
        assert.equal((await stored.saveConfig(new Map([[config.name, { ...config, disabled: true }]]))).success, true);
        release();
        const denied = await pending;
        assert.equal(denied.success, false);
        assert.equal(denied.error, 'HOST_CONSENT_REQUIRED');
        assert.throws(() => process.kill(child.pid, 0), error => error.code === 'ESRCH');
      } finally { release(); fs.promises.open = originalOpen; }
      assert.equal((await stored.saveConfig(new Map([[config.name, config]]))).success, true);
      fs.unlinkSync(witness);
      transport = era === 'v1' ? ordinary.createStdioTransport(config) : beta.createBetaTransport(config);
      const replacement = era === 'v1' ? ordinary.createNewClient(config) : beta.createNewBetaClient(config);
      await replacement.connect(transport);
      const restartedDeadline = Date.now() + 5000;
      while (!fs.existsSync(witness) && Date.now() < restartedDeadline) await sleep(20);
      assert.ok(fs.existsSync(witness));
      const restarted = JSON.parse(fs.readFileSync(witness, 'utf8'));
      const owned = transport;
      grant.approvals = [];
      fs.writeFileSync(process.env.FLUJO_MCP_TRUSTED_HOST_FILE, JSON.stringify(grant), { mode: 0o600 });
      await assert.rejects(dispatch.assertMcpIsolationDispatch({ transport: owned, close: () => owned.close() }, config.name), error => error.code === 'HOST_CONSENT_REQUIRED');
      // The SDK's pid getter clears before close finishes; use the retained exact
      // spawned process ID, and require an OS absence witness after awaited close.
      assert.throws(() => process.kill(restarted.pid, 0), error => error.code === 'ESRCH');
      const broker = require(path.join(sourceRoot, 'src/backend/mcpApps/runtimeBroker.ts'));
      const apps = { ...config, enableMcpApps: true };
      grant.approvals = [{ workspace: workspace.getCurrentWorkspace(), serverName: apps.name,
        policyDigest: policy.trustedHostMcpPolicyDigest(apps), expiresAt: Date.now() + 120000 }];
      fs.writeFileSync(process.env.FLUJO_MCP_TRUSTED_HOST_FILE, JSON.stringify(grant), { mode: 0o600 });
      const ownedCapabilities = () => broker.getMcpAppRuntimeBrokerSnapshot().capabilities.filter(item => item.serverName === apps.name);
      assert.equal(ownedCapabilities().length, 0);
      assert.throws(() => era === 'v1' ? ordinary.createStdioTransport(apps, { enableRuntimeBroker: true })
        : beta.createBetaTransport(apps, { enableRuntimeBroker: true }), error => error.code === 'HOST_POLICY_INVALID');
      assert.equal(ownedCapabilities().length, 0, 'Issued broker lease survived a refused environment');
      console.log(JSON.stringify({ sourceControl: 'trusted-host-owned-process', sdk: era, realApprovedChildStarted: true,
        actualStoredProfileRetained: true, scopedEnvironmentObserved: true, unapprovedInheritedSecretAbsent: true,
        actualInitializeAndToolRoundTrip: true, literalArgumentsObserved: true, sharedSecretReferenceDenied: true,
        actualStoredConfigDisabledDuringFingerprintDeniedWithOldGrantValid: true,
        actualIssuedBrokerLeaseRevokedAfterHostEnvironmentRefusal: true,
        actualRevocationDeniedDispatch: true, ownedRootPidAbsentAfterClose: true,
        limits: 'Source transpilation with current nonmatching local SDK graph; no installed artifact, descendant-tree, scanner or independent acceptance' }));
      transport = undefined;
    }
  } finally {
    if (transport) await transport.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(base));
    assert.match(path.basename(directory), /^flujo-async-host-process-/);
    assert.equal(fs.lstatSync(directory).isSymbolicLink(), false);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.name, error.message, error.stack); process.exitCode = 1; });
