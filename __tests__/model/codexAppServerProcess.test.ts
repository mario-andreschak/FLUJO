import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startOwnedCodexAppServer, assertCodexOwnedProcessRegistration, type CodexOwnedProcessRegistration } from '@/backend/services/model/adapters/codexAppServerProcess';

// A real child process exercises wire ordering and exit/close ownership. This
// deterministic fixture performs no provider execution and uses no credentials.
const fixture = `
const fs=require('node:fs'),readline=require('node:readline');
const log=process.argv[1], mode=process.argv[2];
setInterval(()=>{},1000);
if(mode==='pre-admission'){
  const tick=setInterval(()=>{if(fs.existsSync(log+'.trigger')){
    clearInterval(tick);process.stdout.write(JSON.stringify({method:'unsolicited',params:{private:'must not publish'}})+'\\n');
  }},5);
}
process.stdin.on('end',()=>process.exit(0));
readline.createInterface({input:process.stdin}).on('line',line=>{
  fs.appendFileSync(log,line+'\\n');
  const m=JSON.parse(line);if(m.id===undefined || m.method===undefined)return;
  if(mode==='compaction' && m.method==='thread/compact/start'){
    const params={threadId:m.params.threadId,turnId:'compact-1',item:{id:'item-compact-1',type:'contextCompaction'}};
    process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n'+
      JSON.stringify({method:'item/started',params})+'\\n'+
      JSON.stringify({method:'item/completed',params})+'\\n'+
      JSON.stringify({method:'turn/completed',params:{threadId:m.params.threadId,turn:{id:'compact-1',status:'completed'}}})+'\\n');return;
  }
  if(mode==='incoming-terminal' && m.method==='turn/interrupt'){
    process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n'+JSON.stringify({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'interrupted'}}})+'\\n');return;
  }
  if(mode==='incoming' || mode==='incoming-resolved' || mode==='incoming-terminal'){
    process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n'+JSON.stringify({id:'input-1',method:'item/tool/requestUserInput',params:{threadId:'thread-1',turnId:'turn-1',questions:[]}})+'\\n'+
      (mode==='incoming-resolved' ? JSON.stringify({method:'serverRequest/resolved',params:{threadId:'thread-1',requestId:'input-1'}})+'\\n' : ''));return;
  }
  if(mode==='silent')return;
  if(mode==='malformed'){process.stdout.write('{invalid\\n');return;}
  if(mode==='unknown'){process.stdout.write(JSON.stringify({id:m.id+100,result:{}})+'\\n');return;}
  if(mode==='dualerror'){process.stdout.write(JSON.stringify({id:m.id,result:{},error:{code:-32600,message:'invalid'}})+'\\n');return;}
  if(mode==='bareerror'){process.stdout.write(JSON.stringify({id:m.id,error:{code:-32600}})+'\\n');return;}
  if(mode==='coalesced'){
    process.stdout.write(JSON.stringify({id:m.id,result:{method:m.method}})+'\\n'+
      JSON.stringify({method:'first',params:{}})+'\\n'+JSON.stringify({method:'second',params:{}})+'\\n');return;
  }
  process.stdout.write(JSON.stringify({id:m.id,result:{method:m.method}})+'\\n');
});`;
let root: string;
const children: Array<Awaited<ReturnType<typeof startOwnedCodexAppServer>>> = [];
const registrations: CodexOwnedProcessRegistration[] = [];
beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),'codex-owned-process-'));});
afterEach(async()=>{
  const stopped=await Promise.allSettled(children.splice(0).map(child=>child.stop()));
  try {
    for(const registration of registrations.splice(0)){registration.requestStop();await registration.close;}
  } finally {
    if(path.dirname(path.resolve(root))!==path.resolve(os.tmpdir()) || !path.basename(root).startsWith('codex-owned-process-'))throw new Error('Unexpected fixture cleanup path');
    await fs.rm(root,{recursive:true,force:true});
  }
  const failures=stopped.filter((result): result is PromiseRejectedResult=>result.status==='rejected');
  if(failures.length)throw new AggregateError(failures.map(result=>result.reason),'Owned process cleanup failed');
});

