'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const sourceRoot = path.resolve(process.argv[2] || path.join(__dirname, '../..'));
const ts = require(path.join(sourceRoot, 'node_modules/typescript'));
const originalResolve = Module._resolveFilename;
const originalTs = require.extensions['.ts'];
Module._resolveFilename = function (name, ...args) {
  return originalResolve.call(this, name.startsWith('@/') ? path.join(sourceRoot, 'src', name.slice(2)) : name, ...args);
};
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);

// Source equipment only. Every owner issue/read and native ACL check is real;
// no installed/compiled HTTP result is inferred from this control.
(async () => {
  const promises = fs.promises;
  const originalMkdtemp = promises.mkdtemp;
  let injected = 0;
  let operator;
  let primary;
  const cleanupErrors = [];
  const savedData = process.env.FLUJO_DATA_DIR;
  const savedParent = process.env.FLUJO_PARENT_DATA_DIR;
  try {
    if (process.platform === 'win32') promises.mkdtemp = async (...args) => {
      const directory = await originalMkdtemp.apply(promises, args);
      if (!String(args[0]).includes('flujo-smoke-operator-')) return directory;
      // Introduce a real inheritable foreign-reader rule on this freshly owned
      // directory before the operator helper runs. chmod alone cannot fix it.
      const executable = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
      const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', String.raw`
$ErrorActionPreference='Stop'
$request=[Console]::In.ReadToEnd()|ConvertFrom-Json
$directory=[IO.DirectoryInfo]::new([string]$request.directory)
$acl=$directory.GetAccessControl()
$rule=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow')
$acl.AddAccessRule($rule)
$directory.SetAccessControl($acl)
if (-not @($directory.GetAccessControl().GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference.Value -eq 'S-1-5-32-545' -and $_.AccessControlType -eq 'Allow' }).Count) { throw 'Foreign rule was not installed' }
`], { input: JSON.stringify({ directory }), encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 65536 });
      if (result.error || result.status !== 0 || result.signal) throw new Error('Owned foreign ACL fixture setup failed.');
      injected++;
      return directory;
    };
    const { createSmokeOperator } = await import(pathToFileURL(path.join(sourceRoot, 'scripts/smoke-bundled-operator.mjs')).href);
    operator = await createSmokeOperator();
    promises.mkdtemp = originalMkdtemp;
    if (process.platform === 'win32') assert.equal(injected, 1);
    const filename = operator.env.FLUJO_OWNER_AUTH_FILE;
    process.env.FLUJO_DATA_DIR = path.join(path.dirname(filename), 'unrelated-data');
    delete process.env.FLUJO_PARENT_DATA_DIR;
    const bytes = fs.readFileSync(filename);
    const { readPrivateApprovalAsync } = require(path.join(sourceRoot, 'src/backend/services/security/trustedHostMcp.ts'));
    const { ownerPolicySchema, authenticateOwnerBearer } = require(path.join(sourceRoot, 'src/backend/services/security/ownerCredentials.ts'));
    const policy = ownerPolicySchema.parse(await readPrivateApprovalAsync(filename, AbortSignal.timeout(30_000)));
    assert.equal(policy.ownerId, 'packed-smoke-operator');
    assert.ok(authenticateOwnerBearer(new Request('http://localhost/', { headers: { authorization: `Bearer ${operator.token}` } }), policy));
    assert.deepEqual(fs.readFileSync(filename), bytes);
    bytes.fill(0);
    console.log(JSON.stringify({ scope: 'source-private-smoke-owner', nativeWindows: process.platform === 'win32', foreignAclIntroduced: injected === 1, realAsyncOwnerRead: true, realOwnerAuthentication: true }));
  } catch (error) { primary = error; }
  finally {
    promises.mkdtemp = originalMkdtemp;
    if (operator) try { await operator.restore(); } catch (error) { cleanupErrors.push(error); }
    if (savedData === undefined) delete process.env.FLUJO_DATA_DIR; else process.env.FLUJO_DATA_DIR = savedData;
    if (savedParent === undefined) delete process.env.FLUJO_PARENT_DATA_DIR; else process.env.FLUJO_PARENT_DATA_DIR = savedParent;
    Module._resolveFilename = originalResolve;
    if (originalTs === undefined) delete require.extensions['.ts']; else require.extensions['.ts'] = originalTs;
  }
  if (primary || cleanupErrors.length) throw new AggregateError(primary ? [primary, ...cleanupErrors] : cleanupErrors, 'Smoke owner authority source control failed.');
})().catch(() => { console.error('Smoke owner authority source control failed; private causes are not logged.'); process.exitCode = 1; });
