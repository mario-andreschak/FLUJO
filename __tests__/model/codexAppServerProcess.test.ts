import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startOwnedCodexAppServer, assertCodexOwnedProcessRegistration, probeCodexOwnedProcessRegistration, type CodexOwnedProcessRegistration } from '@/backend/services/model/adapters/codexAppServerProcess';
import { probeRuntimeProcessIdentity } from '@/backend/services/enduringAgents/runtimeLock';
let uncertainProbe=false;
let unavailableBirthReads=0,birthReads=0,lastBirthPid=0;
jest.mock('@/backend/services/enduringAgents/runtimeLock',()=>{
  const actual=jest.requireActual<typeof import('@/backend/services/enduringAgents/runtimeLock')>('@/backend/services/enduringAgents/runtimeLock');
  return {...actual,probeRuntimeProcessIdentity:async(identity:Parameters<typeof actual.probeRuntimeProcessIdentity>[0])=>
    uncertainProbe?false:actual.probeRuntimeProcessIdentity(identity),captureRuntimeChildIdentity:async(pid:number)=>{
    birthReads++;lastBirthPid=pid;
    if(unavailableBirthReads-->0)throw new Error('Offline uncertain birth read');
    return actual.captureRuntimeChildIdentity(pid);
  }};
});

// A real child process exercises wire ordering and exit/close ownership. This
// deterministic fixture performs no provider execution and uses no credentials.
const fixture = `
const fs=require('node:fs'),readline=require('node:readline');
const log=process.argv[1], mode=process.argv[2];
setInterval(()=>{},1000);
process.stdin.on('end',()=>process.exit(0));
readline.createInterface({input:process.stdin}).on('line',line=>{
  fs.appendFileSync(log,line+'\\n');
  const m=JSON.parse(line);if(m.id===undefined)return;
  if(mode==='silent')return;
  if(mode==='malformed'){process.stdout.write('{invalid\\n');return;}
  if(mode==='unknown'){process.stdout.write(JSON.stringify({id:m.id+100,result:{}})+'\\n');return;}
  process.stdout.write(JSON.stringify({id:m.id,result:{method:m.method}})+'\\n');
});`;
let root: string;
const children: Array<Awaited<ReturnType<typeof startOwnedCodexAppServer>>> = [];
const registrations: CodexOwnedProcessRegistration[] = [];
beforeEach(async()=>{uncertainProbe=false;unavailableBirthReads=0;birthReads=0;lastBirthPid=0;root=await fs.mkdtemp(path.join(os.tmpdir(),'codex-owned-process-'));});
afterEach(async()=>{
  await Promise.all(children.splice(0).map(child=>child.stop()));
  for(const registration of registrations.splice(0)){registration.requestStop();await registration.close;}
  if(path.dirname(path.resolve(root))!==path.resolve(os.tmpdir()) || !path.basename(root).startsWith('codex-owned-process-'))throw new Error('Unexpected fixture cleanup path');
  await fs.rm(root,{recursive:true,force:true});
});
function options(mode='normal') {
  const owner={};
  // Explicit minimal environment: fixture tests never inherit account state.
  const env: NodeJS.ProcessEnv={};
  for(const key of ['SystemRoot','SYSTEMROOT','WINDIR','PATH','Path'])if(process.env[key])env[key]=process.env[key];
  return {executable:process.execPath,args:['-e',fixture,path.join(root,'wire.jsonl'),mode],env,cwd:root,owner,
    onNotification:()=>{},register:async(registration: CodexOwnedProcessRegistration)=>{registrations.push(registration);}};
}
async function wire() {return fs.readFile(path.join(root,'wire.jsonl'),'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});}

it('retains only the same owned original with positive OS identity and refuses uncertainty or closure',async()=>{
  const input=options();const child=await startOwnedCodexAppServer(input);children.push(child);
  expect(await probeCodexOwnedProcessRegistration(child.registration,input.owner)).toBe(child.registration);
  expect(await probeRuntimeProcessIdentity({...child.registration.identity,processBirthMarkerV2:'invalid'})).toBe(false);
  uncertainProbe=true;expect(await probeCodexOwnedProcessRegistration(child.registration,input.owner)).toBeNull();
  uncertainProbe=false;
  await expect(probeCodexOwnedProcessRegistration({...child.registration},input.owner)).rejects.toThrow('mismatched');
  await expect(probeCodexOwnedProcessRegistration(child.registration,{})).rejects.toThrow('mismatched');
  await child.stop();expect(await probeCodexOwnedProcessRegistration(child.registration,input.owner)).toBeNull();
});

it('rechecks an uncertain OS birth read on the same child before any wire input',async()=>{
  unavailableBirthReads=1;const child=await startOwnedCodexAppServer(options());children.push(child);
  expect(birthReads).toBe(2);expect(child.registration.identity.pid).toBe(lastBirthPid);
  expect(child.registration.identity.processBirthMarkerV2).toBeDefined();expect(await wire()).toBe('');
});
it('holds repeated birth uncertainty and closes the child without registration or input',async()=>{
  unavailableBirthReads=3;await expect(startOwnedCodexAppServer(options())).rejects.toThrow('uncertain birth');
  expect(birthReads).toBe(3);expect(registrations).toHaveLength(0);expect(await wire()).toBe('');
  expect(()=>process.kill(lastBirthPid,0)).toThrow();
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

it.each(['malformed','unknown'])('rejects %s responses and confirms owned process closure',async mode=>{
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
