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
(async()=>{
 const {installTrustedHostProfile}=require(path.join(sourceRoot,'__tests__/mcp/fixtures/trustedHostProfile.ts'));
 const fixture=installTrustedHostProfile();
 const {createOwnedPrivateApprovalStage}=require(path.join(sourceRoot,'src/backend/services/security/ownedPrivateApprovalStage.ts'));
 const {withPrivateApprovalLedgerLock}=require(path.join(sourceRoot,'src/backend/services/security/privateApprovalLedgerLock.ts'));
 const filename=process.env.FLUJO_MCP_TRUSTED_HOST_FILE,signal=new AbortController().signal;
 const previous=JSON.parse(fs.readFileSync(filename,'utf8'));
 try{
  const mutation=await createOwnedPrivateApprovalStage(filename,previous,signal);
  fs.writeFileSync(mutation.path,JSON.stringify({...previous,ownerId:'foreign-stage-owner'}));
  try{await assert.rejects(mutation.publish(filename));assert.deepEqual(JSON.parse(fs.readFileSync(filename,'utf8')),previous);}finally{await mutation.dispose();}
  const replacement=await createOwnedPrivateApprovalStage(filename,previous,signal);
  const retained=path.join(path.dirname(replacement.path),'retained-owned-stage');fs.renameSync(replacement.path,retained);fs.writeFileSync(replacement.path,'synthetic foreign replacement');
  try{await assert.rejects(replacement.publish(filename));}finally{await replacement.dispose();}
  assert.equal(fs.readFileSync(replacement.path,'utf8'),'synthetic foreign replacement');assert.deepEqual(JSON.parse(fs.readFileSync(filename,'utf8')),previous);
  fs.unlinkSync(replacement.path);fs.unlinkSync(retained);
  let entered,release,secondEntered=false;
  const firstEntered=new Promise(resolve=>{entered=resolve;});const barrier=new Promise(resolve=>{release=resolve;});
  const first=withPrivateApprovalLedgerLock(filename,signal,async()=>{
   const next={...JSON.parse(fs.readFileSync(filename,'utf8')),approvals:[...previous.approvals,{...previous.approvals[0],serverName:'serialized-second-server'}]};
   const stage=await createOwnedPrivateApprovalStage(filename,next,signal);entered();await barrier;try{await stage.publish(filename);}finally{await stage.dispose();}
  });
  await firstEntered;
  const second=withPrivateApprovalLedgerLock(filename,signal,async()=>{
   secondEntered=true;const current=JSON.parse(fs.readFileSync(filename,'utf8'));assert.equal(current.approvals.some(item=>item.serverName==='serialized-second-server'),true);
   const stage=await createOwnedPrivateApprovalStage(filename,{...current,approvals:current.approvals.filter(item=>item.serverName!=='serialized-second-server')},signal);try{await stage.publish(filename);}finally{await stage.dispose();}
  });
  await new Promise(resolve=>setTimeout(resolve,100));assert.equal(secondEntered,false);release();await Promise.all([first,second]);
  assert.deepEqual(JSON.parse(fs.readFileSync(filename,'utf8')),previous);assert.equal(fs.existsSync(`${filename}.writer-lock`),false);
  const {issueOwnerCredential}=require(path.join(sourceRoot,'src/backend/services/security/ownerCredentials.ts'));
  const credential=issueOwnerCredential(['control:admin','mcp:access','secrets:read'],Date.now()+600000);
  fs.writeFileSync(process.env.FLUJO_OWNER_AUTH_FILE,JSON.stringify({schemaVersion:1,ownerId:previous.ownerId,credentials:[credential.record]}),{mode:0o600});
  const secondLedger=path.join(path.dirname(filename),'second-private-ledger.json');fs.writeFileSync(secondLedger,JSON.stringify(previous),{mode:0o600});
  let lockEntered,unlock;const locked=new Promise(resolve=>{lockEntered=resolve;});const lockBarrier=new Promise(resolve=>{unlock=resolve;});
  const held=withPrivateApprovalLedgerLock(filename,signal,async()=>{lockEntered();await lockBarrier;});await locked;
  const consent=require(path.join(sourceRoot,'src/backend/services/security/bundledMcpConsent.ts'));
  const request=new Request('http://127.0.0.1/api/mcp/servers/filesystem/host-consent',{method:'POST',headers:{Authorization:`Bearer ${credential.token}`}});
  const refused=assert.rejects(consent.approveBundledHostConsent(request,'filesystem',{runtimeHome:'host',reviewedDigest:'0'.repeat(64),expiresAt:Date.now()+120000}),/Captured approval ledger changed/);
  await new Promise(resolve=>setTimeout(resolve,100));process.env.FLUJO_MCP_TRUSTED_HOST_FILE=secondLedger;unlock();
  try{await Promise.all([held,refused]);assert.deepEqual(JSON.parse(fs.readFileSync(filename,'utf8')),previous);assert.deepEqual(JSON.parse(fs.readFileSync(secondLedger,'utf8')),previous);}finally{process.env.FLUJO_MCP_TRUSTED_HOST_FILE=filename;}
  console.log(JSON.stringify({sourceControl:'captured-private-ledger',actualOwnerBearer:true,ledgerEnvironmentChangedWhileWriterWaited:true,capturedFilenameChangeRefused:true,bothLedgersUnchanged:true}));
  const ownerFile=process.env.FLUJO_OWNER_AUTH_FILE,ownerBytes=fs.readFileSync(ownerFile),originalOpenSync=fs.openSync;let revokedWhileStaging=false;
  fs.openSync=function(...args){const fd=Reflect.apply(originalOpenSync,fs,args);if(path.basename(String(args[0])).startsWith('.flujo-mcp-consent-')&&!revokedWhileStaging){revokedWhileStaging=true;const current=JSON.parse(ownerBytes);current.credentials[0].revokedAt=Date.now();fs.writeFileSync(ownerFile,JSON.stringify(current),{mode:0o600});}return fd;};
  try{await assert.rejects(consent.revokeBundledHostConsent(request,fixture.config.name),error=>error.response?.status===401);assert.equal(revokedWhileStaging,true);assert.deepEqual(JSON.parse(fs.readFileSync(filename,'utf8')),previous);}finally{fs.openSync=originalOpenSync;fs.writeFileSync(ownerFile,ownerBytes,{mode:0o600});ownerBytes.fill(0);}
  await consent.revokeBundledHostConsent(request,fixture.config.name);assert.equal(JSON.parse(fs.readFileSync(filename,'utf8')).approvals.some(item=>item.serverName===fixture.config.name),false);fixture.approve();
  console.log(JSON.stringify({sourceControl:'authenticated-private-ledger-revocation',actualOwnerBearerRevocationPublished:true,actualOwnerCredentialRevokedDuringStageReadRefused:true,grantUnchangedOnRetiredAuthority:true,scope:'Actual Source authenticated API helper/private ledger; no full HTTP or installed acceptance claim'}));
  const {NextRequest}=require(path.join(sourceRoot,'node_modules/next/server.js'));
  const {proxy}=require(path.join(sourceRoot,'src/proxy.ts'));
  const savedMode=process.env.FLUJO_WORKER_MODE,savedToken=process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN;
  process.env.FLUJO_WORKER_MODE='1';process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN='synthetic-proxy-snapshot-token';
  const call=(endpoint,token,method='GET')=>proxy(new NextRequest(`http://127.0.0.1${endpoint}`,{method,headers:token?{Authorization:`Bearer ${token}`}:{}}));
  try{
   const endpoint='/api/mcp/servers/filesystem/host-consent';
   assert.equal(call(endpoint).status,401);assert.equal(call(endpoint,'forged-private-owner').status,401);assert.equal(call(endpoint,process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN).status,401);
   for(const method of['GET','POST','DELETE'])assert.equal(call(endpoint,credential.token,method).status,200);
   assert.equal(call('/api/mcp/servers/filesystem',credential.token).status,401);assert.equal(call('/api/mcp/servers/filesystem',process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN).status,200);
   const limited=issueOwnerCredential(['control:admin','mcp:access'],Date.now()+600000);
   fs.writeFileSync(process.env.FLUJO_OWNER_AUTH_FILE,JSON.stringify({schemaVersion:1,ownerId:previous.ownerId,credentials:[limited.record]}),{mode:0o600});assert.equal(call(endpoint,limited.token).status,403);
   console.log(JSON.stringify({sourceControl:'worker-owner-provisioning-proxy',actualPrivateOwnerBearer:true,allThreeScopesRequired:true,missingForgedAndSnapshotBearersRefused:true,exactThreeMethodsAdmitted:true,neighborRouteStillSnapshotProtected:true,scope:'Actual Source proxy/auth policy; no HTTP server readiness or installed acceptance claim'}));
  }finally{if(savedMode===undefined)delete process.env.FLUJO_WORKER_MODE;else process.env.FLUJO_WORKER_MODE=savedMode;if(savedToken===undefined)delete process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN;else process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN=savedToken;}
  console.log(JSON.stringify({sourceControl:'private-approval-ledger',actualStageInPlaceMutationRefused:true,actualForeignReplacementNotPublished:true,actualForeignReplacementPreservedDuringCleanup:true,actualHeldOwnedStage:true,actualConcurrentPublisherAndRevokerSerialized:true,latestLedgerReadAfterLock:true,revocationPreserved:true,ownedLockRemoved:true,scope:'Source real private files/owned FD/OS exclusive lock mechanics; no full authenticated API or installed SDK acceptance claim'}));
 }finally{fixture.restore();}
})().catch(error=>{console.error(error);process.exitCode=1;});
