import { randomUUID } from 'node:crypto';
import type { SharedState } from '@/backend/execution/flow/types';
import { withWorkspaceRuntimeLock } from '@/backend/services/enduringAgents/runtimeLock';
import { getCurrentWorkspace, runWithWorkspace } from '@/utils/workspace';
import { loadCollectionItem, saveCollectionItem } from '@/utils/storage/backend';
import { isWorkerMode } from '@/backend/services/workspace/workerMode';
import type { HarnessObservation, HarnessProfile, HarnessToolReplay } from '@/shared/types/harnessIntegration';
import { normalizeHarnessTask, type HarnessRun } from '@/shared/types/harness';
import { isFlowInvocationSource, type FlowInvocationSource } from '@/shared/types/execution/invocation';
import { listHarnessProfiles, getHarnessProfile, saveHarnessProfile, harnessProfilesForTarget } from './profiles';
import { assertHarnessEnabled, createHarnessRun, getHarnessRun, advanceHarnessRun, promoteHarnessRun, cancelHarnessRun, listHarnessRunSummaries } from './service';
import { hasSeenHarnessTask } from './history';
import { captureHarnessTarget, harnessTargetPrompt } from './targets';
import { getHarnessExecution, harnessDigest } from './executionScope';

interface Queue { pending: string[]; job?: { id: string; observations: string[] }; nextRunAt?: number }
const queues = 'harness-queues';
const observations = (profileId: string) => `harness-observations/${profileId}`;
const getQueue = (id: string) => loadCollectionItem<Queue>(queues, id, { pending: [] });
async function updateProfile(id: string, task: (profile: HarnessProfile) => void) {
  await withWorkspaceRuntimeLock(harnessDigest({ lock: 'profile', id: id }), async () => {
    const profile = await getHarnessProfile(id);
    if (profile) { task(profile); await saveHarnessProfile(profile); }
  });
}

/** Durable admission after an actual conversation turn. Evaluations never enqueue themselves. */
export async function observeHarnessConversation(state: SharedState, admission: { completedBehaviorCall?: boolean; variables?: Record<string, string>; source?: FlowInvocationSource } = {}) {
  if (isWorkerMode() || getHarnessExecution() || (!admission.completedBehaviorCall && (state.ephemeral || (state.runDepth ?? 0) > 0))
    || !['completed', 'error', 'capped'].includes(state.status ?? '')) return;
  // A scheduled conversation may have been resumed interactively. Its saved
  // origin cannot tell us how this turn ran; require the trusted call-site input.
  if (!isFlowInvocationSource(admission.source)) return;
  try { await assertHarnessEnabled(); } catch { return; }
  const messages = state.messages ?? [];
  const userIndex = messages.findLastIndex(message => message.role === 'user' && typeof message.content === 'string');
  if (userIndex < 0) return;
  const input = String(messages[userIndex].content).trim();
  if (!input || input.length > 6000) return;
  const history = messages.slice(0, userIndex + 1);
  const executionInputs = { variables: admission.variables, mcpAppContexts: state.mcpAppContexts };
  if (history.length > 64 || JSON.stringify({ history, executionInputs }).length > 64000) return;
  const tools: HarnessToolReplay[] = [];
  for (const message of messages.slice(userIndex + 1)) {
    if (message.role !== 'assistant') continue;
    for (const call of message.tool_calls ?? []) {
      if (call.type !== 'function') continue;
      const result = messages.find(item => item.role === 'tool' && item.tool_call_id === call.id);
      if (!result || typeof result.content !== 'string' || result.content.length > 32000) continue;
      try {
        const args = JSON.parse(call.function.arguments);
        if (!args || typeof args !== 'object' || Array.isArray(args)) continue;
        const recordingId = harnessDigest({ run: state.logicalRunId ?? state.conversationId, call: call.id });
        tools.push({ name: call.function.name, arguments: args, output: result.content, recordingId });
        const mapping = state.toolNameMap?.[call.function.name];
        if (mapping) tools.push({ name: `${mapping.server}::${mapping.tool}`, arguments: args, output: result.content, recordingId });
      } catch { /* malformed evidence is never executable */ }
    }
  }
  if (tools.length > 32) return;
  const revision = state.personaAttribution?.behaviorRevisionId
    ? await (await import('@/backend/services/enduringAgents/store')).getBehaviorRevision(state.personaAttribution.behaviorRevisionId) : null;
  const owner = state.personaAttribution
    ? revision && { kind: 'persona' as const, personaId: state.personaAttribution.personaId, behaviorId: revision.behaviorId }
    : state.flowId && { kind: 'flow' as const, flowId: state.flowId };
  if (!owner) return;
  const profiles = (await harnessProfilesForTarget(owner)).filter(profile => profile.policy.automatic);
  for (const profile of profiles) {
    if (await hasSeenHarnessTask(input)) continue;
    const sourceRunId = state.logicalRunId ?? `${state.conversationId}:${messages[userIndex].id}`;
    const id = harnessDigest({ profile: profile.id, task: normalizeHarnessTask(input) });
    await withWorkspaceRuntimeLock(harnessDigest({ lock: 'queue', id: profile.id }), async () => {
      if (await loadCollectionItem(observations(profile.id), id, null)) return;
      const queue = await getQueue(profile.id);
      if (queue.pending.length >= 128) return;
      const output = [...messages].reverse().find(message => message.role === 'assistant' && typeof message.content === 'string')?.content;
      const observation: HarnessObservation = { id, profileId: profile.id, sourceRunId, createdAt: Date.now(), input,
        output: typeof output === 'string' ? output.slice(0, 32000) : '', tools, messages: structuredClone(history), executionInputs,
        invocation: !state.personaAttribution ? 'flow' : state.personaInstructionContext ? 'persona-activity' : 'persona-behavior',
        source: admission.source,
        ...(state.personaAttribution ? { personaToolPolicy: {
          maintenanceMemoryProposal: Boolean(state.executionAuthority?.proposePersonaMemoryMaintenance),
        } } : {}) };
      await saveCollectionItem(observations(profile.id), id, observation);
      queue.pending.push(id);
      // Leave the same post-conversation quiet period for Persona memory maintenance.
      if (queue.pending.length === 4 && !queue.job) queue.nextRunAt = Math.max(queue.nextRunAt ?? 0, Date.now() + profile.policy.cooldownMinutes * 60000);
      await saveCollectionItem(queues, profile.id, queue);
    });
  }
  startHarnessWorker();
}

