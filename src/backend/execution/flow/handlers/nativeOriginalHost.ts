import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Flow } from '@/shared/types/flow';
import type { Model } from '@/shared/types/model';
import type { PersonaAttribution } from '@/shared/types/enduringAgent';
import { DEFAULT_AGENTIC_MAX_TURNS } from '@/shared/types/model/model';
import type { FlowExecutionAuthority } from '../types';
import { getCurrentWorkspace, getWorkspaceDataDir } from '@/utils/workspace';
import { withWorkspaceMutation } from '@/backend/services/workspace/workspaceMutationGate';
import { withWorkspaceRuntimeLock, isRuntimeProcessIdentityAlive } from '@/backend/services/enduringAgents/runtimeLock';
import { getPersonaActivity, getPersonaWorkItem } from '@/backend/services/enduringAgents/store';
import { createNativeBrokerAuthority, nativeDigest } from './nativeToolBroker';
import { createNativeLineageRootBinding } from './nativeOriginLineage';
import { createNativeInvocationSessionHook, type NativeInvocationSession } from './nativeInvocationSession';
import { readSavedNativeOrigin, readSavedNativeTerminal } from './nativeSavedOrigin';
import { assertClaudeOwnedProcessRegistration, type ClaudeOwnedProcessRegistration } from '@/backend/services/model/adapters/claudeOwnedProcess';

type Binding = { workspace: string; personaId: string; activityId: string; dispatchId: string;
  goalId: string; round: number; revisionId: string; leaseEpoch: string;
  conversationId: string; runId: string; flow: Flow; planDigest: string; authority: FlowExecutionAuthority };
const registryRoot = globalThis as typeof globalThis & { __flujoNativeOriginalAuthorities?: WeakMap<object, Binding> };
const bindings = registryRoot.__flujoNativeOriginalAuthorities ??= new WeakMap<object, Binding>();
/** Causal wrappers keep the root's hold. A child is not thereby accepted as a
 * root Original; createPersonaNativeOriginalHost rejects its different tuple. */
export function inheritNativeOriginalAuthority(parent: FlowExecutionAuthority, child: FlowExecutionAuthority): void {
  const binding = bindings.get(parent);
  if (binding) bindings.set(child, binding);
}
const held = (): never => { throw new Error('Native Original authority or reservation is held.'); };
const positive = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
type Reservation = { invocationId: string; descriptorDigest: string; owner: NativeInvocationSession['descriptor']['receipt']['owner'];
  lineageDigest: string; acceptanceDigest: string; planDigest: string; modelId: string; maxTurns: number;
  state: 'accepted' | 'registered' | 'exited' | 'released';
  sdkUsage?: { source: 'claude-sdk-result'; numTurns?: number; inputTokens?: number;
    outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number; totalCostUsd?: number; durationMs?: number };
  identity?: ClaudeOwnedProcessRegistration['identity']; sdkOutcome?: string; exit?: { code: number | null; signal: NodeJS.Signals | null } };
type Ledger = { version: 1; goalId: string; personaId: string; reservations: Reservation[] };
const hosts = new WeakSet<object>();
export function assertNativeOriginalProcessHost(value: unknown): asserts value is NativeOriginalProcessHost {
  if (!value || typeof value !== 'object' || !hosts.has(value)) return held();
}
const ledgerFile = (binding: Binding) => path.join(getWorkspaceDataDir(binding.workspace), 'db',
  'native-session-origins', 'host-ledger', `${nativeDigest([binding.personaId, binding.goalId])}.json`);
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
  let entry;
  try { entry = await fs.lstat(file, { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1,
      goalId: binding.goalId, personaId: binding.personaId, reservations: [] };
    throw error;
  }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== BigInt(1)
    || entry.size <= BigInt(0) || entry.size > BigInt(256 * 1024)) return held();
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    await assertDirectories(binding);
    const stat = await handle.stat({ bigint: true });
    if (stat.dev !== entry.dev || stat.ino !== entry.ino || stat.size !== entry.size || !privateOwner(stat)) return held();
    const bytes = Buffer.alloc(Number(entry.size) + 1);
    let read = 0;
    while (read < bytes.length) {
      const chunk = await handle.read(bytes, read, bytes.length - read, read);
      if (!chunk.bytesRead) break;
      read += chunk.bytesRead;
    }
    const final = await handle.stat({ bigint: true });
    const after = await fs.lstat(file, { bigint: true });
    if (read !== Number(entry.size) || after.dev !== entry.dev || after.ino !== entry.ino
      || after.size !== entry.size || after.isSymbolicLink() || final.mtimeNs !== stat.mtimeNs || final.ctimeNs !== stat.ctimeNs) return held();
    const value = JSON.parse(bytes.subarray(0, read).toString('utf8')) as Ledger;
    if (value.version !== 1 || value.goalId !== binding.goalId || value.personaId !== binding.personaId
      || !Array.isArray(value.reservations) || value.reservations.length > 256
      || value.reservations.some(item => !item.invocationId || !item.acceptanceDigest
        || !['accepted', 'registered', 'exited', 'released'].includes(item.state))) return held();
    return value;
  } finally { await handle.close(); }
}

