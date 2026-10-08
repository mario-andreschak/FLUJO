import type { FlujoChatMessage } from '@/shared/types/chat';
import type { FlowExecutionAuthority, SharedState } from './types';
import { loadConversationState } from './loadConversationState';
import { replaceConversationTranscript } from './conversationLog';
import { flowService } from '@/backend/services/flow';
import { ModelHandler } from './handlers/ModelHandler';
import {
  compactHistory,
  estimateTokens,
  isCompactionSummary,
} from './handlers/summarizingCompaction';
import { digestProjectedMessages, digestProjectionIdentity } from './compaction/digest';
import {
  COMPACTION_POLICY_VERSION,
  COMPACTION_PROJECTION_VERSION,
  type CompactionProjectionIdentity,
} from './compaction/types';
import { createLogger } from '@/utils/logger';

const log = createLogger('backend/execution/flow/sessionTranscriptPolicy');

export interface LogicalTranscript {
  metadata: FlujoChatMessage[];
  turns: FlujoChatMessage[][];
}

export type SessionTranscriptPreparation =
  | {
      kind: 'valid';
      state: SharedState;
      summarized: boolean;
      trimmedTurns: number;
    }
  | {
      kind: 'recovery';
      reason: 'missing' | 'corrupt';
      detail?: string;
    };

function toolCallIds(message: FlujoChatMessage): string[] {
  if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) return [];
  return message.tool_calls
    .map((call) => call?.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/**
 * Validate the canonical child transcript before reuse. Tool calls and their
 * results are treated as one atomic bundle, so a malformed persisted history is
 * abandoned rather than forwarded to a provider.
 */
export function validateSessionTranscript(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return 'messages is not an array';
  const ids = new Set<string>();
  let pendingToolIds = new Set<string>();

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index] as Partial<FlujoChatMessage>;
    if (!message || typeof message !== 'object') return `message ${index} is not an object`;
    if (typeof message.id !== 'string' || !message.id) return `message ${index} has no id`;
    if (ids.has(message.id)) return `duplicate message id ${message.id}`;
    ids.add(message.id);
    if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(String(message.role))) {
      return `message ${index} has unsupported role`;
    }

    if (message.role === 'tool') {
      const toolCallId = (message as { tool_call_id?: unknown }).tool_call_id;
      if (typeof toolCallId !== 'string' || !pendingToolIds.delete(toolCallId)) {
        return `tool result at ${index} does not match the preceding assistant call`;
      }
      continue;
    }

    if (pendingToolIds.size > 0) {
      return `assistant tool call before message ${index} is missing result(s)`;
    }
    pendingToolIds = new Set(toolCallIds(message as FlujoChatMessage));
  }

  return pendingToolIds.size > 0 ? 'final assistant tool call is missing result(s)' : undefined;
}

/** Split the transcript into metadata and top-level logical user turns. */
export function splitLogicalTurns(messages: FlujoChatMessage[]): LogicalTranscript {
  const metadata: FlujoChatMessage[] = [];
  const turns: FlujoChatMessage[][] = [];
  let current: FlujoChatMessage[] | undefined;

  for (const message of messages) {
    if (message.role === 'system' || isCompactionSummary(message) || (message.depth ?? 0) > 0) {
      metadata.push(message);
      continue;
    }
    if (message.role === 'user') {
      current = [message];
      turns.push(current);
      continue;
    }
    if (current) current.push(message);
    else metadata.push(message);
  }

  return { metadata, turns };
}

/**
 * Before an incoming task, retain at most cap - 1 completed logical turns.
 * Metadata does not count and assistant/tool bundles remain inside their turn.
 */
export function trimCompletedLogicalTurns(
  messages: FlujoChatMessage[],
  sessionTurnCap: number | undefined,
): { messages: FlujoChatMessage[]; trimmedTurns: number } {
  if (!sessionTurnCap) return { messages, trimmedTurns: 0 };
  const { metadata, turns } = splitLogicalTurns(messages);
  const keep = Math.max(0, sessionTurnCap - 1);
  const retained = keep === 0 ? [] : turns.slice(-keep);
  return {
    messages: [...metadata, ...retained.flat()],
    trimmedTurns: Math.max(0, turns.length - retained.length),
  };
}

function lastTurnTokenBudget(messages: FlujoChatMessage[]): number {
  const turns = splitLogicalTurns(messages).turns;
  const tail = turns.at(-1) ?? messages.slice(-1);
  return Math.max(1, estimateTokens(tail));
}

async function resolveSummaryModelId(state: SharedState, childFlowId: string): Promise<string | undefined> {
  const flow = state.flowSnapshot ?? await flowService.getFlow(childFlowId);
  const process = flow?.nodes?.find((node) => node.type === 'process');
  const modelId = process?.data?.properties?.boundModel;
  return typeof modelId === 'string' && modelId ? modelId : undefined;
}

/**
 * Load, validate, optionally summarize, deterministically trim, and durably
 * rewrite a resumed child transcript. The incoming task is not accepted here,
 * so it can never enter the summarized slice.
 */
export async function prepareResumedSessionTranscript(input: {
  conversationId: string;
  childFlowId: string;
  inputMode: 'resume' | 'summary' | undefined;
  sessionTurnCap?: number;
  nodeId?: string;
  executionAuthority?: FlowExecutionAuthority;
}): Promise<SessionTranscriptPreparation> {
  const state = await loadConversationState(input.conversationId);
  if (!state) return { kind: 'recovery', reason: 'missing' };

  const invalid = validateSessionTranscript(state.messages);
  if (invalid) return { kind: 'recovery', reason: 'corrupt', detail: invalid };

  const original = structuredClone(state.messages);
  let candidate = original;
  let summarized = false;

  if (input.inputMode === 'summary' && splitLogicalTurns(original).turns.length > 1) {
    try {
      const modelId = await resolveSummaryModelId(state, input.childFlowId);
      if (!modelId) throw new Error('child flow has no bound Process model');
      const projection: CompactionProjectionIdentity = {
        conversationId: input.conversationId,
        nodeId: input.nodeId,
        view: 'full-history',
        handoffPolicy: 'strip-v1',
        version: COMPACTION_PROJECTION_VERSION,
      };
      const sourceDigest = digestProjectedMessages(original);
      const projectionDigest = digestProjectionIdentity(projection);
      const compacted = await compactHistory(original, {
        keepTokens: lastTurnTokenBudget(original),
        nodeId: input.nodeId,
        conversationId: input.conversationId,
        projection,
        sourceDigest,
        projectionDigest,
        policyVersion: COMPACTION_POLICY_VERSION,
        modelId,
      }, {
        summarize: (messages, prompt) => ModelHandler.summarizeSessionHistory(
          modelId,
          messages,
          prompt,
          input.executionAuthority,
        ),
      });
      if (compacted?.artifact.summaryText.trim()) {
        candidate = compacted.wireMessages;
        summarized = true;
      } else {
        log.warn('Subflow session summary was empty; retaining resume history', {
          conversationId: input.conversationId,
        });
      }
    } catch (error) {
      log.warn('Subflow session summary failed; retaining resume history', {
        conversationId: input.conversationId,
        error,
      });
    }
  }

  const trimmed = trimCompletedLogicalTurns(candidate, input.sessionTurnCap);
  const changed = JSON.stringify(trimmed.messages) !== JSON.stringify(original);
  if (changed) {
    await replaceConversationTranscript(state, trimmed.messages);
  }

  return {
    kind: 'valid',
    state,
    summarized,
    trimmedTurns: trimmed.trimmedTurns,
  };
}