export async function drainHarnessProfile(profile: HarnessProfile) {
  if (!profile.policy.automatic) return;
  if (profile.target.kind === 'persona') {
    const persona = await (await import('@/backend/services/enduringAgents/store')).getPersona(profile.target.personaId);
    if (!persona || ['disabled', 'error'].includes(persona.lifecycleState)) return;
  }
  const job = await withWorkspaceRuntimeLock(harnessDigest({ lock: 'queue', id: profile.id }), async () => {
    const queue = await getQueue(profile.id);
    if ((queue.nextRunAt ?? 0) > Date.now()) return undefined;
    if (!queue.job && queue.pending.length >= 4) {
      // Split is fixed before any proposal. Every generation consumes fresh independent tasks.
      queue.job = { id: randomUUID(), observations: queue.pending.splice(0, 4) };
      await saveCollectionItem(queues, profile.id, queue);
    }
    return queue.job;
  });
  if (!job) return;
  try {
    let run: HarnessRun | null;
    try { run = await getHarnessRun(job.id); } catch (error) {
      if (!(error instanceof Error) || !('status' in error) || error.status !== 404) throw error;
      run = null;
    }
    if (!run) {
      const runtime = await captureHarnessTarget(profile.target, profile.policy.maxModelCallsPerProbe);
      const records = await Promise.all(job.observations.map(id => loadCollectionItem<HarnessObservation | null>(observations(profile.id), id, null)));
      if (records.some(item => !item)) throw new Error('The queued task evidence is incomplete.');
      const selected = records as HarnessObservation[];
      if (selected.some(item => !isFlowInvocationSource(item.source))) throw new Error('Recorded invocation semantics are missing. Collect fresh task evidence.');
      run = await createHarnessRun({ id: job.id, input: {
        name: `${runtime.flow.name.slice(0, 72)} · automatic improvement`, domain: `target:${profile.id}`,
        target: profile.target, modelId: profile.policy.modelId, basePrompt: harnessTargetPrompt(runtime.flow, profile.target.nodeId),
        rounds: profile.policy.rounds, reuseLessons: true, rubric: profile.policy.rubric,
        cases: selected.map((item, index) => ({ id: item.id, split: index < 2 ? 'train' : 'holdout', input: item.input,
          required: [], forbidden: [], tools: item.tools, source: item.source })),
      } }, { profileId: profile.id, caseMessages: Object.fromEntries(selected.map(item => [item.id, item.messages ?? []])),
        caseInputs: Object.fromEntries(selected.map(item => [item.id, item.executionInputs ?? {}])),
        caseInvocations: Object.fromEntries(selected.map(item => [item.id, item.invocation ?? runtime.invocation])),
        casePersonaToolPolicies: Object.fromEntries(selected.filter(item => item.personaToolPolicy).map(item => [item.id, item.personaToolPolicy!])) });
      for (const item of selected) await saveCollectionItem(observations(profile.id), item.id, { ...item, consumedBy: job.id });
    }
    await updateProfile(profile.id, current => { current.runningExperimentId = job.id; current.lastError = undefined; });
    while (run.status === 'pending') {
      if (!(await getHarnessProfile(profile.id))?.policy.automatic) throw new Error('Automatic improvement disabled.');
      run = await advanceHarnessRun(run.id, new AbortController().signal);
    }
    if (run.status === 'completed' && run.decision?.eligible) run = await promoteHarnessRun(run.id, true);
    await updateProfile(profile.id, current => {
      current.runningExperimentId = undefined;
      current.events.push({ at: Date.now(), action: run!.activatedVersionId ? 'generation_accepted' : 'generation_retained',
        experimentId: run!.id, detail: run!.error ?? run!.decision?.reasons.join(' ') ?? run!.status });
    });
  } catch {
    try { await cancelHarnessRun(job.id); } catch { /* admission may have stopped before a run was created */ }
    await updateProfile(profile.id, current => {
      current.runningExperimentId = undefined;
      current.lastError = 'Automatic comparison stopped: disabled settings, changed source, missing evidence, or model failure. Completed evidence is retained.';
      current.events.push({ at: Date.now(), action: 'generation_stopped', experimentId: job.id, detail: current.lastError });
    });
  }
  await withWorkspaceRuntimeLock(harnessDigest({ lock: 'queue', id: profile.id }), async () => {
    const queue = await getQueue(profile.id);
    if (queue.job?.id === job.id) {
      queue.job = undefined;
      queue.nextRunAt = Date.now() + profile.policy.cooldownMinutes * 60000;
      await saveCollectionItem(queues, profile.id, queue);
    }
  });
}

