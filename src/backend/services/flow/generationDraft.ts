/**
 * Deterministic hardening shared by the production generator and the editable
 * Flow-based generator.
 *
 * Keeping this in one place is important: changing the generator Flow's prompts
 * should tune its reasoning, while the safety/default/compile contract remains
 * identical to the proven production generator.
 */
import type { Flow } from '@/shared/types/flow';
import {
  applyGenerationDefaults,
  compileFlowSpec,
  type FlowSpec,
  MAX_GENERATED_FLOWS,
} from '@/utils/shared/flowSpecCompiler';
import { repairFlowSpec, type RepairChange } from '@/utils/shared/flowAutoRepair';
import { validateFlow, type FlowValidationResult } from '@/utils/shared/flowValidation';
import { guardGeneratedFlowSpec, type GuardChange } from './generationGuard';
import { mergeIssues, type GenerationContext } from './generationContext';

export const DEFAULT_GENERATED_SUBFLOW_DEPTH = 2;

/**
 * Canonical model-facing policy for generated flows. Both generator surfaces use
 * this exact text so their authored specs follow the same data-flow conventions.
 */
export const GENERATED_FLOW_AUTHORING_POLICY = `GENERATED-FLOW DEFAULTS (context saving): process nodes you leave without an explicit inputMode/outputMode are compiled with inputMode "latest-message" and outputMode "latest-message" — each step sees only the current task and later steps see only its final response, not its tool calls/results. When a step genuinely needs the whole conversation or later steps need its intermediate work, set "full-history" / "full-conversation" explicitly.

GENERATED-FLOW DATA-FLOW POLICY (IMPORTANT — carry data through the conversation, NOT scratchpad variables):
1. PREFER CONVERSATION HISTORY. For a later step to use an earlier step's output, keep that output in the thread: give the earlier (producer) step outputMode "full-conversation" (or leave "latest-message" when only its final text matters) and give the later (consumer) step inputMode "full-history" so it actually sees the producer's turn.
2. DO NOT emit \${var:NAME} in generated prompts. The scratchpad variable feature is valid for hand authoring, but unsafe for ordinary auto-generated handoff. Use history instead.
3. DO NOT emit passive "captureResource" on a process node. Process artifacts require an explicit Resource node and write_resource. Ordinary generated flows should use history.
4. Any unsafe \${var:NAME} reference is deterministically rewritten to history or removed before compilation.

FORGIVING GENERATION: missing Start/Finish nodes and obvious disconnected linear steps are repaired deterministically in author order before compilation. The complete bundle is compiled with generated-flow defaults and validated, including every inline nested flow.`;

export interface GeneratedDraftEntry {
  flow: Flow;
  validation: FlowValidationResult;
}

export interface CompileGeneratedDraftSuccess {
  success: true;
  /** The hardened complete spec that was actually compiled. */
  spec: FlowSpec;
  flow: Flow;
  flows: GeneratedDraftEntry[];
  validation: FlowValidationResult;
  guardChanges: GuardChange[];
  repairChanges: RepairChange[];
}

export interface CompileGeneratedDraftFailure {
  success: false;
  spec: FlowSpec;
  issues: Array<{ severity: string; code: string; message: string }>;
  guardChanges: GuardChange[];
  repairChanges: RepairChange[];
}

export type CompileGeneratedDraftResult =
  | CompileGeneratedDraftSuccess
  | CompileGeneratedDraftFailure;

/**
 * Apply the production generator's post-model pipeline to one complete FlowSpec:
 * scratchpad guard → forgiving structural repair → bounded bundle compile →
 * generated defaults → whole-bundle validation.
 */
export function compileGeneratedDraft(
  inputSpec: FlowSpec,
  context: GenerationContext,
  options?: { maxDepth?: number; maxFlows?: number },
): CompileGeneratedDraftResult {
  const spec = JSON.parse(JSON.stringify(inputSpec)) as FlowSpec;
  const guarded = guardGeneratedFlowSpec(spec);
  const repaired = repairFlowSpec(guarded.spec);
  const maxDepth = options?.maxDepth ?? DEFAULT_GENERATED_SUBFLOW_DEPTH;
  const maxFlows = options?.maxFlows ?? MAX_GENERATED_FLOWS;
  const compiled = compileFlowSpec(repaired.spec, context.compile, { maxDepth, maxFlows });

  if (!compiled.flow) {
    return {
      success: false,
      spec: repaired.spec,
      issues: compiled.issues,
      guardChanges: guarded.changes,
      repairChanges: repaired.changes,
    };
  }

  for (const flow of compiled.flows) applyGenerationDefaults(flow);
  const flows: GeneratedDraftEntry[] = compiled.flows.map((flow) => ({
    flow,
    validation: validateFlow(flow, {
      models: context.compile.models,
      servers: context.validatorServers,
      serverTools: context.compile.serverTools,
    }),
  }));
  const hardeningIssues = [
    ...guarded.changes.map((change) => ({
      severity: 'warning' as const,
      code: change.code,
      message: change.message,
    })),
    ...repaired.changes.map((change) => ({
      severity: 'warning' as const,
      code: change.code,
      message: change.message,
    })),
    ...compiled.issues,
  ];
  const validation = mergeIssues(hardeningIssues, {
    issues: flows.flatMap((entry) => entry.validation.issues),
    errorCount: 0,
    warningCount: 0,
    isRunnable: true,
  });

  return {
    success: true,
    spec: repaired.spec,
    flow: compiled.flow,
    flows,
    validation,
    guardChanges: guarded.changes,
    repairChanges: repaired.changes,
  };
}
