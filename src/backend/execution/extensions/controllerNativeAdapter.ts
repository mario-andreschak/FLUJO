import { createHash, timingSafeEqual } from 'node:crypto';
import { applyExecutionRunInput, createExecutionExtensionContext, ExecutionExtensionError, runWithExecutionInput,
  type ExecutionExtensionAdapter, type ExecutionExtensionContext, type ExecutionNativeWorkerRoot,
  type ExecutionNativeWorkerRootRequest } from './index';
import { createControllerNativeToolGateway, type ControllerNativeToolTransport } from './controllerNativeTools';

type Claim = Readonly<{ runId: string; rootConversationId: string; goalId: string; workspace: string }>;
type Plan = Readonly<{ flowId: string; flowDigest: string; modelId: string; modelDigest: string }>;
export interface ControllerNativeTransport {
  readonly bindingId: string;
  admit(workerAuthorization: string, claim: Claim): Promise<object>;
  readPlan(context: object): Promise<Plan>;
  assertRun(context: object, expected?: { conversationId?: string; runId?: string; graphHash?: string }): Promise<void>;
  bindRun(context: object, conversationId: string, runId: string): Promise<void>;
  readRoot(context: object, expected: ExecutionNativeWorkerRootRequest): Promise<ExecutionNativeWorkerRoot>;
  commit<T>(context: object, task: () => Promise<T>): Promise<T>;
  observe(context: object): Promise<{ signal: AbortSignal; close(): Promise<void> }>;
}
type Gateway = Pick<ExecutionExtensionAdapter, 'isProtectedServer' | 'assertServerConfig' | 'protectedServer' |
  'authorizeHandoffs' | 'assertModelTool' | 'assertDispatch' | 'normalizeArguments' | 'requestMeta' | 'validateResult'>;
type Active = { remote: object; claim: Claim; plan: Plan; watch: Awaited<ReturnType<ControllerNativeTransport['observe']>> };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const denied = () => new ExecutionExtensionError('controller_native_source_refused');
function checkedPlan(value: Plan): Plan {
  if (!value || Object.keys(value).sort().join() !== ['flowDigest','flowId','modelDigest','modelId'].join()
      || !value.flowId || !value.modelId || !/^[a-f0-9]{64}$/.test(value.flowDigest) || !/^[a-f0-9]{64}$/.test(value.modelDigest)) throw denied();
  return Object.freeze({ flowId:value.flowId,flowDigest:value.flowDigest,modelId:value.modelId,modelDigest:value.modelDigest });
}
export interface ControllerNativeSourceAdapter {
  readonly adapter: ExecutionExtensionAdapter;
  withWorkerRun<T>(workerAuthorization: string, claim: Claim, task: (context: ExecutionExtensionContext) => Promise<T>, signal?: AbortSignal): Promise<T>;
  close(): Promise<void>;
}
export interface ControllerNativeRequester { origin: string; authorization: string }

/** Production composition uses the actual Parent client for both ownership
 * and tools, rather than supplying permissive gateway callbacks. */
export function createControllerNativeWorkerSourceAdapter(transport: ControllerNativeTransport & ControllerNativeToolTransport,
  requester: ControllerNativeRequester): ControllerNativeSourceAdapter {
  return createControllerNativeSourceAdapter(transport,createControllerNativeToolGateway(transport),requester);
}
type Binding = { composed: ControllerNativeSourceAdapter; requesterDigest: string };
const shared = globalThis as typeof globalThis & { __flujoControllerNativeAdapters?: Map<string, Binding> };
const adapters = shared.__flujoControllerNativeAdapters ??= new Map<string, Binding>();

