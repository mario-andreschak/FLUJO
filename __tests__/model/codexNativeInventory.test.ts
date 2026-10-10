import { qualifyCodexNativeInventory } from '@/backend/services/model/adapters/codexNativeInventory';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
let mode='valid',directory:string,previousData:string|undefined;
const fixture=`
const rl=require('node:readline'),url=process.argv[1],mode=process.argv[2];
setInterval(()=>{},1000);process.stdin.on('end',()=>process.exit(0));
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
rl.createInterface({input:process.stdin}).on('line',async line=>{
 const request=JSON.parse(line);if(request.id===undefined)return;
 if(request.method==='thread/start'){send({id:request.id,result:{thread:{id:'inventory-fixture'},model:request.params.model}});return;}
 if(request.method!=='turn/start'){send({id:request.id,result:{}});return;}
 send({id:request.id,result:{turn:{id:'inventory-turn'}}});
 const post=async(input)=>fetch(url+'/responses',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({model:'gpt-6-luna',tools:mode==='exposed'?[{type:'function',name:'exec_command'}]:[],input})});
 const first=await post([]);if(!first.ok)return;
 const events=(await first.text()).split('\\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)));
 const calls=events.find(event=>event.type==='response.completed').response.output;
 const outputs=calls.map(call=>({type:'function_call_output',call_id:call.call_id,
  output:mode==='wrong-denial'?'simulated denial':'unsupported call: '+call.name}));
 const second=await post(outputs);if(!second.ok)return;
 send({method:'turn/completed',params:{threadId:'inventory-fixture',turnId:'inventory-turn',turn:{id:'inventory-turn',status:'completed'}}});
});`;
jest.mock('@/backend/services/model/adapters/codexAppServerProcess',()=>{
  const actual=jest.requireActual<typeof import('@/backend/services/model/adapters/codexAppServerProcess')>('@/backend/services/model/adapters/codexAppServerProcess');
  return {...actual,startOwnedCodexAppServer:async(input:Parameters<typeof actual.startOwnedCodexAppServer>[0])=>{
    const argument=input.args!.find(value=>value.startsWith('model_providers.inventory.base_url='))!;
    const url=JSON.parse(argument.slice(argument.indexOf('=')+1));
    return actual.startOwnedCodexAppServer({...input,executable:process.execPath,args:['-e',fixture,url,mode]});
  }};
});
beforeEach(async()=>{mode='valid';previousData=process.env.FLUJO_DATA_DIR;
  directory=await fs.mkdtemp(path.join(os.tmpdir(),'codex-inventory-contract-'));process.env.FLUJO_DATA_DIR=directory;});
afterEach(async()=>{
  if(previousData===undefined)delete process.env.FLUJO_DATA_DIR;else process.env.FLUJO_DATA_DIR=previousData;
  if(path.dirname(path.resolve(directory))!==path.resolve(os.tmpdir())||!path.basename(directory).startsWith('codex-inventory-contract-'))throw new Error('Unexpected cleanup path');
  await fs.rm(directory,{recursive:true,force:true});
});
function input(){return {executable:process.execPath,catalogPath:path.join(directory,'fixture-catalog.json'),
  model:'gpt-6-luna',signal:AbortSignal.timeout(20000),assertCurrent:async()=>{}};}
it('requires actual outbound empty inventory and exact unsupported outputs for every forced call',async()=>{
  const receipt=await qualifyCodexNativeInventory(input());
  expect(receipt).toMatchObject({kind:'offline-pinned-binary-inventory',posts:2,advertisedTools:[],forcedCallsDenied:true,
    authenticated:false,liveProvider:false,exit:{code:0,signal:null},closeObserved:true,billedCostUsd:null});
  expect(receipt.forcedCalls).toHaveLength(16);
});
it.each(['exposed','wrong-denial'])('refuses %s and closes its owned child without minting a receipt',async value=>{
  mode=value;await expect(qualifyCodexNativeInventory(input())).rejects.toThrow();
});
