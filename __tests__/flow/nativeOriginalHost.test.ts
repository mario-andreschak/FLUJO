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
  getModel: async () => selectedModel, resolveAndDecryptApiKey: async () => 'offline-fixture-token',
  loadModels: async () => [selectedModel],
} }));
jest.mock('@/backend/services/model/adapters', () => ({ getCompletionAdapter: () =>
  selectedModel.adapter === 'codex-cli'
    ? new (jest.requireActual<typeof import('@/backend/services/model/adapters/codexAdapter')>(
      '@/backend/services/model/adapters/codexAdapter').CodexAdapter)()
    : new (jest.requireActual<typeof import('@/backend/services/model/adapters/claudeSubscriptionAdapter')>(
      '@/backend/services/model/adapters/claudeSubscriptionAdapter').ClaudeSubscriptionAdapter)() }));
jest.mock('@openai/codex-sdk', () => ({ Codex: class {
  constructor() { throw new Error('Native ownership must not use the unowned SDK constructor'); }
} }), { virtual: true });
jest.mock('@/backend/services/model/adapters/codexAppServerProcess', () => {
  const actual = jest.requireActual<typeof import('@/backend/services/model/adapters/codexAppServerProcess')>(
    '@/backend/services/model/adapters/codexAppServerProcess');
  return { ...actual, startOwnedCodexAppServer: async (input: Parameters<typeof actual.startOwnedCodexAppServer>[0]) => {
    const wire = path.join(directory, 'codex-wire.jsonl');
    return actual.startOwnedCodexAppServer({ ...input, executable: process.execPath,
      args: ['-e', codexChildFixture, wire, codexForeignScope],
      register: async registration => { codexRegistrations.push(registration);
        let closeObserved = false;
        void registration.close.then(() => { closeObserved = true; });
        codexExitWitnesses.push(registration.exit.then(async () => {
          const pipeCloseObservedAtExit = closeObserved;
          const reservation = (await ledger()).reservations[0];
          return { pipeCloseObservedAtExit, stateAtExit: reservation.state };
        }));
        await input.register(registration); await beforePrompt?.(); },
      onNotification: message => {
        codexFrames.push(message);
        input.onNotification(message);
        if (message.method === 'turn/started') {
          void (async () => { await afterPrompt?.(); await fs.writeFile(`${wire}.events`, 'ready'); })();
        }
      },
    });
  } };
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
import { createPersonaNativeOriginalHost } from '@/backend/execution/flow/handlers/nativeOriginalHost';
import { subflowExecutionAuthority } from '@/backend/execution/flow/executionAuthority';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import { flowService } from '@/backend/services/flow';

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
let codexRegistrations: import('@/backend/services/model/adapters/codexAppServerProcess').CodexOwnedProcessRegistration[] = [];
let codexFrames: unknown[] = [];
let codexForeignScope = '';
let codexExitWitnesses: Array<Promise<{ pipeCloseObservedAtExit: boolean; stateAtExit: string }>> = [];
const codexChildFixture = `
const fs=require('node:fs'), readline=require('node:readline'), wire=process.argv[1];
process.stdin.on('end',()=>{
 require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},700)'],{stdio:['ignore',process.stdout,process.stderr],windowsHide:true});
 process.exit(0);
});
fs.writeFileSync(wire+'.environment',JSON.stringify({names:Object.keys(process.env), selectedKey:process.env.CODEX_API_KEY==='offline-fixture-token', managedHome:process.env.CODEX_HOME===process.env.HOME}));
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 fs.appendFileSync(wire,line+'\\n');const m=JSON.parse(line);if(!m.id)return;
 if(m.method==='initialize')send({id:m.id,result:{userAgent:'offline'}});
 else if(m.method==='thread/start')send({id:m.id,result:{model:m.params.model,thread:{id:'native_codex_thread'}}});
 else if(m.method==='turn/start'){
  let threadId=m.params.threadId,turnId='native_codex_turn';
  send({id:m.id,result:{turn:{id:turnId}}});send({method:'turn/started',params:{threadId,turn:{id:turnId}}});
  const tick=setInterval(()=>{if(!fs.existsSync(wire+'.events'))return;clearInterval(tick);
   if(process.argv[2]==='thread')threadId='foreign_thread';
   if(process.argv[2]==='turn')turnId='foreign_turn';
   send({method:'item/completed',params:{threadId,turnId,item:{id:'native_codex_item',type:'agentMessage',text:'offline codex done'}}});
   send({method:'thread/tokenUsage/updated',params:{threadId,turnId,tokenUsage:{total:{inputTokens:7,outputTokens:4,cachedInputTokens:0}}}});
   send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed'}}});
  },5);
 }
});`;
let observedPrompt: unknown;
let phaseStart: number | undefined;
function phase(name: string) {
  if (phaseStart !== undefined) console.info(JSON.stringify({ nativeOriginalHostPhase: name,
    elapsedMs: Math.round(performance.now() - phaseStart) }));
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-original-host-'));
  previousData = process.env.FLUJO_DATA_DIR;
  process.env.FLUJO_DATA_DIR = directory;
  selectedModel = { ...modelFixture };
  promptCount = 0; children = []; beforePrompt = undefined; emitHandoff = false; afterHandoffStop = undefined;
  afterPrompt = undefined; transcriptText = 'done';
  lateResultFirst = false; offeredLateUsage = undefined;
  observedPrompt = undefined;
  phaseStart = undefined;
  codexRegistrations = []; codexFrames = []; codexForeignScope = ""; codexExitWitnesses = [];
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
    phase('child spawned');
    const close = () => child.stdin.end();
    options.abortController.signal.addEventListener('abort', close, { once: true });
    const stream = (async function* () {
      await beforePrompt?.();
      observedPrompt = (await prompt[Symbol.asyncIterator]().next()).value;
      phase('prompt received');
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
  for (const registration of codexRegistrations) { registration.requestStop(); await registration.close; }
  stopPersonaGoalRuntime();
  if (previousData === undefined) delete process.env.FLUJO_DATA_DIR; else process.env.FLUJO_DATA_DIR = previousData;
  await fs.rm(directory, { recursive: true, force: true });
});

async function withClaim(task: (input: FlowRunInput, goalId: string) => Promise<void>,
  after?: (personaId: string, goalId: string) => Promise<void>, production: false | 'no-handoff' | 'handoff' | 'handoff-refusal' | 'child' | 'child-refusal' | 'no-handoff-refusal' = false) {
  await runWithWorkspace(`native-host-${process.pid}-${++sequence}`, async () => {
    phase('claim setup started');
    stopPersonaGoalRuntime();
    let roleVersionId: string | undefined;
    if (production === 'no-handoff' || production === 'no-handoff-refusal' || production === 'child' || production === 'child-refusal') {
      await ensureTestRole();
      const version = buildTestRoleVersion();
      version.id = 'rolever_native_no_handoff_v2';
      version.version = 2;
      // A separately authored frozen root Core with a terminal Process. Never
      // strip handoff tools from a dispatched plan or weaken broker admission.
      const core = version.coreFlowTemplate!;
      core.nodes = core.nodes.filter(node => node.data.type !== 'finish');
      core.edges = core.edges.filter(edge => edge.target !== 'test_core_finish');
      if (production === 'child' || production === 'child-refusal') {
        const child = structuredClone(core);
        child.id = 'native_pinned_child';
        child.name = 'Pinned native child';
        child.nodes.find(node => node.data.type === 'process')!.data.properties!.boundModel = 'model-test';
        expect((await flowService.saveFlow(child)).success).toBe(true);
        const call = core.nodes.find(node => node.data.type === 'process')!;
        call.type = 'subflow';
        call.data.type = 'subflow';
        call.data.properties = { subflowId: child.id, inputMode: 'isolated', promptTemplate: 'Offline child task' };
      }
      roleVersionId = (await createRoleVersion(version)).id;
      phase('role authored');
    }
    const { persona } = await createPersonaFromRole({ name: 'Native host fixture', idempotencyKey: 'native-host-persona', autonomyLevel: 'locked', roleVersionId });
    phase('persona created');
    const goal = await createPersonaWorkItem({ personaId: persona.id, title: 'Offline host contract',
      goal: { successCriteria: 'Offline lifecycle proof', continuationIntervalMs: 10000 } });
    phase('goal created');
    const dispatchId = personaFlowDispatchId(persona.id, 'native-host-round');
    await savePersonaWorkItem({ ...goal, goal: { ...goal.goal!, rounds: 1, roundsInWindow: 1,
      pendingTaskId: goal.id, pendingDispatchId: dispatchId, pendingAttemptKey: 'native-host-round',
      pendingPrompt: 'Offline fixture only', pendingPriority: 'normal' } });
    let observed = false;
    let failure: unknown;
    const dispatcher = new PersonaFlowDispatcher({ dependencies: { runFlow: async input => {
      phase('dispatcher entered');
      observed = true;
      try {
        await task(input, goal.id);
        phase('task assertions completed');
        if (production) {
          phase('production flow started');
          const result = await runFlow(input);
          phase('production flow completed');
          expect(result.status).toBe(production === 'handoff-refusal' || production === 'child-refusal' || production === 'no-handoff-refusal' ? 'error' : 'completed');
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
      phase('dispatch submitted');
      if (production === 'handoff-refusal' || production === 'no-handoff-refusal') {
        try { await dispatcher.pump(persona.id); }
        catch (error) { expect(error).toMatchObject({ code: 'PERSONA_GOAL_NOT_CURRENT' }); }
      } else await dispatcher.pump(persona.id);
      phase('dispatcher pump completed');
      expect(observed).toBe(true);
      if (failure) {
        if (production === 'handoff-refusal' || production === 'no-handoff-refusal') expect(failure).toMatchObject({ code: 'PERSONA_GOAL_NOT_CURRENT' });
        else throw failure;
      }
      await after?.(persona.id, goal.id);
    } finally { await dispatcher.quiesce(persona.id); phase('dispatcher quiesced'); }
  });
}

async function prepare(input: FlowRunInput) {
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
  const invoke = () => (ModelHandler as unknown as { generateCompletion: (...args: unknown[]) => Promise<{ success: boolean }> })
    .generateCompletion('model-test', '', [{ id: 'user-fixture', role: 'user', content: 'offline', timestamp: 1 }], [], {
      conversationId: input.conversationId, runId: input.runId, nodeId: node.id, archiveModelTurns: true, maxTurns: 3,
      nativeBrokerAuthority: host!.broker, nativeInvocationSessionHook: host!.session, nativeOriginalProcessHost: host!.process,
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

describe('Original host with real Persona lease and actual child / offline SDK edge', () => {
  it('runs a genuine Codex Original through its owned public app-server and releases only after exit and pipe close', async () => {
    selectedModel = { ...modelFixture, provider: 'codex-subscription', adapter: 'codex-cli' } as Model;
    const canaries = ['FLUJO_SNAPSHOT_CONTROL_TOKEN', 'FLUJO_PRIVATE_OWNER_GRANT', 'MCP_SECRET',
      'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS', 'NODE_PATH'];
    const previous = canaries.map(name => process.env[name]);
    for (const name of canaries) process.env[name] = 'offline-private-env-canary';
    // NODE_OPTIONS is deliberately syntactically valid: it must still be absent in the child.
    process.env.NODE_OPTIONS = '--no-warnings';
    try {
    await withClaim(async () => {}, async (_personaId, goalId) => {
      const environment = JSON.parse(await fs.readFile(path.join(directory, 'codex-wire.jsonl.environment'), 'utf8'));
      expect(environment).toMatchObject({ selectedKey: true, managedHome: true });
      for (const name of canaries) expect(environment.names).not.toContain(name);
      expect(queryMock).not.toHaveBeenCalled();
      expect(codexRegistrations).toHaveLength(1);
      expect(codexFrames).toEqual(expect.arrayContaining([expect.objectContaining({ method: 'turn/completed' })]));
      const saved = await ledger();
      expect(saved.goalId).toBe(goalId);
      expect(saved.reservations).toHaveLength(1);
      expect(saved.reservations[0]).toMatchObject({ state: 'released', sdkOutcome: 'completed',
        sdkUsage: { source: 'codex-app-server-turn', outerTurns: 1, inputTokens: 7, outputTokens: 4 },
        exit: { code: 0, signal: null } });
      expect(saved.reservations[0].identity.processBirthMarkerV2).toBeTruthy();
      expect(await codexExitWitnesses[0]).toMatchObject({ pipeCloseObservedAtExit: false });
      expect((await codexExitWitnesses[0]).stateAtExit).not.toBe('released');
      const wire = (await fs.readFile(path.join(directory, 'codex-wire.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(wire.map(message => message.method)).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start']);
    }, 'no-handoff');
    } finally { canaries.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index];
    }); }
  }, 30000);
  it.each(['before-prompt', 'after-prompt', 'foreign-thread', 'foreign-turn'])(
    'holds a real Codex Original for %s without accepting transcript, usage or release', async mode => {
      selectedModel = { ...modelFixture, provider: 'codex-subscription', adapter: 'codex-cli' } as Model;
      codexForeignScope = mode === 'foreign-thread' ? 'thread' : mode === 'foreign-turn' ? 'turn' : '';
      const events: string[] = [];
      const unsubscribe = executionEventBus.subscribeGlobal(({ event }) => events.push(JSON.stringify(event)));
      try {
        await withClaim(async (input, goalId) => {
          const revoke = async () => {
            expect((await ledger()).reservations[0].state).toBe('registered');
            const goal = (await getPersonaWorkItem(input.personaAttribution!.personaId, goalId))!;
            await savePersonaWorkItem({ ...goal, goal: { ...goal.goal!, state: 'paused' } });
          };
          if (mode === 'before-prompt') beforePrompt = revoke;
          if (mode === 'after-prompt') afterPrompt = revoke;
        }, async () => {
          expect(queryMock).not.toHaveBeenCalled();
          expect(codexRegistrations).toHaveLength(1);
          const reservation = (await ledger()).reservations[0];
          expect(reservation.state).not.toBe('released');
          expect(reservation.sdkUsage).toBeUndefined();
          expect(events.join('\n')).not.toContain('offline codex done');
          const saved = await loadCollectionItem<SharedState | undefined>('conversations', reservation.owner.conversationId, undefined);
          expect(JSON.stringify(saved?.messages)).not.toContain('offline codex done');
          if (mode === 'before-prompt') {
            await expect(fs.access(path.join(directory, 'codex-wire.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
          } else {
            expect(codexFrames).toEqual(expect.arrayContaining([expect.objectContaining({ method: 'item/completed',
              params: expect.objectContaining({ item: expect.objectContaining({ text: 'offline codex done' }) }) })]));
            const wire = await fs.readFile(path.join(directory, 'codex-wire.jsonl'), 'utf8');
            expect(wire).toContain('turn/start');
          }
        }, 'no-handoff-refusal');
      } finally { unsubscribe(); }
    }, 30000);
  it('admits a real attached child from the pinned root plan under the root goal and releases only after owned exit and close', async () => {
    let rootConversation: string | undefined;
    let rootRun: string | undefined;
    await withClaim(async input => {
      rootConversation = input.conversationId;
      rootRun = input.runId;
      expect(input.flowDefinition!.executionDependencies!.flows.map(entry => entry.flowId)).toContain('native_pinned_child');
      // A mutable saved child edit cannot revise the already captured round.
      const changed = structuredClone(input.flowDefinition!.executionDependencies!.flows[0].flowSnapshot);
      changed.nodes.find(node => node.data.type === 'process')!.data.properties!.promptTemplate = 'MUTABLE_CHILD_REVISION';
      expect((await flowService.saveFlow(changed)).success).toBe(true);
    }, async (_personaId, goalId) => {
      expect(promptCount).toBe(1);
      expect(JSON.stringify(observedPrompt)).not.toContain('MUTABLE_CHILD_REVISION');
      expect(queryMock).toHaveBeenCalledTimes(1);
      expect(children).toHaveLength(1);
      expect(children[0].exitCode).toBe(0);
      const saved = await ledger();
      expect(saved.goalId).toBe(goalId);
      expect(saved.reservations).toHaveLength(1);
      const reservation = saved.reservations[0];
      expect(reservation.owner.conversationId).not.toBe(rootConversation);
      expect(reservation.owner.runId).not.toBe(rootRun);
      expect(reservation).toMatchObject({ state: 'released', sdkOutcome: 'completed',
        sdkUsage: { source: 'claude-sdk-result', inputTokens: 7, outputTokens: 4 }, exit: { code: 0, signal: null } });
      expect(reservation.identity.processBirthMarkerV2).toBeTruthy();
      const child = await loadCollectionItem<SharedState | undefined>('conversations', reservation.owner.conversationId, undefined);
      expect(child).toMatchObject({ parentConversationId: rootConversation, parentLogicalRunId: rootRun,
        rootConversationId: rootConversation, flowId: 'native_pinned_child', runDepth: 1 });
    }, 'child');
  }, 30000);
  it('refuses missing, unlisted, and changed descendant plans before the actual child executes', async () => {
    phaseStart = performance.now();
    await withClaim(async input => {
      const child = input.flowDefinition!.executionDependencies!.flows[0].flowSnapshot;
      const common = { authority: subflowExecutionAuthority(input.executionAuthority),
        conversationId: 'unissued_child', runId: 'unissued_child_run',
        nodeId: 'test_core_process', modelId: 'model-test', flowId: child.id };
      await expect(createPersonaNativeOriginalHost(common)).rejects.toThrow('held');
      phase('missing plan refused');
      await expect(createPersonaNativeOriginalHost({ ...common, flowId: 'unlisted_child', flowSnapshot: child })).rejects.toThrow('held');
      phase('unlisted plan refused');
      const changed = structuredClone(child);
      changed.nodes.find(node => node.data.type === 'process')!.data.properties!.promptTemplate = 'forged plan';
      await expect(createPersonaNativeOriginalHost({ ...common, flowSnapshot: changed })).rejects.toThrow('held');
      phase('changed plan refused');
      expect(queryMock).not.toHaveBeenCalled();
    }, async () => {
      expect(promptCount).toBe(1);
      expect((await ledger()).reservations[0].state).toBe('released');
    }, 'child');
  }, 30000);
  it('holds an issued descendant when its saved lineage changes before the first prompt', async () => {
    beforePrompt = async () => {
      const reservation = (await ledger()).reservations[0];
      const child = await loadCollectionItem<SharedState | undefined>('conversations', reservation.owner.conversationId, undefined);
      expect(child!.parentLogicalRunId).toBeTruthy();
      await saveCollectionItem('conversations', child!.conversationId!, { ...child!, parentLogicalRunId: 'foreign_parent_run' });
    };
    await withClaim(async () => {}, async () => {
      expect(queryMock).toHaveBeenCalledTimes(1);
      expect(children).toHaveLength(1);
      expect(promptCount).toBe(0);
      expect(observedPrompt).toBeUndefined();
      const reservation = (await ledger()).reservations[0];
      expect(reservation.state).not.toBe('released');
      expect(reservation.sdkUsage).toBeUndefined();
      expect(reservation.sdkOutcome).not.toBe('completed');
    }, 'child-refusal');
  }, 30000);
  it('discards a descendant SDK result and transcript after its saved parent lineage changes', async () => {
    lateResultFirst = true;
    transcriptText = 'stale-descendant-private-output';
    afterPrompt = async () => {
      const reservation = (await ledger()).reservations[0];
      const child = await loadCollectionItem<SharedState | undefined>('conversations', reservation.owner.conversationId, undefined);
      await saveCollectionItem('conversations', child!.conversationId!, { ...child!, parentLogicalRunId: 'foreign_parent_run' });
    };
    const observed: unknown[] = [];
    const unsubscribe = executionEventBus.subscribeGlobal(({ event }) => observed.push(event));
    try {
      await withClaim(async () => {}, async () => {
        expect(promptCount).toBe(1);
        expect(offeredLateUsage).toMatchObject({ type: 'result', usage: { input_tokens: 7, output_tokens: 4 } });
        const reservation = (await ledger()).reservations[0];
        expect(reservation.state).not.toBe('released');
        expect(reservation.sdkUsage).toBeUndefined();
        const child = await loadCollectionItem<SharedState | undefined>('conversations', reservation.owner.conversationId, undefined);
        expect(JSON.stringify(child!.messages)).not.toContain(transcriptText);
        expect(JSON.stringify(observed)).not.toContain(transcriptText);
      }, 'child-refusal');
    } finally { unsubscribe(); }
  }, 30000);
  it('refuses a ledger parent replaced after the last awaited temporary check and preserves the foreign directory', async () => {
    await withClaim(async input => {
      const { invoke, state } = await prepare(input);
      const lstat = fs.lstat.bind(fs);
      let replaced: string | undefined;
      let osRefusal: string | undefined;
      const spy = jest.spyOn(fs, 'lstat').mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
        const stat = await lstat(...args);
        const filename = String(args[0]);
        if (!replaced && filename.includes('host-ledger') && filename.endsWith('.tmp')) {
          replaced = path.dirname(filename);
          try { await fs.rename(replaced, `${replaced}.displaced`); }
          catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (process.platform === 'win32' && ['EBUSY', 'EPERM', 'EACCES'].includes(code ?? '')) osRefusal = code;
            throw error;
          }
          await fs.mkdir(replaced, { mode: 0o700 });
          await fs.writeFile(path.join(replaced, 'foreign.json'), 'foreign sentinel', { mode: 0o600 });
        }
        return stat;
      });
      try {
        expect((await invoke()).success).toBe(false);
        expect(replaced).toBeDefined();
        expect(queryMock).not.toHaveBeenCalled();
        if (osRefusal) {
          expect(process.platform).toBe('win32');
          expect(['EBUSY', 'EPERM', 'EACCES']).toContain(osRefusal);
          expect(await fs.readdir(replaced!)).toEqual([]);
        } else {
          expect(await fs.readFile(path.join(replaced!, 'foreign.json'), 'utf8')).toBe('foreign sentinel');
          expect(await fs.readdir(replaced!)).toEqual(['foreign.json']);
        }
      } finally { spy.mockRestore(); FlowExecutor.conversationStates.delete(state.conversationId!); }
    });
  }, 30000);
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

  it('holds Codex without inferring a public child hook and rejects changed model budget before launch', async () => {
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
