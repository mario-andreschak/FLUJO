import { isSelfOrchestratingAdapter, resolveModelAdapter, type ModelAdapter, type ModelProvider } from '@/shared/types/model/provider';
import type { ToolDefinition } from '../types';
import { normalizeCodeModeSetting, normalizeToolLoadingMode } from '@/shared/types/flow/toolLoading';
import { planToolLoading } from './deferredTools';
import type { StepToolCatalog } from './toolLoadingExecutors';
import {
  buildRunToolScriptTool,
  buildScriptBindings,
  offersCodeMode,
} from '../codeMode/codeModeTool';
import { defaultScriptLimits } from '../codeMode/sandbox';

export interface StepToolPlanInput {
  /** Every tool the step offers, after all filters. */
  tools: ToolDefinition[];
  nodeId?: string;
  /** The Process node's `toolLoading` and `codeMode` settings, as stored. */
  toolLoading?: unknown;
  codeMode?: unknown;
  loadedNames?: readonly string[];
  model?: {
    contextWindow?: number;
    provider?: ModelProvider;
    adapter?: ModelAdapter;
    fallbackPolicy?: unknown;
  };
  /** Private executions keep their exact approved tool list: no deferral, no code mode. */
  restricted: boolean;
}

export interface StepToolPlan {
  /** What the model is offered this turn. */
  tools: ToolDefinition[];
  catalog: StepToolCatalog;
  /** Offered to the step but not described yet. */
  deferredNames: string[];
}

/** Decide, for one turn, which tool descriptions the model gets and whether code mode is offered (#1448). */
export function planStepTools(input: StepToolPlanInput): StepToolPlan {
  const adapter = input.model ? resolveModelAdapter(input.model.provider, input.model.adapter) : undefined;
  // A fallback policy may switch adapters between attempts, so it keeps FLUJO's own loop semantics.
  const callThrough = isSelfOrchestratingAdapter(adapter) && !input.model?.fallbackPolicy;
  const plan = planToolLoading({
    tools: input.tools,
    mode: input.restricted ? 'up-front' : normalizeToolLoadingMode(input.toolLoading),
    loadedNames: input.loadedNames,
    contextWindow: input.model?.contextWindow,
    callThrough,
  });
  const codeMode = !input.restricted
    && offersCodeMode(normalizeCodeModeSetting(input.codeMode), plan.deferring, plan.mcpTools.length);
  const tools = plan.visible;
  if (codeMode) {
    const bindings = buildScriptBindings(plan.mcpTools.map((tool) => ({
      name: tool.name,
      server: tool.server ?? '',
      tool: tool.originalName ?? tool.name,
    })));
    tools.push(buildRunToolScriptTool(bindings, {
      timeoutSeconds: Math.round(defaultScriptLimits().timeoutMs / 1000),
      deferring: plan.deferring,
    }));
  }
  return {
    tools,
    catalog: { nodeId: input.nodeId, tools: plan.mcpTools, deferring: plan.deferring, callThrough, codeMode },
    deferredNames: plan.deferred.map((tool) => tool.name),
  };
}

/** Remember loaded tools on the conversation, sorted and without repeats. */
export function addLoadedDeferredTools(state: { loadedDeferredTools?: string[] }, names: readonly string[]): void {
  if (names.length === 0) return;
  const next = new Set([...(state.loadedDeferredTools ?? []), ...names]);
  if (next.size === (state.loadedDeferredTools?.length ?? 0)) return;
  state.loadedDeferredTools = [...next].sort();
}

/** Attach a value that must never be persisted, cloned or logged. */
export function attachRuntimeOnly<T extends object, K extends string, V>(target: T, key: K, value: V): void {
  Object.defineProperty(target, key, { value, enumerable: false, writable: true, configurable: true });
}
