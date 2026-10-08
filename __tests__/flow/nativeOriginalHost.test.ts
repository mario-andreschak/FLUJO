import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import type { FlowRunInput, FlowRunResult } from '@/backend/execution/flow/runFlow';
import { runFlow } from '@/backend/execution/flow/runFlow';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { Model } from '@/shared/types/model';

const modelFixture: Model = { id: 'model-test', name: 'offline-native', displayName: 'Offline native',
  provider: 'claude-subscription', adapter: 'claude-cli', ApiKey: 'fixture', maxTurns: 3 } as Model;
let selectedModel = { ...modelFixture };
const queryMock = jest.fn();
jest.mock('@/backend/services/model', () => ({ modelService: {
  getModel: async () => selectedModel, resolveAndDecryptApiKey: async () => selectedModel.adapter==='codex-cli'?'':'offline-fixture-token',
  loadModels: async () => [selectedModel],
} }));
jest.mock('@/backend/services/model/adapters', () => ({ getCompletionAdapter: () => selectedModel.adapter==='codex-cli'
  ? new (jest.requireActual<typeof import('@/backend/services/model/adapters/codexAdapter')>('@/backend/services/model/adapters/codexAdapter').CodexAdapter)()
  : new (jest.requireActual<typeof import('@/backend/services/model/adapters/claudeSubscriptionAdapter')>(
    '@/backend/services/model/adapters/claudeSubscriptionAdapter').ClaudeSubscriptionAdapter)() }));
jest.mock('@openai/codex-sdk',()=>({Codex:class {constructor(){throw new Error('Offline owned Original must not use SDK exec');}}}),{virtual:true});
// Only the model edge is deterministic. Production Original, Persona lease,
// journal, thread wrapper, MCP bridge and born-child registration remain real.
// The separate opt-in live qualification suite proves the real profile mint.
jest.mock('@/backend/services/model/adapters/codexNativeQualification',()=>{
  const profile=Object.freeze({verifiedCliVersion:'offline-fixture',verifiedCliPath:process.execPath,
    verifiedCliSha256:'fixture',verifiedModelCatalogPath:'fixture',verifiedModelCatalogSha256:'fixture'});
  return {qualifyNativeCodex:async()=>profile,assertNativeCodexQualification:(value:unknown)=>{
    if(value!==profile)throw new Error('Fixture qualification capability mismatch');}};
});
jest.mock('@/backend/services/model/adapters/codexRestrictedProfile',()=>{
  const actual=jest.requireActual<typeof import('@/backend/services/model/adapters/codexRestrictedProfile')>('@/backend/services/model/adapters/codexRestrictedProfile');
  return {...actual,assertRestrictedCodexProfile:async()=>process.execPath,prepareRestrictedCodexRuntimeEnvironment:async()=>({
    home:directory,workingDirectory:directory,env:Object.fromEntries(Object.entries(process.env).filter(([key,value])=>value!==undefined&&/^(path|systemroot|windir|comspec|pathext)$/i.test(key))),
    configOverrides:[],modelCatalogPath:'offline-fixture-catalog',cleanup:async()=>{},
  })};
});
const codexFixture=`
const rl=require('node:readline'),bridge=process.argv[1],handoff=process.argv[2]==='true';
setInterval(()=>{},1000);process.stdin.on('end',()=>process.exit(0));
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
rl.createInterface({input:process.stdin}).on('line',async line=>{
 const request=JSON.parse(line);if(request.id===undefined)return;
 if(request.method==='thread/start'){send({id:request.id,result:{thread:{id:'thread-offline-owned'},model:request.params.model}});return;}
 if(request.method!=='turn/start'){send({id:request.id,result:{}});return;}
 const threadId='thread-offline-owned',turnId='turn-offline-owned';send({id:request.id,result:{turn:{id:turnId}}});
 const emit=(method,extra)=>send({method,params:{threadId,turnId,...extra}});
 if(handoff){
   const call=async(method,params)=>{const response=await fetch(bridge,{method:'POST',headers:{'content-type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});return response.json();};
   await call('initialize',{protocolVersion:'2025-03-26',clientInfo:{name:'offline-fixture',version:'1'},capabilities:{}});
   const listed=await call('tools/list',{});const tool=listed.result.tools.find(value=>value.name.startsWith('handoff_to_'));
   if(!tool){process.exitCode=1;process.stdin.destroy();return;}
   // Exit and pipe close are independently observable even with inherited
   // fixture stdout held briefly by another actual process.
   require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},700)'],{stdio:['ignore',process.stdout,process.stderr],windowsHide:true});
   emit('item/started',{item:{type:'mcpToolCall',id:'offline-code-call-1',server:'flujo',tool:tool.name,status:'inProgress',arguments:{}}});
   await call('tools/call',{name:tool.name,arguments:{},_meta:{callId:'offline-code-call-1',threadId}});return;
 }
 emit('item/completed',{item:{type:'agentMessage',id:'offline-code-message',text:'done'}});
 emit('thread/tokenUsage/updated',{tokenUsage:{last:{inputTokens:7,cachedInputTokens:2,outputTokens:4,reasoningOutputTokens:1}}});
 emit('turn/completed',{turn:{id:turnId,status:'completed'}});
});`;
jest.mock('@/backend/services/model/adapters/codexAppServerProcess',()=>{
  const actual=jest.requireActual<typeof import('@/backend/services/model/adapters/codexAppServerProcess')>('@/backend/services/model/adapters/codexAppServerProcess');
  return {...actual,startOwnedCodexAppServer:async(input:Parameters<typeof actual.startOwnedCodexAppServer>[0])=>{
    const arg=input.args?.find(value=>value.startsWith('mcp_servers.flujo.url='));
    const bridge=arg?JSON.parse(arg.slice(arg.indexOf('=')+1)):'';
    const transport=await actual.startOwnedCodexAppServer({...input,executable:process.execPath,args:['-e',codexFixture,bridge,String(emitHandoff)],
      register:async process=>{await input.register(process);await beforePrompt?.();}});
    return {...transport,request:async(method:string,params:unknown,timeout?:number)=>{
      const result=await transport.request(method,params,timeout);
      if(method==='turn/start'){promptCount++;await afterPrompt?.();}
      return result;
    }};
  }};
});
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: (...args: unknown[]) => queryMock(...args),
  createSdkMcpServer: (value: unknown) => value,
  tool: (name: string, _description: unknown, _schema: unknown, handler: unknown) => ({ name, handler }) }));

import { PersonaFlowDispatcher, personaFlowDispatchId } from '@/backend/services/enduringAgents/personaDispatcher';
import { createPersonaWorkItem } from '@/backend/services/enduringAgents/workItems';
import { createRoleVersion, getPersonaWorkItem, savePersonaWorkItem } from '@/backend/services/enduringAgents/store';
import { stopPersonaGoalRuntime } from '@/backend/services/enduringAgents/goalRuntime';
import { buildTestRoleVersion, createPersonaFromRole, ensureTestRole } from '../enduringAgents/fixtures/personaFactory';
import { runWithWorkspace, getWorkspaceDataDir } from '@/utils/workspace';
import { loadCollectionItem, saveCollectionItem } from '@/utils/storage/backend';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import type { SharedState } from '@/backend/execution/flow/types';
import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import { createPersonaNativeOriginalHost, createWorkerNativeOriginalHost, assertNativeOriginalExecutionContext,
  nativeOriginalSourceReader } from '@/backend/execution/flow/handlers/nativeOriginalHost';
