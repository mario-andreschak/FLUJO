import { constants, promises as fs, fstatSync, lstatSync, realpathSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Flow } from '@/shared/types/flow';
import type { Model } from '@/shared/types/model';
import type { PersonaAttribution } from '@/shared/types/enduringAgent';
import { DEFAULT_AGENTIC_MAX_TURNS } from '@/shared/types/model/model';
import type { FlowExecutionAuthority } from '../types';
import { getCurrentWorkspace, getWorkspaceDataDir } from '@/utils/workspace';
import { withWorkspaceMutation } from '@/backend/services/workspace/workspaceMutationGate';
import { withWorkspaceRuntimeLock, probeRuntimeProcessIdentity } from '@/backend/services/enduringAgents/runtimeLock';
import { getPersonaActivity, getPersonaWorkItem } from '@/backend/services/enduringAgents/store';
import { createNativeBrokerAuthority, nativeDigest } from './nativeToolBroker';
import { createNativeLineageRootBinding } from './nativeOriginLineage';
import { createNativeInvocationSessionHook, type NativeInvocationSession, type NativeInvocationSessionPayloadRef } from './nativeInvocationSession';
import { assertSavedNativePublishable, readSavedNativeOrigin, readSavedNativeTerminal } from './nativeSavedOrigin';
import { readNativeSessionPayload } from './nativeSessionPayload';
import { assertClaudeOwnedProcessRegistration, type ClaudeOwnedProcessRegistration } from '@/backend/services/model/adapters/claudeOwnedProcess';
import { assertCodexOwnedProcessRegistration, probeCodexOwnedProcessRegistration, type CodexOwnedProcessRegistration } from '@/backend/services/model/adapters/codexAppServerProcess';
import { qualifyNativeCodex, assertNativeCodexQualification } from '@/backend/services/model/adapters/codexNativeQualification';
import type { RestrictedCodexProfile } from '@/backend/services/model/adapters/codexRestrictedProfile';
import { CODEX_HANDOFF_PROTOCOL, NATIVE_HANDOFF_PROTOCOL, type NativeHandoffProtocol } from './nativeHandoffProtocol';
import { readNativeHeldFile } from './nativeHeldFile';
import { commitExecutionExtensionMutation, executionExtensionNativeWorkerRoot, executionExtensionSupportsNativeWorkerRoot, executionExtensionSignal,
  executionExtensionNativeWorkerDescendant,isExecutionChildContext,
  type ExecutionNativeWorkerDescendant,
  type ExecutionExtensionContext } from '@/backend/execution/extensions';

type Binding = { workspace: string; dispatchId: string;
  goalId: string; round: number; revisionId: string; leaseEpoch: string;
  conversationId: string; runId: string; flow: Flow; planDigest: string; authority: FlowExecutionAuthority } & (
  { kind: 'persona'; personaId: string; activityId: string }
  | { kind: 'worker'; workerId: string; targetDigest: string; context: ExecutionExtensionContext;
      descendant?:ExecutionNativeWorkerDescendant & {rootFlowId:string} });
const registryRoot = globalThis as typeof globalThis & { __flujoNativeOriginalAuthorities?: WeakMap<object, Binding> };
const bindings = registryRoot.__flujoNativeOriginalAuthorities ??= new WeakMap<object, Binding>();
/** Causal wrappers keep the root's hold. A child is not thereby accepted as a
 * root Original; createPersonaNativeOriginalHost rejects its different tuple. */
export { inheritNativeOriginalAuthority } from '../nativeOriginalAuthorityInheritance';
const held = (reason?: string): never => {
  throw new Error(`Native Original authority or reservation is held.${reason ? ` Reason: ${reason}.` : ''}`);
};
const positive = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
const modelPlan = (value: Model | null) => ({ id: value?.id, name: value?.name, adapter: value?.adapter,
  provider: value?.provider, maxTurns: value?.maxTurns, temperature: value?.temperature,
  reasoningEffort: value?.reasoningEffort, fallbackPolicy: value?.fallbackPolicy });
type Reservation = { invocationId: string; descriptorDigest: string; owner: NativeInvocationSession['descriptor']['receipt']['owner'];
  lineageDigest: string; acceptanceDigest: string; planDigest: string; modelId: string; maxTurns: number;
  state: 'accepted' | 'registered' | 'exited' | 'released';
  handoff?: { protocol: NativeHandoffProtocol; toolInvocationIds: string[]; state: 'requested' | 'confirmed' };
  sdkUsage?: { source: 'claude-sdk-result'|'codex-app-server-usage'; numTurns?: number; appServerTurns?:number; inputTokens?: number;
    outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number; totalCostUsd?: number; durationMs?: number };
  identity?: ClaudeOwnedProcessRegistration['identity']; sdkOutcome?: string; exit?: { code: number | null; signal: NodeJS.Signals | null } };
type Ledger = ({ version: 1; goalId: string; personaId: string }
  | { version: 2; kind: 'worker'; goalId: string; workerId: string }) & { reservations: Reservation[] };
type FacadeOwner = Readonly<Record<string, unknown>>;
type TerminalExpectation = {
  expectedOwner: NativeInvocationSession['descriptor']['receipt']['owner'];
  expectedLineageDigest: string; expectedDescriptorDigest: string; expectedWorkspace: string;
};
/** Source-only capabilities. Target enrollment and Worker bearer admission
 * still belong to the Controller; this reader cannot mint either authority. */