async function boundedRequestBody(request: Request): Promise<unknown> {
  const reader=request.body?.getReader(); if (!reader) throw denied();
  const signal=AbortSignal.any([request.signal,AbortSignal.timeout(5000)]);
  const chunks:Buffer[]=[]; let bytes=0;
  const abort=()=>{void reader.cancel().catch(()=>{});}; signal.addEventListener('abort',abort,{once:true});
  try {
    signal.throwIfAborted();
    while(true) {
      const next=await reader.read(); signal.throwIfAborted(); if(next.done)break;
      bytes+=next.value.byteLength; if(bytes>32*1024)throw denied(); chunks.push(Buffer.from(next.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {signal.removeEventListener('abort',abort);await reader.cancel();reader.releaseLock();for(const chunk of chunks)chunk.fill(0);}
}

/** Trusted build/launcher composition only. No Flow or HTTP DTO selects this
 * transport or gateway. The real Parent client authenticates Worker ownership,
 * rereads its immutable plan and holds its mutation fence. Next server graphs
 * reuse one adapter/weak-capability registry for the same private binding. */
export function createControllerNativeSourceAdapter(transport: ControllerNativeTransport, gateway: Gateway,
  requester?: ControllerNativeRequester): ControllerNativeSourceAdapter {
  if (!/^[a-f0-9]{64}$/.test(transport?.bindingId ?? '')
      || ['admit','readPlan','assertRun','bindRun','readRoot','commit','observe'].some(key=>typeof transport[key as keyof ControllerNativeTransport]!=='function')
      || ['isProtectedServer','assertServerConfig','protectedServer','authorizeHandoffs','assertModelTool','assertDispatch',
        'normalizeArguments','requestMeta','validateResult'].some(key=>typeof gateway?.[key as keyof Gateway]!=='function')) throw denied();
  let origin:URL|undefined, credential:Buffer|undefined;
  if(requester) {
    origin=new URL(requester.origin);
    if(origin.protocol!=='http:' || origin.hostname!=='127.0.0.1' || !origin.port || origin.pathname!=='/'
      || origin.search || origin.hash || origin.username || origin.password || !/^Bearer [A-Za-z0-9_-]{43}$/.test(requester.authorization))throw denied();
    credential=Buffer.from(requester.authorization);
  }
  const requesterDigest=digest(requester??null);
  const existing = adapters.get(transport.bindingId);
  if (existing) {if(existing.requesterDigest!==requesterDigest)throw denied();return existing.composed;}
  if (adapters.size >= 16) throw denied();
  const contexts = new WeakMap<object, Active>();
  const active = new Set<Active>();
  const conversations = new Set<string>();
  let closed = false;
  const item = (context: object) => {
    const selected = contexts.get(context);
    if (closed || !selected) throw denied();
    selected.watch.signal.throwIfAborted(); return selected;
  };
  const current = async (selected: Active) => {
    if (closed) throw denied(); selected.watch.signal.throwIfAborted();
    await transport.assertRun(selected.remote);
    if (digest(checkedPlan(await transport.readPlan(selected.remote))) !== digest(selected.plan)) throw denied();
    if (closed) throw denied(); selected.watch.signal.throwIfAborted();
  };
  const adapter: ExecutionExtensionAdapter = {
    isProtectedServer: server => gateway.isProtectedServer(server),
    assertServerConfig: config => gateway.assertServerConfig(config),
    async assertRun(context, expected) { const selected=item(context); await current(selected); await transport.assertRun(selected.remote,expected); },
    async assertConversationAccess(conversation) { if (conversations.has(conversation)) throw denied(); },
    async exposeConversationInList(conversation) { return !conversations.has(conversation); },
    async validateRun(input, context) {
      const selected=item(context); await current(selected);
      if (input.conversationId!==selected.claim.rootConversationId || input.flowId!==selected.plan.flowId
          || input.flowDefinition || input.personaAttribution || input.parentRunId || (input.depth??0)!==0) throw denied();
    },
    async validateLoadedState(context, state) {
      const selected=item(context); await current(selected);
      const saved=state as { conversationId?:string; flowSnapshot?:unknown; flowId?:string };
      if (!saved || saved.conversationId!==selected.claim.rootConversationId || saved.flowId!==selected.plan.flowId
          || digest(saved.flowSnapshot)!==selected.plan.flowDigest) throw denied();
    },
    async bindRun(context, conversation, run) { const selected=item(context); await current(selected); await transport.bindRun(selected.remote,conversation,run); },
    signal(context) { return item(context).watch.signal; },
    async commit(context, task) {
      const selected=item(context); await current(selected);
      return transport.commit(selected.remote,async()=>{await current(selected); const result=await task(); await current(selected); return result;});
    },
    protectedServer(context) { return gateway.protectedServer(item(context).remote); },
    authorizeHandoffs(context,names) { gateway.authorizeHandoffs(item(context).remote,names); },
    async assertModelTool(context,name,advertised) { const selected=item(context); await current(selected); await gateway.assertModelTool(selected.remote,name,advertised); },
    async assertDispatch(context,server,source) {
      if (!context) throw denied(); const selected=item(context); await current(selected); await gateway.assertDispatch(selected.remote,server,source);
    },
    normalizeArguments(context,tool,args) { return gateway.normalizeArguments(item(context).remote,tool,args); },
    async requestMeta(context,server,tool,args) { const selected=item(context); await current(selected); return gateway.requestMeta(selected.remote,server,tool,args); },
    validateResult(context,tool,result) { return gateway.validateResult(item(context).remote,tool,result); },
    async nativeWorkerRoot(context,expected) {
      const selected=item(context); await current(selected);
      const result=await transport.readRoot(selected.remote,expected); await current(selected); return result;
    },
  };
  if(origin && credential) {
    const selectedOrigin=origin, selectedCredential=credential;
    const target=(request:Request)=>new URL(request.url).pathname==='/v1/chat/completions';
    const authorized=(request:Request)=>{
      const address=new URL(request.url), supplied=Buffer.from(request.headers.get('authorization')??'');
      // Next normalizes the proxy's internal URL to localhost even when its
      // actual listener and HTTP Host are 127.0.0.1. Preserve the exact wire
      // Host/port and private bearer; only this internal spelling is equivalent.
      const ownedAddress=address.origin===selectedOrigin.origin || address.protocol==='http:'
        && address.hostname==='localhost' && address.port===selectedOrigin.port;
      return !closed && ownedAddress && !address.search && !address.hash && !address.username && !address.password
        && request.headers.get('host')===selectedOrigin.host && !request.headers.has('origin') && request.method==='POST'
        && request.headers.get('content-type')?.split(';')[0].trim()==='application/json'
        && supplied.length===selectedCredential.length && timingSafeEqual(supplied,selectedCredential);
    };
    const refusal=()=>Response.json({error:'controller_native_source_refused'},{status:403});
    adapter.authorizeTransport=request=>target(request)?authorized(request)?null:refusal():undefined;
    adapter.withRoute=async(request,task)=>{
      if(!target(request))return task(request);
      if(!authorized(request))return refusal();
      const body=await boundedRequestBody(request) as {prompt?:unknown;claim?:Claim;workerAuthorization?:unknown};
      if(!body || Object.keys(body).sort().join()!=='claim,prompt,workerAuthorization' || typeof body.prompt!=='string'
        || !body.prompt.trim() || Buffer.byteLength(body.prompt)>16*1024 || typeof body.workerAuthorization!=='string'
        || body.workerAuthorization.length>4096)throw denied();
      return composed.withWorkerRun(body.workerAuthorization,body.claim!,async()=>{
        request.signal.throwIfAborted();
        const input=applyExecutionRunInput({source:'internal',prompt:body.prompt as string});
        const headers=new Headers({'content-type':'application/json','host':selectedOrigin.host,
          'x-flujo-workspace':body.claim!.workspace});
        const admitted=new Request(request.url,{method:'POST',headers,signal:request.signal,body:JSON.stringify({
          model:`flow-${input.flowId}`,stream:false,messages:[{role:'user',content:body.prompt}],
          metadata:{flujo:'true',requireApproval:'false',conversationId:input.conversationId},
        })});
        return task(admitted);
      },request.signal);
    };
  }
  const composed: ControllerNativeSourceAdapter = Object.freeze({ adapter,
    async withWorkerRun<T>(workerAuthorization: string, claim: Claim, task: (context: ExecutionExtensionContext)=>Promise<T>, signal?:AbortSignal) {
      signal?.throwIfAborted();
      if (closed || typeof task!=='function' || active.size>=100 || conversations.size>=256) throw denied();
      const captured=Object.freeze(structuredClone(claim));
      const remote=await transport.admit(workerAuthorization,captured);
      const plan=checkedPlan(await transport.readPlan(remote));
      const observed=await transport.observe(remote);
      const watch=signal?{...observed,signal:AbortSignal.any([observed.signal,signal])}:observed;
      if (closed || active.size>=100 || conversations.size>=256) { await watch.close(); throw denied(); }
      const selected:Active={remote,claim:captured,plan,watch};
      const value=Object.freeze({}); contexts.set(value,selected); active.add(selected); conversations.add(captured.rootConversationId);
      const context=createExecutionExtensionContext(adapter,value);
      try {
        await current(selected);
        const result=await runWithExecutionInput({source:'internal',executionExtensionContext:context,conversationId:captured.rootConversationId,flowId:plan.flowId},()=>task(context));
        await current(selected);
        return result;
      } finally {contexts.delete(value);active.delete(selected);await watch.close();}
    },
    async close() {
      if (closed) return; closed=true;
      await Promise.all([...active].map(selected=>selected.watch.close()));
      credential?.fill(0);
      if (adapters.get(transport.bindingId)?.composed===composed) adapters.delete(transport.bindingId);
    },
  });
  adapters.set(transport.bindingId,{composed,requesterDigest}); return composed;
}