import { createExecutionExtensionContext, registerExecutionExtension, runWithExecutionInput,
  type ExecutionExtensionAdapter, type ExecutionNativeWorkerRoot } from '@/backend/execution/extensions';
import { createNativeInvocationSessionHook, type NativeInvocationSession } from '@/backend/execution/flow/handlers/nativeInvocationSession';
import { nativeDigest, createNativeToolPort, createNativeBrokerAuthority, nativeToolInventoryDigest } from '@/backend/execution/flow/handlers/nativeToolBroker';
import { prepareNativeInvocation, submitNativeInvocation } from '@/backend/execution/flow/handlers/nativeToolJournal';
import { subflowExecutionAuthority } from '@/backend/execution/flow/executionAuthority';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';

let directory: string;
let previousData: string | undefined;
let sequence = 0;
let promptCount = 0;
let children: SpawnedProcess[] = [];
let beforePrompt: (() => Promise<void>) | undefined;
let emitHandoff = false;
let afterHandoffStop: (() => Promise<void>) | undefined;
let afterPrompt: (() => Promise<void>) | undefined;
let transcriptText = 'done';
let lateResultFirst = false;
let offeredLateUsage: unknown;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-original-host-'));
  previousData = process.env.FLUJO_DATA_DIR;
  process.env.FLUJO_DATA_DIR = directory;
  selectedModel = { ...modelFixture };
  promptCount = 0; children = []; beforePrompt = undefined; emitHandoff = false; afterHandoffStop = undefined;
  afterPrompt = undefined; transcriptText = 'done';
  lateResultFirst = false; offeredLateUsage = undefined;
  queryMock.mockReset().mockImplementation(({ prompt, options }: {
    prompt: AsyncIterable<unknown>; options: { spawnClaudeCodeProcess: (options: SpawnOptions) => SpawnedProcess;
      env: SpawnOptions['env']; abortController: AbortController };
  }) => {
    const forwarded = new AbortController();
    const childScript = emitHandoff
      ? 'process.stdin.resume();process.stdin.on("end",()=>{require("node:child_process").spawn(process.execPath,["-e","setTimeout(()=>{},700)"],{stdio:["ignore",process.stdout,process.stderr],windowsHide:true});process.exit(0)});'
      : 'process.stdin.resume();process.stdin.on("end",()=>setTimeout(()=>process.exit(0),150));';
    const child = options.spawnClaudeCodeProcess({ command: process.execPath,
      args: ['-e', childScript],
      env: options.env, signal: forwarded.signal });
    children.push(child);
    const close = () => child.stdin.end();
    options.abortController.signal.addEventListener('abort', close, { once: true });
    const stream = (async function* () {
      await beforePrompt?.();
      await prompt[Symbol.asyncIterator]().next();
      expect((await ledger()).reservations[0].state).toBe('registered');
      expect(child.exitCode).toBeNull();
      promptCount++;
      await afterPrompt?.();
      if (lateResultFirst) {
        const result = { type: 'result', subtype: 'success', result: transcriptText, session_id: 'offline-fixture',
          num_turns: 1, total_cost_usd: 0.012, duration_ms: 19, usage: { input_tokens: 7, output_tokens: 4 } };
        offeredLateUsage = result;
        yield result;
      }
      yield { type: 'assistant', uuid: 'fixture-assistant', message: { role: 'assistant', content: [{ type: 'text', text: transcriptText }] } };
      if (emitHandoff) {
        const sdk = options as typeof options & {
          mcpServers: { flujo: { tools: { name: string; handler(args: Record<string, unknown>): Promise<unknown> }[] } };
          canUseTool(name: string, args: Record<string, unknown>, options: { toolUseID: string }): Promise<{ behavior: string }>;
        };
        const handoff = sdk.mcpServers.flujo.tools.find(tool => tool.name.startsWith('handoff_to_'))!;
        expect(handoff).toBeDefined();
        expect(await sdk.canUseTool(`mcp__flujo__${handoff.name}`, {}, { toolUseID: 'handoff-fixture-1' }))
          .toMatchObject({ behavior: 'allow' });
        const sdkArgs: Record<string, unknown> = {};
        const pendingHandoff = handoff.handler(sdkArgs);
        sdkArgs.prompt = 'late-sdk-mutation';
        await pendingHandoff;
        expect(child.exitCode).toBeNull();
        const requested = (await ledger()).reservations[0];
        expect(requested.state).not.toBe('released');
        expect(requested.handoff).toMatchObject({ state: 'requested', toolInvocationIds: ['handoff-fixture-1'] });
        await afterHandoffStop?.();
        yield { type: 'assistant', uuid: 'post-handoff', message: { role: 'assistant', content: [{ type: 'text', text: 'must not route before close' }] } };
        return;
      }
      yield { type: 'result', subtype: 'success', result: 'done', session_id: 'offline-fixture',
        num_turns: 1, total_cost_usd: 0.012, duration_ms: 19, usage: { input_tokens: 7, output_tokens: 4 } };
    })();
    return Object.assign(stream, { close });
  });
});
afterEach(async () => {
  for (const child of children) child.kill('SIGKILL');
  stopPersonaGoalRuntime();
  if (previousData === undefined) delete process.env.FLUJO_DATA_DIR; else process.env.FLUJO_DATA_DIR = previousData;
  await fs.rm(directory, { recursive: true, force: true });
});

