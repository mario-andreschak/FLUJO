import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { withWorkspaceRuntimeLock } from '@/backend/services/enduringAgents/runtimeLock';
import { flowService } from '@/backend/services/flow';
import { resolveCompletionAdapterRoute } from '@/backend/services/model/adapters/completionRoute';
import { assertSafeCollectionId, listCollectionItemEntriesStrict, loadCollectionItem, loadItem, saveCollectionItem } from '@/utils/storage/backend';
import { StorageKey, type Settings } from '@/shared/types/storage';
import { HarnessInputSchema, harnessCallLimit, normalizeHarnessTask, type HarnessRun, type HarnessProbe } from '@/shared/types/harness';
import type { Flow } from '@/shared/types/flow';
import { acceptHarnessLesson, acceptHarnessProposal, nextHarnessOperation, promptHash } from './engine';
import { scoreHarnessOutput } from './evaluation';
import { completeHarnessOperation, getHarnessModel, modelFingerprint } from './model';
import { captureHarnessTarget, harnessTargetId, harnessTargetPrompt } from './targets';
import { configureHarnessProfile, getHarnessProfile, publishHarnessVersion } from './profiles';
import { probeHarnessRuntime } from './runtimeProbe';
import { harnessAssessmentOperation, parseHarnessAssessment } from './assessment';
import { harnessDigest } from './executionScope';
import { isEncryptionLocked } from '@/utils/encryption/secure';
import { initializeHarnessHistory, readHarnessSummaries, indexHarnessRun, hasSeenHarnessTask, reserveHarnessTasks } from './history';

const COLLECTION = 'harness-experiments';
export class HarnessError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

export async function assertHarnessEnabled() {
  if (await isEncryptionLocked()) throw new HarnessError('Unlock this workspace before running Harness Lab.', 423);
  const settings = await loadItem<Settings | undefined>(StorageKey.SPEECH_SETTINGS, undefined);
  if (settings?.experimental?.harnessLabEnabled !== true) throw new HarnessError('Enable Harness Lab in Settings → Experimental first.', 403);
}

export async function listHarnessRuns(): Promise<HarnessRun[]> {
  const entries = await listCollectionItemEntriesStrict<HarnessRun>(COLLECTION);
  for (const { id, item } of entries) {
    if (!item || item.schemaVersion !== 1 || item.id !== id || !HarnessInputSchema.safeParse(item.input).success) {
      throw new HarnessError('An experiment record is invalid. Restore workspace storage before admitting new held-out data.', 409);
    }
  }
  return entries.map(entry => entry.item).sort((a, b) => b.createdAt - a.createdAt);
}

export async function getHarnessRun(id: string): Promise<HarnessRun> {
  try { assertSafeCollectionId(id); } catch { throw new HarnessError('Invalid experiment ID.'); }
  const run = await loadCollectionItem<HarnessRun | null>(COLLECTION, id, null);
  if (!run) throw new HarnessError('Experiment not found.', 404);
  if (run.schemaVersion !== 1 || run.id !== id) throw new HarnessError('Unsupported experiment record.', 409);
  return run;
}

async function persist(run: HarnessRun) {
  run.updatedAt = Date.now();
  await saveCollectionItem(COLLECTION, run.id, run);
  await indexHarnessRun(run);
}

export async function listHarnessRunSummaries() {
  await withWorkspaceRuntimeLock('harness-create', () => initializeHarnessHistory(listHarnessRuns));
  return readHarnessSummaries();
}

