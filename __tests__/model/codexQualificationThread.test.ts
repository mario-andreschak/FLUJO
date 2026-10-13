import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createQualificationCodexThread } from '@/backend/services/model/adapters/codexQualificationThread';
import type { CodexOwnedProcessRegistration } from '@/backend/services/model/adapters/codexAppServerProcess';

let directory:string, mode:string, cliArguments:string[];
const registrations:CodexOwnedProcessRegistration[]=[];
const fixture=`
const fs=require('node:fs'),rl=require('node:readline');
const log=process.argv[1],mode=process.argv[2];
process.stdin.on('end',()=>process.exit(mode.endsWith('nonzero-exit')?1:0));
setInterval(()=>{},1000);
const emit=m=>process.stdout.write(JSON.stringify(m)+'\\n');
rl.createInterface({input:process.stdin}).on('line',line=>{
  fs.appendFileSync(log,line+'\\n');const m=JSON.parse(line);if(m.id===undefined)return;
  if(m.method==='thread/start'){emit({id:m.id,result:{thread:{id:'thread-fixture'},model:mode==='wrong-model'?'wrong-model':m.params.model}});return;}
  if(m.method!=='turn/start'){emit({id:m.id,result:{}});return;}
  const threadId='thread-fixture',turnId='turn-fixture';emit({id:m.id,result:{turn:{id:turnId}}});
  const send=(method,extra)=>emit({method,params:{threadId,turnId,...extra}});
  if(mode==='early-close'){process.exit(0);return;}
  if(mode==='rerouted'){send('model/rerouted',{fromModel:'gpt-6-luna',toModel:'wrong-model'});return;}
  if(mode==='forbidden'||mode==='forbidden-nonzero-exit'){send('item/started',{item:{id:'forbidden-native',type:'commandExecution',command:'fixture-never-executed'}});return;}
  send('item/agentMessage/delta',{itemId:'agent-fixture',delta:'REA'});
  send('item/agentMessage/delta',{itemId:'agent-fixture',delta:'DY'});
  send('item/completed',{item:{type:'agentMessage',id:'agent-fixture',text:'READY'}});
  if(mode!=='missing-usage')send('thread/tokenUsage/updated',{tokenUsage:{last:{inputTokens:9,cachedInputTokens:2,outputTokens:5,reasoningOutputTokens:3}}});
  send('turn/completed',{turn:{id:turnId,status:'completed'}});
});`;
jest.mock('@/backend/services/model/adapters/codexAppServerProcess',()=>{
  const actual=jest.requireActual<typeof import('@/backend/services/model/adapters/codexAppServerProcess')>('@/backend/services/model/adapters/codexAppServerProcess');
  return {...actual,startOwnedCodexAppServer:async(input:Parameters<typeof actual.startOwnedCodexAppServer>[0])=>{
    cliArguments=[...(input.args??[])];
    return actual.startOwnedCodexAppServer({...input,executable:process.execPath,args:['-e',fixture,path.join(directory,'wire.jsonl'),mode],
      register:async registration=>{registrations.push(registration);await input.register(registration);}});
  }};
});
beforeEach(async()=>{directory=await fs.mkdtemp(path.join(os.tmpdir(),'codex-owned-thread-'));mode='normal';cliArguments=[];});
afterEach(async()=>{
  for(const process of registrations.splice(0)){process.requestStop();await process.close;}
  if(path.dirname(path.resolve(directory))!==path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('codex-owned-thread-'))throw new Error('Unexpected fixture cleanup path');
  await fs.rm(directory,{recursive:true,force:true});
});
function input(overrides:Partial<Parameters<typeof createQualificationCodexThread>[0]>={}) {
  const env:NodeJS.ProcessEnv={NODE_ENV:'test'};
  for(const key of ['PATH','Path','SystemRoot','WINDIR'])if(process.env[key])env[key]=process.env[key];
  return {executable:process.execPath,env,cwd:directory,owner:{},model:'gpt-6-luna',effort:'medium',
    config:{features:{shell_tool:false},mcp_servers:{flujo:{url:'http://127.0.0.1/fixture-bridge'}},service_tier:'default'},
    register:async()=>{},beforePrompt:async()=>{},observeUsage:jest.fn(async()=>{}),...overrides};
}
async function wire() {return (await fs.readFile(path.join(directory,'wire.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));}
async function collect(thread:ReturnType<typeof createQualificationCodexThread>,signal?:AbortSignal) {
  const {events}=await thread.runStreamed('fixture prompt',{signal});const values=[];
  for await(const event of events)values.push(event);
  return values;
}

it('gates the actual prompt after registration and retains exact model/effort with actual usage',async()=>{
  let release!:()=>void,atGate!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});const entered=new Promise<void>(resolve=>{atGate=resolve;});
  const options=input({beforePrompt:async()=>{atGate();await gate;}});const thread=createQualificationCodexThread(options);
  const running=collect(thread);await entered;
  expect(registrations).toHaveLength(1);
  expect((await wire()).some(message=>message.method==='turn/start')).toBe(false);
  expect(cliArguments).toContain('features.shell_tool=false');
  expect(cliArguments).toContain('features.code_mode_host=false');
  expect(cliArguments).toContain('project_root_markers=[]');
  expect(cliArguments.some(value=>value.includes('fixture-bridge'))).toBe(false);
  expect(cliArguments.some(value=>value.startsWith('mcp_servers.'))).toBe(false);
  release();const events=await running;
  expect(events.filter(event=>event.type==='item.updated').map(event=>event.item.type==='agent_message'?event.item.text:undefined)).toEqual(['REA','READY']);
  const prompt=(await wire()).find(message=>message.method==='turn/start');
  expect((await wire()).find(message=>message.method==='thread/start').params.config.mcp_servers)
    .toEqual(options.config.mcp_servers);
  expect(prompt.params).toMatchObject({model:'gpt-6-luna',effort:'medium',threadId:'thread-fixture'});
  expect(options.observeUsage).toHaveBeenCalledWith({type:'codex-app-server-usage',appServerTurns:1,
    usage:{input_tokens:9,cached_input_tokens:2,output_tokens:5,reasoning_output_tokens:3}});
  expect(await registrations[0].exit).toEqual({code:0,signal:null});await registrations[0].close;
  await expect(collect(thread)).rejects.toThrow('replacement turn');
});

it('preserves unknown usage rather than inventing zero tokens or billed cost',async()=>{
  mode='missing-usage';const options=input();const events=await collect(createQualificationCodexThread(options));
  expect(events.at(-1)).toEqual({type:'turn.completed',usage:undefined});
  expect(options.observeUsage).not.toHaveBeenCalled();
});

it.each(['wrong-model','rerouted','forbidden','early-close'])('fails closed on %s and closes only its original process',async value=>{
  mode=value;await expect(collect(createQualificationCodexThread(input()))).rejects.toThrow();
  await registrations[0].exit;await registrations[0].close;
  if(value==='wrong-model')expect((await wire()).some(message=>message.method==='turn/start')).toBe(false);
});

it('refuses a revoked prompt gate without sending model input',async()=>{
  await expect(collect(createQualificationCodexThread(input({beforePrompt:async()=>{throw new Error('Original lease revoked');}})))).rejects.toThrow('Original lease revoked');
  expect((await wire()).some(message=>message.method==='turn/start')).toBe(false);
  await registrations[0].exit;await registrations[0].close;
});

it('refuses completed qualification frames when the actual child exits nonzero',async()=>{
  mode='completed-nonzero-exit';
  const options=input(),thread=createQualificationCodexThread(options);
  const observed:string[]=[];
  const consume=async()=>{
    const {events}=await thread.runStreamed('fixture prompt');
    for await(const event of events)observed.push(event.type);
  };
  await expect(consume()).rejects.toThrow();
  expect(observed).toContain('turn.completed');
  expect(options.observeUsage).toHaveBeenCalledTimes(1);
  expect(await registrations[0].exit).toEqual({code:1,signal:null});
  await registrations[0].close;
  expect((await wire()).filter(message=>message.method==='turn/start')).toHaveLength(1);
});

it('preserves the protocol refusal and actual nonzero closure as independent failures',async()=>{
  mode='forbidden-nonzero-exit';
  const options=input();
  const failure=await collect(createQualificationCodexThread(options)).catch(error=>error);
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure.errors).toHaveLength(2);
  expect(failure.errors[0]).toMatchObject({message:'Owned Codex produced an unapproved native item.'});
  expect(failure.errors[1]).toBeInstanceOf(Error);
  expect(failure.errors[1].message).not.toBe(failure.errors[0].message);
  expect(options.observeUsage).not.toHaveBeenCalled();
  expect(await registrations[0].exit).toEqual({code:1,signal:null});
  await registrations[0].close;
  expect((await wire()).filter(message=>message.method==='turn/start')).toHaveLength(1);
});