async function withClaim(task: (input: FlowRunInput, goalId: string) => Promise<void>,
  after?: (personaId: string, goalId: string) => Promise<void>, production: false | 'no-handoff' | 'handoff' | 'handoff-refusal' = false) {
  await runWithWorkspace(`native-host-${process.pid}-${++sequence}`, async () => {
    stopPersonaGoalRuntime();
    let roleVersionId: string | undefined;
    if (production === 'no-handoff') {
      await ensureTestRole();
      const version = buildTestRoleVersion();
      version.id = 'rolever_native_no_handoff_v2';
      version.version = 2;
      // A separately authored frozen root Core with a terminal Process. Never
      // strip handoff tools from a dispatched plan or weaken broker admission.
      const core = version.coreFlowTemplate!;
      core.nodes = core.nodes.filter(node => node.data.type !== 'finish');
      core.edges = core.edges.filter(edge => edge.target !== 'test_core_finish');
      roleVersionId = (await createRoleVersion(version)).id;
    }
    const { persona } = await createPersonaFromRole({ name: 'Native host fixture', idempotencyKey: 'native-host-persona', autonomyLevel: 'locked', roleVersionId });
    const goal = await createPersonaWorkItem({ personaId: persona.id, title: 'Offline host contract',
      goal: { successCriteria: 'Offline lifecycle proof', continuationIntervalMs: 10000 } });
    const dispatchId = personaFlowDispatchId(persona.id, 'native-host-round');
    await savePersonaWorkItem({ ...goal, goal: { ...goal.goal!, rounds: 1, roundsInWindow: 1,
      pendingTaskId: goal.id, pendingDispatchId: dispatchId, pendingAttemptKey: 'native-host-round',
      pendingPrompt: 'Offline fixture only', pendingPriority: 'normal' } });
    let observed = false;
    let failure: unknown;
    const dispatcher = new PersonaFlowDispatcher({ dependencies: { runFlow: async input => {
      observed = true;
      try {
        await task(input, goal.id);
        if (production) {
          const result = await runFlow(input);
          expect(result.status).toBe(production === 'handoff-refusal' ? 'error' : 'completed');
          return result;
        }
      } catch (error) { failure = error; }
      return { status: production ? 'error' : 'completed', conversationId: input.conversationId!, runId: input.runId!,
        outputText: 'fixture', messages: [], sharedState: {} as SharedState } satisfies FlowRunResult;
    } } });
    try {
      await dispatcher.submit({ personaId: persona.id, idempotencyKey: 'native-host-round', kind: 'assignment',
        source: { kind: 'assignment', sourceId: goal.id }, flowInput: { source: 'internal', prompt: 'offline fixture', mode: 'conversation', requireApproval: false, onApprovalRequired: 'fail' } },
      { startPump: false });
      if (production === 'handoff-refusal') {
        try { await dispatcher.pump(persona.id); }
        catch (error) { expect(error).toMatchObject({ code: 'PERSONA_GOAL_NOT_CURRENT' }); }
      } else await dispatcher.pump(persona.id);
      expect(observed).toBe(true);
      if (failure) {
        if (production === 'handoff-refusal') expect(failure).toMatchObject({ code: 'PERSONA_GOAL_NOT_CURRENT' });
        else throw failure;
      }
      await after?.(persona.id, goal.id);
    } finally { await dispatcher.quiesce(persona.id); }
  });
}

async function prepare(input: FlowRunInput, observeSession?: (session: NativeInvocationSession) => Promise<void>) {
  const node = input.flowDefinition!.nodes.find(value => value.data.type === 'process')!;
  const state = { conversationId: input.conversationId!, logicalRunId: input.runId!, flowId: input.flowDefinition!.id,
    flowSnapshot: input.flowDefinition!, currentNodeId: node.id, source: 'api', status: 'running', runDepth: 0,
    createdAt: Date.now(), updatedAt: Date.now(), messages: [], personaAttribution: input.personaAttribution } as unknown as SharedState;
  await saveCollectionItem('conversations', state.conversationId!, state);
  Object.defineProperty(state, 'executionAuthority', { value: input.executionAuthority, enumerable: false });
  FlowExecutor.conversationStates.set(state.conversationId!, state);
  const host = await createPersonaNativeOriginalHost({ authority: input.executionAuthority,
    conversationId: input.conversationId, runId: input.runId, nodeId: node.id,
    modelId: node.data.properties!.boundModel as string });
  const sessionHook = observeSession ? createNativeInvocationSessionHook({ ...host!.session,
    publish: async value => { await host!.session.publish(value); await observeSession(value); } }) : host!.session;
  const invoke = () => (ModelHandler as unknown as { generateCompletion: (...args: unknown[]) => Promise<{ success: boolean }> })
    .generateCompletion('model-test', '', [{ id: 'user-fixture', role: 'user', content: 'offline', timestamp: 1 }], [], {
      conversationId: input.conversationId, runId: input.runId, nodeId: node.id, archiveModelTurns: true, maxTurns: 3,
      nativeBrokerAuthority: host!.broker, nativeInvocationSessionHook: sessionHook, nativeOriginalProcessHost: host!.process,
      durableContext: { executionAuthority: input.executionAuthority, personaAttribution: input.personaAttribution },
      signal: input.executionAuthority!.signal,
    });
  return { host: host!, invoke, node, state };
}
async function ledger() {
  const folder = path.join(getWorkspaceDataDir(), 'db', 'native-session-origins', 'host-ledger');
  const files = await fs.readdir(folder);
  return JSON.parse(await fs.readFile(path.join(folder, files.find(file => file.endsWith('.json'))!), 'utf8'));
}

/** Deterministic trusted-adapter enrollment records; no cloud Worker, account
 * or live provider is present. Source context, journals and child are real. */
