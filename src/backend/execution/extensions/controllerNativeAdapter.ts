import { createHash } from 'node:crypto';
import { createExecutionExtensionContext, ExecutionExtensionError, runWithExecutionInput,
  type ExecutionExtensionAdapter, type ExecutionExtensionContext, type ExecutionNativeWorkerRoot,
  type ExecutionNativeWorkerRootRequest } from './index';

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
  withWorkerRun<T>(workerAuthorization: string, claim: Claim, task: (context: ExecutionExtensionContext) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
const shared = globalThis as typeof globalThis & { __flujoControllerNativeAdapters?: Map<string, ControllerNativeSourceAdapter> };
const adapters = shared.__flujoControllerNativeAdapters ??= new Map<string, ControllerNativeSourceAdapter>();

/** Trusted build/launcher composition only. No Flow or HTTP DTO selects this
 * transport or gateway. The real Parent client authenticates Worker ownership,
 * rereads its immutable plan and holds its mutation fence. Next server graphs
 * reuse one adapter/weak-capability registry for the same private binding. */
export function createControllerNativeSourceAdapter(transport: ControllerNativeTransport, gateway: Gateway): ControllerNativeSourceAdapter {
  if (!/^[a-f0-9]{64}$/.test(transport?.bindingId ?? '')
      || ['admit','readPlan','assertRun','bindRun','readRoot','commit','observe'].some(key=>typeof transport[key as keyof ControllerNativeTransport]!=='function')
      || ['isProtectedServer','assertServerConfig','protectedServer','authorizeHandoffs','assertModelTool','assertDispatch',
        'normalizeArguments','requestMeta','validateResult'].some(key=>typeof gateway?.[key as keyof Gateway]!=='function')) throw denied();
  const existing = adapters.get(transport.bindingId);
  if (existing) return existing;
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
  const composed: ControllerNativeSourceAdapter = Object.freeze({ adapter,
    async withWorkerRun<T>(workerAuthorization: string, claim: Claim, task: (context: ExecutionExtensionContext)=>Promise<T>) {
      if (closed || typeof task!=='function' || active.size>=100 || conversations.size>=256) throw denied();
      const captured=Object.freeze(structuredClone(claim));
      const remote=await transport.admit(workerAuthorization,captured);
      const plan=checkedPlan(await transport.readPlan(remote));
      const watch=await transport.observe(remote);
      if (closed || active.size>=100 || conversations.size>=256) { await watch.close(); throw denied(); }
      const selected:Active={remote,claim:captured,plan,watch};
      const value=Object.freeze({}); contexts.set(value,selected); active.add(selected); conversations.add(captured.rootConversationId);
      const context=createExecutionExtensionContext(adapter,value);
      try {
        await current(selected);
        return await runWithExecutionInput({executionExtensionContext:context,conversationId:captured.rootConversationId,flowId:plan.flowId},()=>task(context));
      } finally {contexts.delete(value);active.delete(selected);await watch.close();}
    },
    async close() {
      if (closed) return; closed=true;
      await Promise.all([...active].map(selected=>selected.watch.close()));
      if (adapters.get(transport.bindingId)===composed) adapters.delete(transport.bindingId);
    },
  });
  adapters.set(transport.bindingId,composed); return composed;
}
