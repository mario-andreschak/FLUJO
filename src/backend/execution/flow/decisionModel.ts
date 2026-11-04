/**
 * Runs a model decision entry of a Static node.
 *
 * The check stays out of the conversation: the main model never sees the question, the
 * answer or the reason, unless a flow chooses to pass them on. A provider gets the
 * question in the shape decision models use. Today a chat model answers. A decision
 * model such as Jev or Kev would be one more provider, chosen by the bound model.
 */
import { randomUUID } from 'node:crypto';
import { admitCatalogModel, type ModelCatalogAdmission } from '@/backend/services/model/catalogAdmission';
import { createLogger } from '@/utils/logger';
import { readConditionVariable, selectConditionText, recordVariableSource } from '@/utils/shared/edgeConditions';
import { MODEL_NOT_ALLOWED_CODE, modelsOutsideBoundary } from '@/utils/shared/flowModelBoundary';
import {
  MAX_DECISION_INPUT_CHARS,
  decisionOutputSchema,
  decisionResultFrom,
  decisionSystemPrompt,
  parseChatDecisionReply,
  type DecisionModelRequest,
  type DecisionModelResponse,
  type DecisionResult,
  type ModelDecisionFailure,
} from '@/utils/shared/modelDecision';
import { MAX_DECISION_LOG } from '@/utils/shared/decisionRules';
import type { FlujoChatMessage } from '@/shared/types/chat';
import { ModelHandler } from './handlers/ModelHandler';
import type { SharedState, StaticEntry } from './types';

const log = createLogger('backend/flow/execution/decisionModel');

export interface DecisionProviderContext {
  admission: ModelCatalogAdmission;
  sharedState: SharedState;
}

/** What answers a decision. The shape matches decision models, so they fit as they are. */
export interface DecisionProvider {
  decide(request: DecisionModelRequest, context: DecisionProviderContext): Promise<DecisionModelResponse>;
}

class DecisionProviderError extends Error {
  constructor(readonly failure: ModelDecisionFailure, message: string) {
    super(message);
  }
}

const chatDecisionProvider: DecisionProvider = {
  async decide(request, { admission, sharedState }) {
    const answers: DecisionModelResponse['answers'] = {};
    for (const [name, question] of Object.entries(request.questions)) {
      const boundary = `TEXT-${randomUUID()}`;
      const response = await ModelHandler.askOnce(admission, {
        system: decisionSystemPrompt(question),
        user: `The text to judge is between the two ${boundary} lines.\n${boundary}\n${request.state}\n${boundary}`,
        outputSchema: decisionOutputSchema(question),
        maxTokens: 400,
        shouldAbort: () => !!sharedState.isCancelled || !!sharedState.abortSignal?.aborted,
        onModelRouted: (modelId) => recordModelUsed(sharedState, modelId),
        durableContext: {
          executionAuthority: sharedState.executionAuthority,
          personaAttribution: sharedState.personaAttribution,
        },
      });
      if (!response.success) throw new DecisionProviderError('model_unavailable', response.error?.message ?? 'The model did not answer.');
      addUsage(sharedState, admission.model.id, response.value.fullResponse?.usage);
      const answer = parseChatDecisionReply(question, response.value.content ?? '');
      if (!answer) throw new DecisionProviderError('invalid_answer', 'The model gave an answer the question does not allow.');
      answers[name] = answer;
    }
    return { answers };
  },
};

function recordModelUsed(sharedState: SharedState, modelId: string): void {
  if (!sharedState.modelsUsed?.includes(modelId)) sharedState.modelsUsed = [...(sharedState.modelsUsed ?? []), modelId];
}

function addUsage(
  sharedState: SharedState,
  nodeKey: string,
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null | undefined,
): void {
  if (!usage) return;
  const prompt = usage.prompt_tokens ?? 0;
  const completion = usage.completion_tokens ?? 0;
  const total = usage.total_tokens ?? prompt + completion;
  const totals = sharedState.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0, byNode: {} };
  totals.promptTokens += prompt;
  totals.completionTokens += completion;
  totals.totalTokens += total;
  const node = totals.byNode[nodeKey] ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 };
  node.promptTokens += prompt;
  node.completionTokens += completion;
  node.totalTokens += total;
  totals.byNode[nodeKey] = node;
  sharedState.usage = totals;
}