const root = globalThis as typeof globalThis & { __flujoHarnessWorkers?: Map<string, { timer?: ReturnType<typeof setInterval>; running: boolean; cursor?: number }> };
const workers = root.__flujoHarnessWorkers ??= new Map();
export function wakeHarnessWorker() {
  if (isWorkerMode()) return;
  const workspace = getCurrentWorkspace();
  let worker = workers.get(workspace);
  if (!worker) { worker = { running: false }; workers.set(workspace, worker); }
  if (worker.running) return;
  worker.running = true;
  void runWithWorkspace(workspace, async () => {
    try {
      await assertHarnessEnabled();
      await listHarnessRunSummaries(); // One-time legacy migration before admitting automatic holdouts.
      await withWorkspaceRuntimeLock('harness-background-worker', async () => {
        // One bounded batch per target per pass; subsequent generations use the newly active baseline.
        const profiles = (await listHarnessProfiles()).filter(item => item.policy.automatic).sort((a, b) => a.id.localeCompare(b.id));
        const cursor = (worker!.cursor ?? 0) % Math.max(1, profiles.length);
        const selected = [...profiles.slice(cursor), ...profiles.slice(0, cursor)].slice(0, 20);
        worker!.cursor = cursor + selected.length;
        for (const profile of selected) await drainHarnessProfile(profile);
      });
    } catch { /* OFF/locked workspaces and another owner's lease are idle states */ }
    finally { worker!.running = false; }
  });
}
export function startHarnessWorker() {
  if (isWorkerMode()) return;
  const workspace = getCurrentWorkspace();
  const worker = workers.get(workspace) ?? { running: false };
  workers.set(workspace, worker);
  if (!worker.timer) {
    worker.timer = setInterval(() => runWithWorkspace(workspace, () => wakeHarnessWorker()), 60000);
    worker.timer.unref?.();
  }
  wakeHarnessWorker();
}
export async function harnessQueueSummary(profileId: string) {
  const queue = await getQueue(profileId);
  return { pendingTasks: queue.pending.length, experimentId: queue.job?.id, nextRunAt: queue.nextRunAt };
}
