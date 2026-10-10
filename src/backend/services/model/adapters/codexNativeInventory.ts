import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getWorkspaceDataDir } from '@/utils/workspace';
import { admitCodexDirectory } from './codexRuntimeFiles';
import { createOwnedCodexThread } from './codexOwnedThread';
import { RESTRICTED_CODEX_CONFIG } from './codexRestrictedProfile';
import type { CodexOwnedProcessRegistration } from './codexAppServerProcess';

// No account, business input, external responder or valid command payload is
// involved. This checks the binary's effective tool definitions and unsupported
// call handling; it is expressly not a live provider execution.
const probes=['exec_command','apply_patch','view_image','browser_use','browser_use_full_cdp_access',
  'computer_use','web_search','spawn_agent','node_repl','imagegen','request_user_input',
  'skill_search','tool_search','memory','create_goal','sleep'];
const refused=()=>new Error('Native Codex effective inventory or forced-call denial is unconfirmed.');
export async function qualifyCodexNativeInventory(input:{executable:string;catalogPath:string;model:string;
  signal:AbortSignal;assertCurrent:()=>Promise<void>}) {
  const parent=path.join(getWorkspaceDataDir(),'db');const parentGuard=await admitCodexDirectory(parent,true);
  await parentGuard();const home=await fs.mkdtemp(path.join(parent,'codex-private-inventory-'));
  const guard=await admitCodexDirectory(home,true);const cwd=path.join(home,'workspace');await admitCodexDirectory(cwd,true);
  const env:NodeJS.ProcessEnv={NODE_ENV:'production'};
  for(const key of ['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','SSL_CERT_FILE','SSL_CERT_DIR'])
    if(process.env[key]!==undefined)env[key]=process.env[key];
  for(const key of ['HOME','USERPROFILE','CODEX_HOME','APPDATA','LOCALAPPDATA','XDG_CONFIG_HOME','XDG_CACHE_HOME',
    'XDG_DATA_HOME','XDG_STATE_HOME','XDG_RUNTIME_DIR','TMPDIR','TMP','TEMP'])env[key]=home;
  let thread:ReturnType<typeof createOwnedCodexThread>|undefined,registration:CodexOwnedProcessRegistration|undefined;
  let posts=0,denied=false;const inventories:string[][]=[];
  const server=createServer(async(req,res)=>{
    try {
      if(req.socket.remoteAddress!=='127.0.0.1'||req.method!=='POST'||req.url!=='/responses'||++posts>2)throw refused();
      const chunks:Buffer[]=[];let length=0;
      for await(const chunk of req){length+=chunk.length;if(length>1024*1024)throw refused();chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(body.model!==input.model||!Array.isArray(body.tools))throw refused();
      const names=body.tools.flatMap((tool:{type?:string;name?:string;tools?:Array<{name?:string;type?:string}>;function?:{name?:string}})=>
        tool.type==='namespace'&&Array.isArray(tool.tools)?tool.tools.map(child=>`${tool.name}.${child.name??child.type}`)
          :[tool.name??tool.function?.name??tool.type]);
      if(names.length)throw refused();inventories.push(names);
      let output:Array<Record<string,unknown>>;
      if(posts===1)output=probes.map((name,index)=>({id:`fc_${index}`,type:'function_call',status:'completed',
        call_id:`call_${index}`,name,arguments:'{'}));
      else {
        if(!Array.isArray(body.input))throw refused();
        const outputs=body.input.filter((item:{type?:string})=>item.type==='function_call_output');
        const byId=new Map(outputs.map((item:{call_id?:string;output?:unknown})=>[item.call_id,item.output]));
        if(outputs.length!==probes.length||byId.size!==probes.length
          ||!probes.every((name,index)=>byId.get(`call_${index}`)===`unsupported call: ${name}`))throw refused();
        denied=true;output=[{id:'msg_inventory',type:'message',role:'assistant',status:'completed',
          content:[{type:'output_text',text:'OFFLINE_DENIAL_COMPLETE',annotations:[]}]}];
      }
      const response={id:'resp_inventory',object:'response',created_at:0,status:'completed',model:input.model,
        output,usage:{input_tokens:0,output_tokens:0,total_tokens:0}};
      const events:Array<Record<string,unknown>>=[{type:'response.created',response:{...response,status:'in_progress',output:[]}}];
      output.forEach((item,index)=>{
        events.push({type:'response.output_item.added',output_index:index,item:{...item,status:'in_progress',arguments:''}});
        if(item.type==='function_call')events.push(
          {type:'response.function_call_arguments.delta',output_index:index,item_id:item.id,delta:item.arguments},
          {type:'response.function_call_arguments.done',output_index:index,item_id:item.id,arguments:item.arguments});
        else events.push({type:'response.output_text.delta',output_index:index,item_id:item.id,content_index:0,delta:'OFFLINE_DENIAL_COMPLETE'});
        events.push({type:'response.output_item.done',output_index:index,item});
      });
      events.push({type:'response.completed',response});
      const bytes=events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
      res.writeHead(200,{'Content-Type':'text/event-stream','Connection':'close'});res.end(bytes);
    } catch {res.writeHead(409).end();registration?.requestStop();}
  });
  server.requestTimeout=15000;server.headersTimeout=15000;
  try {
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const address=server.address();if(!address||typeof address==='string')throw refused();
    const url=`http://127.0.0.1:${address.port}`;
    const {forced_login_method:omitted,...restricted}=RESTRICTED_CODEX_CONFIG;void omitted;
    const owner={};
    thread=createOwnedCodexThread({executable:input.executable,env,cwd,owner,model:input.model,signal:input.signal,
      register:async value=>{registration=value;await input.assertCurrent();input.signal.throwIfAborted();},
      beforePrompt:async()=>{await input.assertCurrent();input.signal.throwIfAborted();},observeUsage:async()=>{},
      configOverrides:['project_root_markers=[]',`projects.${JSON.stringify(cwd)}.trust_level="untrusted"`],
      config:{...restricted,model_catalog_json:input.catalogPath,model_provider:'inventory',
        check_for_update_on_startup:false,analytics:{enabled:false},
        features:{...restricted.features,enable_request_compression:false,unbounded_connection_retries:false},
        model_providers:{inventory:{name:'Source offline inventory fixture',base_url:url,wire_api:'responses',
          requires_openai_auth:false,supports_websockets:false,request_max_retries:0,stream_max_retries:0}}}});
    let completed=false;
    for await(const event of (await thread.runStreamed('Offline binary protocol qualification. No business work or valid tool payloads.')).events){
      input.signal.throwIfAborted();await input.assertCurrent();
      if(event.type==='turn.completed')completed=true;
      if(event.type==='turn.failed'||event.type==='error')throw refused();
    }
    if(!completed||posts!==2||!denied||inventories.length!==2||!registration)throw refused();
    await thread.close();const exit=await registration.exit;await registration.close;
    await input.assertCurrent();input.signal.throwIfAborted();
    return {kind:'offline-pinned-binary-inventory',posts,advertisedTools:inventories[0],forcedCalls:probes,
      forcedCallsDenied:true,processIdentity:registration.identity,exit,closeObserved:true,
      authenticated:false,liveProvider:false,billedCostUsd:null};
  } finally {
    await thread?.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    await parentGuard();await guard();
    if(path.dirname(path.resolve(home))!==path.resolve(parent)||!path.basename(home).startsWith('codex-private-inventory-'))throw refused();
    await fs.rm(home,{recursive:true,force:true});
  }
}