export interface NativeOriginalSourceReader {
  readOrigin(invocationId: string): Promise<NativeInvocationSession['descriptor']>;
  readPayload(ref: NativeInvocationSessionPayloadRef): ReturnType<typeof readNativeSessionPayload>;
  assertPublishable(input: Omit<Parameters<typeof assertSavedNativePublishable>[0], 'authority' | 'root'>): Promise<true>;
  retainLive(session: NativeInvocationSession, owner: FacadeOwner, hostGeneration: object):
    Promise<Readonly<{ handle: object; generation: string }>>;
  probeLive(handle: object, owner: FacadeOwner, hostGeneration: object): Promise<object | null>;
  readTerminal(invocationId: string, expected: TerminalExpectation):
    Promise<Awaited<ReturnType<typeof readSavedNativeTerminal>> & { cancelResolved: true }>;
}
// Next may evaluate this module in several server graphs. Preserve provenance
// and the exact retained reader within this process, never across a restart.
const hostRoot = globalThis as typeof globalThis & {
  __flujoNativeOriginalHosts?: WeakSet<object>;
  __flujoNativeOriginalReaders?: WeakMap<object, NativeOriginalSourceReader>;
  __flujoNativeOriginalHostContexts?: WeakMap<object, ExecutionExtensionContext>;
};
const hosts = hostRoot.__flujoNativeOriginalHosts ??= new WeakSet<object>();
const sourceReaders = hostRoot.__flujoNativeOriginalReaders ??= new WeakMap<object, NativeOriginalSourceReader>();
const hostContexts = hostRoot.__flujoNativeOriginalHostContexts ??= new WeakMap<object, ExecutionExtensionContext>();
/** A Persona host cannot be combined with a private Worker context. */
export function assertNativeOriginalExecutionContext(host: unknown, context?: ExecutionExtensionContext): void {
  assertNativeOriginalProcessHost(host);
  if (hostContexts.get(host) !== context) return held();
}
/** In-process access only. JSON, a PID, or caller-supplied lifecycle callbacks
 * cannot recover a reader for an existing Original. No transport is exposed. */
export function nativeOriginalSourceReader(host: unknown): NativeOriginalSourceReader {
  assertNativeOriginalProcessHost(host);
  return sourceReaders.get(host) ?? held();
}
export function assertNativeOriginalProcessHost(value: unknown): asserts value is NativeOriginalProcessHost {
  if (!value || typeof value !== 'object' || !hosts.has(value)) return held();
}
const ledgerOwner = (binding: Binding) => binding.kind === 'persona'
  ? [binding.personaId, binding.goalId] : ['worker', binding.workerId, binding.goalId];
const ledgerHeader = (binding: Binding) => binding.kind === 'persona'
  ? { version: 1 as const, goalId: binding.goalId, personaId: binding.personaId }
  : { version: 2 as const, kind: 'worker' as const, goalId: binding.goalId, workerId: binding.workerId };
const ledgerFile = (binding: Binding) => path.join(getWorkspaceDataDir(binding.workspace), 'db',
  'native-session-origins', binding.kind === 'persona' ? 'host-ledger' : 'worker-host-ledger', `${nativeDigest(ledgerOwner(binding))}.json`);
const privateOwner = (stat: { mode: bigint; uid: bigint }): boolean => process.platform === 'win32'
  || ((stat.mode & BigInt(0o077)) === BigInt(0) && stat.uid === BigInt(process.getuid!()));
async function assertDirectories(binding: Binding): Promise<void> {
  const base = getWorkspaceDataDir(binding.workspace);
  for (const directory of [base, path.join(base, 'db'), path.dirname(path.dirname(ledgerFile(binding))), path.dirname(ledgerFile(binding))]) {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return held();
    const canonical = await fs.realpath(directory);
    const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    if (normalize(canonical) !== normalize(directory)) return held();
  }
}

