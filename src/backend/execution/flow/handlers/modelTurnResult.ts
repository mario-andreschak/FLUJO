// Turns one successful provider reply into the conversation messages and the result runFlow reads.
import { createLogger } from '@/utils/logger';
import { ModelCallInput, ModelCallResult } from '../types/modelHandler';
import { ToolCallInfo } from '../types';
import { FlujoChatMessage } from '@/shared/types/chat';
import { Result } from '../errors';
import { decodeToolName } from './toolNamespace';
import OpenAI from 'openai';
import { mapOpenAiUsage } from '@/backend/services/model/adapters/openaiUsage';
import { requireFunctionToolCalls } from '@/shared/types/openai';
import { extractAssistantMedia } from '@/backend/services/model/adapters/messageUtils';
import { type FlowDurableMutationContext } from '@/backend/execution/flow/executionAuthority';
import { v4 as uuidv4 } from 'uuid';
import { classifyStatisticsError } from '@/backend/services/statistics';
import { persistModelMedia, type GeneratedImagePart } from './modelMedia';
import type { EmitFn } from '@/shared/types/execution/events';

const log = createLogger('backend/flow/execution/handlers/modelTurnResult');

/** What turning one provider reply into conversation messages needs from the model call. */
export type ModelTurnContext = {
  modelId: string;
  conversationId?: string;
  nodeId?: string;
  messages: FlujoChatMessage[];
  toolNameMap: ModelCallInput['toolNameMap'];
  durableContext: FlowDurableMutationContext;
  emit?: EmitFn;
  /** Live-only drafts; any not confirmed by a durable message are retracted. */
  liveMessageIds: ReadonlySet<string>;
  effectiveMaxTurns: number;
};

/**
 * The result of one successful model call: the complete threaded input plus
 * the new assistant message (or an agent SDK's whole transcript), with media
 * saved, usage attached, MCP tool calls labelled and the requested tool calls
 * parsed. Wire-only summaries and substitutions never reach these messages.
 */
