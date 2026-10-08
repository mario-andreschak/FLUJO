import { promises as fs } from 'node:fs';
import path from 'node:path';
import { startOwnedCodexAppServer, assertCodexOwnedProcessRegistration } from '@/backend/services/model/adapters/codexAppServerProcess';

// Opt-in provider qualification. Normal CI skips this test; it never creates an
// auth profile, transfers credentials or counts qualification as swarm work.
const executable=process.env.FLUJO_LIVE_CODEX_PATH;
const home=process.env.FLUJO_LIVE_CODEX_HOME;
const receiptFile=process.env.FLUJO_LIVE_CODEX_RECEIPT;
const live=executable && home && receiptFile ? it : it.skip;
live('qualifies the Source-owned public app-server with exact Luna/medium and original turn interruption',async()=>{
  for(const value of [executable!,home!,receiptFile!])if(!path.isAbsolute(value))throw new Error('Absolute private qualification paths required');
  const relative=path.relative(process.cwd(),receiptFile!);
  if(!relative.startsWith('..'+path.sep) && !path.isAbsolute(relative))throw new Error('Qualification receipt must stay outside the checkout');
  const env: NodeJS.ProcessEnv={};
  for(const key of ['PATH','Path','SystemRoot','WINDIR','COMSPEC','PATHEXT','SSL_CERT_FILE','SSL_CERT_DIR'])if(process.env[key])env[key]=process.env[key];
  Object.assign(env,{CODEX_HOME:home,HOME:home,USERPROFILE:home,APPDATA:path.join(home!,'AppData','Roaming'),LOCALAPPDATA:path.join(home!,'AppData','Local'),TEMP:path.join(home!,'tmp'),TMP:path.join(home!,'tmp')});
  const notifications: Array<{method?:string;params?:unknown}>=[];
  let wake: (()=>void)|undefined;
  const owner={};
  const receipt: Record<string,unknown>={kind:'source-owned-app-server-live-qualification',startedAt:new Date().toISOString(),model:'gpt-6-luna',reasoningEffort:'medium',countsAsRequestedSwarm:false,billedSpendUsd:null};
  let primaryError: unknown;
  const child=await startOwnedCodexAppServer({executable:executable!,env,cwd:path.join(home!,'workspace'),owner,
    args:['app-server','--stdio','-c','features.shell_tool=false','-c','features.multi_agent=false','-c','features.apps=false','-c','features.plugins=false','-c','features.memories=false','-c','features.goals=false','-c','web_search="disabled"','-c','project_doc_max_bytes=0'],
    register:async registration=>{assertCodexOwnedProcessRegistration(registration,owner);receipt.registration={pid:registration.identity.pid,birthIdentityObserved:Boolean(registration.identity.processBirthMarkerV2)};},
    onNotification:message=>{if(notifications.length>=1000)throw new Error('Qualification notification bound exceeded');notifications.push(message);wake?.();}
  });
  const wait=async(predicate:(message:typeof notifications[number])=>boolean)=>{
    const started=Date.now();
    while(true){const found=notifications.find(predicate);if(found)return found;
      if(Date.now()-started>45000)throw new Error('Qualification notification timed out');
      let timer:NodeJS.Timeout|undefined;
      try {await new Promise<void>(resolve=>{wake=resolve;timer=setTimeout(resolve,200);});}
      finally{wake=undefined;if(timer)clearTimeout(timer);}
    }
  };
  try {
    await child.request('initialize',{clientInfo:{name:'flujo_source_qualification',title:'FLUJO Source qualification',version:'3.46.3'}});
    child.notify('initialized');
    const models=await child.request('model/list',{includeHidden:true,limit:100}) as {data:Array<{id:string;model:string;supportedReasoningEfforts:Array<{reasoningEffort:string}>}>};
    const luna=models.data.find(model=>model.model==='gpt-6-luna');
    expect(luna?.supportedReasoningEfforts.some(effort=>effort.reasoningEffort==='medium')).toBe(true);
    const thread=await child.request('thread/start',{model:'gpt-6-luna',cwd:path.join(home!,'workspace'),sandbox:'read-only',approvalPolicy:'never',ephemeral:false}) as {thread:{id:string};model:string};
    expect(thread.model).toBe('gpt-6-luna');receipt.threadId=thread.thread.id;
    const ready=await child.request('turn/start',{threadId:thread.thread.id,model:'gpt-6-luna',effort:'medium',input:[{type:'text',text:'Reply exactly READY. Do not use tools.'}]}) as {turn:{id:string}};
    const completed=await wait(message=>message.method==='turn/completed'&&(message.params as {turn?:{id:string}})?.turn?.id===ready.turn.id);
    expect((completed.params as {turn:{status:string}}).turn.status).toBe('completed');
    const read=await child.request('thread/read',{threadId:thread.thread.id,includeTurns:true}) as {thread:{turns:Array<{id:string;items:Array<{type:string;text?:string}>}>}};
    const output=read.thread.turns.find(turn=>turn.id===ready.turn.id)?.items.filter(item=>item.type==='agentMessage').map(item=>item.text).join('');
    expect(output?.trim()).toBe('READY');receipt.ready={status:'completed',output};
    const next=await child.request('turn/start',{threadId:thread.thread.id,model:'gpt-6-luna',effort:'medium',input:[{type:'text',text:'Explain why there are infinitely many primes in about 2000 words. Do not use tools.'}]}) as {turn:{id:string}};
    await wait(message=>message.method==='item/agentMessage/delta'&&(message.params as {turnId?:string;delta?:string})?.turnId===next.turn.id&&Boolean((message.params as {delta?:string})?.delta));
    await child.request('turn/interrupt',{threadId:thread.thread.id,turnId:next.turn.id});
    const interrupted=await wait(message=>message.method==='turn/completed'&&(message.params as {turn?:{id:string}})?.turn?.id===next.turn.id);
    expect((interrupted.params as {turn:{status:string}}).turn.status).toBe('interrupted');
    receipt.cancellation={providerOutputObservedBeforeInterrupt:true,status:'interrupted',turnId:next.turn.id};
  } catch(error) {primaryError=error;receipt.error=error instanceof Error ? error.message.slice(0,1024) : 'Qualification failed';throw error;}
  finally {
    let closeError: unknown;
    try {
      await child.stop();receipt.exit=await child.registration.exit;
      await child.registration.close;receipt.closeObserved=true;
    } catch(error) {
      closeError=error;receipt.closeObserved=false;
      receipt.closeError=error instanceof Error ? error.message.slice(0,1024) : 'Process closure unconfirmed';
    }
    receipt.observedAt=new Date().toISOString();
    try {await fs.writeFile(receiptFile!,JSON.stringify(receipt,null,2),{mode:0o600});}
    catch(writeError) {throw new AggregateError([...(primaryError ? [primaryError] : []),...(closeError ? [closeError] : []),writeError],'Qualification receipt could not be retained');}
    if(closeError)throw new AggregateError([...(primaryError ? [primaryError] : []),closeError],'Qualification process closure remains unconfirmed');
  }
},120000);