async function withWorkerClaim(task: (input: {
  host: NonNullable<Awaited<ReturnType<typeof createWorkerNativeOriginalHost>>>;
  invoke: () => Promise<{ success: boolean }>;
  autoInvoke: () => Promise<{ success: boolean }>;
  enrollment: { active: boolean; root: ExecutionNativeWorkerRoot };
  context: ReturnType<typeof createExecutionExtensionContext>;
  state: SharedState;
  workerLedger: () => Promise<{ version: number; kind: string; workerId: string; reservations: Record<string, unknown>[] }>;
}) => Promise<void>) {
  await runWithWorkspace(`native-worker-${process.pid}-${++sequence}`, async () => {
    selectedModel = { ...modelFixture, name: 'gpt-6-luna', provider: 'codex', adapter: 'codex-cli', ApiKey: '', reasoningEffort: 'medium' };
    const flow = { id: 'flow-worker-owned', name: 'Owned Worker fixture', nodes: [{ id: 'node-worker-owned',
      position: { x: 0, y: 0 }, data: { type: 'process', name: 'Worker', properties: { boundModel: 'model-test', maxTurns: 3 } } }], edges: [] } as unknown as NonNullable<SharedState['flowSnapshot']>;
    const state = { conversationId: 'worker-root-conversation', logicalRunId: 'worker-logical-run', flowId: flow.id,
      flowSnapshot: flow, currentNodeId: 'node-worker-owned', source: 'api', status: 'running', runDepth: 0,
      createdAt: Date.now(), updatedAt: Date.now(), messages: [] } as unknown as SharedState;
    const enrollment = { active: true, root: { version: 1, workerId: 'worker-enrolled-fixture', goalId: 'goal-worker-fixture',
      fleetRunId: 'fleet-root-fixture', rootConversationId: state.conversationId!, logicalRunId: state.logicalRunId!,
      workspace: `native-worker-${process.pid}-${sequence}`, targetDigest: 'a'.repeat(64), flowDigest: nativeDigest(flow),
      leaseEpoch: 'source-worker-lease-fixture', modelId: 'model-test', modelDigest: nativeDigest({
        id: selectedModel.id, name: selectedModel.name, adapter: selectedModel.adapter, provider: selectedModel.provider,
        maxTurns: selectedModel.maxTurns, temperature: selectedModel.temperature, reasoningEffort: selectedModel.reasoningEffort,
        fallbackPolicy: selectedModel.fallbackPolicy,
      }) } satisfies ExecutionNativeWorkerRoot };
    const assertCurrent = async () => { if (!enrollment.active) throw new Error('Fixture Worker admission revoked'); };
    const adapter: ExecutionExtensionAdapter = {
      isProtectedServer: () => false, assertServerConfig: () => {}, assertRun: assertCurrent,
      bindRun: async () => {}, signal: () => controller.signal,
      commit: async (_context, mutation) => { await assertCurrent(); return mutation(); },
      protectedServer: () => 'fixture-worker', authorizeHandoffs: () => {}, assertModelTool: assertCurrent,
      assertDispatch: assertCurrent, normalizeArguments: (_context, _tool, args) => args,
      requestMeta: async () => ({}), validateResult: (_context, _tool, result) => result,
      nativeWorkerRoot: async () => { await assertCurrent(); return structuredClone(enrollment.root); },
    };
    const controller = new AbortController();
    const restore = registerExecutionExtension(adapter);
    const context = createExecutionExtensionContext(adapter, enrollment);
    Object.defineProperty(state, 'executionExtensionContext', { value: context, enumerable: false, configurable: true });
    state.executionExtensionOwned = true;
    await saveCollectionItem('conversations', state.conversationId!, state);
    FlowExecutor.conversationStates.set(state.conversationId!, state);
    try {
      const host = (await createWorkerNativeOriginalHost({ context, conversationId: state.conversationId,
        runId: state.logicalRunId, nodeId: 'node-worker-owned', modelId: 'model-test' }))!;
      expect(host).toBeDefined();
      const invoke = () => runWithExecutionInput({ executionExtensionContext: context, conversationId: state.conversationId,
        runId: state.logicalRunId }, () => (ModelHandler as unknown as { generateCompletion: (...args: unknown[]) => Promise<{ success: boolean }> })
        .generateCompletion('model-test', '', [{ id: 'worker-user-fixture', role: 'user', content: 'offline', timestamp: 1 }], [], {
          conversationId: state.conversationId, runId: state.logicalRunId, nodeId: 'node-worker-owned', archiveModelTurns: true, maxTurns: 3,
          nativeBrokerAuthority: host.broker, nativeInvocationSessionHook: host.session, nativeOriginalProcessHost: host.process,
          executionExtensionContext: context, durableContext: { executionExtensionContext: context }, signal: controller.signal,
        }));
      const workerLedger = async () => {
        const folder = path.join(getWorkspaceDataDir(), 'db', 'native-session-origins', 'worker-host-ledger');
        const files = await fs.readdir(folder);
        return JSON.parse(await fs.readFile(path.join(folder, files.find(file => file.endsWith('.json'))!), 'utf8'));
      };
      const autoInvoke = () => runWithExecutionInput({ executionExtensionContext: context, conversationId: state.conversationId,
        runId: state.logicalRunId }, () => ModelHandler.callModel({ modelId: 'model-test', prompt: '',
          messages: [{ id: 'worker-auto-fixture', role: 'user', content: 'automatic offline Source host', timestamp: 1 }], tools: [],
          conversationId: state.conversationId, runId: state.logicalRunId, nodeId: 'node-worker-owned',
          executionExtensionContext: context, archiveModelTurns: true, maxTurns: 3, unattended: true,
          iteration: 1, maxIterations: 3, nodeName: 'Worker',
        }));
      await task({ host, invoke, autoInvoke, enrollment, context, state, workerLedger });
    } finally { restore(); FlowExecutor.conversationStates.delete(state.conversationId!); }
  });
}

describe('Worker roots from trusted Source execution contexts / offline model edge', () => {
  it('forwards the actual Worker context from its Original broker into MCP dispatch', async () => {
    await withWorkerClaim(async ({ host, context, state }) => {
      const tools=[{type:'function' as const,function:{name:'owned_worker_read',parameters:{type:'object',properties:{}}}}];
      const mapping={owned_worker_read:{server:'fixture-worker',tool:'worker_read_file',clientGeneration:7,schemaHash:'fixture-schema'}};
      const receipt=await prepareNativeInvocation({conversationId:state.conversationId!,runId:state.logicalRunId!,nodeId:'node-worker-owned',
        modelId:'model-test',leaseEpoch:host.broker.leaseEpoch,inventoryDigest:nativeToolInventoryDigest(tools,mapping),inputDigest:'fixture',attemptOrdinal:1});
      await submitNativeInvocation(receipt);
      const callTool=jest.fn(async(...args:unknown[])=>{expect(args[10]).toBe(context);return {success:true,data:{content:[{type:'text',text:'fixture'}]}};});
      const service={getClient:()=>({}),getClientGeneration:()=>7,getToolSchemaHash:()=> 'fixture-schema',callTool} as unknown as Parameters<typeof createNativeToolPort>[0]['service'];
      const input={receipt,tools,toolNameMap:mapping,service,signal:new AbortController().signal,
        authority:createNativeBrokerAuthority(host.broker.leaseEpoch,async()=>{}),originalProcessHost:host.process,executionExtensionContext:context};
      expect(()=>createNativeToolPort({...input,executionExtensionContext:{} as never})).toThrow('held');
      const port=createNativeToolPort(input);
      const result=await port.dispatch({toolInvocationId:'fixture-context-forward',name:'owned_worker_read',args:{path:'repo/file'},signal:input.signal});
      expect(result.result.isError).not.toBe(true);expect(callTool).toHaveBeenCalledTimes(1);expect(promptCount).toBe(0);
    });
  },30000);
  it('acquires the Worker host through production callModel instead of caller-supplied native capabilities', async () => {
    await withWorkerClaim(async ({ autoInvoke, workerLedger }) => {
      expect(await autoInvoke()).toMatchObject({ success: true });
      expect(promptCount).toBe(1);
      expect((await workerLedger()).reservations[0]).toMatchObject({ state: 'released', sdkOutcome: 'completed', exit: { code: 0, signal: null } });
    });
  }, 30000);
  it('uses actual Worker lineage and its separate journal with no Persona attribution', async () => {
    await withWorkerClaim(async ({ host, invoke, context, workerLedger }) => {
      assertNativeOriginalExecutionContext(host.process, context);
      expect(() => assertNativeOriginalExecutionContext(host.process)).toThrow('held');
      expect(() => assertNativeOriginalExecutionContext(host.process, {} as never)).toThrow('held');
      const result = await invoke();
      if (!result.success) throw new Error(JSON.stringify(result));
      expect(result).toMatchObject({ success: true });
      expect(promptCount).toBe(1);
      const saved = await workerLedger();
      expect(saved).toMatchObject({ version: 2, kind: 'worker', workerId: 'worker-enrolled-fixture',
        reservations: [{ state: 'released', sdkOutcome: 'completed', exit: { code: 0, signal: null } }] });
      const reservation = saved.reservations[0];
      const origin = JSON.parse(await fs.readFile(path.join(getWorkspaceDataDir(), 'db', 'native-session-origins',
        `${reservation.invocationId}.json`), 'utf8'));
      expect(origin.descriptor.lineage).toMatchObject({ workerId: 'worker-enrolled-fixture', goalId: 'goal-worker-fixture',
        fleetRunId: 'fleet-root-fixture', rootConversationId: 'worker-root-conversation' });
      await expect(fs.access(path.join(getWorkspaceDataDir(), 'db', 'native-session-origins', 'host-ledger')))
        .rejects.toMatchObject({ code: 'ENOENT' });
    });
  }, 30000);
  it.each(['revoked', 'target-drift'] as const)('refuses first prompt after %s and retains the Original hold', async condition => {
    await withWorkerClaim(async ({ invoke, enrollment, workerLedger }) => {
      beforePrompt = async () => {
        if (condition === 'revoked') enrollment.active = false;
        else enrollment.root.targetDigest = 'b'.repeat(64);
      };
      expect((await invoke()).success).toBe(false);
      expect(promptCount).toBe(0);
      expect((await workerLedger()).reservations[0].state).not.toBe('released');
    });
  }, 30000);
  it('refuses caller contexts, child root relabeling and changed model attestations before an SDK child', async () => {
    await withWorkerClaim(async ({ enrollment, context, state }) => {
      const input = { context, conversationId: state.conversationId, runId: state.logicalRunId,
        nodeId: 'node-worker-owned', modelId: 'model-test' };
      await expect(createWorkerNativeOriginalHost({ ...input, context: {} as never })).rejects.toThrow('trusted_execution_context_required');
      state.runDepth = 1;
      await expect(createWorkerNativeOriginalHost(input)).rejects.toThrow('execution_native_worker_child_invalid');
      state.runDepth = 0;
      enrollment.root.modelDigest = '0'.repeat(64);
      await expect(createWorkerNativeOriginalHost(input)).rejects.toThrow('execution_native_worker_root_invalid');
      expect(promptCount).toBe(0);
    });
  }, 30000);
});