export async function materializeModelTurn(
  context: ModelTurnContext,
  modelResponse: ModelCallResult,
): Promise<Result<ModelCallResult>> {
  const { modelId, conversationId, nodeId, messages, toolNameMap, durableContext, emit, liveMessageIds, effectiveMaxTurns } = context;
  const content = modelResponse.content || '';
  const rawResponseMedia = modelResponse.media?.length
    ? modelResponse.media
    : extractAssistantMedia(modelResponse.fullResponse?.choices?.[0]?.message);
  const responseMedia = await persistModelMedia(rawResponseMedia, conversationId, nodeId, durableContext);
  // Canonical writeback always starts from the complete threaded input. Wire
  // summaries, resource substitutions, and omissions never enter the persisted
  // conversation transcript.
  const finalMessages: FlujoChatMessage[] = [...messages];

  // Extract provider-reported token usage, if present, so the UI can show
  // per-message and aggregated token/cost figures.
  //
  // Cache RE-READ tokens (Anthropic cache_read / OpenAI cached_tokens) live in
  // the provider's `prompt_tokens_details`. They ARE part of prompt_tokens; we
  // carry the subset separately so the UI can subtract them from the headline
  // instead of counting a warmed cache as fresh input every turn (#87, and its
  // OpenAI-path sibling #89). The mapping is a small pure helper so it can be
  // unit-tested (see __tests__/model/openaiUsageMapping.test.ts).
  const usage = mapOpenAiUsage(modelResponse.fullResponse?.usage);
  const usageReport = usage ? { usage } : { usageNotReported: true as const };

  const projectMcpToolCalls = (toolCalls: unknown): FlujoChatMessage['mcpToolCalls'] => {
    if (!Array.isArray(toolCalls)) return undefined;
    const projected: NonNullable<FlujoChatMessage['mcpToolCalls']> = {};
    for (const toolCall of toolCalls) {
      if (!toolCall || typeof toolCall !== 'object') continue;
      const call = toolCall as OpenAI.ChatCompletionMessageFunctionToolCall;
      if (call.type !== 'function' || typeof call.id !== 'string') continue;
      const decoded = decodeToolName(call.function?.name, toolNameMap);
      if (decoded) projected[call.id] = { serverName: decoded.server, toolName: decoded.tool };
    }
    return Object.keys(projected).length > 0 ? projected : undefined;
  };

  const completionToolCalls = requireFunctionToolCalls(
    modelResponse.fullResponse?.choices?.[0]?.message?.tool_calls,
  );
  // A reply that reached the output limit is still a reply: keep it and tell
  // the user it was cut off, the same way for every adapter.
  const cutOff = modelResponse.fullResponse?.choices?.[0]?.finish_reason === 'length'
    ? { cutOff: 'length' as const } : {};

  if (modelResponse.transcript && modelResponse.transcript.length > 0) {
    // Self-orchestrating adapter (Claude subscription): the adapter already ran
    // the agentic tool loop in-process and handed back the full assistant/tool
    // sequence. Materialize each into the conversation so the tool calls +
    // results are visible, attaching usage to the final message.
    const baseTs = Date.now();
    const transcript = modelResponse.transcript;
    for (let idx = 0; idx < transcript.length; idx++) {
      const msg = transcript[idx];
      const isLast = idx === transcript.length - 1;
      const transcriptMedia = msg.media?.length
        ? await persistModelMedia(msg.media, conversationId, nodeId, durableContext)
        : undefined;
      finalMessages.push({
        ...msg,
        // Preserve the id/timestamp the adapter assigned (and live-emitted via
        // onTranscriptMessage) so the persisted message dedupes against the
        // already-streamed copy instead of duplicating it in the UI.
        id: msg.id ?? uuidv4(),
        timestamp: msg.timestamp ?? baseTs + idx, // keep ordering stable
        processNodeId: nodeId,
        ...(projectMcpToolCalls((msg as { tool_calls?: unknown }).tool_calls)
          ? { mcpToolCalls: projectMcpToolCalls((msg as { tool_calls?: unknown }).tool_calls) }
          : {}),
        ...(transcriptMedia?.length ? { media: transcriptMedia } : {}),
        ...(isLast ? usageReport : {}),
        ...(isLast && modelResponse.contextUsage !== undefined ? { contextUsage: modelResponse.contextUsage } : {}),
        ...(isLast && msg.role === 'assistant' ? cutOff : {}),
      } as FlujoChatMessage);
    }
  } else {
    const generatedImageParts = responseMedia.flatMap((part): GeneratedImagePart[] => {
      if (part.type !== 'image') return [];
      const url = part.url ?? (
        part.data
          ? `data:${part.mimeType ?? 'image/png'};base64,${part.data}`
          : undefined
      );
      return url ? [{ type: 'image_url', image_url: { url } }] : [];
    });
    const assistantContent = generatedImageParts.length
      ? [
          ...(content
            ? [{ type: 'text' as const, text: content }]
            : []),
          ...generatedImageParts,
        ]
      : content;

    // Create the assistant message with timestamp and ID
    const projectedMcpToolCalls = projectMcpToolCalls(completionToolCalls);
    const assistantMessage: FlujoChatMessage = {
      ...(modelResponse.providerMetadata ? { providerMetadata: modelResponse.providerMetadata } : {}),
      id: modelResponse.liveMessageId ?? uuidv4(),
      role: 'assistant',
      content: assistantContent as OpenAI.ChatCompletionAssistantMessageParam['content'],
      ...(responseMedia.length ? { media: responseMedia } : {}),
      // IMPORTANT: Include tool_calls if they exist in the raw response
      ...(completionToolCalls.length ? { tool_calls: completionToolCalls } : {}),
      ...(projectedMcpToolCalls
        ? { mcpToolCalls: projectedMcpToolCalls }
        : {}),
      timestamp: Date.now(), // Add timestamp
      processNodeId: nodeId, // Attach the process node ID
      ...usageReport,
      ...(modelResponse.contextUsage !== undefined ? { contextUsage: modelResponse.contextUsage } : {}),
      ...cutOff,
    };
    finalMessages.push(assistantMessage);
  }

  // Retract live-only drafts that never became a durable message. A draft is
  // confirmed either by onTranscriptMessage (self-orchestrating adapters) or
  // by carrying the adapter's liveMessageId into the final assistant message.
  // Anything left is a transient bubble the UI would otherwise keep showing
  // until the next refetch — e.g. a quarantined SDK turn, or an adapter whose
  // draft id could not be reconciled. Discarding it here keeps the live view
  // identical to what gets persisted (no phantom half-sentence bubbles).
  if (liveMessageIds.size > 0) {
    const materializedIds = new Set(finalMessages.map(message => message.id));
    for (const messageId of liveMessageIds) {
      if (materializedIds.has(messageId)) continue;
      emit?.({ type: 'model:end', messageId, discard: true, node: nodeId ? { nodeId } : undefined });
    }
  }

  // Map tool calls for the result structure (if they exist)
  // This provides structured info about requested calls, but doesn't execute them
  const toolCalls = completionToolCalls.length > 0 ? completionToolCalls.map((tc) => {
     try {
       return {
         name: tc.function.name,
         args: JSON.parse(tc.function.arguments),
         id: tc.id,
         result: '' // Result is empty as it's not processed here
       };
     } catch (e) {
       log.warn('Failed to parse tool arguments', {
         toolCallId: tc.id,
         errorClass: classifyStatisticsError(e),
       });
       return {
         name: tc.function.name,
         args: {}, // Use empty object on parse failure
         id: tc.id,
         result: ''
       };
     }
  }).filter(Boolean) as ToolCallInfo[] : undefined;


  // Return the result of this single step
  const result: Result<ModelCallResult> = {
    success: true,
    value: {
      content, // Final assistant text (from the model response / adapter)
      media: responseMedia,
      messages: finalMessages, // Include the new assistant message (now FlujoChatMessage[])
      fullResponse: modelResponse.fullResponse,
      toolCalls, // Pass the structured tool calls info
      effectiveMaxTurns, // #253: surface the resolved turn cap for runFlow's per-node counter
    }
  };

  log.debug('Model call completed', {
    modelId,
    nodeId,
    hasToolCalls: Boolean(toolCalls?.length),
    usagePresent: Boolean(usage),
  });
  return result;
}