// Kept beneath the existing private origin exclusion; no accepted IDs, process
// identities or budget holds enter generic snapshot/restore or provider input.
async function readLedger(binding: Binding): Promise<Ledger> {
  const file = ledgerFile(binding);
  let bytes;
  try { bytes = await readNativeHeldFile(file, 256 * 1024, { privateOwner: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...ledgerHeader(binding), reservations: [] };
    throw error;
  }
    await assertDirectories(binding);
    const value = JSON.parse(bytes.toString('utf8')) as Ledger;
    if (Object.entries(ledgerHeader(binding)).some(([key, expected]) => (value as unknown as Record<string, unknown>)[key] !== expected)
      || !Array.isArray(value.reservations) || value.reservations.length > 256
      || value.reservations.some(item => !item.invocationId || !item.acceptanceDigest
        || !['accepted', 'registered', 'exited', 'released'].includes(item.state))) return held();
    return value;
}

type CommitCapability = { assertCurrent: () => Promise<void>; assertActive: () => void };

function cleanupOwnedTemporary(binding: Binding, temporary: string, fd: number,
  directoryIdentity: { dev: bigint; ino: bigint }): void {
  try {
    const base = getWorkspaceDataDir(binding.workspace);
    const directory = path.dirname(temporary);
    const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    for (const part of [base, path.join(base, 'db'), path.dirname(directory), directory]) {
      const stat = lstatSync(part);
      if (!stat.isDirectory() || stat.isSymbolicLink() || normalize(realpathSync(part)) !== normalize(part)) return;
    }
    const parent = lstatSync(directory, { bigint: true });
    if (parent.dev !== directoryIdentity.dev || parent.ino !== directoryIdentity.ino) return;
    const owned = fstatSync(fd, { bigint: true });
    const current = lstatSync(temporary, { bigint: true });
    if (!owned.isFile() || !current.isFile() || current.isSymbolicLink()
      || owned.nlink !== BigInt(1) || current.nlink !== BigInt(1) || !privateOwner(owned) || !privateOwner(current)
      || current.dev !== owned.dev || current.ino !== owned.ino) return;
    // No awaited operation separates the last path/FD comparison and unlink.
    // The workspace lock covers cooperating writers; this is not an OS-wide
    // conditional unlink guarantee against arbitrary external writers.
    unlinkSync(temporary);
  } catch { /* Refusal remains primary; foreign or uncertain paths are retained. */ }
}

async function mutate<T>(binding: Binding, task: (ledger: Ledger) => Promise<T>, cap: CommitCapability): Promise<T> {
  return withWorkspaceMutation(() => withWorkspaceRuntimeLock(`native-original-${nativeDigest(ledgerOwner(binding)).slice(0, 32)}`, async lock => {
    const directory = path.dirname(ledgerFile(binding));
    // Admit each private directory separately before following the next segment.
    for (const part of [path.dirname(directory), directory]) {
      await fs.mkdir(part, { recursive: false, mode: 0o700 }).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      });
      const stat = await fs.lstat(part, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || !privateOwner(stat)) return held();
    }
    await assertDirectories(binding);
    const directoryIdentity = await fs.lstat(directory, { bigint: true });
    const fileIdentity = await fs.lstat(ledgerFile(binding), { bigint: true }).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    const ledger = await readLedger(binding);
    const result = await task(ledger);
    const bytes = Buffer.from(JSON.stringify(ledger));
    if (bytes.length > 256 * 1024) return held();
    await lock.assertOwned();
    const temporary = `${ledgerFile(binding)}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, 'wx', 0o600);
    let committed = false;
    try {
      await handle.writeFile(bytes); await handle.sync();
      const temporaryIdentity = await handle.stat({ bigint: true });
      await assertDirectories(binding);
      const currentDirectory = await fs.lstat(directory, { bigint: true });
      if (currentDirectory.dev !== directoryIdentity.dev || currentDirectory.ino !== directoryIdentity.ino) return held();
      const currentFile = await fs.lstat(ledgerFile(binding), { bigint: true }).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      if (Boolean(fileIdentity) !== Boolean(currentFile) || (fileIdentity && currentFile
        && (fileIdentity.dev !== currentFile.dev || fileIdentity.ino !== currentFile.ino
          || fileIdentity.mtimeNs !== currentFile.mtimeNs || fileIdentity.ctimeNs !== currentFile.ctimeNs))) return held();
      const currentTemporary = await fs.lstat(temporary, { bigint: true });
      if (!currentTemporary.isFile() || currentTemporary.isSymbolicLink() || currentTemporary.nlink !== BigInt(1)
        || currentTemporary.dev !== temporaryIdentity.dev || currentTemporary.ino !== temporaryIdentity.ino
        || currentTemporary.size !== BigInt(bytes.length) || !privateOwner(currentTemporary)) return held();
      await cap.assertCurrent();
      await lock.assertOwned();
      cap.assertActive();
      // The final owner check is adjacent to rename; all awaited path checks are
      // complete. Launch mutations also retain the outer Persona lease commit.
      await fs.rename(temporary, ledgerFile(binding));
      committed = true;
      if (process.platform !== 'win32') {
        const parent = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try {
          const owned = await parent.stat({ bigint: true });
          if (!owned.isDirectory() || owned.dev !== directoryIdentity.dev || owned.ino !== directoryIdentity.ino) return held();
          await parent.sync();
        } finally { await parent.close(); }
      }
      return result;
    } finally {
      if (!committed) cleanupOwnedTemporary(binding, temporary, handle.fd, directoryIdentity);
      await handle.close();
    }
  }), binding.workspace);
}

/** Dispatcher-only mint: inputs come from its claimed lease and frozen Core,
 * not Flow/HTTP metadata. JSON or a lookalike Flow authority cannot recover it. */
export async function bindPersonaNativeOriginalAuthority(authority: FlowExecutionAuthority, input: {
  personaId: string; activityId: string; dispatchId: string; taskId?: string;
  revisionId: string; leaseEpoch: string; conversationId: string; runId: string; flow: Flow;
}): Promise<void> {
  if (!input.taskId) return;
  const dispatcher = await import('@/backend/services/enduringAgents/personaDispatcher');
  const assertPersonaFlowExecutionAuthority: (value: unknown) => asserts value is FlowExecutionAuthority = dispatcher.assertPersonaFlowExecutionAuthority;
  assertPersonaFlowExecutionAuthority(authority);
  if (!authority.commitWhileCurrent) return held();
  const candidate = await getPersonaWorkItem(input.personaId, input.taskId);
  if (!candidate?.goal && !candidate?.parentGoalId) return;
  await authority.commitWhileCurrent(async () => {
    const task = await getPersonaWorkItem(input.personaId, input.taskId!);
    if (!task?.goal && !task?.parentGoalId) return;
    const goal = task.goal ? task : await getPersonaWorkItem(input.personaId, task.parentGoalId!);
    if (!goal?.goal || goal.goal.state !== 'active' || goal.goal.pendingDispatchId !== input.dispatchId
      || goal.goal.pendingTaskId !== task.id || task.revokedGoalDispatchId === input.dispatchId) return held();
    const flow = structuredClone(input.flow);
    const binding: Binding = { ...input, kind: 'persona', workspace: getCurrentWorkspace(), goalId: goal.id,
      round: goal.goal.rounds, flow, planDigest: nativeDigest([input.revisionId, flow]), authority };
    // A later lease, model or Activity cannot evade an unresolved original.
    const prior = await readLedger(binding);
    if (prior.reservations.some(item => item.state !== 'released')) return held();
    bindings.set(authority, binding);
  });
}

export interface NativeOriginalProcessHost {
  readonly terminationProtocol: NativeHandoffProtocol;
  readonly codexProfile?: Readonly<RestrictedCodexProfile>;
  assertTurnBudget(maxTurns: number): Promise<void>;
  register(process: ClaudeOwnedProcessRegistration | CodexOwnedProcessRegistration): Promise<void>;
  beforeFirstPrompt(): Promise<void>;
  waitForExit(): Promise<void>;
  releaseAfterTerminal(): Promise<void>;
  observeSdkUsage(result: unknown): Promise<void>;
  prepareHandoff(invocationId: string, toolInvocationId: string): Promise<void>;
  requestHandoffTermination(invocationId: string): Promise<void>;
  confirmHandoffTermination(invocationId: string, toolInvocationIds: readonly string[]): Promise<void>;
}

type NativeOriginalHostInput = {
  authority?: FlowExecutionAuthority; conversationId?: string; runId?: string; nodeId?: string;
  modelId: string;
  personaAttribution?: PersonaAttribution;
};

/** Only a live branded Persona root run can use the Persona mint. */
export async function createPersonaNativeOriginalHost(input: NativeOriginalHostInput) {
  const binding = input.authority && bindings.get(input.authority);
  if (binding && binding.kind !== 'persona') return held();
  return createBoundNativeOriginalHost(input);
}

/** Worker roots use their real protected execution context and live Source
 * conversation. Flow metadata cannot choose the owner or manufacture a lease.
 * This root-only mint does not qualify any Controller transport or image. */
export async function createWorkerNativeOriginalHost(input: Omit<NativeOriginalHostInput, 'authority' | 'personaAttribution'> & {
  context: ExecutionExtensionContext;
}) {
  if (!executionExtensionSupportsNativeWorkerRoot(input.context)) return undefined;
  const { modelService } = await import('@/backend/services/model');
  const model = await modelService.getModel(input.modelId);
  if (model?.adapter !== 'codex-cli') return undefined;
  if (!input.conversationId || !input.runId || !input.nodeId) return held();
  const { FlowExecutor } = await import('../FlowExecutor');
  const state = FlowExecutor.conversationStates.get(input.conversationId);
  if (!state?.flowSnapshot) return held();
  if (state.executionExtensionContext !== input.context || state.logicalRunId !== input.runId
    || state.personaAttribution || ![0,1].includes(state.runDepth??0)) return held();
  const flow = structuredClone(state.flowSnapshot);
  if (Buffer.byteLength(JSON.stringify(flow)) > 1024 * 1024) return held();
  const node = flow.nodes.find(item => item.id === input.nodeId && item.data.type === 'process');
  if (!node || node.data.properties?.boundModel !== input.modelId) return held();
  const expected = { conversationId: input.conversationId, runId: input.runId, workspace: getCurrentWorkspace(),
    flowId: flow.id, flowDigest: nativeDigest(flow), modelId: input.modelId, modelDigest: nativeDigest(modelPlan(model)) };
  const descendant=state.runDepth===1?await executionExtensionNativeWorkerDescendant(input.context,expected):undefined;
  const selected = descendant?.root??await executionExtensionNativeWorkerRoot(input.context, expected);
  if (!selected) return held();
  if (model?.adapter !== 'codex-cli' || model.ApiKey?.trim() || model.fallbackPolicy) return held();
  const signal = executionExtensionSignal(input.context);
  if (!signal) return held();
  const ownerDigest = nativeDigest(selected);
  const parent=descendant?FlowExecutor.conversationStates.get(selected.rootConversationId):undefined;
  if(descendant&&(!parent?.flowSnapshot||!parent.executionExtensionContext
    ||!isExecutionChildContext(input.context,parent.executionExtensionContext)
    ||state.parentRunId!==parent.conversationId||state.subflowLane?.parentNodeId!==descendant.parentNodeId
    ||parent.logicalRunId!==selected.logicalRunId||nativeDigest(parent.flowSnapshot)!==selected.flowDigest))return held();
  const assertCurrent = async () => {
    signal.throwIfAborted();
    if (getCurrentWorkspace() !== expected.workspace || FlowExecutor.conversationStates.get(expected.conversationId) !== state
      || state.executionExtensionContext !== input.context || state.logicalRunId !== expected.runId
      || nativeDigest(state.flowSnapshot) !== expected.flowDigest
      || nativeDigest(modelPlan(await modelService.getModel(input.modelId))) !== expected.modelDigest) return held();
    const child=descendant?await executionExtensionNativeWorkerDescendant(input.context,expected):undefined;
    if(descendant&&nativeDigest(child)!==nativeDigest(descendant))return held();
    const current = child?.root??await executionExtensionNativeWorkerRoot(input.context, expected);
    if (!current || nativeDigest(current) !== ownerDigest) return held();
    signal.throwIfAborted();
  };
  const authority: FlowExecutionAuthority = Object.freeze({ signal, assertCurrent,
    commitWhileCurrent: <T>(task: () => Promise<T>) => commitExecutionExtensionMutation(input.context, async () => {
      await assertCurrent(); return task();
    }) });
  const binding: Binding = { kind: 'worker', workerId: selected.workerId, targetDigest: selected.targetDigest,
    context: input.context, workspace: selected.workspace, dispatchId: selected.fleetRunId, goalId: selected.goalId,
    round: 1, revisionId: selected.flowDigest, leaseEpoch: selected.leaseEpoch, conversationId:expected.conversationId,
    runId:expected.runId, flow, planDigest: nativeDigest([selected.flowDigest, flow]), authority,
    ...(descendant?{descendant:{...descendant,rootFlowId:parent!.flowId}}:{}) };
  await authority.commitWhileCurrent!(async () => {
    const prior = await readLedger(binding);
    if (prior.reservations.some(item => item.state !== 'released')) return held();
    bindings.set(authority, binding);
  });
  return createBoundNativeOriginalHost({ ...input, authority });
}

async function createBoundNativeOriginalHost(input: NativeOriginalHostInput): Promise<{
  broker: ReturnType<typeof createNativeBrokerAuthority>;
  session: ReturnType<typeof createNativeInvocationSessionHook>; process: NativeOriginalProcessHost } | undefined> {
  const binding = input.authority && bindings.get(input.authority);
  if (!binding && !input.personaAttribution) return undefined;
  const { modelService } = await import('@/backend/services/model');
  const model = await modelService.getModel(input.modelId);
  if (!binding) {
    if (model?.adapter !== 'claude-cli' && model?.adapter !== 'codex-cli') return undefined;
    const attribution = input.personaAttribution!;
    if (!attribution.activityId) return held();
    const activity = await getPersonaActivity(attribution.personaId, attribution.activityId);
    if (!activity) return held();
    if (activity.source.kind !== 'assignment' || !activity.source.sourceId) return undefined;
    const task = await getPersonaWorkItem(attribution.personaId, activity.source.sourceId);
    if (!task || task.goal || task.parentGoalId) return held();
    return undefined;
  }
  if (model?.adapter !== 'claude-cli' && model?.adapter !== 'codex-cli') return undefined;
  // Always use the mint's captured real lease closures, including when a causal
  // wrapper carries the binding. Caller-owned wrapper methods are not authority.
  const authority = binding.authority;
  if (binding.workspace !== getCurrentWorkspace() || input.conversationId !== binding.conversationId
    || input.runId !== binding.runId || !authority.commitWhileCurrent) return held();
  const node = binding.flow.nodes.find(item => item.id === input.nodeId && item.data.type === 'process');
  if (!node || node.data.properties?.boundModel !== input.modelId) return held();
  if (model.id !== input.modelId || model.fallbackPolicy) return held();
  if(model.adapter==='codex-cli' && model.ApiKey?.trim())return held();
  const maxTurns = positive(node.data.properties?.maxTurns) ?? positive(model.maxTurns) ?? DEFAULT_AGENTIC_MAX_TURNS;
  const modelPlanDigest = nativeDigest(modelPlan(model));
  const assertGoalCurrent = async () => {
    authority.signal.throwIfAborted();
    if (binding.kind === 'worker') return authority.assertCurrent();
    const goal = await getPersonaWorkItem(binding.personaId, binding.goalId);
    if (!goal?.goal || goal.goal.state !== 'active' || goal.goal.rounds !== binding.round
      || goal.goal.pendingDispatchId !== binding.dispatchId) return held();
    authority.signal.throwIfAborted();
  };
  const assertCurrent = async () => {
    authority.signal.throwIfAborted(); await authority.assertCurrent(); await assertGoalCurrent();
  };
  // Every launch-cap mutation runs inside real commitWhileCurrent, which holds
  // the Persona lease lock across this callback. Its contract forbids acquiring
  // that same lock recursively. Re-read goal state and signal under the held
  // lease, then revalidate ledger ownership adjacent to the rename.
  const launchCap: CommitCapability = { assertCurrent: assertGoalCurrent,
    assertActive: () => authority.signal.throwIfAborted() };
  await assertCurrent();
  const codexProfile=model.adapter==='codex-cli'
    ? await qualifyNativeCodex(model.name,model.reasoningEffort,authority.signal,assertCurrent):undefined;
  if(codexProfile)assertNativeCodexQualification(codexProfile);
  await assertCurrent();
  const terminationProtocol=model.adapter==='codex-cli'?CODEX_HANDOFF_PROTOCOL:NATIVE_HANDOFF_PROTOCOL;
  const broker = createNativeBrokerAuthority(binding.leaseEpoch, assertCurrent);
  const root = createNativeLineageRootBinding({ workspace: binding.workspace, fleetRunId: binding.dispatchId,
    workerId: binding.kind === 'persona' ? binding.activityId : binding.workerId, goalId: binding.goalId,
    rootConversationId:binding.kind==='worker'&&binding.descendant?binding.descendant.root.rootConversationId:binding.conversationId,
    rootLogicalRunId:binding.kind==='worker'&&binding.descendant?binding.descendant.root.logicalRunId:binding.runId,
    rootFlowId:binding.kind==='worker'&&binding.descendant?binding.descendant.rootFlowId:binding.flow.id }, assertCurrent);
  let original: NativeInvocationSession | undefined;
  let child: ClaudeOwnedProcessRegistration | CodexOwnedProcessRegistration | undefined;
  let exited = false;
  let closed = false;
  let handoffStopRequested = false;
  const handoffIds = new Set<string>();
  const update = async (task: (reservation: Reservation) => Promise<void>, cap = launchCap) => {
    if (!original) return held();
    return mutate(binding, async ledger => {
      const reservation = ledger.reservations.find(item => item.invocationId === original!.descriptor.receipt.invocationId);
      if (!reservation || reservation.descriptorDigest !== nativeDigest(original!.descriptor)) return held();
      await task(reservation);
    }, cap);
  };
  const session = createNativeInvocationSessionHook({ root,
    publish: async value => {
      if (original) return held();
      const descriptor = value.descriptor;
      const owner = descriptor.receipt.owner;
      if (owner.conversationId !== binding.conversationId || owner.runId !== binding.runId
        || owner.nodeId !== input.nodeId || owner.modelId !== input.modelId || owner.leaseEpoch !== binding.leaseEpoch
        || descriptor.archive.adapter !== model.adapter || descriptor.lineage.rootFlowId !== root.rootFlowId) return held();
      const descendant=binding.kind==='worker'?binding.descendant:undefined;
      if(descendant){
        const edge=descriptor.lineage.edges[0];
        if(descriptor.lineage.edges.length!==1||edge?.kind!=='attached-lane'
          ||edge.parentConversationId!==root.rootConversationId||edge.parentLogicalRunId!==root.rootLogicalRunId
          ||edge.parentNodeId!==descendant.parentNodeId||edge.childConversationId!==binding.conversationId
          ||edge.childLogicalRunId!==binding.runId||edge.childFlowId!==binding.flow.id)return held();
      }else if(descriptor.lineage.edges.length)return held();
      const saved = await readSavedNativeOrigin({ invocationId: descriptor.receipt.invocationId,
        authority: broker, root, signal: authority.signal });
      if (nativeDigest(saved) !== nativeDigest(descriptor)) return held();
      await authority.commitWhileCurrent!(async () => {
        await mutate(binding, async ledger => {
          const acceptanceDigest = nativeDigest([binding.dispatchId, binding.round, binding.planDigest,
            owner.conversationId, owner.runId, owner.nodeId, owner.modelId, owner.inputDigest, owner.attemptOrdinal]);
          if (ledger.reservations.length >= 256 || ledger.reservations.some(item => item.state !== 'released'
            || item.invocationId === descriptor.receipt.invocationId || item.acceptanceDigest === acceptanceDigest)) return held();
          ledger.reservations.push({ invocationId: descriptor.receipt.invocationId,
            descriptorDigest: nativeDigest(descriptor), owner: structuredClone(owner), lineageDigest: descriptor.lineage.digest,
            acceptanceDigest, planDigest: nativeDigest([binding.planDigest, modelPlanDigest]), modelId: input.modelId, maxTurns, state: 'accepted' });
        }, launchCap);
      });
      original = value;
      authority.signal.addEventListener('abort', () => value.cancel(), { once: true });
    },
    acknowledgeLive: async value => { if (value !== original || !child || exited || closed) return held(); await assertCurrent(); },
    acknowledgeSdkOutcome: async (value, outcome) => {
      if (value !== original || !child || !exited || !closed) return held();
      await authority.commitWhileCurrent!(() => update(async reservation => {
        if (outcome === 'completed' && reservation.handoff && reservation.handoff.state !== 'confirmed') return held();
        reservation.sdkOutcome = outcome;
      }));
    },
    acknowledgeTerminalReady: async value => {
      if (value !== original || !child || !exited || !closed) return held();
      await assertCurrent();
    },
  });
  const processHost: NativeOriginalProcessHost = {
    terminationProtocol,
    ...(codexProfile?{codexProfile}:{}),
    prepareHandoff: async (invocationId, toolInvocationId) => {
      if (!original || original.descriptor.receipt.invocationId !== invocationId || !child || exited || closed
        || original.descriptor.inventory.terminationProtocol !== terminationProtocol
        || handoffStopRequested || !toolInvocationId || toolInvocationId.length > 256
        || handoffIds.size >= 32 || handoffIds.has(toolInvocationId)) return held();
      await processHost.beforeFirstPrompt();
      await authority.commitWhileCurrent!(() => update(async reservation => {
        if (reservation.state !== 'registered') return held();
        reservation.handoff = { protocol: terminationProtocol,
          toolInvocationIds: [...handoffIds, toolInvocationId], state: 'requested' };
      }));
      handoffIds.add(toolInvocationId);
    },
    requestHandoffTermination: async invocationId => {
      if (!original || original.descriptor.receipt.invocationId !== invocationId || !child
        || !handoffIds.size || exited || closed || handoffStopRequested) return held();
      await assertCurrent();
      authority.signal.throwIfAborted();
      handoffStopRequested = true;
      child.requestStop();
    },
    confirmHandoffTermination: async (invocationId, toolInvocationIds) => {
      if (!original || original.descriptor.receipt.invocationId !== invocationId || !child
        || !handoffStopRequested || !exited || !closed || !handoffIds.size
        || nativeDigest([...handoffIds]) !== nativeDigest(toolInvocationIds)) return held();
      await assertCurrent();
      await authority.commitWhileCurrent!(() => update(async reservation => {
        if (reservation.state !== 'exited' || !reservation.exit || reservation.handoff?.state !== 'requested'
          || nativeDigest(reservation.handoff.toolInvocationIds) !== nativeDigest(toolInvocationIds)) return held();
        reservation.handoff.state = 'confirmed';
      }));
    },
    observeSdkUsage: async result => {
      if (!result || typeof result !== 'object' || !child || !original) return held();
      const value = result as Record<string, unknown>;
      const usage = value.usage && typeof value.usage === 'object' ? value.usage as Record<string, unknown> : {};
      const number = (candidate: unknown): number | undefined => typeof candidate === 'number'
        && Number.isFinite(candidate) && candidate >= 0 ? candidate : undefined;
      if(model.adapter==='codex-cli' && (value.type!=='codex-app-server-usage' || value.appServerTurns!==1))return held();
      if(model.adapter==='claude-cli' && value.type!=='result')return held();
      const receipt: NonNullable<Reservation['sdkUsage']> = model.adapter==='codex-cli'
        ? {source:'codex-app-server-usage',appServerTurns:1,inputTokens:number(usage.input_tokens),outputTokens:number(usage.output_tokens),cacheReadTokens:number(usage.cached_input_tokens),cacheCreationTokens:number(usage.cache_write_input_tokens)}
        : { source: 'claude-sdk-result',
        numTurns: number(value.num_turns), inputTokens: number(usage.input_tokens), outputTokens: number(usage.output_tokens),
        cacheReadTokens: number(usage.cache_read_input_tokens), cacheCreationTokens: number(usage.cache_creation_input_tokens),
        totalCostUsd: number(value.total_cost_usd), durationMs: number(value.duration_ms) };
      await authority.commitWhileCurrent!(() => update(async reservation => {
        if (reservation.sdkUsage && nativeDigest(reservation.sdkUsage) !== nativeDigest(receipt)) return held();
        reservation.sdkUsage = receipt;
      }));
      if (receipt.numTurns !== undefined && receipt.numTurns > maxTurns) return held();
    },
    assertTurnBudget: async value => {
      if (!original || value !== maxTurns
        || nativeDigest(modelPlan(await modelService.getModel(input.modelId))) !== modelPlanDigest) return held();
      await assertCurrent();
    },
    register: async value => {
      if(model.adapter==='codex-cli')assertCodexOwnedProcessRegistration(value,processHost);
      else assertClaudeOwnedProcessRegistration(value, processHost);
      if (!original || child || !value.identity.processBirthMarkerV2) return held();
      child = value;
      void value.exit.then(() => { exited = true; });
      void value.close.then(() => { closed = true; });
      await authority.commitWhileCurrent!(() => update(async reservation => {
        if (reservation.state !== 'accepted') return held();
        reservation.identity = value.identity; reservation.state = 'registered';
      }));
      await processHost.beforeFirstPrompt();
    },
    beforeFirstPrompt: async () => {
      if (!child || exited || closed || !original) return held('process_not_live');
      if (nativeDigest(modelPlan(await modelService.getModel(input.modelId))) !== modelPlanDigest) return held('model_plan_changed');
      await assertCurrent();
      if (!await probeRuntimeProcessIdentity(child.identity) || exited || closed) return held('process_identity_unconfirmed');
      await assertCurrent();
    },
    waitForExit: async () => {
      if (!child || !original) return held('process_not_registered');
      const exit = await child.exit;
      await child.close;
      exited = true; closed = true;
      // Exit observation does not require a now-revoked launch lease and never
      // releases the budget reservation or unresolved effects by itself.
      await update(async reservation => {
        if (reservation.exit && nativeDigest(reservation.exit) !== nativeDigest(exit)) return held();
        reservation.exit = exit;
        if (reservation.state !== 'released') reservation.state = 'exited';
      }, { assertCurrent: async () => { if (!original || !child || !exited || !closed) return held(); },
        assertActive: () => { if (!original || !child || !exited || !closed) return held(); } });
    },
    releaseAfterTerminal: async () => {
      if (!original || !exited || !closed) return held();
      const value = original;
      const terminal = await value.waitTerminal();
      if (terminal.state !== 'terminal') return held();
      const terminalCap = async () => { await readSavedNativeTerminal({ invocationId: value.descriptor.receipt.invocationId,
        expectedOwner: value.descriptor.receipt.owner, expectedLineageDigest: value.descriptor.lineage.digest,
        expectedDescriptorDigest: nativeDigest(value.descriptor), expectedWorkspace: binding.workspace,
        assertReadAuthorized: async () => { if (value !== original || !exited || !closed) return held(); } }); };
      await update(async reservation => {
        if (reservation.sdkOutcome !== 'completed' || (reservation.handoff && reservation.handoff.state !== 'confirmed')) return held();
        reservation.state = 'released';
      },
        { assertCurrent: terminalCap, assertActive: () => { if (value !== original || !exited || !closed) return held(); } });
    },
  };
  const requireOriginal = (invocationId?: string) => {
    if (!original || invocationId !== undefined && original.descriptor.receipt.invocationId !== invocationId) return held();
    return original;
  };
  // One accepted Original can retain one opaque facade owner/generation. Keep
  // the actual child in this closure, never in a serializable proof envelope.
  let retained: { handle: object; ownerDigest: string; hostGeneration: object; generation: string } | undefined;
  const liveChild = async () => {
    if (!child || exited || closed || authority.signal.aborted || original?.signal.aborted) return false;
    const owned = child;
    if (model.adapter === 'codex-cli') {
      if (!await probeCodexOwnedProcessRegistration(owned, processHost)) return false;
    } else {
      assertClaudeOwnedProcessRegistration(owned, processHost);
      if (!await probeRuntimeProcessIdentity(owned.identity)) return false;
    }
    return child === owned && !exited && !closed && !authority.signal.aborted && !original?.signal.aborted;
  };
  const sourceReader: NativeOriginalSourceReader = Object.freeze({
    async readOrigin(invocationId: string) {
      const value = requireOriginal(invocationId);
      const saved = await readSavedNativeOrigin({ invocationId, authority: broker, root, signal: authority.signal });
      if (nativeDigest(saved) !== nativeDigest(value.descriptor)) return held();
      return saved;
    },
    async readPayload(ref: NativeInvocationSessionPayloadRef) {
      const value = requireOriginal(ref?.invocationId);
      if (nativeDigest(ref) !== nativeDigest(value.descriptor.payloadRef)) return held();
      await sourceReader.readOrigin(ref.invocationId);
      const payload = await readNativeSessionPayload(ref, binding.workspace);
      await assertCurrent();
      return payload;
    },
    async assertPublishable(input: Parameters<NativeOriginalSourceReader['assertPublishable']>[0]) {
      if (input.session !== requireOriginal(input.invocationId) || child) return held();
      await assertCurrent();
      return assertSavedNativePublishable({ ...input, authority: broker, root });
    },
    async retainLive(value: NativeInvocationSession, owner: FacadeOwner, hostGeneration: object) {
      if (value !== requireOriginal() || !hostGeneration || typeof hostGeneration !== 'object'
        || Array.isArray(hostGeneration) || !child) return held();
      const descriptor = value.descriptor;
      const generation = `source-${nativeDigest([descriptor.lineage.installationId, descriptor.receipt.owner.leaseEpoch])}`;
      const fields = { invocationId: descriptor.receipt.invocationId,
        workerId: descriptor.lineage.workerId, goalId: descriptor.lineage.goalId,
        fleetRunId: descriptor.lineage.fleetRunId, rootConversationId: descriptor.lineage.rootConversationId,
        workspace: binding.workspace, conversationId: descriptor.receipt.owner.conversationId,
        logicalRunId: descriptor.receipt.owner.runId, nodeId: descriptor.receipt.owner.nodeId, generation };
      if (Object.entries(fields).some(([key, expected]) => owner?.[key] !== expected)) return held();
      const ownerDigest = nativeDigest(owner);
      if (retained && (retained.ownerDigest !== ownerDigest || retained.hostGeneration !== hostGeneration)) return held();
      await assertCurrent();
      if (!await liveChild()) return held();
      const reservation = (await readLedger(binding)).reservations.find(item => item.invocationId === fields.invocationId);
      if (reservation?.state !== 'registered' || nativeDigest(reservation.identity) !== nativeDigest(child.identity)
        || reservation.descriptorDigest !== nativeDigest(descriptor)) return held();
      await assertCurrent();
      if (!await liveChild()) return held();
      retained ??= { handle: Object.freeze({}), ownerDigest, hostGeneration, generation };
      return Object.freeze({ handle: retained.handle, generation });
    },
    async probeLive(handle: object, owner: FacadeOwner, hostGeneration: object) {
      if (!retained || handle !== retained.handle || hostGeneration !== retained.hostGeneration
        || nativeDigest(owner) !== retained.ownerDigest || !await liveChild()) return null;
      return handle;
    },
    async readTerminal(invocationId: string, expected: TerminalExpectation) {
      const value = requireOriginal(invocationId);
      const exact = { expectedOwner: value.descriptor.receipt.owner,
        expectedLineageDigest: value.descriptor.lineage.digest,
        expectedDescriptorDigest: nativeDigest(value.descriptor), expectedWorkspace: binding.workspace };
      if (nativeDigest(expected) !== nativeDigest(exact)) return held();
      const authorize = async () => {
        if (!child || !exited || !closed || value !== original) return held();
        const reservation = (await readLedger(binding)).reservations.find(item => item.invocationId === invocationId);
        if (!reservation || !['exited', 'released'].includes(reservation.state)
          || reservation.sdkOutcome !== 'completed' || !reservation.exit
          || reservation.descriptorDigest !== exact.expectedDescriptorDigest
          || nativeDigest(reservation.identity) !== nativeDigest(child.identity)
          || reservation.handoff && reservation.handoff.state !== 'confirmed') return held();
      };
      const terminal = await readSavedNativeTerminal({ invocationId, ...exact, assertReadAuthorized: authorize });
      // Both actual exit/close and durable effect resolution have been reread.
      // Neither SDK completion nor process exit alone resolves cancellation.
      return { ...terminal, cancelResolved: true as const };
    },
  });
  hosts.add(processHost);
  sourceReaders.set(processHost, sourceReader);
  if (binding.kind === 'worker') hostContexts.set(processHost, binding.context);
  return { broker, session, process: Object.freeze(processHost) };
}