type ModelDecisionEntry = Extract<StaticEntry, { kind: 'modelDecision' }>;

function inputOf(entry: ModelDecisionEntry, sharedState: SharedState, visibleMessages: FlujoChatMessage[]): string | null {
  const text = entry.target === 'variable'
    ? readConditionVariable(entry.variable, sharedState.variables)
    : selectConditionText(visibleMessages, entry.target ?? 'last-user');
  return text?.trim() ? text.slice(0, MAX_DECISION_INPUT_CHARS) : null;
}

/** Store the result where rules and edges read it, marked as coming from a model. */
function capture(entry: ModelDecisionEntry, sharedState: SharedState, nodeId: string, result: DecisionResult): void {
  sharedState.variables ??= {};
  Object.defineProperty(sharedState.variables, entry.captureVariable, {
    value: JSON.stringify(result), configurable: true, enumerable: true, writable: true,
  });
  recordVariableSource(sharedState, entry.captureVariable, 'model');
  sharedState.decisionLog = [
    ...(sharedState.decisionLog ?? []),
    {
      nodeId,
      ruleId: entry.captureVariable,
      outcome: result.value ?? 'failed',
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.probability !== undefined ? { probability: result.probability } : {}),
      model: result.model,
      ...(result.failed ? { failed: true as const } : {}),
      at: new Date().toISOString(),
      ...(sharedState.logicalRunId ? { runId: sharedState.logicalRunId } : {}),
    },
  ].slice(-MAX_DECISION_LOG);
}

/**
 * Ask the model. Returns the failure that should stop the run, or null to carry on. The
 * flow's allowed list is not a failure to work around, so breaking it always throws.
 */
export async function runModelDecision(
  entry: ModelDecisionEntry,
  sharedState: SharedState,
  nodeId: string,
  visibleMessages: FlujoChatMessage[],
): Promise<ModelDecisionFailure | null> {
  if (sharedState.executionExtensionContext) {
    throw new Error(`Static node ${nodeId}: a model decision is not available in this kind of run.`);
  }
  let failure: ModelDecisionFailure | null = null;
  let reason = '';
  try {
    const admission = await admitCatalogModel(entry.boundModel);
    const outside = modelsOutsideBoundary(admission.model, sharedState.allowedModels);
    if (outside.length > 0) {
      const message = `This flow may not use model "${outside.join('", "')}". Only the models on its allowed list can be used.`;
      throw Object.assign(new Error(message), { details: { code: MODEL_NOT_ALLOWED_CODE, status: 403, type: 'invalid_request_error' } });
    }
    if (!admission.model.fallbackPolicy) recordModelUsed(sharedState, admission.model.id);
    const state = inputOf(entry, sharedState, visibleMessages);
    if (state === null) throw new DecisionProviderError('no_input', 'There is no text to judge.');
    const response = await chatDecisionProvider.decide({ state, questions: { [entry.captureVariable]: entry.question } }, { admission, sharedState });
    const result = decisionResultFrom(entry.question, response.answers[entry.captureVariable], admission.model.id);
    if (!result) throw new DecisionProviderError('invalid_answer', 'The answer does not fit the question.');
    capture(entry, sharedState, nodeId, result);
    log.info('Model decision', { nodeId, variable: entry.captureVariable, value: result.value, probability: result.probability });
    return null;
  } catch (error) {
    if ((error as { details?: { code?: string } }).details?.code === MODEL_NOT_ALLOWED_CODE) throw error;
    failure = error instanceof DecisionProviderError ? error.failure : 'model_unavailable';
    reason = error instanceof Error ? error.message : String(error);
  }
  log.warn('Model decision failed', { nodeId, variable: entry.captureVariable, failure, reason });
  if ((entry.onFailure ?? 'fail') === 'fail') return failure;
  capture(entry, sharedState, nodeId, {
    ...(entry.failureValue ? { value: entry.failureValue } : {}),
    reason: failure,
    model: entry.boundModel,
    failed: true,
  });
  return null;
}