export async function createHarnessRun(raw: unknown, automatic?: { profileId: string; caseMessages?: HarnessRun['caseMessages']; caseInputs?: HarnessRun['caseInputs']; caseInvocations?: HarnessRun['caseInvocations'] }) {
  await assertHarnessEnabled();
  const parsed = z.object({ id: z.uuid(), input: HarnessInputSchema }).strict().safeParse(raw);
  if (!parsed.success) throw new HarnessError(parsed.error.issues.map(issue => issue.message).join(' '));
  const { id, input } = parsed.data;
  // Creation and task-history admission are serialized across processes and route bundles.
  return withWorkspaceRuntimeLock('harness-create', async lock => {
    await assertHarnessEnabled();
    const existing = await loadCollectionItem<HarnessRun | null>(COLLECTION, id, null);
    if (existing) {
      const normalized = input.target ? { ...input, basePrompt: existing.input.basePrompt } : input;
      if (JSON.stringify(existing.input) !== JSON.stringify(normalized)) throw new HarnessError('Experiment ID already used for another input.', 409);
      return existing;
    }
    const { model, route } = await getHarnessModel(input.modelId);
    const profileId = input.target ? harnessTargetId(input.target) : undefined;
    let profile = profileId ? await getHarnessProfile(profileId) : null;
    if (input.target && !profile) profile = await configureHarnessProfile(input.target, { modelId: input.modelId });
    if (automatic && (!profile?.policy.automatic || profile.id !== automatic.profileId)) throw new HarnessError('Automatic improvement is disabled.', 409);
    if (automatic && (profile!.policy.modelId !== input.modelId || profile!.policy.rubric !== input.rubric || profile!.policy.rounds !== input.rounds)) {
      throw new HarnessError('Automatic improvement settings changed before admission.', 409);
    }
    const runtime = input.target ? await captureHarnessTarget(input.target, profile?.policy.maxModelCallsPerProbe) : undefined;
    const runtimeVariants: HarnessRun['runtimeVariants'] = {};
    if (input.target?.kind === 'persona') {
      for (const invocation of new Set(Object.values(automatic?.caseInvocations ?? {}))) {
        if (invocation === 'flow' || invocation === runtime?.invocation) continue;
        runtimeVariants[invocation] = await captureHarnessTarget(input.target, profile?.policy.maxModelCallsPerProbe, 'evaluation', invocation);
        if (runtimeVariants[invocation]!.baseRevision !== runtime?.baseRevision) throw new HarnessError('The Persona behavior changed during context capture.', 409);
      }
    }
    if (runtime) {
      input.basePrompt = harnessTargetPrompt(runtime.flow, runtime.target.nodeId);
      runtime.policyHash = profile ? harnessDigest(profile.policy) : undefined;
      const active = profile?.versions.find(version => version.id === profile.activeVersionId);
      if (automatic && (runtime.target.kind === 'persona' ? active?.behaviorRevisionId : active?.flowHash) !== runtime.baseRevision) {
        throw new HarnessError('The selected source changed outside Harness Lab. Capture its baseline before resuming automatic improvement.', 409);
      }
    }
    await initializeHarnessHistory(listHarnessRuns);
    if ((await Promise.all(input.cases.filter(item => item.split === 'holdout').map(item => hasSeenHarnessTask(item.input)))).some(Boolean)) {
      throw new HarnessError('Held-out inputs must be fresh in this workspace. Previously inspected examples may be reused as training examples.');
    }
    const fingerprint = modelFingerprint(model);
    const lessonScope = harnessDigest({ domain: normalizeHarnessTask(input.domain), fingerprint,
      models: runtime?.modelFingerprints, invocations: automatic?.caseInvocations
        ? [...new Set(Object.values(automatic.caseInvocations))].sort() : runtime ? [runtime.invocation] : undefined,
      rubric: input.rubric });
    const lessons = input.reuseLessons ? (await readHarnessSummaries()).filter(run => run.status === 'completed'
      && run.eligible && run.promotedPromptHash && run.lesson && run.modelFingerprint === fingerprint
      && (run.lessonScope === lessonScope || (!runtime && !input.rubric && !run.lessonScope && normalizeHarnessTask(run.domain) === normalizeHarnessTask(input.domain)))).slice(0, 5)
      .map(run => ({ sourceId: run.id, domain: run.domain, text: run.lesson! })) : [];
    const run: HarnessRun = {
      schemaVersion: 1, id, createdAt: Date.now(), updatedAt: Date.now(), status: 'pending', input,
      model: { id: model.id, name: model.name, adapter: resolveCompletionAdapterRoute(model), authentication: route },
      modelFingerprint: fingerprint, lessonScope, lessons, frontierIds: [], callsStarted: 0, callsCompleted: 0,
      runtime, runtimeVariants, caseInvocations: automatic?.caseInvocations, profileId, origin: automatic ? 'automatic' : 'manual',
      caseMessages: automatic?.caseMessages, caseInputs: automatic?.caseInputs,
      toolReplays: Object.fromEntries(input.cases.map(item => [item.id, item.tools ?? []])),
      modelCallsStarted: 0, modelCallsCompleted: 0,
      totalTokens: 0, unknownUsageCalls: 0, modelTimeMs: 0,
      candidates: [{ id: 'baseline', round: 0, scope: 'baseline', prompt: input.basePrompt,
        promptHash: promptHash(input.basePrompt), rationale: 'Original instructions.', probes: [] }],
    };
    await lock.assertOwned();
    await reserveHarnessTasks(run);
    await persist(run);
    return run;
  });
}

