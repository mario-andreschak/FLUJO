import type OpenAI from 'openai';
import type { Item } from '@openrouter/agent';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { LLM_REQUEST_TIMEOUT_MS } from '@/shared/config/timeouts';
import { rethrowFlowExecutionAuthorityError } from '@/backend/execution/flow/executionAuthority';
import { ModelTurnArchiveMemoryError } from '@/backend/execution/flow/modelTurnArchiveWriteBudget';
import { redactErrorDetails } from '@/backend/execution/flow/normalizeError';
import type { CompletionAdapter, CompletionInput, CompletionResult } from './types';
import { assertReadOnlyAssessmentInput } from './types';
import { assertExecutionExtensionConcreteAdapter } from '@/backend/execution/extensions';
import { contextUsageFromCompletion } from './contextUsage';
import { toAnthropicToolSchema } from './anthropicToolSchema';
import {
  fromResponse, toResponsesInput, toResponsesTools,
  prepareResponsesReasoning,
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

/** Observe provider SSE without using the SDK's multi-turn broadcaster. Its
 * streaming consumer can leave the execution promise unhandled on cancellation.
 * Pass bytes through with backpressure; never tee or retain response bodies. */
type ProviderEvent = { type?: string; delta?: string; outputIndex?: number;
  item?: { type?: string; callId?: string; name?: string; arguments?: string } };
function observeProviderStream(response: Response, onEvent: (event: ProviderEvent) => void): Response {
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) return response;
  const decoder = new TextDecoder();
  let frame = '';
  let tail = '';
  let skipping = false;
  const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      const text = decoder.decode(chunk, { stream: true });
      for (const character of text) {
        tail = (tail + character).slice(-4);
        if (!skipping) frame += character;
        if (frame.length > 256 * 1024) { frame = ''; skipping = true; }
        if (!tail.endsWith('\n\n') && tail !== '\r\n\r\n') continue;
        if (!skipping) {
          const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trimStart()).join('\n');
          if (data && data !== '[DONE]') {
            try { onEvent(mapOpenRouterEnvelopeKeys(JSON.parse(data)) as ProviderEvent); }
            catch { /* Observation must not alter SDK parsing or completion. */ }
          }
        }
        frame = ''; tail = ''; skipping = false;
      }
    },
  }));
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** Preserve the upstream rejection the SDK otherwise reduces to "Provider returned error". */
async function readProviderRejection(response: Response, credential: string): Promise<Error | undefined> {
  const reader = response.clone().body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) { void reader.cancel().catch(() => {}); return undefined; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const text = new TextDecoder().decode(bytes);
    const body = JSON.parse(credential ? text.split(credential).join('[REDACTED]') : text) as { error?: { message?: string; code?: unknown; metadata?: { raw?: string } } };
    if (!body.error) return undefined;
    let message = body.error.message ?? 'OpenRouter request failed';
    try {
      const native = JSON.parse(body.error.metadata?.raw ?? '{}') as { message?: string; error?: { message?: string } };
      const detail = native.error?.message ?? native.message;
      if (detail) message += `: ${detail}`;
    } catch { /* Retain a non-JSON rejection in the redacted details. */ }
    const details = redactErrorDetails({ status: response.status, ...body.error });
    const safeMessage = redactErrorDetails({ message })?.message;
    return Object.assign(new Error(typeof safeMessage === 'string' ? safeMessage : 'OpenRouter request failed'), {
      status: response.status, code: body.error.code, details,
    });
  } catch { return undefined; }
  finally { reader.releaseLock(); }
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
    await assertExecutionExtensionConcreteAdapter(input.executionExtensionContext, input.model, 'openrouter-agent');
    // Agent requests remain outside the restricted repository assessment route.
    assertReadOnlyAssessmentInput(input);
    input.signal?.throwIfAborted();
    const { OpenRouter, tool, stepCountIs } = await import('@openrouter/agent');
    const effort = input.model.reasoningEffort;
    const supports = (parameter: string) => !input.model.supportedParameters || input.model.supportedParameters.includes(parameter);
    if (effort === 'ultra') throw new Error('OpenRouter Agent SDK does not support ultra reasoning effort');
    const translation = buildProviderToolNameTranslation(input.tools, input.toolNameMap);
    const tools = translateToolsForProvider(input.tools, translation);
    const messages = translateMessagesForProvider(input.messages, translation);
    const reasoningState = prepareResponsesReasoning(input, 'openrouter-agent');
    const nativeTools = toResponsesTools(tools)?.map(definition =>
      input.model.name.startsWith('anthropic/') && definition.type === 'function'
        ? { ...definition, parameters: toAnthropicToolSchema(definition.parameters ?? {}) }
        : definition);
    const dispatchIds: string[] = [];
    let admissionError: unknown;
    const liveMessageId = streaming ? uuidv4() : undefined;
    const toolIndexes = new Map<number, number>();
    const observe = (event: ProviderEvent) => {
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
        input.onModelDelta?.({ messageId: liveMessageId!, contentDelta: event.delta });
      } else if (event.type === 'response.output_item.added' && event.item?.type === 'function_call'
          && typeof event.outputIndex === 'number' && typeof event.item.callId === 'string' && typeof event.item.name === 'string') {
        const index = toolIndexes.size;
        toolIndexes.set(event.outputIndex, index);
        input.onModelDelta?.({ messageId: liveMessageId!, toolCallDelta: {
          index, id: event.item.callId,
          nameDelta: translation.providerToCanonical.get(event.item.name) ?? event.item.name,
          ...(event.item.arguments ? { argumentsDelta: event.item.arguments } : {}),
        } });
      } else if (event.type === 'response.function_call_arguments.delta'
          && typeof event.outputIndex === 'number' && typeof event.delta === 'string') {
        const index = toolIndexes.get(event.outputIndex);
        if (index !== undefined) input.onModelDelta?.({ messageId: liveMessageId!, toolCallDelta: {
          index, argumentsDelta: event.delta,
        } });
      }
    };
    const client = new OpenRouter({
      apiKey: input.apiKey,
      ...(input.model.baseUrl ? { serverURL: input.model.baseUrl } : {}),
      appTitle: 'FLUJO',
      hooks: {
        afterSuccess: async (_context, response) => streaming ? observeProviderStream(response, observe) : response,
        afterError: async (_context, response, error) => {
          if (response && !response.ok) {
            admissionError ??= await readProviderRejection(response, input.apiKey);
          }
          return { response, error };
        },
        beforeRequest: async (_context, request) => {
          input.signal?.throwIfAborted();
          const body = await request.clone().json();
          // Manual tools do not run or validate arguments inside the SDK. Keep
          // MCP's JSON Schema rather than round-tripping through Zod. Claude
          // requires a root object projection; MCP retains original validation.
          if (nativeTools?.length) body.tools = nativeTools;
          const window = input.model.contextWindow;
          if (window && Number.isFinite(window)) {
            const serialized = JSON.stringify({ input: body.input, tools: body.tools ?? [] });
            const estimate = input.model.name.startsWith('anthropic/')
              ? Buffer.byteLength(serialized, 'utf8') : Math.ceil(serialized.length / 4);
            const budget = Math.max(0, window - (input.maxTokens ?? 8192) - 2048);
            if (estimate > budget) {
              admissionError = Object.assign(new Error('OpenRouter input exceeds the maximum context length configured for this model.'),
                { status: 413, code: 'context_length_exceeded', details: { estimate, budget } });
              throw admissionError;
            }
          }
          const outgoing = new Request(request, { body: JSON.stringify(body) });
          try {
            const id = await input.onSdkRequest?.({
              adapter: 'openrouter-agent', operation: 'callModel', request: body,
              wireMessages: input.messages,
            });
            if (id) dispatchIds.push(id);
          } catch (error) {
            if (error instanceof ModelTurnArchiveMemoryError) { admissionError = error; throw error; }
            try { rethrowFlowExecutionAuthorityError(error); }
            catch (fatal) { admissionError = fatal; throw fatal; }
          }
          input.signal?.throwIfAborted();
          return outgoing;
        },
      },
    });
    let outcome: 'completed' | 'error' | 'cancelled' = 'completed';
    try {
      const result = client.callModel({
        model: input.model.name,
        input: mapOpenRouterEnvelopeKeys(reasoningState.replay(toResponsesInput(messages))) as Item[],
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
        ...(input.temperature !== undefined && supports('temperature') ? { temperature: input.temperature } : {}),
        ...(input.maxTokens !== undefined ? { maxOutputTokens: input.maxTokens } : {}),
        ...(effort && (supports('reasoning') || supports('reasoning_effort')) ? { reasoning: { effort } } : {}),
        ...(input.conversationId ? { sessionId: input.conversationId } : {}),
        signal: input.signal,
      }, { timeoutMs: LLM_REQUEST_TIMEOUT_MS, retries: { strategy: 'none' } });
      const response = await result.getResponse();
      input.signal?.throwIfAborted();
      if (response.status === 'cancelled') {
        outcome = 'cancelled';
        throw new Error('OpenRouter Agent SDK response was cancelled');
      }
      if (response.error || response.status === 'failed') {
        throw new Error(response.error?.message || 'OpenRouter Agent SDK response failed');
      }
      if (response.status !== 'completed' && response.status !== 'incomplete') {
        throw new Error(`OpenRouter Agent SDK returned a nonterminal response: ${response.status}`);
      }
      const wireResponse = mapOpenRouterEnvelopeKeys(response, true) as OpenAI.Responses.Response;
      // The installed SDK accepts compaction on input but currently wraps it as
      // UNKNOWN on output. Restore only this recognized wire item; unrelated
      // unknown envelopes still invalidate derived replay state.
      wireResponse.output = wireResponse.output.map(item => {
        const unknown = item as unknown as { type?: string; is_unknown?: boolean;
          raw?: OpenAI.Responses.ResponseCompactionItem };
        return unknown.type === 'UNKNOWN' && unknown.is_unknown === true
          && unknown.raw?.type === 'compaction' && typeof unknown.raw.id === 'string'
          && typeof unknown.raw.encrypted_content === 'string' && unknown.raw.encrypted_content.length > 0
          ? unknown.raw : item;
      });
      const { completion: nativeCompletion, reasoning, media } = fromResponse(wireResponse, input.model.name);
      const completion = translateCompletionFromProvider(nativeCompletion, translation);
      if (response.status === 'completed') reasoningState.remember(completion, reasoning, wireResponse.output);
      return { completion, media,
        contextUsage: contextUsageFromCompletion(completion.usage, input.model.contextWindow),
        ...(liveMessageId ? { liveMessageId } : {}),
      };
    } catch (error) {
      if (outcome !== 'cancelled') outcome = input.signal?.aborted ? 'cancelled' : 'error';
      throw admissionError ?? (input.signal?.aborted ? input.signal.reason ?? error : error);
    } finally {
      for (const dispatchId of dispatchIds) {
        await input.onSdkRequestResult?.({ dispatchId, outcome }).catch(rethrowFlowExecutionAuthorityError);
      }
    }
  }
}
