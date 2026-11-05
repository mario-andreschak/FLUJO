/**
 * Comparison runs: the same examples against several flows or models, with fixed checks.
 *
 * Experiments improve one instruction on one fixed model, and they need a model to
 * propose and to judge. A comparison changes nothing and asks no model for an opinion,
 * so the answer to "which is the smallest model that gets this right?" costs only the
 * runs themselves. It uses the same evaluation scope as experiments: the run goes through
 * the real engine, and no tool has a real effect.
 */
import { z } from 'zod';
import { createLogger } from '@/utils/logger';
import { flowService } from '@/backend/services/flow';
import { modelService } from '@/backend/services/model';
import { runFlow } from '@/backend/execution/flow/runFlow';
import type { Flow } from '@/shared/types/flow';
import {
  assertSafeCollectionId,
  deleteCollectionItem,
  listCollectionItemEntriesStrict,
  loadCollectionItem,
  saveCollectionItem,
} from '@/utils/storage/backend';
import {
  HarnessComparisonInputSchema,
  harnessComparisonCaseId,
  type HarnessComparison,
  type HarnessComparisonCase,
  type HarnessComparisonResult,
  type HarnessComparisonVariantSummary,
} from '@/shared/types/harnessComparison';
import type { HarnessRuntimeSnapshot } from '@/shared/types/harnessIntegration';
import type { HarnessCase } from '@/shared/types/harness';
import { scoreHarnessOutput } from './evaluation';
import { withHarnessExecution, type HarnessExecutionScope } from './executionScope';
import { assertHarnessEnabled, HarnessError } from './service';

const log = createLogger('backend/services/harness/comparison');

const COLLECTION = 'harness-comparisons';
const CASE_DEADLINE_MS = 180_000;
const MAX_OUTPUT_CHARS = 16_000;
const NOT_RUN_RESULT = 'This is a comparison run, so the tool did not run and returned nothing.';

/** Runs in this process. A saved `running` record that is not here was cut off by a restart. */
const root = globalThis as typeof globalThis & {
  __flujoHarnessComparisons?: Map<string, { controller: AbortController; done: Promise<void> }>;
};
const active = root.__flujoHarnessComparisons ??= new Map();

const sanitizeToolName = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, '_');

/**
 * Turns the name a tool call arrived under into the tool's own name. Depending on the
 * path that is `mcp_<tool>_<hash>`, `server::tool` or, in a self-orchestrating adapter,
 * `server__tool`.
 */
function toolNameFromCall(name: string): string {
  if (name.includes('::')) return name.slice(name.lastIndexOf('::') + 2);
  const encoded = /^mcp_(.+)_[a-z0-9]+$/.exec(name);
  if (encoded) return encoded[1];
  if (name.includes('__')) return name.slice(name.lastIndexOf('__') + 2);
  return name;
}

/** A long name is cut short when it is encoded, so the called name can be a prefix. */
function isSameTool(called: string, wanted: string): boolean {
  const clean = sanitizeToolName(wanted);
  return called === wanted || called === clean || (called.length >= 40 && clean.startsWith(called));
}

function resultForTool(example: HarnessComparisonCase, called: string): string {
  const match = Object.entries(example.toolResults ?? {}).find(([name]) => isSameTool(called, name));
  return match?.[1] ?? NOT_RUN_RESULT;
}

/** The flow as this variant runs it, leaving the saved flow untouched. */
function variantFlow(flow: Flow, modelId: string | undefined): Flow {
  const copy = structuredClone(flow);
  if (!modelId) return copy;
  for (const node of copy.nodes) {
    if (node.type === 'process') node.data.properties = { ...node.data.properties, boundModel: modelId };
  }
  return copy;
}

