import { timingSafeEqual } from 'node:crypto';
import { nativeDigest as digest } from '../flow/handlers/nativeDigest';
import { applyExecutionRunInput, createExecutionExtensionContext, ExecutionExtensionError, runWithExecutionInput,
  executionExtensionNativeWorkerRoot,
  type ExecutionExtensionAdapter, type ExecutionExtensionContext, type ExecutionNativeWorkerRoot,
  type ExecutionNativeWorkerRootRequest } from './index';
import { createControllerNativeToolGateway, type ControllerNativeToolTransport } from './controllerNativeTools';

type Claim = Readonly<{ runId: string; rootConversationId: string; goalId: string; workspace: string }>;
type Plan = Readonly<{ flowId: string; flowDigest: string; modelId: string; modelDigest: string }>;
type ChildPlan = Plan & Readonly<{parentNodeId:string}>;
export interface ControllerNativeTransport {
  readonly bindingId: string;
  admit(workerAuthorization: string, claim: Claim): Promise<object>;
  readPlan(context: object): Promise<Plan>;
  readChildren?(context: object): Promise<ChildPlan[]>;
  assertRun(context: object, expected?: { conversationId?: string; runId?: string; graphHash?: string }): Promise<void>;
  bindRun(context: object, conversationId: string, runId: string): Promise<void>;
  readRoot(context: object, expected: ExecutionNativeWorkerRootRequest): Promise<ExecutionNativeWorkerRoot>;
  commit<T>(context: object, task: () => Promise<T>): Promise<T>;
  observe(context: object): Promise<{ signal: AbortSignal; close(): Promise<void> }>;
}
type Gateway = Pick<ExecutionExtensionAdapter, 'isProtectedServer' | 'assertServerConfig' | 'protectedServer' |
  'authorizeHandoffs' | 'assertModelTool' | 'assertDispatch' | 'normalizeArguments' | 'requestMeta' | 'validateResult'>;
type Active = { remote: object; claim: Claim; plan: Plan; children:ChildPlan[];
  context?:ExecutionExtensionContext; child?:Child; handoffs:Set<string>; watch: Awaited<ReturnType<ControllerNativeTransport['observe']>> };
