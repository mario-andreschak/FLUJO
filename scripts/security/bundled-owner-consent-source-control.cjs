'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const {closeAndRestoreFixture}=require('./owned-source-fixture-cleanup.cjs');
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
(async()=>{
 const {installTrustedHostProfile}=require(path.join(sourceRoot,'__tests__/mcp/fixtures/trustedHostProfile.ts'));
 const fixture=installTrustedHostProfile();
 const savedApp=process.env.FLUJO_APP_ROOT;process.env.FLUJO_APP_ROOT=sourceRoot;
 let transport,primaryError;
 try{
  const {issueOwnerCredential}=require(path.join(sourceRoot,'src/backend/services/security/ownerCredentials.ts'));
  const credential=issueOwnerCredential(['control:admin','mcp:access','secrets:read'],Date.now()+600000);
  fs.writeFileSync(process.env.FLUJO_OWNER_AUTH_FILE,JSON.stringify({schemaVersion:1,ownerId:'synthetic-fixture-owner',credentials:[credential.record]}),{mode:0o600});
  const ledgerFilename=process.env.FLUJO_MCP_TRUSTED_HOST_FILE;assert.equal(fs.lstatSync(ledgerFilename).isSymbolicLink(),false);fs.unlinkSync(ledgerFilename);
  await require(path.join(sourceRoot,'__tests__/utils/privateProfileFixture.ts')).unlockPrivateFixtureInCurrentWorkspace();
  const workspace=require(path.join(sourceRoot,'src/utils/workspace.ts'));
  const copied=require(path.join(sourceRoot,'src/backend/services/mcp/shippedWorkspacePackages.ts'));
  await copied.ensureShippedWorkspacePackages(workspace.getWorkspaceDataDir(),sourceRoot,['filesystem']);
  const descriptors=require(path.join(sourceRoot,'src/backend/services/mcp/shippedServers.ts'));
  const descriptor=descriptors.SHIPPED_MCP_SERVERS.find(item=>item.packageDirectory==='filesystem');
  const target=path.join(workspace.getWorkspaceDataDir(),'files');fs.mkdirSync(target,{recursive:true});fs.writeFileSync(path.join(target,'input.txt'),'actual bundled source fixture');
  const config={...descriptors.createShippedServerConfig(descriptor,{FLUJO_DATA_DIR:process.env.FLUJO_DATA_DIR}),roots:[target]};config.env.FLUJO_FS_ROOTS=target;
  const stored=require(path.join(sourceRoot,'src/backend/services/mcp/config.ts'));assert.equal((await stored.saveConfig(new Map([[config.name,config]]))).success,true);
  const consent=require(path.join(sourceRoot,'src/backend/services/security/bundledMcpConsent.ts'));
  const {readPrivateApprovalAsync}=require(path.join(sourceRoot,'src/backend/services/security/trustedHostMcp.ts'));
  const makeRequest=()=>new Request('http://127.0.0.1/api/mcp/servers/filesystem/host-consent',{method:'POST',headers:{Authorization:`Bearer ${credential.token}`}});
  const ordinary=require(path.join(sourceRoot,'src/backend/services/mcp/connection.ts'));
  const beta=require(path.join(sourceRoot,'src/backend/services/mcp/betaClient.ts'));
  const tools=require(path.join(sourceRoot,'src/backend/services/mcp/tools.ts'));
  for(const era of['v1','beta']){
   const started=performance.now();
   const preview=await consent.previewBundledHostConsent(config.name,{runtimeHome:'host'});
   const previewMs=performance.now()-started;
   console.log(JSON.stringify({stage:'bundle-preview',sdk:era,elapsedMs:previewMs,dependencyPackages:preview.revision.dependencyGraph.packages.length}));
   await assert.rejects(consent.approveBundledHostConsent(new Request('http://127.0.0.1'),config.name,{runtimeHome:'host',reviewedDigest:preview.policyDigest,expiresAt:Date.now()+120000}),e=>e.response?.status===401);
   if(era==='v1')assert.equal(fs.existsSync(ledgerFilename),false);
   await assert.rejects(consent.approveBundledHostConsent(makeRequest(),config.name,{runtimeHome:'host',reviewedDigest:'0'.repeat(64),expiresAt:Date.now()+120000}));
   if(era==='v1'){const initialized=await readPrivateApprovalAsync(ledgerFilename);assert.equal(initialized.ownerId,'synthetic-fixture-owner');assert.deepEqual(initialized.approvals,[]);console.log(JSON.stringify({stage:'operator-ledger-initialized',missingBearerCreatedNoFile:true,actualPrivateOwnerInitializedEmptyLedger:true,staleReviewCreatedNoGrant:true}));}
   const approvalStarted=performance.now();
   await consent.approveBundledHostConsent(makeRequest(),config.name,{runtimeHome:'host',reviewedDigest:preview.policyDigest,expiresAt:Date.now()+120000});
   const approvalMs=performance.now()-approvalStarted;
   console.log(JSON.stringify({stage:'bundle-approved',sdk:era,elapsedMs:performance.now()-started,approvalMs}));
   const approved=(await stored.loadServerConfigs()).find(item=>item.name===config.name);assert.ok(approved.trustedHost?.bundledInstallation);
   const launchStarted=performance.now();
   transport=era==='v1'?ordinary.createStdioTransport(approved):beta.createBetaTransport(approved);
   const client=era==='v1'?ordinary.createNewClient(approved):beta.createNewBetaClient(approved);await client.connect(transport);
   const grant=(await readPrivateApprovalAsync(ledgerFilename)).approvals.find(item=>item.serverName===approved.name);
   const launchInitializeMs=performance.now()-launchStarted;
   console.log(JSON.stringify({stage:'bundle-before-read',sdk:era,elapsedMs:performance.now()-started,grantRemainingMs:grant.expiresAt-Date.now(),launchInitializeMs}));
   const toolsStarted=performance.now();
   const read=await tools.callTool(client,approved.name,'read_file',{path:path.join(target,'input.txt')},30);assert.equal(read.success,true,JSON.stringify(read));
   const write=await tools.callTool(client,approved.name,'write_file',{path:path.join(target,`${era}-output.txt`),content:'actual authorized bundled write'},30);assert.equal(write.success,true,JSON.stringify(write));assert.equal(fs.readFileSync(path.join(target,`${era}-output.txt`),'utf8'),'actual authorized bundled write');
   const pid=transport.pid;await transport.close();transport=undefined;if(pid)assert.throws(()=>process.kill(pid,0),e=>e.code==='ESRCH');
   const toolsAndCloseMs=performance.now()-toolsStarted;
   console.log(JSON.stringify({stage:'bundle-original-positive-workflow',sdk:era,previewMs,approvalMs,launchInitializeMs,toolsAndCloseMs,totalPositiveWorkflowMs:previewMs+approvalMs+launchInitializeMs+toolsAndCloseMs,negativeControlsExcluded:true}));
   console.log(JSON.stringify({sourceControl:'bundled-owner-consent',sdk:era,realOwnerBearer:true,missingBearerRefused:true,changedReviewRefused:true,actualProtectedLedgerWritten:true,authoritativeApprovedConfigPersisted:true,actualShippedFilesystemSourceUsed:true,actualSdkInitializeReadWrite:true,originalTargetAssertions:true,ownedRootPidAbsentAfterClose:true,scope:'Source-built actual shipped package/nonmatching SDK graph; no packed-installed qualification, descendant-family absence or scanner clearance'}));
  }
 }catch(error){primaryError=error;throw error;}finally{await closeAndRestoreFixture(transport,()=>{if(savedApp===undefined)delete process.env.FLUJO_APP_ROOT;else process.env.FLUJO_APP_ROOT=savedApp;},()=>fixture.restore(),primaryError);}
})().catch(error=>{console.error(error);process.exitCode=1;});
