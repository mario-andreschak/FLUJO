import { runFlow } from '@/backend/execution/flow/runFlow';
import { hashBehaviorFlow } from '@/backend/services/enduringAgents/behaviorRevisions';
import { authorizePersonaCoreAppAccess } from '@/backend/services/enduringAgents/personaCoreApps';
import type { HarnessRun } from '@/shared/types/harness';
import type { HarnessOperation } from './engine';
import { assertHarnessTargetCurrent, harnessCandidateFlow } from './targets';
import { getHarnessModel } from './model';
import { withHarnessExecution, type HarnessExecutionScope } from './executionScope';

export async function probeHarnessRuntime(run: HarnessRun, operation: Extract<HarnessOperation, { kind: 'probe' }>, signal: AbortSignal,
  beforeCall: () => Promise<void>, afterCall: (tokens: number | null, completedCalls?: number) => Promise<void>) {
  const invocation = run.caseInvocations?.[operation.example.id];
  const runtime = (invocation && run.runtimeVariants?.[invocation]) || run.runtime!;
  if (run.origin === 'automatic' && !operation.example.source) {
    throw new Error('Recorded invocation semantics are missing. Collect fresh conversation evidence.');
  }
  const source = operation.example.source ?? (runtime.invocation === 'flow' ? 'chat'
    : runtime.invocation === 'persona-behavior' ? 'subflow' : 'internal');
  await assertHarnessTargetCurrent(runtime);
  const flow = harnessCandidateFlow({ ...runtime, flow: runtime.evaluationFlow ?? runtime.flow }, operation.system);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(cancel, 180_000);
  const current = async () => { signal.throwIfAborted(); controller.signal.throwIfAborted(); await assertHarnessTargetCurrent(runtime); };
  const scope: HarnessExecutionScope = { runtime, calls: 0, replayed: 0, prompts: [], trace: [], beforeCall, afterCall,
    resourceSnapshots: run.resourceSnapshots ??= {},
    personaToolPolicy: run.casePersonaToolPolicies?.[operation.example.id],
    tools: structuredClone(run.toolReplays?.[operation.example.id] ?? []), signal: controller.signal,
    authorize: async model => {
      await current();
      if (!runtime.modelFingerprints[model.id]) throw new Error('An unpinned model was requested.');
      await getHarnessModel(model.id, runtime.modelFingerprints[model.id]);
    } };
  const started = Date.now();
  try {
    const result = await withHarnessExecution(scope, () => runFlow({ flowDefinition: flow,
      ...run.caseInputs?.[operation.example.id],
      ...(run.caseMessages?.[operation.example.id] ? { messages: run.caseMessages[operation.example.id] } : { prompt: operation.user }),
      source, mode: 'ephemeral', abortSignal: controller.signal,
      requireApproval: false,
      ...(runtime.personaAttribution ? {
        ...(runtime.personaContext ? { personaInstructionContext: { ...runtime.personaContext, behaviorContentHash: hashBehaviorFlow(flow) } } : {}),
        personaAttribution: runtime.personaAttribution,
        personaCoreAppRefs: runtime.personaCoreAppRefs,
        behaviorToolRegistry: runtime.behaviorToolRegistry,
        executionAuthority: { signal: controller.signal, assertCurrent: current,
          ...(runtime.personaCoreAppRefs ? { authorizePersonaCoreMcp: async (server: string) => {
            await current(); await authorizePersonaCoreAppAccess(runtime.personaAttribution!.personaId, runtime.personaCoreAppRefs!, server);
          } } : {}),
          commitWhileCurrent: async task => { await current(); return task(); } },
      } : {}),
    }));
    const evaluationFailure = scope.failureKind === 'tool-evidence' && operation.candidateId !== 'baseline' ? scope.failed : undefined;
    if (!evaluationFailure && (scope.failed || result.status !== 'completed' || !result.outputText.trim() || result.outputText.length > 32000)) {
      throw new Error(scope.failed ?? 'The real flow did not complete a bounded evaluation.');
    }
    return { output: result.outputText || evaluationFailure || '', evaluationFailure, durationMs: Date.now() - started, tokens: result.usage?.totalTokens ?? null,
      systemPrompts: scope.prompts, replayedTools: scope.replayed, toolTrace: scope.trace, modelCalls: scope.calls };
  } finally { clearTimeout(timeout); signal.removeEventListener('abort', cancel); }
}