export async function advanceHarnessRun(id: string, signal: AbortSignal) {
  await assertHarnessEnabled();
  z.uuid().parse(id);
  return withWorkspaceRuntimeLock(`harness-${id}`, async lock => {
    const run = await getHarnessRun(id);
    if (run.status !== 'pending') return run;
    const assertPolicy = async () => {
      if (run.origin !== 'automatic') return;
      const profile = await getHarnessProfile(run.profileId!);
      if (!profile?.policy.automatic || harnessDigest(profile.policy) !== run.runtime?.policyHash) throw new HarnessError('Automatic improvement settings changed or were disabled.', 409);
    };
    await assertPolicy();
    if (run.pendingOperation) {
      run.status = 'failed';
      run.error = 'A previous model request has an unknown outcome. Its call was counted and will not be replayed. Start a new experiment with fresh held-out examples.';
      await lock.assertOwned();
      await persist(run);
      return run;
    }
    signal.throwIfAborted();
    const operation = nextHarnessOperation(run);
    if (!operation) { await lock.assertOwned(); await persist(run); return run; }
    if (run.callsStarted >= harnessCallLimit(run.input)) throw new HarnessError('Experiment call limit reached.', 409);
    const { model } = await getHarnessModel(run.input.modelId, run.modelFingerprint);
    await assertHarnessEnabled();
    await lock.assertOwned();
    run.pendingOperation = operation.key;
    run.callsStarted++;
    await persist(run);
    const beforeCall = async () => {
      await assertHarnessEnabled();
      await assertPolicy();
      await lock.assertOwned();
      run.modelCallsStarted = (run.modelCallsStarted ?? 0) + 1;
      await persist(run);
    };
    const afterCall = async (tokens: number | null, completedCalls = 1) => {
      run.modelCallsCompleted = (run.modelCallsCompleted ?? 0) + completedCalls;
      if (tokens === null) run.unknownUsageCalls += completedCalls; else run.totalTokens += tokens;
      await lock.assertOwned(); await persist(run);
    };
    const invoke = async (next: import('./engine').HarnessOperation) => {
      await getHarnessModel(run.input.modelId, run.modelFingerprint);
      await beforeCall();
      const result = await completeHarnessOperation(model, next, signal);
      await afterCall(result.tokens);
      return result;
    };
    try {
      const result: Awaited<ReturnType<typeof completeHarnessOperation>> & Partial<HarnessProbe> = operation.kind === 'probe' && run.runtime
        ? await probeHarnessRuntime(run, operation, signal, beforeCall, afterCall) : await invoke(operation);
      await lock.assertOwned();
      run.modelTimeMs += result.durationMs;
      if (operation.kind === 'probe') {
        const candidate = run.candidates.find(item => item.id === operation.candidateId)!;
        const textScore = scoreHarnessOutput(operation.example, result.output);
        const evaluationFailure = 'evaluationFailure' in result && result.evaluationFailure;
        const originalSystemPrompts = candidate.id === 'baseline'
          ? ('systemPrompts' in result ? result.systemPrompts : undefined)
          : run.candidates[0].probes.find(probe => probe.caseId === operation.example.id)?.systemPrompts;
        const assessment = run.input.rubric && !evaluationFailure ? await invoke(harnessAssessmentOperation(run, operation.example, result.output,
          { originalSystemPrompts, toolTrace: 'toolTrace' in result ? result.toolTrace : undefined })) : undefined;
        if (assessment) run.modelTimeMs += assessment.durationMs;
        const assessed = evaluationFailure ? { quality: 0, compliance: 0, evaluatorReason: String(evaluationFailure) }
          : assessment ? parseHarnessAssessment(assessment.output) : undefined;
        candidate.probes.push({ caseId: operation.example.id, split: operation.example.split,
          promptHash: candidate.promptHash, ...result, ...textScore,
          ...(assessed ? { quality: Math.min(textScore.quality, assessed.quality), compliance: Math.min(textScore.compliance, assessed.compliance), evaluatorReason: assessed.evaluatorReason } : {}) });
      } else if (operation.kind === 'propose') {
        acceptHarnessProposal(run, operation, result.output);
      } else {
        run.lesson = acceptHarnessLesson(result.output);
      }
      run.callsCompleted++;
      run.pendingOperation = undefined;
      nextHarnessOperation(run); // Freeze selection before returning any held-out evidence.
    } catch {
      run.status = signal.aborted ? 'cancelled' : 'failed';
      // Provider errors may contain URLs, credentials or customer output; never persist them.
      run.error = signal.aborted ? 'Cancelled. Completed evidence is retained.'
        : 'The model request failed, timed out, or returned invalid output. Harness Lab did not retry or switch providers. Completed evidence is retained.';
      run.pendingOperation = undefined;
    }
    await lock.assertOwned();
    await persist(run);
    return run;
  });
}