async function runCase(
  flow: Flow,
  example: HarnessComparisonCase,
  variant: number,
  id: string,
  maxModelCalls: number,
  signal: AbortSignal,
): Promise<HarnessComparisonResult> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(cancel, CASE_DEADLINE_MS);
  let tokens: number | null = null;
  const reportedModels = new Set<string>();
  const scope: HarnessExecutionScope = {
    runtime: {
      target: { kind: 'flow', flowId: flow.id, nodeId: '' },
      flow,
      baseRevision: '',
      contextHash: '',
      modelFingerprints: {},
      invocation: 'flow',
      maxModelCallsPerProbe: maxModelCalls,
    } as HarnessRuntimeSnapshot,
    tools: [],
    calls: 0,
    replayed: 0,
    prompts: [],
    trace: [],
    signal: controller.signal,
    beforeCall: async () => { controller.signal.throwIfAborted(); },
    afterCall: async (used) => { if (used !== null) tokens = (tokens ?? 0) + used; },
    authorize: async () => { controller.signal.throwIfAborted(); },
    comparison: {
      toolResult: (name) => resultForTool(example, toolNameFromCall(name)),
      reportedModels,
    },
  };

  const started = Date.now();
  const base = {
    variant,
    caseId: id,
    missing: [],
    violations: [],
    missingTools: [],
    forbiddenToolsCalled: [],
    reportedModels: [] as string[],
    modelsUsed: [] as string[],
  };
  try {
    const result = await withHarnessExecution(scope, () => runFlow({
      flowDefinition: flow,
      prompt: example.input,
      source: 'chat',
      mode: 'ephemeral',
      abortSignal: controller.signal,
      requireApproval: false,
    }));
    const toolsCalled = [...new Set(scope.trace.map((call) => toolNameFromCall(call.name)))];
    const shared = {
      ...base,
      output: result.outputText.slice(0, MAX_OUTPUT_CHARS),
      toolsCalled,
      modelsUsed: result.modelsUsed ?? [],
      reportedModels: [...reportedModels],
      modelCalls: scope.calls,
      tokens,
      durationMs: Date.now() - started,
    };
    if (result.status !== 'completed' || scope.failed) {
      return {
        ...shared,
        status: 'error',
        error: {
          message: scope.failed ?? result.error?.message ?? `The run ended as ${result.status}.`,
          ...(result.error?.details?.code ? { code: String(result.error.details.code) } : {}),
        },
      };
    }
    const scored = scoreHarnessOutput(
      { required: example.required, forbidden: example.forbidden } as HarnessCase,
      result.outputText,
    );
    const missingTools = example.expectedTools.filter((wanted) => !toolsCalled.some((called) => isSameTool(called, wanted)));
    const forbiddenToolsCalled = example.forbiddenTools.filter((wanted) => toolsCalled.some((called) => isSameTool(called, wanted)));
    const passed = scored.missing.length === 0 && scored.violations.length === 0
      && missingTools.length === 0 && forbiddenToolsCalled.length === 0;
    return {
      ...shared,
      status: passed ? 'passed' : 'failed',
      missing: scored.missing,
      violations: scored.violations,
      missingTools,
      forbiddenToolsCalled,
    };
  } catch (error) {
    return {
      ...base,
      status: 'error',
      output: '',
      toolsCalled: [...new Set(scope.trace.map((call) => toolNameFromCall(call.name)))],
      modelCalls: scope.calls,
      tokens,
      durationMs: Date.now() - started,
      error: { message: scope.failed ?? (error instanceof Error ? error.message : String(error)) },
    };
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', cancel);
  }
}

function summarize(comparison: HarnessComparison): HarnessComparisonVariantSummary[] {
  return comparison.input.variants.map((variant, index) => {
    const results = comparison.results.filter((result) => result.variant === index);
    return {
      variant: index,
      label: variant.label ?? (variant.modelId ? `${variant.flowId} on ${variant.modelId}` : variant.flowId),
      flowId: variant.flowId,
      ...(variant.modelId ? { modelId: variant.modelId } : {}),
      passed: results.filter((result) => result.status === 'passed').length,
      failed: results.filter((result) => result.status === 'failed').length,
      errors: results.filter((result) => result.status === 'error').length,
      modelCalls: results.reduce((sum, result) => sum + result.modelCalls, 0),
      tokens: results.reduce((sum, result) => sum + (result.tokens ?? 0), 0),
      durationMs: results.reduce((sum, result) => sum + result.durationMs, 0),
    };
  });
}

/** A missed save must not stop the run: the next case saves everything again. */
async function saveProgress(comparison: HarnessComparison): Promise<void> {
  comparison.updatedAt = Date.now();
  comparison.summary = summarize(comparison);
  try {
    await saveCollectionItem(COLLECTION, comparison.id, comparison);
  } catch (error) {
    log.warn(`Could not save comparison ${comparison.id}; the next case saves it again`, error);
  }
}

async function runComparison(comparison: HarnessComparison, flows: Flow[], signal: AbortSignal): Promise<void> {
  try {
    for (let variant = 0; variant < flows.length; variant++) {
      for (let index = 0; index < comparison.input.cases.length; index++) {
        signal.throwIfAborted();
        const example = comparison.input.cases[index];
        comparison.results.push(await runCase(
          flows[variant], example, variant, harnessComparisonCaseId(example, index), comparison.input.maxModelCallsPerCase, signal,
        ));
        await saveProgress(comparison);
      }
    }
    comparison.status = 'completed';
  } catch (error) {
    if (signal.aborted) {
      comparison.status = 'cancelled';
    } else {
      comparison.status = 'failed';
      comparison.error = error instanceof Error ? error.message : String(error);
      log.error(`Comparison ${comparison.id} failed`, error);
    }
  }
  comparison.finishedAt = Date.now();
  await saveProgress(comparison);
}