async function mutate<T>(binding: Binding, task: (ledger: Ledger) => Promise<T>): Promise<T> {
  return withWorkspaceMutation(() => withWorkspaceRuntimeLock(`native-original-${nativeDigest([binding.personaId, binding.goalId]).slice(0, 32)}`, async lock => {
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
    let temporaryIdentity;
    try {
      await handle.writeFile(bytes); await handle.sync();
      temporaryIdentity = await handle.stat({ bigint: true });
    } finally { await handle.close(); }
    await lock.assertOwned();
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
    await fs.rename(temporary, ledgerFile(binding));
    if (process.platform !== 'win32') {
      const parent = await fs.open(directory, 'r');
      try { await parent.sync(); } finally { await parent.close(); }
    }
    return result;
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
    const binding: Binding = { ...input, workspace: getCurrentWorkspace(), goalId: goal.id,
      round: goal.goal.rounds, flow, planDigest: nativeDigest([input.revisionId, flow]), authority };
    // A later lease, model or Activity cannot evade an unresolved original.
    const prior = await readLedger(binding);
    if (prior.reservations.some(item => item.state !== 'released')) return held();
    bindings.set(authority, binding);
  });
}

export interface NativeOriginalProcessHost {
  assertTurnBudget(maxTurns: number): Promise<void>;
  register(process: ClaudeOwnedProcessRegistration): Promise<void>;
  beforeFirstPrompt(): Promise<void>;
  waitForExit(): Promise<void>;
  releaseAfterTerminal(): Promise<void>;
  observeSdkUsage(result: unknown): Promise<void>;
}

/** Only a live branded Persona root run can produce the runtime capabilities. */
export async function createPersonaNativeOriginalHost(input: {
  authority?: FlowExecutionAuthority; conversationId?: string; runId?: string; nodeId?: string;
  modelId: string;
  personaAttribution?: PersonaAttribution;
}): Promise<{ broker: ReturnType<typeof createNativeBrokerAuthority>;
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
  if (model?.adapter !== 'claude-cli') {
    if (model?.adapter === 'codex-cli') return held(); // No verified public owned-child hook.
    return undefined;
  }
  // Always use the mint's captured real lease closures, including when a causal
  // wrapper carries the binding. Caller-owned wrapper methods are not authority.
  const authority = binding.authority;
  if (binding.workspace !== getCurrentWorkspace() || input.conversationId !== binding.conversationId
    || input.runId !== binding.runId || !authority.commitWhileCurrent) return held();
  const node = binding.flow.nodes.find(item => item.id === input.nodeId && item.data.type === 'process');
  if (!node || node.data.properties?.boundModel !== input.modelId) return held();
  if (model.id !== input.modelId || model.fallbackPolicy) return held();
  const maxTurns = positive(node.data.properties?.maxTurns) ?? positive(model.maxTurns) ?? DEFAULT_AGENTIC_MAX_TURNS;
  const modelPlan = (value: Model | null) => ({ id: value?.id, name: value?.name, adapter: value?.adapter,
    provider: value?.provider, maxTurns: value?.maxTurns, temperature: value?.temperature,
    reasoningEffort: value?.reasoningEffort, fallbackPolicy: value?.fallbackPolicy });
  const modelPlanDigest = nativeDigest(modelPlan(model));
  const assertCurrent = async () => {
    authority.signal.throwIfAborted(); await authority.assertCurrent(); authority.signal.throwIfAborted();
    const goal = await getPersonaWorkItem(binding.personaId, binding.goalId);
    if (!goal?.goal || goal.goal.state !== 'active' || goal.goal.rounds !== binding.round
      || goal.goal.pendingDispatchId !== binding.dispatchId) return held();
    authority.signal.throwIfAborted();
  };
  await assertCurrent();
  const broker = createNativeBrokerAuthority(binding.leaseEpoch, assertCurrent);
  const root = createNativeLineageRootBinding({ workspace: binding.workspace, fleetRunId: binding.dispatchId,
    workerId: binding.activityId, goalId: binding.goalId, rootConversationId: binding.conversationId,
    rootLogicalRunId: binding.runId, rootFlowId: binding.flow.id }, assertCurrent);
  let original: NativeInvocationSession | undefined;
  let child: ClaudeOwnedProcessRegistration | undefined;
  let exited = false;
  let closed = false;
  const update = async (task: (reservation: Reservation) => Promise<void>) => {
    if (!original) return held();
    return mutate(binding, async ledger => {
      const reservation = ledger.reservations.find(item => item.invocationId === original!.descriptor.receipt.invocationId);
      if (!reservation || reservation.descriptorDigest !== nativeDigest(original!.descriptor)) return held();
      await task(reservation);
    });
  };
  const session = createNativeInvocationSessionHook({ root,
    publish: async value => {
      if (original) return held();
      const descriptor = value.descriptor;
      const owner = descriptor.receipt.owner;
      if (owner.conversationId !== binding.conversationId || owner.runId !== binding.runId
        || owner.nodeId !== input.nodeId || owner.modelId !== input.modelId || owner.leaseEpoch !== binding.leaseEpoch
        || descriptor.archive.adapter !== 'claude-cli' || descriptor.lineage.edges.length
        || descriptor.lineage.rootFlowId !== binding.flow.id) return held();
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
        });
      });
      original = value;
      authority.signal.addEventListener('abort', () => value.cancel(), { once: true });
    },
    acknowledgeLive: async value => { if (value !== original || !child || exited || closed) return held(); await assertCurrent(); },
    acknowledgeSdkOutcome: async (value, outcome) => {
      if (value !== original || !child || !exited || !closed) return held();
      await authority.commitWhileCurrent!(() => update(async reservation => { reservation.sdkOutcome = outcome; }));
    },
    acknowledgeTerminalReady: async value => {
      if (value !== original || !child || !exited || !closed) return held();
      await assertCurrent();
    },
  });
  const processHost: NativeOriginalProcessHost = {
    observeSdkUsage: async result => {
      if (!result || typeof result !== 'object' || !child || !original) return held();
      const value = result as Record<string, unknown>;
      if (value.type !== 'result') return held();
      const usage = value.usage && typeof value.usage === 'object' ? value.usage as Record<string, unknown> : {};
      const number = (candidate: unknown): number | undefined => typeof candidate === 'number'
        && Number.isFinite(candidate) && candidate >= 0 ? candidate : undefined;
      const receipt: NonNullable<Reservation['sdkUsage']> = { source: 'claude-sdk-result',
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
      assertClaudeOwnedProcessRegistration(value, processHost);
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
      if (!child || exited || closed || !original) return held();
      if (nativeDigest(modelPlan(await modelService.getModel(input.modelId))) !== modelPlanDigest) return held();
      await assertCurrent();
      if (!await isRuntimeProcessIdentityAlive(child.identity) || exited || closed) return held();
      await assertCurrent();
    },
    waitForExit: async () => {
      if (!child || !original) return held();
      const exit = await child.exit;
      await child.close;
      exited = true; closed = true;
      // Exit observation does not require a now-revoked launch lease and never
      // releases the budget reservation or unresolved effects by itself.
      await update(async reservation => {
        if (reservation.exit && nativeDigest(reservation.exit) !== nativeDigest(exit)) return held();
        reservation.exit = exit;
        if (reservation.state !== 'released') reservation.state = 'exited';
      });
    },
    releaseAfterTerminal: async () => {
      if (!original || !exited || !closed) return held();
      const value = original;
      const terminal = await value.waitTerminal();
      if (terminal.state !== 'terminal') return held();
      await readSavedNativeTerminal({ invocationId: value.descriptor.receipt.invocationId,
        expectedOwner: value.descriptor.receipt.owner, expectedLineageDigest: value.descriptor.lineage.digest,
        expectedDescriptorDigest: nativeDigest(value.descriptor), expectedWorkspace: binding.workspace,
        assertReadAuthorized: async () => { if (value !== original || !exited || !closed) return held(); } });
      await update(async reservation => { if (reservation.sdkOutcome !== 'completed') return held(); reservation.state = 'released'; });
    },
  };
  hosts.add(processHost);
  return { broker, session, process: Object.freeze(processHost) };
}