export async function cancelHarnessRun(id: string) {
  z.uuid().parse(id);
  return withWorkspaceRuntimeLock(`harness-${id}`, async lock => {
    const run = await getHarnessRun(id);
    if (run.status === 'pending') {
      run.status = 'cancelled'; run.pendingOperation = undefined;
      await lock.assertOwned(); await persist(run);
    }
    return run;
  });
}

export async function promoteHarnessRun(id: string, automatic = false) {
  await assertHarnessEnabled();
  z.uuid().parse(id);
  return withWorkspaceRuntimeLock(`harness-${id}`, async lock => {
    const run = await getHarnessRun(id);
    if (run.status !== 'completed' || !run.decision?.eligible || !run.selectedId) throw new HarnessError('This experiment has no eligible candidate.', 409);
    if (run.runtime) {
      if (run.activatedVersionId) return run;
      const profile = await publishHarnessVersion(run, automatic);
      run.activatedVersionId = profile.versions.find(version => version.experimentId === run.id)!.id;
      run.promotedPromptHash = run.candidates.find(candidate => candidate.id === run.selectedId)!.promptHash;
      await lock.assertOwned(); await persist(run);
      return run;
    }
    await getHarnessModel(run.input.modelId, run.modelFingerprint);
    await assertHarnessEnabled();
    const selected = run.candidates.find(candidate => candidate.id === run.selectedId)!;
    // Persist identity first so a lost HTTP response cannot create duplicate agent copies.
    if (!run.promotedFlowId) { run.promotedFlowId = randomUUID(); await lock.assertOwned(); await persist(run); }
    const existing = await flowService.readFlowExecutionSnapshot(run.promotedFlowId);
    if (existing) {
      const node = existing.flow.nodes.find(item => item.type === 'process');
      if (node?.data.properties?.harnessExperimentId !== run.id || node.data.properties.promptTemplate !== selected.prompt) {
        throw new HarnessError('The created agent has changed. It will not be overwritten.', 409);
      }
    } else {
      const flow: Flow = {
        id: run.promotedFlowId, name: `${run.input.name} (evolved)`, folder: 'Harness Lab',
        description: `Experimental text-only instructions from Harness Lab ${run.id}. Checks are limited to the supplied examples.`,
        nodes: [
          { id: 'start', type: 'start', position: { x: 200, y: 0 }, data: { label: 'Start', type: 'start', properties: {} } },
          { id: 'agent', type: 'process', position: { x: 200, y: 160 }, data: { label: 'Agent', type: 'process', properties: {
            boundModel: run.input.modelId, promptTemplate: selected.prompt, excludeModelPrompt: true,
            excludeStartNodePrompt: true, excludeSystemPrompt: true, inputMode: 'latest-message',
            maxTurns: 1, maxTokens: 4096, harnessExperimentId: run.id, harnessPromptHash: selected.promptHash,
          } } },
          { id: 'finish', type: 'finish', position: { x: 200, y: 320 }, data: { label: 'Finish', type: 'finish', properties: {} } },
        ],
        edges: [{ id: 'start-agent', source: 'start', target: 'agent' }, { id: 'agent-finish', source: 'agent', target: 'finish' }],
      };
      await lock.assertOwned();
      const saved = await flowService.saveFlow(flow);
      if (!saved.success) throw new HarnessError('Could not save the evolved agent. Retry creation to reuse its reserved ID.', 500);
    }
    run.promotedPromptHash = selected.promptHash;
    await lock.assertOwned(); await persist(run);
    return run;
  });
}
