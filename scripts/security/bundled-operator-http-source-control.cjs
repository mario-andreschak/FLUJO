'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),Module=require('node:module'),assert=require('node:assert/strict');
const {closeAndRestoreFixture}=require('./owned-source-fixture-cleanup.cjs');
const sourceRoot=path.resolve(process.argv[2]||path.join(__dirname,'../..')),ts=require(path.join(sourceRoot,'node_modules/typescript')),resolve=Module._resolveFilename;
Module._resolveFilename=function(name,...args){
 if(name==='mcp-stdio-oauth'||name.startsWith('mcp-stdio-oauth/')){const root=path.join(sourceRoot,'node_modules/mcp-stdio-oauth'),spec=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')),key=name==='mcp-stdio-oauth'?'.':`./${name.slice('mcp-stdio-oauth/'.length)}`;return resolve.call(this,path.join(root,spec.exports[key].import),...args);}
 return resolve.call(this,name.startsWith('@/')?path.join(sourceRoot,'src',name.slice(2)):name,...args);
};
require.extensions['.ts']=(module,filename)=>module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,filename);
(async()=>{
 const {installTrustedHostProfile}=require(path.join(sourceRoot,'__tests__/mcp/fixtures/trustedHostProfile.ts'));
 const vars=['FLUJO_APP_ROOT','FLUJO_WORKER_MODE','FLUJO_SNAPSHOT_CONTROL_TOKEN'],saved=Object.fromEntries(vars.map(name=>[name,process.env[name]]));
 const globalNames=['__flujo_worker_bootstrap_status','__flujo_workspace_migration_promise','__flujo_workspace_layout_status'],savedGlobals=Object.fromEntries(globalNames.map(name=>[name,global[name]]));
 const fixture=installTrustedHostProfile();let server,primaryError;
 try{
  process.env.FLUJO_APP_ROOT=sourceRoot;delete process.env.FLUJO_WORKER_MODE;delete process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN;
  const {issueOwnerCredential}=require(path.join(sourceRoot,'src/backend/services/security/ownerCredentials.ts'));
  const owner=issueOwnerCredential(['control:admin','mcp:access','secrets:read'],Date.now()+600000),limited=issueOwnerCredential(['control:admin','mcp:access'],Date.now()+600000);
  fs.writeFileSync(process.env.FLUJO_OWNER_AUTH_FILE,JSON.stringify({schemaVersion:1,ownerId:'synthetic-fixture-owner',credentials:[owner.record,limited.record]}),{mode:0o600});
  const ledger=process.env.FLUJO_MCP_TRUSTED_HOST_FILE;fs.unlinkSync(ledger);
  await require(path.join(sourceRoot,'__tests__/utils/privateProfileFixture.ts')).unlockPrivateFixtureInCurrentWorkspace();
  const workspace=require(path.join(sourceRoot,'src/utils/workspace.ts'));
  await require(path.join(sourceRoot,'src/backend/services/workspace/migration.ts')).migrateWorkspaceLayout();
  await workspace.ensureWorkspaceDirs('other-workspace');
  await require(path.join(sourceRoot,'src/backend/services/mcp/shippedWorkspacePackages.ts')).ensureShippedWorkspacePackages(workspace.getWorkspaceDataDir(),sourceRoot,['filesystem']);
  const shipped=require(path.join(sourceRoot,'src/backend/services/mcp/shippedServers.ts')),descriptor=shipped.SHIPPED_MCP_SERVERS.find(item=>item.packageDirectory==='filesystem'),config=shipped.createShippedServerConfig(descriptor,{FLUJO_DATA_DIR:process.env.FLUJO_DATA_DIR});
  const store=require(path.join(sourceRoot,'src/backend/services/mcp/config.ts'));assert.equal((await store.saveConfig(new Map([[config.name,config]]))).success,true);
  process.env.FLUJO_WORKER_MODE='1';process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN='synthetic-snapshot-worker-bearer';
  const worker=require(path.join(sourceRoot,'src/backend/services/workspace/workerMode.ts'));worker.setWorkerBootstrapStatus({state:'error',workspace:workspace.getCurrentWorkspace(),error:'Synthetic bootstrap failure state; actual failed image qualification remains separate.'});
  const {NextRequest}=require(path.join(sourceRoot,'node_modules/next/server.js')),{proxy}=require(path.join(sourceRoot,'src/proxy.ts')),route=require(path.join(sourceRoot,'src/app/api/mcp/servers/[name]/host-consent/route.ts'));
  const {withWorkspaceRoute}=require(path.join(sourceRoot,'src/app/api/_workspace.ts'));let runtimeDispatches=0;
  const runtimeRoute=withWorkspaceRoute(async()=>{runtimeDispatches++;return Response.json({runtimeDispatched:true});});
  server=http.createServer(async(incoming,outgoing)=>{
   try{
    const chunks=[];for await(const chunk of incoming)chunks.push(chunk);
    const init={method:incoming.method,headers:incoming.headers};if(!['GET','HEAD'].includes(incoming.method))init.body=Buffer.concat(chunks);
    const request=new NextRequest(`http://${incoming.headers.host}${incoming.url}`,init),gate=proxy(request);let response=gate;
    if(gate.headers.get('x-middleware-next')==='1'){
     if(request.nextUrl.pathname==='/api/source-control/runtime')response=await runtimeRoute(request,{});
     else{const handler=route[incoming.method];response=handler?await handler(request,{params:Promise.resolve({name:config.name})}):Response.json({error:'Unsupported method'},{status:405});}
    }
    outgoing.writeHead(response.status,Object.fromEntries(response.headers));outgoing.end(await response.text());
   }catch{outgoing.writeHead(500);outgoing.end('Source control handler failed.');}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const base=`http://127.0.0.1:${server.address().port}/api/mcp/servers/${config.name}/host-consent`,selected=workspace.getCurrentWorkspace();
  const call=(method,token,body,scope=selected)=>fetch(`${base}?workspace=${scope}&runtimeHome=host`,{method,headers:{...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal((await call('GET')).status,401);assert.equal((await call('GET','forged-owner')).status,401);assert.equal((await call('GET',process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN)).status,401);assert.equal((await call('GET',limited.token)).status,403);assert.equal(fs.existsSync(ledger),false);
  assert.equal((await call('GET',owner.token,undefined,'other-workspace')).status,409);
  const response=await call('GET',owner.token);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');const preview=await response.json();
  assert.match(preview.policyDigest,/^[a-f0-9]{64}$/);assert.equal(worker.getWorkerBootstrapStatus().state,'error');
  const approved=await call('POST',owner.token,{runtimeHome:'host',reviewedDigest:preview.policyDigest,expiresAt:Date.now()+120000});assert.equal(approved.status,200,await approved.clone().text());
  const current=(await store.loadServerConfigs()).find(item=>item.name===config.name);assert.ok(current.trustedHost?.bundledInstallation);assert.equal(JSON.parse(fs.readFileSync(ledger,'utf8')).approvals[0].policyDigest,preview.policyDigest);
  assert.equal(worker.getWorkerBootstrapStatus().state,'error');
  const runtime=await fetch(`http://127.0.0.1:${server.address().port}/api/source-control/runtime?workspace=${selected}`,{headers:{Authorization:`Bearer ${process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN}`}});assert.equal(runtime.status,503);assert.equal(runtimeDispatches,0);
  const deniedDelete=await call('DELETE',process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN);assert.equal(deniedDelete.status,401);
  const revoked=await call('DELETE',owner.token);assert.equal(revoked.status,200);assert.deepEqual(JSON.parse(fs.readFileSync(ledger,'utf8')).approvals,[]);
  console.log(JSON.stringify({sourceControl:'bundled-operator-http',actualLoopbackHttp:true,actualSourceProxyAndNextRoute:true,actualMigrationAndWorkspaceStorage:true,notReadyAssignedWorkerOwnerPreviewApproveRevoke:true,missingForgedSnapshotAndLimitedBearersRefused:true,otherAssignedWorkspaceRefused:true,missingLedgerInitializedUnderActualOwner:true,actualPrivateGrantAndSavedProfile:true,workerReadinessNeverBypassedForRuntime:true,scope:'Actual Source HTTP/proxy/handler/private owner and storage; injected not-ready status, no real worker bootstrap retry or compiled packed Next/image acceptance'}));
 }catch(error){primaryError=error;throw error;}finally{
  await closeAndRestoreFixture(server?{close:()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}:undefined,()=>{for(const[name,value]of Object.entries(saved)){if(value===undefined)delete process.env[name];else process.env[name]=value;}for(const[name,value]of Object.entries(savedGlobals)){if(value===undefined)delete global[name];else global[name]=value;}},()=>fixture.restore(),primaryError);
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
