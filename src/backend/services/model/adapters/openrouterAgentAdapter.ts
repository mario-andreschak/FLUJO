import type OpenAI from 'openai';
import type { Item } from '@openrouter/agent';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { LLM_REQUEST_TIMEOUT_MS } from '@/shared/config/timeouts';
import { rethrowFlowExecutionAuthorityError } from '@/backend/execution/flow/executionAuthority';
import type { CompletionAdapter, CompletionInput, CompletionResult } from './types';
import { contextUsageFromCompletion } from './contextUsage';
import {
  fromResponse, toResponsesInput, toResponsesTools,
  getCarriedResponsesReasoning, rememberResponsesReasoning,
} from './openaiResponsesAdapter';
import {
  buildProviderToolNameTranslation, translateToolsForProvider,
  translateMessagesForProvider, translateCompletionFromProvider,
} from './providerToolNames';

/** The SDK exposes camelCase envelopes; FLUJO's Responses translator uses wire keys.
 * Only use this on protocol envelopes, never on arbitrary function parameters. */
export function mapOpenRouterEnvelopeKeys(value: unknown, toWire = false): unknown {
  if (Array.isArray(value)) return value.map(item => mapOpenRouterEnvelopeKeys(item, toWire));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    toWire ? key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)
      : key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
    mapOpenRouterEnvelopeKeys(item, toWire),
  ]));
}

/** Use the Agent SDK's manual-tool contract: each call yields to FLUJO after one
 * provider turn, so FLUJO retains approvals, durable execution, and handoffs. */
export class OpenRouterAgentAdapter implements CompletionAdapter {
  createCompletion(input: CompletionInput): Promise<CompletionResult> {
    return this.complete(input, false);
  }

  createStreamCompletion(input: CompletionInput): Promise<CompletionResult> {
    return this.complete(input, true);
  }

  private async complete(input: CompletionInput, streaming: boolean): Promise<CompletionResult> {
    const { OpenRouter, tool, stepCountIs } = await import('@openrouter/agent');
    const effort = input.model.reasoningEffort;
    if (effort === 'ultra') throw new Error('OpenRouter Agent SDK does not support ultra reasoning effort');
    const translation = buildProviderToolNameTranslation(input.tools, input.toolNameMap);
    const tools = translateToolsForProvider(input.tools, translation);
    const messages = translateMessagesForProvider(input.messages, translation);
    const nativeTools = toResponsesTools(tools);
    const dispatchIds: string[] = [];
    const liveMessageId = streaming ? uuidv4() : undefined;
    const client = new OpenRouter({
      apiKey: input.apiKey,
      ...(input.model.baseUrl ? { serverURL: input.model.baseUrl } : {}),
      appTitle: 'FLUJO',
      hooks: {
        beforeRequest: async (_context, request) => {
          const body = await request.clone().json();
          // Manual tools do not run or validate arguments inside the SDK. Keep
          // MCP's original JSON Schema intact, including refs and composition,
          // instead of round-tripping it through the SDK's Zod tool builder.
          if (nativeTools?.length) body.tools = nativeTools;
          const outgoing = new Request(request, { body: JSON.stringify(body) });
          try {
            const id = await input.onSdkRequest?.({
              adapter: 'openrouter-agent', operation: 'callModel', request: body,
              wireMessages: input.messages,
            });
            if (id) dispatchIds.push(id);
          } catch (error) {
            rethrowFlowExecutionAuthorityError(error);
          }
          return outgoing;
        },
      },
    });
    let outcome: 'completed' | 'error' | 'cancelled' = 'completed';
    try {
      const result = client.callModel({
        model: input.model.name,
        input: mapOpenRouterEnvelopeKeys(toResponsesInput(messages,
          getCarriedResponsesReasoning(input.conversationId, input.nodeId))) as Item[],
        tools: tools?.map(definition => tool({
          name: definition.function.name,
          description: definition.function.description,
          inputSchema: z.object({}).passthrough(),
          strict: false,
          execute: false,
        })),
        stopWhen: stepCountIs(1),
        allowFinalResponse: false,
        store: false,
        include: ['reasoning.encrypted_content'],
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        ...(input.maxTokens !== undefined ? { maxOutputTokens: input.maxTokens } : {}),
        ...(effort ? { reasoning: { effort } } : {}),
        ...(input.conversationId ? { sessionId: input.conversationId } : {}),
        signal: input.signal,
      }, { timeoutMs: LLM_REQUEST_TIMEOUT_MS });
      if (streaming) {
        const toolIndexes = new Map<number, number>();
        for await (const event of result.getFullResponsesStream()) {
          if (event.type === 'response.output_text.delta') {
            input.onModelDelta?.({ messageId: liveMessageId!, contentDelta: event.delta });
          } else if (event.type === 'response.output_item.added' && event.item.type === 'function_call') {
            const index = toolIndexes.size;
            toolIndexes.set(event.outputIndex, index);
            input.onModelDelta?.({ messageId: liveMessageId!, toolCallDelta: {
              index, id: event.item.callId,
              nameDelta: translation.providerToCanonical.get(event.item.name) ?? event.item.name,
              ...(event.item.arguments ? { argumentsDelta: event.item.arguments } : {}),
            } });
          } else if (event.type === 'response.function_call_arguments.delta') {
            const index = toolIndexes.get(event.outputIndex);
            if (index !== undefined) input.onModelDelta?.({ messageId: liveMessageId!, toolCallDelta: {
              index, argumentsDelta: event.delta,
            } });
          }
        }
      }
      const response = await result.getResponse();
      if (response.error || response.status === 'failed') {
        throw new Error(response.error?.message || 'OpenRouter Agent SDK response failed');
      }
      const { completion: nativeCompletion, reasoning, media } = fromResponse(
        mapOpenRouterEnvelopeKeys(response, true) as OpenAI.Responses.Response, input.model.name);
      rememberResponsesReasoning(input.conversationId, input.nodeId,
        nativeCompletion.choices[0]?.message.tool_calls?.[0]?.id, reasoning);
      const completion = translateCompletionFromProvider(nativeCompletion, translation);
      return { completion, media,
        contextUsage: contextUsageFromCompletion(completion.usage, input.model.contextWindow),
        ...(liveMessageId ? { liveMessageId } : {}),
      };
    } catch (error) {
      outcome = input.signal?.aborted ? 'cancelled' : 'error';
      throw error;
    } finally {
      for (const dispatchId of dispatchIds) {
        await input.onSdkRequestResult?.({ dispatchId, outcome }).catch(rethrowFlowExecutionAuthorityError);
      }
    }
  }
}