describe('Original host with real Persona lease and actual child / offline SDK edge', () => {
  function selectCodex(){selectedModel={...modelFixture,name:'gpt-6-luna',provider:'codex',adapter:'codex-cli',ApiKey:'',reasoningEffort:'medium'};}
  it('does not recover private Source readers from serialized or caller-owned hosts', () => {
    for (const value of [{}, { readOrigin: async () => ({}) }, JSON.parse('{"identity":{"pid":1}}')]) {
      expect(() => nativeOriginalSourceReader(value)).toThrow('held');
    }
  });
  it.each(['codex', 'claude'] as const)('retains the exact %s Original child and rereads durable terminal evidence', async adapter => {
    if (adapter === 'codex') selectCodex();
    await withClaim(async input => {
      let original!: NativeInvocationSession;
      const prepared = await prepare(input, async value => {
        original = value;
        const source = nativeOriginalSourceReader(prepared.host.process);
        const descriptor = value.descriptor;
        expect(await source.readOrigin(descriptor.receipt.invocationId)).toEqual(descriptor);
        expect((await source.readPayload(descriptor.payloadRef)).invocationId).toBe(descriptor.receipt.invocationId);
        await expect(source.readPayload({ ...descriptor.payloadRef, sha256: '0'.repeat(64) })).rejects.toThrow('held');
        await expect(source.readOrigin('foreign-original')).rejects.toThrow('held');
        expect(await source.assertPublishable({ session: value, descriptor,
          invocationId: descriptor.receipt.invocationId, stage: 'grant', signal: input.executionAuthority!.signal,
          deadlineAt: Date.now() + 120000, actor: descriptor.lineage })).toBe(true);
      });
      const source = nativeOriginalSourceReader(prepared.host.process);
      jest.isolateModules(() => {
        const isolated = require('@/backend/execution/flow/handlers/nativeOriginalHost') as typeof import('@/backend/execution/flow/handlers/nativeOriginalHost');
        expect(isolated.nativeOriginalSourceReader(prepared.host.process)).toBe(source);
        expect(() => isolated.nativeOriginalSourceReader({ ...prepared.host.process })).toThrow('held');
      });
      const hostGeneration = Object.freeze({ nonce: 'offline-controller-generation' });
      let handle!: object;
      let owner!: Record<string, unknown>;
      let expected!: Parameters<typeof source.readTerminal>[1];
      afterPrompt = async () => {
        const descriptor = original.descriptor;
        owner = { invocationId: descriptor.receipt.invocationId, workerId: descriptor.lineage.workerId,
          goalId: descriptor.lineage.goalId, fleetRunId: descriptor.lineage.fleetRunId,
          rootConversationId: descriptor.lineage.rootConversationId, workspace: descriptor.lineage.workspace,
          conversationId: descriptor.receipt.owner.conversationId, logicalRunId: descriptor.receipt.owner.runId,
          nodeId: descriptor.receipt.owner.nodeId,
          generation: `source-${nativeDigest([descriptor.lineage.installationId, descriptor.receipt.owner.leaseEpoch])}` };
        expected = { expectedOwner: descriptor.receipt.owner, expectedLineageDigest: descriptor.lineage.digest,
          expectedDescriptorDigest: nativeDigest(descriptor), expectedWorkspace: descriptor.lineage.workspace };
        await expect(source.retainLive(original, { ...owner, workerId: 'foreign-worker' }, hostGeneration)).rejects.toThrow('held');
        handle = (await source.retainLive(original, owner, hostGeneration)).handle;
        expect(await source.probeLive(handle, { ...owner }, hostGeneration)).toBe(handle);
        expect(await source.probeLive(JSON.parse(JSON.stringify(handle)), owner, hostGeneration)).toBeNull();
        expect(await source.probeLive(handle, { ...owner, nodeId: 'foreign-node' }, hostGeneration)).toBeNull();
        expect(await source.probeLive(handle, owner, { ...hostGeneration })).toBeNull();
        await expect(source.retainLive(original, owner, { ...hostGeneration })).rejects.toThrow('held');
        await expect(source.readTerminal(descriptor.receipt.invocationId, expected)).rejects.toThrow('held');
      };
      try {
        expect((await prepared.invoke()).success).toBe(true);
        expect(handle).toBeDefined();
        expect(await source.probeLive(handle, owner, hostGeneration)).toBeNull();
        expect(await source.readTerminal(original.descriptor.receipt.invocationId, expected))
          .toMatchObject({ receipt: { state: 'terminal', outcome: 'completed' }, holdAbsent: true,
            effectsResolved: true, cancelResolved: true });
        await expect(source.readTerminal(original.descriptor.receipt.invocationId,
          { ...expected, expectedWorkspace: 'foreign-workspace' })).rejects.toThrow('held');
      } finally { FlowExecutor.conversationStates.delete(prepared.state.conversationId!); }
    });
  }, 60000);
  it('keeps a cancelled Codex Original held instead of inferring terminal from process teardown', async () => {
    selectCodex();
    await withClaim(async input => {
      let original!: NativeInvocationSession;
      const prepared = await prepare(input, async value => { original = value; });
      const source = nativeOriginalSourceReader(prepared.host.process);
      afterPrompt = async () => { original.cancel(); };
      try {
        expect((await prepared.invoke()).success).toBe(false);
        const descriptor = original.descriptor;
        expect((await ledger()).reservations[0].state).not.toBe('released');
        await expect(source.readTerminal(descriptor.receipt.invocationId, {
          expectedOwner: descriptor.receipt.owner, expectedLineageDigest: descriptor.lineage.digest,
          expectedDescriptorDigest: nativeDigest(descriptor), expectedWorkspace: descriptor.lineage.workspace,
        })).rejects.toThrow();
      } finally { FlowExecutor.conversationStates.delete(prepared.state.conversationId!); }
    });
  }, 30000);
  it('runs a Codex Core through its saved Original, owned app-server child, actual usage and terminal release',async()=>{
    selectCodex();await withClaim(async()=>{},async()=>{
      expect(promptCount).toBe(1);const reservation=(await ledger()).reservations[0];
      expect(reservation).toMatchObject({state:'released',sdkOutcome:'completed',exit:{code:0,signal:null},
        sdkUsage:{source:'codex-app-server-usage',appServerTurns:1,inputTokens:7,outputTokens:4,cacheReadTokens:2}});
      expect(reservation.sdkUsage.totalCostUsd).toBeUndefined();expect(reservation.identity.processBirthMarkerV2).toBeDefined();
      expect(reservation.sdkUsage.cacheCreationTokens).toBeUndefined();
    },'no-handoff');
  },30000);
  it('confirms Codex routing only after the Original child exits and its inherited output pipe closes',async()=>{
    selectCodex();emitHandoff=true;await withClaim(async()=>{},async()=>{
      expect(promptCount).toBe(1);expect((await ledger()).reservations[0]).toMatchObject({state:'released',sdkOutcome:'completed',
        handoff:{protocol:'owned-codex-app-server-exit-close-v1',state:'confirmed',toolInvocationIds:['offline-code-call-1']}});
    },'handoff');
  },30000);
  it('holds a Codex Original and rejects late provider output after its genuine Persona goal pauses',async()=>{
    selectCodex();await withClaim(async(input,goalId)=>{
      afterPrompt=async()=>{const goal=(await getPersonaWorkItem(input.personaAttribution!.personaId,goalId))!;
        await savePersonaWorkItem({...goal,goal:{...goal.goal!,state:'paused'}});};
    },async()=>{const reservation=(await ledger()).reservations[0];expect(promptCount).toBe(1);
      expect(reservation.state).not.toBe('released');expect(reservation.sdkUsage).toBeUndefined();
    },'handoff-refusal');
  },30000);
  it('discards late SDK transcript and usage after a genuine Persona goal loses authority', async () => {
    transcriptText = 'late-private-persona-transcript';
    lateResultFirst = true;
    const events: string[] = [];
    const unsubscribe = executionEventBus.subscribeGlobal(({ event }) => events.push(JSON.stringify(event)));
    try {
    await withClaim(async (input, goalId) => {
      afterPrompt = async () => {
        expect(promptCount).toBe(1);
        expect((await ledger()).reservations[0].state).toBe('registered');
        const goal = (await getPersonaWorkItem(input.personaAttribution!.personaId, goalId))!;
        await savePersonaWorkItem({ ...goal, goal: { ...goal.goal!, state: 'paused' } });
      };
    }, async () => {
      expect(promptCount).toBe(1);
      const reservation = (await ledger()).reservations[0];
      expect(reservation.state).not.toBe('released');
      expect(reservation.sdkUsage).toBeUndefined();
      expect(offeredLateUsage).toMatchObject({ type: 'result', result: transcriptText,
        usage: { input_tokens: 7, output_tokens: 4 }, total_cost_usd: 0.012 });
      expect(events.join('\n')).not.toContain(transcriptText);
      const saved = await loadCollectionItem<SharedState | undefined>('conversations', reservation.owner.conversationId, undefined);
      expect(saved).toBeDefined();
      expect(JSON.stringify(saved!.messages)).not.toContain(transcriptText);
      const archive = path.join(getWorkspaceDataDir(), 'db', 'model-turns', reservation.owner.conversationId);
      const immutable = JSON.parse(gunzipSync(await fs.readFile(path.join(archive, `${reservation.invocationId}.v2.json.gz`))).toString('utf8'));
      expect(immutable.entry.outcome).toBe('running');
      await expect(fs.access(path.join(archive, `${reservation.invocationId}.outcome.json`))).rejects.toMatchObject({ code: 'ENOENT' });
      const holdId = createHash('sha256').update(JSON.stringify(reservation.owner.conversationId)).digest('hex');
      expect(JSON.parse(await fs.readFile(path.join(getWorkspaceDataDir(), 'db', 'native-tool-journal',
        'holds', `${holdId}.json`), 'utf8'))).toMatchObject({ invocationId: reservation.invocationId });
    }, 'handoff-refusal');
    } finally { unsubscribe(); }
  }, 30000);
  it('runs the production Core dispatch through ProcessNode and V2 saved Original to actual child release', async () => {
    await withClaim(async () => {
      beforePrompt = async () => {
        expect(['accepted', 'registered']).toContain((await ledger()).reservations[0].state);
      };
    }, async () => {
      expect(promptCount).toBe(1);
      expect(queryMock).toHaveBeenCalledTimes(1);
      const reservation = (await ledger()).reservations[0];
      expect(reservation).toMatchObject({ state: 'released', exit: { code: 0, signal: null } });
      const original = JSON.parse(await fs.readFile(path.join(getWorkspaceDataDir(), 'db',
        'native-session-origins', `${reservation.invocationId}.json`), 'utf8'));
      expect(original.descriptor.archive.archiveVersion).toBe(2);
      const archiveDir = path.join(getWorkspaceDataDir(), 'db', 'model-turns', reservation.owner.conversationId);
      const immutable = JSON.parse(gunzipSync(await fs.readFile(path.join(archiveDir,
        `${reservation.invocationId}.v2.json.gz`))).toString('utf8'));
      expect(immutable).toMatchObject({ version: 2, entry: { archiveVersion: 2, outcome: 'running' } });
      expect(JSON.parse(await fs.readFile(path.join(archiveDir,
        `${reservation.invocationId}.outcome.json`), 'utf8'))).toMatchObject({
        archiveVersion: 2, dispatchId: reservation.invocationId, outcome: 'completed' });
    }, 'no-handoff');
  }, 30000);

  it('routes an ordinary Core handoff only after the original owned SDK child exits and its pipes close', async () => {
    emitHandoff = true;
    afterHandoffStop = async () => {
      const child = children[0];
      if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
      expect(child.stdout.readableEnded).toBe(false);
      const reservation = (await ledger()).reservations[0];
      expect(reservation.state).not.toBe('released');
      expect(reservation.handoff.state).toBe('requested');
      const folder = path.join(getWorkspaceDataDir(), 'db', 'native-tool-journal', 'tools', reservation.invocationId);
      const [file] = await fs.readdir(folder);
      expect(JSON.parse(await fs.readFile(path.join(folder, file), 'utf8')).state).toBe('effect-unknown');
    };
    await withClaim(async () => undefined, async () => {
      expect(promptCount).toBe(1);
      expect(queryMock).toHaveBeenCalledTimes(1);
      const reservation = (await ledger()).reservations[0];
      expect(reservation).toMatchObject({ state: 'released', exit: { code: 0, signal: null },
        sdkOutcome: 'completed', handoff: { protocol: 'owned-claude-exit-close-v1',
          state: 'confirmed', toolInvocationIds: ['handoff-fixture-1'] } });
      const tools = path.join(getWorkspaceDataDir(), 'db', 'native-tool-journal', 'tools', reservation.invocationId);
      const records = await fs.readdir(tools);
      expect(records).toHaveLength(1);
      expect(JSON.parse(await fs.readFile(path.join(tools, records[0]), 'utf8')))
        .toMatchObject({ state: 'terminal', result: { kind: 'handoff' } });
      const saved = await loadCollectionItem<SharedState | undefined>('conversations', reservation.owner.conversationId, undefined);
      expect(saved).toBeDefined();
      expect(JSON.stringify(saved!.messages)).not.toContain('late-sdk-mutation');
    }, 'handoff');
  }, 30000);

  it('retains unresolved handoff and Original holds when the goal is revoked before process-close confirmation', async () => {
    emitHandoff = true;
    await withClaim(async (input, goalId) => {
      afterHandoffStop = async () => {
        const goal = (await getPersonaWorkItem(input.personaAttribution!.personaId, goalId))!;
        await savePersonaWorkItem({ ...goal, goal: { ...goal.goal!, state: 'paused' } });
      };
    }, async () => {
      const reservation = (await ledger()).reservations[0];
      expect(reservation.state).not.toBe('released');
      expect(reservation.handoff.state).toBe('requested');
      const tools = path.join(getWorkspaceDataDir(), 'db', 'native-tool-journal', 'tools', reservation.invocationId);
      const records = await fs.readdir(tools);
      expect(JSON.parse(await fs.readFile(path.join(tools, records[0]), 'utf8')).state).toBe('effect-unknown');
      const holdId = createHash('sha256').update(JSON.stringify(reservation.owner.conversationId)).digest('hex');
      expect(JSON.parse(await fs.readFile(path.join(getWorkspaceDataDir(), 'db', 'native-tool-journal',
        'holds', `${holdId}.json`), 'utf8'))).toMatchObject({ invocationId: reservation.invocationId });
    }, 'handoff-refusal');
  }, 30000);

  it('durably binds acceptance and bounded turn reservation; waits for actual exit/close before release', async () => {
    await withClaim(async input => {
      const { host, invoke, state } = await prepare(input);
      try {
        beforePrompt = async () => {
          expect(promptCount).toBe(0);
          const reservation = (await ledger()).reservations[0];
          expect(['accepted', 'registered']).toContain(reservation.state);
          expect(reservation).toMatchObject({ modelId: 'model-test', maxTurns: 3 });
        };
        expect((await invoke()).success).toBe(true);
        expect(promptCount).toBe(1);
        const reservation = (await ledger()).reservations[0];
        expect(reservation).toMatchObject({ state: 'released', exit: { code: 0, signal: null },
          sdkUsage: { source: 'claude-sdk-result', numTurns: 1, inputTokens: 7, outputTokens: 4, totalCostUsd: 0.012 } });
        expect(reservation.identity.processBirthMarkerV2).toMatch(/-v2:/);
        expect(JSON.stringify(reservation)).not.toContain('offline-fixture-token');
        await expect(host.process.register({} as never)).rejects.toThrow('registration');
        // Same original input/attempt cannot be replayed even after completion.
        const fresh = await prepare(input);
        expect((await fresh.invoke()).success).toBe(false);
        expect(queryMock).toHaveBeenCalledTimes(1);
      } finally { FlowExecutor.conversationStates.delete(state.conversationId!); }
    });
  }, 30000);

  it('rejects caller lookalikes and parent/model drift without issuing an SDK child', async () => {
    expect(await createPersonaNativeOriginalHost({ authority: { signal: new AbortController().signal,
      assertCurrent: async () => {}, commitWhileCurrent: async task => task() }, modelId: 'model-test' })).toBeUndefined();
    await withClaim(async input => {
      const { node, state } = await prepare(input);
      try {
        await expect(createPersonaNativeOriginalHost({ authority: { signal: new AbortController().signal,
          assertCurrent: async () => {}, commitWhileCurrent: async task => task() }, modelId: 'model-test',
          personaAttribution: input.personaAttribution })).rejects.toThrow('held');
        for (const drift of [{ conversationId: 'foreign' }, { runId: 'foreign' }, { modelId: 'foreign' }, { nodeId: 'foreign' },
          { conversationId: 'child-conversation', authority: subflowExecutionAuthority(input.executionAuthority) }]) {
          await expect(createPersonaNativeOriginalHost({ authority: input.executionAuthority,
            conversationId: input.conversationId, runId: input.runId, nodeId: node.id, modelId: 'model-test', ...drift })).rejects.toThrow('held');
        }
        expect(queryMock).not.toHaveBeenCalled();
      } finally { FlowExecutor.conversationStates.delete(state.conversationId!); }
    });
  }, 30000);

  it('retains durable reservation and denies prompt when goal authority is revoked during registration', async () => {
    await withClaim(async (input, goalId) => {
      const { invoke, state } = await prepare(input);
      try {
        beforePrompt = async () => {
          await input.executionAuthority!.commitWhileCurrent!(async () => {
            const root = (await getPersonaWorkItem(input.personaAttribution!.personaId, goalId))!;
            await savePersonaWorkItem({ ...root, goal: { ...root.goal!, state: 'paused' }, updatedAt: Date.now() });
          });
        };
        expect((await invoke()).success).toBe(false);
        expect(promptCount).toBe(0);
        expect((await ledger()).reservations[0].state).not.toBe('released');
      } finally { FlowExecutor.conversationStates.delete(state.conversationId!); }
    });
  }, 30000);

  it('holds unqualified Codex credentials and rejects changed model budget before launch', async () => {
    await withClaim(async input => {
      const { invoke, node, state } = await prepare(input);
      try {
        selectedModel = { ...selectedModel, adapter: 'codex-cli' };
        await expect(createPersonaNativeOriginalHost({ authority: input.executionAuthority, conversationId: input.conversationId,
          runId: input.runId, nodeId: node.id, modelId: 'model-test' })).rejects.toThrow('held');
        selectedModel = { ...modelFixture, maxTurns: 4 };
        expect((await invoke()).success).toBe(false);
        expect(queryMock).not.toHaveBeenCalled();
        expect((await ledger()).reservations[0].state).toBe('accepted');
      } finally { FlowExecutor.conversationStates.delete(state.conversationId!); }
    });
  }, 30000);

  it('denies first prompt after a real child exits during asynchronous registration', async () => {
    await withClaim(async input => {
      const { invoke, state } = await prepare(input);
      try {
        beforePrompt = async () => {
          const child = children[0];
          const exit = new Promise<void>(resolve => child.once('exit', () => resolve()));
          child.stdin.end();
          await exit;
        };
        expect((await invoke()).success).toBe(false);
        expect(promptCount).toBe(0);
        expect(children[0].exitCode).toBe(0);
        expect((await ledger()).reservations[0].state).not.toBe('released');
      } finally { FlowExecutor.conversationStates.delete(state.conversationId!); }
    });
  }, 30000);

  it('retains refused reservation across a new dispatcher / goal round instead of issuing a successor', async () => {
    await withClaim(async input => {
      const { invoke, state } = await prepare(input);
      try {
        selectedModel = { ...modelFixture, maxTurns: 4 };
        expect((await invoke()).success).toBe(false);
        expect((await ledger()).reservations[0].state).toBe('accepted');
      } finally { FlowExecutor.conversationStates.delete(state.conversationId!); }
    }, async (personaId, goalId) => {
      selectedModel = { ...modelFixture };
      const dispatchId = personaFlowDispatchId(personaId, 'native-host-next-round');
      const root = (await getPersonaWorkItem(personaId, goalId))!;
      await savePersonaWorkItem({ ...root, status: 'open', goal: { ...root.goal!, state: 'active', rounds: 2,
        pendingTaskId: goalId, pendingDispatchId: dispatchId, pendingAttemptKey: 'native-host-next-round',
        pendingPrompt: 'offline successor', pendingPriority: 'normal' }, updatedAt: Date.now() });
      const runFlow = jest.fn(async input => ({ status: 'completed', conversationId: input.conversationId!,
        runId: input.runId!, outputText: 'unexpected', messages: [], sharedState: {} as SharedState } satisfies FlowRunResult));
      const restarted = new PersonaFlowDispatcher({ dependencies: { runFlow } });
      try {
        await restarted.submit({ personaId, idempotencyKey: 'native-host-next-round', kind: 'assignment',
          source: { kind: 'assignment', sourceId: goalId }, flowInput: { source: 'internal', prompt: 'offline successor' } }, { startPump: false });
        await restarted.pump(personaId);
        expect(runFlow).not.toHaveBeenCalled();
        expect(queryMock).not.toHaveBeenCalled();
        expect((await ledger()).reservations[0].state).toBe('accepted');
      } finally { await restarted.quiesce(personaId); }
    });
  }, 30000);

  it('rejects a destination hardlink replacement during atomic reservation without changing the external sentinel', async () => {
    await withClaim(async input => {
      const { invoke, state } = await prepare(input);
      const sentinel = path.join(directory, 'external-sentinel.json');
      await fs.writeFile(sentinel, '{"external":"unchanged"}');
      const open = fs.open.bind(fs);
      let replaced = false;
      const spy = jest.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args);
        const target = String(args[0]);
        if (target.includes('host-ledger') && target.endsWith('.tmp')) {
          const sync = handle.sync.bind(handle);
          handle.sync = async () => {
            await sync();
            const ledgerTarget = target.slice(0, target.lastIndexOf('.json') + 5);
            await fs.link(sentinel, ledgerTarget);
            replaced = true;
          };
        }
        return handle;
      });
      try {
        expect((await invoke()).success).toBe(false);
        expect(replaced).toBe(true);
        expect(queryMock).not.toHaveBeenCalled();
        expect(await fs.readFile(sentinel, 'utf8')).toBe('{"external":"unchanged"}');
        const folder = path.join(getWorkspaceDataDir(), 'db', 'native-session-origins', 'host-ledger');
        expect((await fs.readdir(folder)).filter(file => file.endsWith('.tmp'))).toEqual([]);
      } finally { spy.mockRestore(); FlowExecutor.conversationStates.delete(state.conversationId!); }
    });
  }, 30000);

  it('bounds persisted reservation history and holds an oversized ledger before another child launch', async () => {
    await withClaim(async input => {
      const { invoke, state } = await prepare(input);
      try {
        expect((await invoke()).success).toBe(true);
        const folder = path.join(getWorkspaceDataDir(), 'db', 'native-session-origins', 'host-ledger');
        const target = path.join(folder, (await fs.readdir(folder)).find(file => file.endsWith('.json'))!);
        const oversized = await ledger();
        oversized.reservations = Array.from({ length: 257 }, (_, index) => ({ ...oversized.reservations[0], invocationId: `history-${index}` }));
        await fs.writeFile(target, JSON.stringify(oversized));
        const fresh = await prepare(input);
        expect((await fresh.invoke()).success).toBe(false);
        expect(queryMock).toHaveBeenCalledTimes(1);
      } finally { FlowExecutor.conversationStates.delete(state.conversationId!); }
    });
  }, 30000);

  it('rechecks actual ledger lock ownership after the last awaited temp check and removes only its own refused temp', async () => {
    await withClaim(async input => {
      const { invoke, state } = await prepare(input);
      const lstat = fs.lstat.bind(fs);
      let revoked = false;
      const spy = jest.spyOn(fs, 'lstat').mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
        const stat = await lstat(...args);
        if (!revoked && String(args[0]).includes('host-ledger') && String(args[0]).endsWith('.tmp')) {
          const root = path.join(getWorkspaceDataDir(), 'db', '.runtime-locks', 'enduring-agents');
          const owned = (await fs.readdir(root)).find(file => file.startsWith('.native-original-') && file.endsWith('.lock'))!;
          await fs.unlink(path.join(root, owned));
          revoked = true;
        }
        return stat;
      });
      try {
        expect((await invoke()).success).toBe(false);
        expect(revoked).toBe(true);
        expect(queryMock).not.toHaveBeenCalled();
        const folder = path.join(getWorkspaceDataDir(), 'db', 'native-session-origins', 'host-ledger');
        expect(await fs.readdir(folder)).toEqual([]);
      } finally { spy.mockRestore(); FlowExecutor.conversationStates.delete(state.conversationId!); }
    });
  }, 30000);

  it('refuses late goal revocation and preserves a foreign replacement of the checked temporary path', async () => {
    await withClaim(async (input, goalId) => {
      const { invoke, state } = await prepare(input);
      const lstat = fs.lstat.bind(fs);
      let foreignPath: string | undefined;
      const spy = jest.spyOn(fs, 'lstat').mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
        const stat = await lstat(...args);
        const target = String(args[0]);
        if (!foreignPath && target.includes('host-ledger') && target.endsWith('.tmp')) {
          foreignPath = target;
          await fs.rename(target, `${target}.displaced`);
          await fs.writeFile(target, 'foreign replacement');
          const root = (await getPersonaWorkItem(input.personaAttribution!.personaId, goalId))!;
          await savePersonaWorkItem({ ...root, goal: { ...root.goal!, state: 'paused' }, updatedAt: Date.now() });
        }
        return stat;
      });
      try {
        expect((await invoke()).success).toBe(false);
        expect(foreignPath).toBeDefined();
        expect(queryMock).not.toHaveBeenCalled();
        expect(await fs.readFile(foreignPath!, 'utf8')).toBe('foreign replacement');
        const folder = path.join(getWorkspaceDataDir(), 'db', 'native-session-origins', 'host-ledger');
        expect((await fs.readdir(folder)).filter(file => file.endsWith('.json'))).toEqual([]);
      } finally { spy.mockRestore(); FlowExecutor.conversationStates.delete(state.conversationId!); }
    });
  }, 30000);
});