export async function createHarnessComparison(raw: unknown): Promise<HarnessComparison> {
  await assertHarnessEnabled();
  const parsed = z.object({ id: z.uuid(), input: HarnessComparisonInputSchema }).strict().safeParse(raw);
  if (!parsed.success) throw new HarnessError(parsed.error.issues.map((issue) => issue.message).join(' '));
  const { id, input } = parsed.data;

  // The client reuses one id while retrying, so a repeated request does not run twice.
  const existing = await loadCollectionItem<HarnessComparison | null>(COLLECTION, id, null);
  if (existing) {
    if (JSON.stringify(existing.input) !== JSON.stringify(input)) throw new HarnessError('Comparison ID already used.', 409);
    return existing;
  }

  const ids = input.cases.map(harnessComparisonCaseId);
  if (new Set(ids).size !== ids.length) throw new HarnessError('Example IDs must be distinct.');

  const flows: Flow[] = [];
  for (const variant of input.variants) {
    const flow = await flowService.getFlow(variant.flowId);
    if (!flow) throw new HarnessError(`Flow "${variant.flowId}" was not found.`, 404);
    if (variant.modelId && !(await modelService.getModel(variant.modelId))) {
      throw new HarnessError(`Model "${variant.modelId}" was not found.`, 404);
    }
    flows.push(variantFlow(flow, variant.modelId));
  }

  const now = Date.now();
  const comparison: HarnessComparison = {
    schemaVersion: 1, id, createdAt: now, updatedAt: now, status: 'running', input, results: [], summary: [],
  };
  comparison.summary = summarize(comparison);
  await saveCollectionItem(COLLECTION, id, comparison);

  const controller = new AbortController();
  const done = runComparison(comparison, flows, controller.signal)
    .catch((error) => log.error(`Comparison ${id} stopped unexpectedly`, error))
    .finally(() => active.delete(id));
  active.set(id, { controller, done });
  return comparison;
}

/** A `running` record with no run in this process was cut off by a restart, so it says so. */
async function settleOrphan(comparison: HarnessComparison): Promise<HarnessComparison> {
  if (comparison.status !== 'running' || active.has(comparison.id)) return comparison;
  comparison.status = 'interrupted';
  comparison.finishedAt = Date.now();
  await saveProgress(comparison);
  return comparison;
}

export async function getHarnessComparison(id: string): Promise<HarnessComparison> {
  await assertHarnessEnabled();
  try { assertSafeCollectionId(id); } catch { throw new HarnessError('Invalid comparison ID.'); }
  const comparison = await loadCollectionItem<HarnessComparison | null>(COLLECTION, id, null);
  if (!comparison) throw new HarnessError('Comparison not found.', 404);
  return settleOrphan(comparison);
}

export async function listHarnessComparisons() {
  await assertHarnessEnabled();
  const entries = await listCollectionItemEntriesStrict<HarnessComparison>(COLLECTION);
  const comparisons = await Promise.all(entries.map((entry) => settleOrphan(entry.item)));
  return comparisons
    .sort((first, second) => second.createdAt - first.createdAt)
    .map(({ id, createdAt, finishedAt, status, input, summary }) => ({
      id, createdAt, finishedAt, status, name: input.name, cases: input.cases.length, summary,
    }));
}

/** Stops a comparison that is still running, and otherwise removes its record. */
export async function cancelOrDeleteHarnessComparison(id: string): Promise<{ status: 'cancelled' | 'deleted' }> {
  await assertHarnessEnabled();
  try { assertSafeCollectionId(id); } catch { throw new HarnessError('Invalid comparison ID.'); }
  const running = active.get(id);
  if (running) {
    running.controller.abort();
    await running.done;
    return { status: 'cancelled' };
  }
  if (!(await loadCollectionItem<HarnessComparison | null>(COLLECTION, id, null))) {
    throw new HarnessError('Comparison not found.', 404);
  }
  await deleteCollectionItem(COLLECTION, id);
  return { status: 'deleted' };
}

/** Resolves when a comparison running in this process has finished. */
export async function harnessComparisonFinished(id: string): Promise<void> {
  await active.get(id)?.done;
}
