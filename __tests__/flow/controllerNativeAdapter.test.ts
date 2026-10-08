import { createHash, randomBytes } from 'node:crypto';
import { createControllerNativeSourceAdapter, type ControllerNativeTransport } from '@/backend/execution/extensions/controllerNativeAdapter';
import { registerExecutionExtension, assertExecutionExtensionCurrent, applyExecutionRunInput,
  bindExecutionExtensionRun, executionExtensionNativeWorkerRoot, commitExecutionExtensionMutation,
  type ExecutionExtensionContext, type ExecutionExtensionAdapter } from '@/backend/execution/extensions';

const flow={id:'owned-flow',nodes:[],edges:[]};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const plan={flowId:flow.id,flowDigest:hash(flow),modelId:'owned-luna',modelDigest:'b'.repeat(64)};
const claim={runId:'controller-run',rootConversationId:'owned-conversation',goalId:'owned-goal',workspace:'owned-workspace'};
// Source capability tests use deterministic transport/gateway callbacks. They
// are not authenticated fleet, account-backed SDK or live Worker evidence.

function equipment() {
  const remote=Object.freeze({});const abort=new AbortController();let logical:string|undefined;
  let currentPlan={...plan},held=false,calls=0;
  const read=async(context:object)=>{expect(context).toBe(remote);abort.signal.throwIfAborted();};
  const transport:ControllerNativeTransport={bindingId:randomBytes(32).toString('hex'),
    async admit(auth,received){expect(auth).toBe('Bearer synthetic-worker-only');expect(received).toEqual(claim);return remote;},
    async readPlan(context){await read(context);return {...currentPlan};},
    async assertRun(context,expected){await read(context);if(expected?.conversationId&&expected.conversationId!==claim.rootConversationId)throw new Error('wrong conversation');
      if(expected?.runId&&expected.runId!==logical)throw new Error('wrong logical run');},
    async bindRun(context,conversation,run){await read(context);expect(conversation).toBe(claim.rootConversationId);logical=run;},
    async readRoot(context,expected){await read(context);expect(expected.runId).toBe(logical);calls++;
      return {version:1,workerId:'synthetic-controller-worker',goalId:claim.goalId,fleetRunId:claim.runId,
        rootConversationId:claim.rootConversationId,logicalRunId:logical!,workspace:claim.workspace,targetDigest:'c'.repeat(64),
        flowDigest:plan.flowDigest,leaseEpoch:'owned-epoch',modelId:plan.modelId,modelDigest:plan.modelDigest};},
    async commit(context,task){await read(context);held=true;try{return await task();}finally{held=false;}},
    async observe(context){await read(context);return {signal:abort.signal,async close(){abort.abort(new Error('closed'));}};},
  };
  const gateway={isProtectedServer:(server:string)=>server==='fleet',assertServerConfig:()=>{},protectedServer:()=> 'fleet',
    authorizeHandoffs:()=>{},assertModelTool:async()=>{},assertDispatch:async()=>{},normalizeArguments:(_ctx:object,_tool:string,args:Record<string,unknown>)=>args,
    requestMeta:async()=>({}),validateResult:(_ctx:object,_tool:string,result:unknown)=>result};
  const composed=createControllerNativeSourceAdapter(transport,gateway);
  const restore=registerExecutionExtension(composed.adapter);
  return {composed,transport,gateway,abort,restore,held:()=>held,calls:()=>calls,
    drift(){currentPlan={...currentPlan,modelDigest:'d'.repeat(64)};}};
}

test('trusted transport mints a Source context that pins actual plan and refuses copied or retired capabilities',async()=>{
  const e=equipment();let retained:ExecutionExtensionContext|undefined;
  try {
    await e.composed.withWorkerRun('Bearer synthetic-worker-only',claim,async context=>{
      retained=context;
      const input=applyExecutionRunInput({source:'internal',prompt:'Source adapter contract only; no SDK/provider.'});
      expect(input).toMatchObject({flowId:plan.flowId,conversationId:claim.rootConversationId,executionExtensionContext:context});
      await assertExecutionExtensionCurrent(context);
      await expect(assertExecutionExtensionCurrent({...context} as ExecutionExtensionContext)).rejects.toThrow();
      await bindExecutionExtensionRun(context,claim.rootConversationId,'source-logical-run');
      const root=await executionExtensionNativeWorkerRoot(context,{conversationId:claim.rootConversationId,runId:'source-logical-run',
        workspace:claim.workspace,...plan});
      expect(root).toMatchObject({goalId:claim.goalId,fleetRunId:claim.runId,modelId:plan.modelId});
      expect(e.calls()).toBe(1);
      await commitExecutionExtensionMutation(context,async()=>{expect(e.held()).toBe(true);});
      expect(e.held()).toBe(false);
    });
    await expect(assertExecutionExtensionCurrent(retained)).rejects.toThrow();
    await expect(e.composed.adapter.assertDispatch(undefined,'fleet','model')).rejects.toThrow();
  }finally{e.restore();await e.composed.close();}
});

test('independent plan drift blocks Source writes before effects and root admission',async()=>{
  const e=equipment();let effects=0;
  try {
    await e.composed.withWorkerRun('Bearer synthetic-worker-only',claim,async context=>{
      e.drift();
      await expect(commitExecutionExtensionMutation(context,async()=>{effects++;})).rejects.toThrow();
      await expect(executionExtensionNativeWorkerRoot(context,{conversationId:claim.rootConversationId,runId:'source-logical-run',workspace:claim.workspace,...plan})).rejects.toThrow();
      expect(effects).toBe(0);expect(e.calls()).toBe(0);
    });
  }finally{e.restore();await e.composed.close();}
});

test('Next server graphs reuse the same adapter registry for one private transport binding',async()=>{
  const e=equipment();
  try{expect(createControllerNativeSourceAdapter({...e.transport},e.gateway)).toBe(e.composed);}
  finally{e.restore();await e.composed.close();}
});

test('composition requires a trusted private client and all gateway guards',()=>{
  expect(()=>createControllerNativeSourceAdapter({} as ControllerNativeTransport,{} as ExecutionExtensionAdapter)).toThrow();
});
