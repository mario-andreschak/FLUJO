'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const sourceRoot = path.resolve(process.argv[2] || path.join(__dirname, '../..'));
const dependencyRoot = path.resolve(process.argv[3] || sourceRoot);
const ts = require(path.join(dependencyRoot, 'node_modules/typescript'));
const resolve = Module._resolveFilename;
Module._resolveFilename = function (name, ...args) {
  const selected = name.startsWith('@/') ? path.join(sourceRoot, 'src', name.slice(2)) : name;
  try { return resolve.call(this, selected, ...args); }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND' || name.startsWith('.') || path.isAbsolute(selected)) throw error;
    return require.resolve(name, { paths: [dependencyRoot] });
  }
};
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
(async () => {
  const { buildLaunchEnv } = await import(pathToFileURL(path.join(sourceRoot, 'scripts/launch-next.mjs')).href);
  const { createShippedServerConfig, SHIPPED_MCP_SERVERS } = require(path.join(sourceRoot, 'src/backend/services/mcp/shippedServers.ts'));
  const { trustedHostMcpPolicySchema } = require(path.join(sourceRoot, 'src/backend/services/security/trustedHostMcp.ts'));
  const launch = buildLaunchEnv({});
  const supportsSystemCa = process.allowedNodeEnvironmentFlags.has('--use-system-ca');
  if (supportsSystemCa) assert.equal(launch.NODE_OPTIONS, '--use-system-ca');
  const basePolicy = { schemaVersion: 1, kind: 'trusted-host', privileges: 'owner-account', runtime: 'node',
    entryPoint: path.join(sourceRoot, 'synthetic-entry.js'), sourceRoot,
    sourceDigest: 'a'.repeat(64), executableDigest: 'b'.repeat(64), environmentNames: [] };
  assert.equal(trustedHostMcpPolicySchema.safeParse(basePolicy).success, true);
  for (const descriptor of SHIPPED_MCP_SERVERS) {
    for (const options of [launch.NODE_OPTIONS ?? '', '--require=synthetic-loader', '']) {
      const parent = { ...launch, NODE_OPTIONS: options, FLUJO_DATA_DIR: sourceRoot };
      const stored = createShippedServerConfig(descriptor, parent);
      assert.equal(Object.hasOwn(stored.env, 'NODE_OPTIONS'), false);
      assert.equal(parent.NODE_OPTIONS, options);
      // An existing/imported loader field is never silently repaired by consent.
      const persisted = { ...stored.env, NODE_OPTIONS: options };
      assert.equal(trustedHostMcpPolicySchema.safeParse({ ...basePolicy, environmentNames: Object.keys(persisted) }).success, false);
    }
  }
  console.log(JSON.stringify({ sourceControl: 'shipped-loader-environment', actualLaunchEnvironmentUsed: true,
    systemCaLauncherFlagObserved: supportsSystemCa, allFourShippedConfigsOmitLoaderControl: true,
    parentEnvironmentUnchanged: true, existingBlankAndArbitraryLoaderNamesStillRefusedByPrivateSchema: true,
    scope: 'Actual Source launcher/provisioning/private schema; no installed compiled preview or authority qualification' }));
})().catch(error => { console.error(error); process.exitCode = 1; });
