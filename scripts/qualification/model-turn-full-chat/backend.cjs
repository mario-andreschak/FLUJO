const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),http=require('node:http'),events=require('node:events');
const root=process.argv[2],base=path.resolve(process.argv[3]),data=path.join(base,'runtime-'+process.pid);
fs.mkdirSync(data,{recursive:true});process.env.FLUJO_DATA_DIR=data;process.env.FLUJO_EXPOSURE_MODE='localhost';
const ts=require(path.join(root,'node_modules/typescript')),resolve=Module._resolveFilename;
Module._resolveFilename=function(request,parent,...rest){
  if(request.startsWith('@/'))request=path.join(root,'src',request.slice(2));
  if(request==='mcp-stdio-oauth/client'||request==='mcp-stdio-oauth/protocol')request=path.join(root,'node_modules/mcp-stdio-oauth/dist',request.split('/')[1],'index.js');
  if(request==='mcp-stdio-oauth/client/transport')request=path.join(root,'node_modules/mcp-stdio-oauth/dist/client/transport.js');
  if(request.endsWith('.js')&&request.startsWith('.')&&parent){const candidate=path.resolve(path.dirname(parent.filename),request.slice(0,-3)+'.ts');if(fs.existsSync(candidate))request=candidate;}
  return resolve.call(this,request,parent,...rest);
};
require.extensions['.ts']=(module,file)=>module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
let server,secure,ownerAccess,token,session,archive,budget;
(async()=>{
  await require(path.join(root,'src/backend/services/workspace/migration.ts')).migrateWorkspaceLayout();
  secure=require(path.join(root,'src/utils/encryption/secure.ts'));
  if(!await secure.initializeEncryption('disposable-large-context-fixture-password'))throw Error('Fixture encryption init failed');
  if(!await secure.authenticate('disposable-large-context-fixture-password'))throw Error('Fixture unlock failed');
  const credentials=require(path.join(root,'src/backend/services/security/ownerCredentials.ts'));
  const issued=credentials.issueOwnerCredential(['control:admin','secrets:read'],Date.now()+3600000);token=issued.token;
  process.env.FLUJO_OWNER_AUTH_FILE=path.join(data,'owner.json');
  fs.writeFileSync(process.env.FLUJO_OWNER_AUTH_FILE,JSON.stringify({schemaVersion:1,ownerId:'fixture-owner',credentials:[issued.record]}),{mode:0o600});
  ownerAccess=require(path.join(root,'src/backend/services/security/ownerAccess.ts'));
  session=require(path.join(root,'src/backend/services/security/ownerSession.ts'));
  const route=require(path.join(root,'src/app/v1/chat/conversations/[conversationId]/model-turns/[dispatchId]/route.ts'));
  const {FlowExecutor}=require(path.join(root,'src/backend/execution/flow/FlowExecutor.ts'));
  const state={conversationId:'conversation',title:'Full Chat qualification',createdAt:1,updatedAt:1,messages:[{id:'live-final',role:'assistant',content:'Current completed response',timestamp:1}],status:'completed',nodeContexts:{}};
  const storage=require(path.join(root,'src/utils/storage/backend.ts'));
  await storage.saveItem('conversations/conversation',state);await storage.saveItem('current_conversation_id','conversation');await storage.saveItem('history',[{id:'conversation',title:state.title,createdAt:1,updatedAt:1,status:'completed'}]);
  FlowExecutor.conversationStates.set('conversation',state);
  const logs=require(path.join(root,'src/backend/execution/flow/conversationLog.ts'));
  const entries=JSON.parse(fs.readFileSync(path.join(base,'timeline.json'),'utf8'));
  await logs.appendRawForState(state,entries.map((turn,index)=>({type:'model:dispatch',turn,timestamp:index+1})));
  archive=require(path.join(root,'src/backend/execution/flow/modelTurnArchive.ts'));archive._setModelTurnArchiveDirForTests(path.join(base,'archives'));
  budget=require(path.join(root,'src/backend/execution/flow/modelTurnArchiveReadBudget.ts'));
  const {NextRequest}=require(path.join(root,'node_modules/next/server'));
  server=http.createServer(async(req,res)=>{
    const origin=process.env.FLUJO_OWNER_BROWSER_ORIGIN,url=new URL(req.url,origin);
    if(url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<div id="root"></div><script src="/bundle.js"></script>');return;}
    if(/^\/(?:\d+\.)?bundle\.js$/.test(url.pathname)){res.setHeader('Content-Type','text/javascript');fs.createReadStream(path.join(base,path.basename(url.pathname))).pipe(res);return;}
    const controller=new AbortController();res.on('close',()=>{if(!res.writableEnded)controller.abort(new Error('fixture client disconnected'));});
    const headers=new Headers();for(const [name,value]of Object.entries(req.headers))if(typeof value==='string')headers.set(name,value);
    const body = ['GET','HEAD'].includes(req.method) ? undefined : Buffer.concat(await Array.fromAsync(req));
    const request=new NextRequest(url,{method:req.method,headers,body,signal:controller.signal});
    try{
      if(url.pathname.startsWith('/fixture/')){
        const denied=ownerAccess.assertOwnerRequest(request);if(denied){res.statusCode=denied.status;res.end();return;}
        if(url.pathname==='/fixture/diagnostics'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(budget.getModelTurnArchiveReadDiagnostics()));return;}
        if(url.pathname==='/fixture/arm-close-failure'){
          const originalOpen=fs.promises.open;let armed=true;
          fs.promises.open=async function(filename,...args){const handle=await originalOpen.call(this,filename,...args);
            if(armed&&String(filename).endsWith('.v2.json.gz')){armed=false;fs.promises.open=originalOpen;const close=handle.close.bind(handle);let attempts=0;
              handle.close=async()=>{if(++attempts<=3)throw Error('controlled descriptor close fault');return close();};}
            return handle;};res.end('armed');return;
        }
        if(url.pathname==='/fixture/lock'){require(path.join(root,'src/utils/encryption/session.ts')).lockServer();res.end('locked');return;}
        if(url.pathname==='/fixture/unlock'){await secure.authenticate('disposable-large-context-fixture-password');res.end('unlocked');return;}
      }
      const id=url.pathname.split('/').at(-1);
      let selectedRoute=route;
      if(!/\/model-turns\/[^/]+$/.test(url.pathname)) {
        const segments=url.pathname.split('/').filter(Boolean);
        const routePath=segments.map((segment,index)=>segments[index-1]==='conversations'&&segment==='conversation'?'[conversationId]':segment).join('/');
        const filename=path.join(root,'src/app',routePath,'route.ts');
        if(!fs.existsSync(filename))throw Error('Unexpected fixture route '+url.pathname);
        selectedRoute=require(filename);
      }
      const handler=selectedRoute[req.method];if(!handler)throw Error('Unexpected fixture method');
      const response=await handler(request,{params:Promise.resolve({conversationId:'conversation',dispatchId:id})});
      res.writeHead(response.status,Object.fromEntries(response.headers));
      if(response.body){const reader=response.body.getReader();try{while(true){const next=await reader.read();if(next.done)break;if(!res.write(Buffer.from(next.value)))await events.once(res,'drain',{signal:controller.signal});}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}}
      res.end();
    }catch(error){if(!controller.signal.aborted){console.error(error.stack);res.destroy(error);}}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://localhost:'+server.address().port;process.env.FLUJO_OWNER_BROWSER_ORIGIN=origin;
  const login=new NextRequest(origin+'/fixture/login',{method:'POST',headers:{host:new URL(origin).host,origin,authorization:'Bearer '+token}});
  const resolved=ownerAccess.resolveOwnerRequest(login);if(!resolved.ok)throw Error('Fixture owner authorization failed');
  if(!session.ownerBrowserRequestAllowed(login,true))console.error(JSON.stringify({url:login.url,host:login.headers.get('host'),origin:login.headers.get('origin'),configured:process.env.FLUJO_OWNER_BROWSER_ORIGIN}));
  const cookie=session.createOwnerSession(login,resolved.authorization.principal);
  process.send({ready:true,origin,cookie,memory:process.memoryUsage()});
  process.on('message',async message=>{
    if(message==='stop'){await new Promise(resolve=>server.close(resolve));process.send({stopped:true,diagnostics:budget.getModelTurnArchiveReadDiagnostics()});process.exit(0);}
  });
})().catch(error=>{console.error(error.stack);process.exit(1);});