it('refuses unsolicited incoming notifications during pending owner admission',async()=>{
  const notification=jest.fn();
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const running=startOwnedCodexAppServer({...options('pre-admission'),onNotification:notification,
    register:async registration=>{
      registrations.push(registration);
      await fs.writeFile(path.join(root,'wire.jsonl.trigger'),'ready');
      await gate;
    }});
  try {
    await expect(running).rejects.toThrow('unavailable');
    expect(notification).not.toHaveBeenCalled();
    expect(await wire()).toBe('');
    await registrations[0].exit;await registrations[0].close;
  } finally {release();}
});

it.each(['throw','stop','abort'])('stops coalesced incoming callbacks immediately after %s',async refusal=>{
  const controller=new AbortController();
  const methods:string[]=[];
  const child=await startOwnedCodexAppServer({...options('coalesced'),signal:controller.signal,
    onNotification:message=>{
      methods.push(message.method!);
      if(refusal==='throw')throw new Error('Source callback refused');
      if(refusal==='stop')registrations[0].requestStop();
      if(refusal==='abort')controller.abort();
    }});
  children.push(child);
  await child.request('initialize',{});
  await child.registration.exit;await child.registration.close;
  expect(methods).toEqual(['first']);
});
function options(mode='normal') {
  const owner={};
  // Explicit minimal environment: fixture tests never inherit account state.
  const env: NodeJS.ProcessEnv={NODE_ENV:'production'};
  for(const key of ['SystemRoot','SYSTEMROOT','WINDIR','PATH','Path'])if(process.env[key])env[key]=process.env[key];
  return {executable:process.execPath,args:['-e',fixture,path.join(root,'wire.jsonl'),mode],env,cwd:root,owner,
    onNotification:()=>{},register:async(registration: CodexOwnedProcessRegistration)=>{registrations.push(registration);}};
}
async function wire() {return fs.readFile(path.join(root,'wire.jsonl'),'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});}

it('keeps native/default admission requests refused without an input callback',async()=>{
  const child=await startOwnedCodexAppServer(options('incoming'));children.push(child);
  await child.request('initialize',{});
  for(let attempt=0;attempt<40;attempt++) {
    if((await wire()).includes('input-1'))break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  expect((await wire()).trim().split('\n').map(line=>JSON.parse(line)).at(-1)).toEqual({id:'input-1',error:{code:-32601,message:'Server action is not authorized by this transport'}});
});

it('responds once through the explicitly installed ordinary input callback',async()=>{
  let accepted!:()=>void;const seen=new Promise<void>(resolve=>{accepted=resolve;});
  const callback=jest.fn(async()=>{accepted();return {answers:{choice:{answers:['Blue']}}};});
  const child=await startOwnedCodexAppServer({...options('incoming'),onRequest:callback});children.push(child);
  await child.request('initialize',{});await seen;
  for(let attempt=0;attempt<40;attempt++) {
    if((await wire()).includes('input-1'))break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  expect(callback).toHaveBeenCalledTimes(1);
  expect((await wire()).trim().split('\n').map(line=>JSON.parse(line)).at(-1)).toEqual({id:'input-1',result:{answers:{choice:{answers:['Blue']}}}});
});

it('does not dispatch or answer an input already cleared in the same frame batch',async()=>{
  const callback=jest.fn(async()=>({answers:{}}));
  const notification=jest.fn();
  const child=await startOwnedCodexAppServer({...options('incoming-resolved'),onRequest:callback,onNotification:notification});children.push(child);
  await child.request('initialize',{});
  await new Promise(resolve=>setTimeout(resolve,40));
  expect(notification).toHaveBeenCalledWith(expect.objectContaining({method:'serverRequest/resolved'}));
  expect(callback).not.toHaveBeenCalled();
  expect((await wire()).trim().split('\n')).toHaveLength(1);
});

it('aborts a deferred matching input on terminal arrival and never writes its stale answer',async()=>{
  let started!:()=>void;const seen=new Promise<void>(resolve=>{started=resolve;});
  const callback=jest.fn(async(_request,signal:AbortSignal)=>{
    started();await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));
    return {answers:{choice:{answers:['Blue']}}};
  });
  const child=await startOwnedCodexAppServer({...options('incoming-terminal'),onRequest:callback});children.push(child);
  await child.request('initialize',{});await seen;
  await child.request('turn/interrupt',{threadId:'thread-1',turnId:'turn-1'});
  await new Promise(resolve=>setTimeout(resolve,40));
  expect(callback.mock.calls[0][1].aborted).toBe(true);
  expect((await wire()).trim().split('\n').map(line=>JSON.parse(line)).some(message=>message.id==='input-1')).toBe(false);
});

it('registers the born child before writing and brands it for only its owner',async()=>{
  let release!:()=>void,registered!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const seen=new Promise<void>(resolve=>{registered=resolve;});
  const input=options();
  const running=startOwnedCodexAppServer({...input,register:async registration=>{
    registrations.push(registration);registered();await gate;
  }});
  await seen;
  expect(await wire()).toBe('');
  const registration=registrations[0];
  assertCodexOwnedProcessRegistration(registration,input.owner);
  expect(()=>assertCodexOwnedProcessRegistration({...registration},input.owner)).toThrow('mismatched');
  expect(()=>assertCodexOwnedProcessRegistration(registration,{})).toThrow('mismatched');
  release();const child=await running;children.push(child);
  expect(await child.request('initialize',{})).toEqual({method:'initialize'});
  await child.stop();
  expect(await registration.exit).toEqual({code:0,signal:null});
  await registration.close;
  expect(JSON.parse((await wire()).trim()).method).toBe('initialize');
});

it('closes the original child when registration fails without any wire input',async()=>{
  const input=options();
  await expect(startOwnedCodexAppServer({...input,register:async registration=>{
    registrations.push(registration);throw new Error('Owner admission denied');
  }})).rejects.toThrow('Owner admission denied');
  await registrations[0].exit;await registrations[0].close;
  expect(await wire()).toBe('');
});

it('kills the child during pending admission and refuses dispatch after abort',async()=>{
  const controller=new AbortController();let release!:()=>void,registered!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const seen=new Promise<void>(resolve=>{registered=resolve;});
  const running=startOwnedCodexAppServer({...options(),signal:controller.signal,register:async registration=>{
    registrations.push(registration);registered();await gate;
  }});
  const rejection=expect(running).rejects.toThrow('unavailable');
  await seen;controller.abort();
  await registrations[0].exit;await registrations[0].close;
  expect(await wire()).toBe('');release();await rejection;
});

it('bounds stalled admission while retaining separate exit and close evidence',async()=>{
  await expect(startOwnedCodexAppServer({...options(),admissionTimeoutMs:50,register:async registration=>{
    registrations.push(registration);await new Promise<void>(()=>{});
  }})).rejects.toThrow('unavailable');
  await registrations[0].exit;await registrations[0].close;
  expect(await wire()).toBe('');
});

it.each(['malformed','unknown','dualerror','bareerror'])('rejects %s responses and confirms owned process closure',async mode=>{
  const child=await startOwnedCodexAppServer(options(mode));children.push(child);
  await expect(child.request('initialize',{})).rejects.toThrow('unavailable');
  await child.registration.exit;await child.registration.close;
});

it('bounds a silent request and refuses methods outside the admitted protocol',async()=>{
  const child=await startOwnedCodexAppServer(options('silent'));children.push(child);
  await expect(child.request('account/login/start',{})).rejects.toThrow('unavailable');
  expect(await wire()).toBe('');
  await expect(child.request('initialize',{},50)).rejects.toThrow('unavailable');
  await child.registration.exit;await child.registration.close;
});

it('admits native compaction and preserves its typed completion lifecycle on the owned child',async()=>{
  const notifications:Array<{method?:string;params?:unknown}>=[];
  let complete!:()=>void;
  const completed=new Promise<void>(resolve=>{complete=resolve;});
  const child=await startOwnedCodexAppServer({...options('compaction'),onNotification:message=>{
    notifications.push(message);
    if(message.method==='turn/completed')complete();
  }});children.push(child);
  await child.request('initialize',{});
  await expect(child.request('thread/compact/start',{threadId:'thread-1'})).resolves.toEqual({});
  await completed;
  expect(notifications.map(message=>message.method)).toEqual(['item/started','item/completed','turn/completed']);
  expect(notifications[1].params).toEqual({threadId:'thread-1',turnId:'compact-1',item:{id:'item-compact-1',type:'contextCompaction'}});
  const requests=(await wire()).trim().split('\n').map(line=>JSON.parse(line));
  expect(requests.at(-1)).toMatchObject({method:'thread/compact/start',params:{threadId:'thread-1'}});
  await child.stop();
  await child.registration.close;
});
