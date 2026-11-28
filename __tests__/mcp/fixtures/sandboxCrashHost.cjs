'use strict';
// A FLUJO stand-in for sandboxShutdownPaths.test.ts (#1423): it launches one
// sandboxed server through the real launcher, reports what it created, and
// then waits to be killed, so nothing of FLUJO's own cleanup can run.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ts = require('typescript');

const security = path.resolve(__dirname, '../../../src/backend/services/security');
const allowed = new Set(['isolatedMcp.ts', 'isolatedMcpInspection.ts', 'windowsPrivateAuthority.ts']
  .map(name => path.join(security, name)).concat(path.resolve(security, '../../../utils/realpath.ts')));
require.extensions['.ts'] = (module, filename) => {
  if (!allowed.has(filename)) throw new Error('Unexpected source module');
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, filename);
};
const inspection = require(path.join(security, 'isolatedMcpInspection.ts'));
// The stand-in daemon keeps no full container record; inspection has its own tests.
inspection.assertIsolatedMcpContainerInspection = () => undefined;
const { createIsolatedMcpLaunch, isolatedMcpPolicyDigest } = require(path.join(security, 'isolatedMcp.ts'));

(async () => {
  const [policyJson, workspaceRoot, key] = process.argv.slice(2);
  const policy = JSON.parse(policyJson);
  const launch = await createIsolatedMcpLaunch(policy, isolatedMcpPolicyDigest(policy), workspaceRoot, {}, { key });
  const server = spawn(launch.command, [...launch.args], { env: launch.env, cwd: launch.cwd, stdio: ['pipe', 'pipe', 'ignore'] });
  process.stdout.write(`${JSON.stringify({ containerId: launch.containerId, controlDir: launch.cwd, serverPid: server.pid })}\n`);
  setInterval(() => undefined, 60_000);
})().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
