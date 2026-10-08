'use strict';
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),assert=require('node:assert/strict');
const sourceRoot=path.resolve(process.argv[2]||path.join(__dirname,'../..'));
const ts=require(path.join(sourceRoot,'node_modules/typescript')),resolve=Module._resolveFilename;
Module._resolveFilename=function(name,...args){
 if(name==='mcp-stdio-oauth'||name.startsWith('mcp-stdio-oauth/')){
  const root=path.join(sourceRoot,'node_modules/mcp-stdio-oauth'),spec=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')),key=name==='mcp-stdio-oauth'?'.':`./${name.slice('mcp-stdio-oauth/'.length)}`;
  return resolve.call(this,path.join(root,spec.exports[key].import),...args);
 }
 return resolve.call(this,name.startsWith('@/')?path.join(sourceRoot,'src',name.slice(2)):name,...args);
};
require.extensions['.ts']=(module,filename)=>module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,filename);
(async()=>{
 const {installTrustedHostProfile}=require(path.join(sourceRoot,'__tests__/mcp/fixtures/trustedHostProfile.ts'));
 const fixture=installTrustedHostProfile(),vars=['FLUJO_APP_ROOT','FLUJO_BASE_URL','FLUJO_WORKER_MODE','FLUJO_SNAPSHOT_CONTROL_TOKEN'];
 const saved=Object.fromEntries(vars.map(name=>[name,process.env[name]]));let transport;
 try{
  process.env.FLUJO_APP_ROOT=sourceRoot;process.env.FLUJO_BASE_URL='http://127.0.0.1:1';delete process.env.FLUJO_WORKER_MODE;delete process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN;
  const {issueOwnerCredential}=require(path.join(sourceRoot,'src/backend/services/security/ownerCredentials.ts'));
  const credential=issueOwnerCredential(['control:admin','mcp:access','secrets:read'],Date.now()+600000);
  fs.writeFileSync(process.env.FLUJO_OWNER_AUTH_FILE,JSON.stringify({schemaVersion:1,ownerId:'synthetic-fixture-owner',credentials:[credential.record]}),{mode:0o600});
  await require(path.join(sourceRoot,'__tests__/utils/privateProfileFixture.ts')).unlockPrivateFixtureInCurrentWorkspace();
  const workspace=require(path.join(sourceRoot,'src/utils/workspace.ts'));
  await require(path.join(sourceRoot,'src/backend/services/mcp/shippedWorkspacePackages.ts')).ensureShippedWorkspacePackages(workspace.getWorkspaceDataDir(),sourceRoot,['flujo']);
  const shipped=require(path.join(sourceRoot,'src/backend/services/mcp/shippedServers.ts')),descriptor=shipped.SHIPPED_MCP_SERVERS.find(item=>item.packageDirectory==='flujo');
  const config=shipped.createShippedServerConfig(descriptor,{FLUJO_DATA_DIR:process.env.FLUJO_DATA_DIR,FLUJO_BASE_URL:process.env.FLUJO_BASE_URL});
  const store=require(path.join(sourceRoot,'src/backend/services/mcp/config.ts')),consent=require(path.join(sourceRoot,'src/backend/services/security/bundledMcpConsent.ts'));
  assert.equal((await store.saveConfig(new Map([[config.name,config]]))).success,true);
  const preview=await consent.previewBundledHostConsent(config.name,{runtimeHome:'host'});
  const request=new Request('http://127.0.0.1/api/mcp/servers/flujo/host-consent',{method:'POST',headers:{Authorization:`Bearer ${credential.token}`}});
  await consent.approveBundledHostConsent(request,config.name,{runtimeHome:'host',reviewedDigest:preview.policyDigest,expiresAt:Date.now()+120000});
  const approved=(await store.loadServerConfigs()).find(item=>item.name===config.name);
  assert.equal(approved.trustedHost.bundledInstallation.packageDirectory,'flujo');
  for(const name of['FLUJO_SNAPSHOT_CONTROL_TOKEN','flujo_snapshot_control_token','FLUJO_WORKER_MODE','flujo_worker_mode']){
   const forged={...approved,env:{...approved.env,[name]:'synthetic-persisted-forgery'}};
   assert.equal((await store.saveConfig(new Map([[forged.name,forged]]))).success,true);
   await assert.rejects(consent.previewBundledHostConsent(forged.name,{runtimeHome:'host'}),/Persisted runtime credentials/);
  }
  assert.equal((await store.saveConfig(new Map([[approved.name,approved]]))).success,true);
  process.env.FLUJO_WORKER_MODE='1';process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN='synthetic-runtime-only-worker-token';
  const host=require(path.join(sourceRoot,'src/backend/services/mcp/trustedHost.ts'));
  const launch=host.resolveTrustedHostLaunch(approved);assert.equal(launch.env.FLUJO_SNAPSHOT_CONTROL_TOKEN,process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN);assert.equal(launch.env.FLUJO_WORKER_MODE,'1');assert.equal(launch.env.FLUJO_WORKSPACE,workspace.getCurrentWorkspace());
  assert.equal(Object.keys(approved.env).some(name=>name.toUpperCase()==='FLUJO_SNAPSHOT_CONTROL_TOKEN'),false);
  const audience=process.env.FLUJO_BASE_URL;process.env.FLUJO_BASE_URL='http://127.0.0.1:2';try{assert.throws(()=>host.resolveTrustedHostLaunch(approved),error=>error.code==='HOST_POLICY_INVALID');}finally{process.env.FLUJO_BASE_URL=audience;}
  const ordinary=require(path.join(sourceRoot,'src/backend/services/mcp/connection.ts')),beta=require(path.join(sourceRoot,'src/backend/services/mcp/betaClient.ts'));
  for(const era of['v1','beta']){
   // A fresh real grant for each SDK keeps the original short expiry intact.
   delete process.env.FLUJO_WORKER_MODE;
   const reviewed=await consent.previewBundledHostConsent(approved.name,{runtimeHome:'host'});
   await consent.approveBundledHostConsent(request,approved.name,{runtimeHome:'host',reviewedDigest:reviewed.policyDigest,expiresAt:Date.now()+120000});
   process.env.FLUJO_WORKER_MODE='1';
   const current=(await store.loadServerConfigs()).find(item=>item.name===approved.name);
   transport=era==='v1'?ordinary.createStdioTransport(current):beta.createBetaTransport(current);
   const client=era==='v1'?ordinary.createNewClient(current):beta.createNewBetaClient(current);await client.connect(transport);
   const token=process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN;process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN='synthetic-rotated-worker-token';
   try{await assert.rejects(host.getManagedTrustedHost(transport).assertCurrent(current),error=>error.code==='HOST_CONSENT_REQUIRED');}finally{process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN=token;}
   const pid=transport.pid;await transport.close();transport=undefined;if(pid)assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH');
   console.log(JSON.stringify({sourceControl:'bundled-worker-token',sdk:era,actualPrivateOwnerGrant:true,actualShippedFlujoRevision:true,actualSdkInitialization:true,runtimeOnlyWorkerTokenReleased:true,persistedCaseVariantsRefused:true,exactRunnerAudienceAndSelectedWorkspaceBound:true,runnerAudienceDriftRefused:true,capturedGenerationTokenRotationRefused:true,ownedRootPidAbsentAfterClose:true,scope:'Source-built actual shipped flujo/real private consent/nonmatching local SDK graph; no downstream HTTP/provider call, worker bootstrap, packed-installed acceptance or scanner clearance'}));
  }
 }finally{if(transport)await transport.close();for(const[name,value]of Object.entries(saved)){if(value===undefined)delete process.env[name];else process.env[name]=value;}fixture.restore();}
})().catch(error=>{console.error(error);process.exitCode=1;});