type Child = {root:Active;plan:ChildPlan;conversationId:string;logicalRunId?:string;handoffs:Set<string>};
const denied = () => new ExecutionExtensionError('controller_native_source_refused');
function checkedPlan(value: Plan): Plan {
  if (!value || Object.keys(value).sort().join() !== ['flowDigest','flowId','modelDigest','modelId'].join()
      || !value.flowId || !value.modelId || !/^[a-f0-9]{64}$/.test(value.flowDigest) || !/^[a-f0-9]{64}$/.test(value.modelDigest)) throw denied();
  return Object.freeze({ flowId:value.flowId,flowDigest:value.flowDigest,modelId:value.modelId,modelDigest:value.modelDigest });
}
function checkedChildren(values:ChildPlan[]):ChildPlan[] {
  if(!Array.isArray(values)||values.length>1)throw denied();
  return values.map(value=>{
    if(!value||Object.keys(value).length!==5||typeof value.parentNodeId!=='string'||!value.parentNodeId)throw denied();
    const {parentNodeId,...plan}=value;return Object.freeze({parentNodeId,...checkedPlan(plan)});
  });
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
  const childContexts = new WeakMap<object, Child>();
  const active = new Set<Active>();
  const conversations = new Set<string>();
  let closed = false;
  const item = (context: object) => {
    const selected = contexts.get(context)??childContexts.get(context)?.root;
    if (closed || !selected || !active.has(selected)) throw denied();
    selected.watch.signal.throwIfAborted(); return selected;
  };
  const current = async (selected: Active) => {
    if (closed) throw denied(); selected.watch.signal.throwIfAborted();
    await transport.assertRun(selected.remote);
    if (digest(checkedPlan(await transport.readPlan(selected.remote))) !== digest(selected.plan)) throw denied();
    if(digest(checkedChildren(await transport.readChildren?.(selected.remote)??[]))!==digest(selected.children))throw denied();
    if (closed) throw denied(); selected.watch.signal.throwIfAborted();
  };
  const adapter: ExecutionExtensionAdapter = {
    isProtectedServer: server => gateway.isProtectedServer(server),
    assertServerConfig: config => gateway.assertServerConfig(config),
    async assertRun(context, expected) {
      const selected=item(context),child=childContexts.get(context);await current(selected);
      if(child){
        if(expected?.conversationId!==undefined&&expected.conversationId!==child.conversationId
          ||expected?.runId!==undefined&&expected.runId!==child.logicalRunId
          ||expected?.graphHash!==undefined&&expected.graphHash!==child.plan.flowDigest)throw denied();
      }else await transport.assertRun(selected.remote,expected);
    },
    async assertConversationAccess(conversation) { if (conversations.has(conversation)) throw denied(); },
    async exposeConversationInList(conversation) { return !conversations.has(conversation); },
    async validateRun(input, context) {
      const selected=item(context); await current(selected);
      const child=childContexts.get(context);
      if(child){
        if(input.conversationId!==child.conversationId||input.flowId!==child.plan.flowId||input.flowDefinition
          ||input.personaAttribution||input.parentRunId!==selected.claim.rootConversationId||input.depth!==1
          ||input.source!=='subflow'||input.mode!=='conversation')throw denied();
        return;
      }
      if (input.conversationId!==selected.claim.rootConversationId || input.flowId!==selected.plan.flowId
          || input.flowDefinition || input.personaAttribution || input.parentRunId || (input.depth??0)!==0) throw denied();
    },
    async prepareSubflow(context,input) {
      const selected=item(context);await current(selected);
      if(childContexts.has(context)||!selected.context||input.source!=='subflow'||input.depth!==1
        ||input.parentRunId!==selected.claim.rootConversationId||!input.conversationId||input.flowDefinition
        ||input.personaAttribution||input.mode!=='conversation'||selected.child||!input.lane?.invocationId||!input.lane.laneId)throw denied();
      const {FlowExecutor}=await import('../flow/FlowExecutor');
      const parent=FlowExecutor.conversationStates.get(selected.claim.rootConversationId);
      const invocation=parent?.subflowInvocations?.[input.lane.invocationId];
      const lane=invocation?.lanes.find(value=>value.id===input.lane!.laneId);
      const plan=selected.children.find(value=>value.parentNodeId===input.lane?.parentNodeId&&value.flowId===input.flowId);
      const node=parent?.flowSnapshot?.nodes.find(value=>value.id===plan?.parentNodeId);
      if(!plan||plan.modelId!==selected.plan.modelId||plan.modelDigest!==selected.plan.modelDigest
        ||parent?.executionExtensionContext!==selected.context||parent.isCancelled||parent.runDepth!==0
        ||digest(parent.flowSnapshot)!==selected.plan.flowDigest||!parent.logicalRunId
        ||node?.data.type!=='subflow'||node.data.properties?.subflowId!==plan.flowId
        ||invocation?.version!==1||invocation.parentConversationId!==selected.claim.rootConversationId
        ||invocation.parentRunId!==selected.claim.rootConversationId||invocation.parentNodeId!==plan.parentNodeId
        ||invocation.lanes.length!==1||invocation.status!=='running'||lane?.status!=='running'
        ||lane.conversationId!==input.conversationId||lane.subflowId!==plan.flowId)throw denied();
      const child:Child={root:selected,plan,conversationId:input.conversationId,handoffs:new Set()};
      const value=Object.freeze({});childContexts.set(value,child);selected.child=child;
      conversations.add(child.conversationId);return value;
    },
    async validateLoadedState(context, state) {
      const selected=item(context); await current(selected);
      const child=childContexts.get(context),plan=child?.plan??selected.plan;
      const saved=state as { conversationId?:string; flowSnapshot?:unknown; flowId?:string };
      if (!saved || saved.conversationId!==(child?.conversationId??selected.claim.rootConversationId) || saved.flowId!==plan.flowId
          || digest(saved.flowSnapshot)!==plan.flowDigest) throw denied();
    },
    async bindRun(context, conversation, run) {
      const selected=item(context);await current(selected);const child=childContexts.get(context);
      if(child){if(conversation!==child.conversationId||!run||child.logicalRunId&&child.logicalRunId!==run)throw denied();child.logicalRunId=run;}
      else await transport.bindRun(selected.remote,conversation,run);
    },
    signal(context) { return item(context).watch.signal; },
    async commit(context, task) {
      const selected=item(context); await current(selected);
      return transport.commit(selected.remote,async()=>{await current(selected); const result=await task(); await current(selected); return result;});
    },
    protectedServer(context) { return gateway.protectedServer(item(context).remote); },
    async subflowCapacity(context,parentNodeId) {
      const selected=item(context);await current(selected);
      return !childContexts.has(context)&&!selected.child&&selected.children.some(value=>value.parentNodeId===parentNodeId)?1:0;
    },
    async authorizeHandoffs(context,names) {
      const selected=item(context),child=childContexts.get(context);
      await current(selected);
      const {FlowExecutor}=await import('../flow/FlowExecutor');
      const state=FlowExecutor.conversationStates.get(child?.conversationId??selected.claim.rootConversationId);
      const plan=child?.plan??selected.plan;
      if(!state?.flowSnapshot||digest(state.flowSnapshot)!==plan.flowDigest)throw denied();
      const allowed=names.filter(name=>{
        if(!name.startsWith('handoff_to_'))return false;
        const id=state.handoffNameMap?.[name],node=state.flowSnapshot!.nodes.find(value=>value.id===id);
        return node?.data.type==='finish'||node?.data.type==='process'
          ||!child&&node?.data.type==='subflow'&&selected.children.some(value=>value.parentNodeId===id);
      });
      await gateway.authorizeHandoffs(selected.remote,allowed);
      const admitted=child?.handoffs??selected.handoffs;admitted.clear();for(const name of allowed)admitted.add(name);
      return allowed;
    },
    async assertModelTool(context,name,advertised) { const selected=item(context); await current(selected);
      if((childContexts.get(context)?.handoffs??selected.handoffs).has(name)&&!advertised)return;
      await gateway.assertModelTool(selected.remote,name,advertised);
    },
    async assertDispatch(context,server,source) {
      if (!context) throw denied(); const selected=item(context); await current(selected); await gateway.assertDispatch(selected.remote,server,source);
    },
    normalizeArguments(context,tool,args) { return gateway.normalizeArguments(item(context).remote,tool,args); },
    async requestMeta(context,server,tool,args) { const selected=item(context); await current(selected); return gateway.requestMeta(selected.remote,server,tool,args); },
    validateResult(context,tool,result) { return gateway.validateResult(item(context).remote,tool,result); },
    async nativeWorkerRoot(context,expected) {
      const selected=item(context); await current(selected);
      if(childContexts.has(context))throw denied();
      const result=await transport.readRoot(selected.remote,expected); await current(selected); return result;
    },
    async nativeWorkerDescendant(context,expected) {
      const selected=item(context),child=childContexts.get(context);await current(selected);
      if(!child||!selected.context||expected.conversationId!==child.conversationId||expected.runId!==child.logicalRunId
        ||expected.workspace!==selected.claim.workspace||expected.flowId!==child.plan.flowId
        ||expected.flowDigest!==child.plan.flowDigest||expected.modelId!==child.plan.modelId||expected.modelDigest!==child.plan.modelDigest)throw denied();
      const {FlowExecutor}=await import('../flow/FlowExecutor');
      const parent=FlowExecutor.conversationStates.get(selected.claim.rootConversationId);
      if(!parent?.logicalRunId||parent.executionExtensionContext!==selected.context)throw denied();
      const root=await executionExtensionNativeWorkerRoot(selected.context,{conversationId:selected.claim.rootConversationId,
        runId:parent.logicalRunId,workspace:selected.claim.workspace,...selected.plan});
      if(!root)throw denied();await current(selected);
      return {root,parentNodeId:child.plan.parentNodeId,flowDigest:child.plan.flowDigest,modelId:child.plan.modelId,modelDigest:child.plan.modelDigest};
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
      const children=checkedChildren(await transport.readChildren?.(remote)??[]);
      const observed=await transport.observe(remote);
      const watch=signal?{...observed,signal:AbortSignal.any([observed.signal,signal])}:observed;
      if (closed || active.size>=100 || conversations.size>=256) { await watch.close(); throw denied(); }
      const selected:Active={remote,claim:captured,plan,children,watch,handoffs:new Set()};
      const value=Object.freeze({}); contexts.set(value,selected); active.add(selected); conversations.add(captured.rootConversationId);
      const context=createExecutionExtensionContext(adapter,value);
      selected.context=context;
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
