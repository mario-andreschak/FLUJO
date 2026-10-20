import { createHash, randomUUID } from 'node:crypto';
import type { Interactions } from '@google/genai';
import type OpenAI from 'openai';
import type { ModelProviderMetadata, FlujoFunctionToolCall } from '@/shared/types/openai';
import { mediaTypeFromMime } from '@/shared/types/model/media';
import type { ModelMediaPart } from '@/shared/types/model/media';
import type { CompletionInput, CompletionResult } from './types';
import { extractText, parseToolArgs } from './messageUtils';
import { toGeminiContents } from './geminiMessages';
import { mapInteractionUsage, interactionContextUsage } from './geminiUsage';
import { geminiToolSchema } from './geminiToolSchema';

type Assistant = OpenAI.ChatCompletionAssistantMessageParam & { providerMetadata?: ModelProviderMetadata };

function transcriptHash(message: Assistant): string {
  return createHash('sha256').update(JSON.stringify([
    extractText(message.content ?? ''),
    (message.tool_calls ?? []).map(call => call.type === 'function'
      ? [call.id, call.function.name, parseToolArgs(call.function.arguments)] : call),
  ])).digest('hex');
}

/** Stateless history: retain native signed steps, but never replay stale/edited content. */
export async function toInteractionInput(messages: CompletionInput['messages'], model: string, signal?: AbortSignal) {
  const input: Interactions.Step[] = [];
  const system: string[] = [];
  const names = new Map<string, string>();
  for (const message of messages) {
    signal?.throwIfAborted();
    if (message.role === 'system' || message.role === 'developer') {
      system.push(extractText(message.content));
    } else if (message.role === 'user') {
      // Reuse the bounded media fetcher and media normalization for native Gemini.
      const { contents } = await toGeminiContents([message], signal);
      const content: Interactions.Content[] = [];
      for (const part of contents.flatMap(item => item.parts ?? [])) {
        if (part.text !== undefined) content.push({ type: 'text', text: part.text });
        const mime = part.inlineData?.mimeType ?? part.fileData?.mimeType;
        if (mime) {
          const type = mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'audio'
            : mime.startsWith('video/') ? 'video' : 'document';
          content.push({ type, mime_type: mime,
            ...(part.inlineData?.data ? { data: part.inlineData.data } : { uri: part.fileData?.fileUri }),
          });
        }
      }
      input.push({ type: 'user_input', content });
    } else if (message.role === 'assistant') {
      const assistant = message as Assistant;
      for (const call of assistant.tool_calls ?? []) {
        if (call.type === 'function') names.set(call.id, call.function.name);
      }
      const replay = assistant.providerMetadata?.geminiInteraction;
      if (replay?.model === model && replay.transcriptHash === transcriptHash(assistant)) {
        input.push(...structuredClone(replay.steps));
        continue;
      }
      if (replay?.model === model && assistant.tool_calls?.length) {
        throw new Error('Gemini tool-call history was edited after signing. Start a new turn without the edited tool exchange.');
      }
      const text = extractText(assistant.content ?? '');
      if (text) input.push({ type: 'model_output', content: [{ type: 'text', text }] });
      for (const call of assistant.tool_calls ?? []) {
        if (call.type !== 'function') continue;
        // Existing GenerateContent conversations can retain their original signature.
        const signature = (call as FlujoFunctionToolCall).providerMetadata?.gemini?.thoughtSignature;
        if (signature) input.push({ type: 'thought', signature });
        input.push({ type: 'function_call', id: call.id, name: call.function.name,
          arguments: parseToolArgs(call.function.arguments) });
      }
    } else if (message.role === 'tool') {
      input.push({ type: 'function_result', call_id: message.tool_call_id,
        ...(names.has(message.tool_call_id) ? { name: names.get(message.tool_call_id) } : {}),
        result: [{ type: 'text', text: extractText(message.content) }] });
    }
  }
  return { input, ...(system.length ? { system_instruction: system.join('\n\n') } : {}) };
}

export async function interactionRequest(input: CompletionInput): Promise<Interactions.CreateModelInteractionParamsNonStreaming> {
  const { model, messages, signal, tools, temperature, maxTokens } = input;
  // The API has no numeric thinking-budget setting. Do not silently discard a saved cap.
  if (!model.thinkingLevel && typeof model.thinkingBudget === 'number' && model.thinkingBudget >= 0) {
    throw new Error('Gemini Interactions uses thinking levels. Open and save this model to clear its old thinking token budget, or choose a thinking level.');
  }
  const modalities = model.outputModalities?.map(value => value.toLowerCase())
    .filter((value): value is 'text' | 'image' | 'audio' => ['text', 'image', 'audio'].includes(value));
  return {
    model: model.name.replace(/^models\//, ''),
    ...await toInteractionInput(messages, model.name, signal),
    store: false,
    generation_config: {
      ...(temperature !== undefined && !/^gemini-4/i.test(model.name) ? { temperature } : {}),
      ...(maxTokens !== undefined ? { max_output_tokens: maxTokens } : {}),
      ...(model.thinkingLevel ? { thinking_level: model.thinkingLevel } : {}),
    },
    ...(tools?.length ? { tools: tools.map(tool => ({ type: 'function' as const,
      name: tool.function.name, description: tool.function.description,
      parameters: geminiToolSchema(tool.function.parameters ?? { type: 'object', properties: {} }),
    })) } : {}),
    ...(modalities?.some(value => value !== 'text') ? { response_modalities: modalities } : {}),
  };
}

export function interactionResult(model: CompletionInput['model'], response: Interactions.Interaction): CompletionResult {
  if (!['completed', 'requires_action'].includes(response.status) || response.errors?.length) {
    throw new Error(`Gemini interaction did not complete (${response.status || 'missing status'}).`);
  }
  const steps = (response.steps ?? []).filter(step => !['user_input', 'function_result'].includes(step.type));
  const calls: FlujoFunctionToolCall[] = [];
  const media: ModelMediaPart[] = [];
  let text = '';
  for (const step of steps) {
    if (step.type === 'function_call') {
      if (!step.id || !step.name || !step.arguments || typeof step.arguments !== 'object' || Array.isArray(step.arguments)
        || calls.some(call => call.id === step.id)) throw new Error('Gemini returned an invalid function call.');
      calls.push({ id: step.id, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.arguments) } });
    } else if (step.type === 'model_output') {
      if (step.error) throw new Error('Gemini could not generate this response.');
      for (const content of step.content ?? []) {
        if (content.type === 'text') text += content.text ?? '';
        else if (['image', 'audio', 'video', 'document'].includes(content.type) && ('data' in content || 'uri' in content)) {
          const mimeType = 'mime_type' in content ? content.mime_type ?? 'application/octet-stream' : 'application/octet-stream';
          media.push({ type: mediaTypeFromMime(mimeType), mimeType,
            ...('data' in content && content.data ? { data: content.data } : {}),
            ...('uri' in content && content.uri ? { url: content.uri } : {}),
          });
        }
      }
    } else if (step.type !== 'thought') {
      throw new Error(`Gemini returned an unsupported interaction step: ${step.type}.`);
    }
  }
  if (response.status === 'requires_action' && calls.length === 0) throw new Error('Gemini requested an unsupported action.');
  const message: OpenAI.ChatCompletionMessage & { providerMetadata?: ModelProviderMetadata } = {
    role: 'assistant', content: text || null, refusal: null,
    ...(calls.length ? { tool_calls: calls } : {}),
  };
  const providerMetadata: ModelProviderMetadata = { geminiInteraction: {
    model: model.name, transcriptHash: transcriptHash(message), steps: structuredClone(steps),
  } };
  message.providerMetadata = providerMetadata;
  return {
    completion: { id: response.id || `gemini_${randomUUID()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000),
      model: model.name, choices: [{ index: 0, finish_reason: calls.length ? 'tool_calls' : 'stop', logprobs: null, message }],
      usage: mapInteractionUsage(response.usage) },
    media, providerMetadata, contextUsage: interactionContextUsage(response.usage, model.contextWindow),
  };
}

/** Assemble typed SSE steps before exposing any executable calls to the flow. */
export async function readInteractionStream(stream: AsyncIterable<Interactions.InteractionSSEEvent>, input: CompletionInput): Promise<CompletionResult> {
  const liveMessageId = `stream_${randomUUID()}`;
  const steps = new Map<number, Interactions.Step>();
  const argumentsByIndex = new Map<number, string>();
  const callIndexes = new Map<number, number>();
  const open = new Set<number>();
  let interaction: Interactions.Interaction | undefined;
  let usage: Interactions.Usage | undefined;
  let terminal = false;
  const emitText = (text: string) => { if (text) input.onModelDelta?.({ messageId: liveMessageId, contentDelta: text }); };
  for await (const event of stream) {
    input.signal?.throwIfAborted();
    if (event.event_type === 'error') throw new Error('Gemini interaction stream failed.');
    if (event.event_type === 'interaction.created' || event.event_type === 'interaction.completed') {
      interaction = event.interaction;
      usage = interaction.usage ?? usage;
      if (event.event_type === 'interaction.completed') terminal = true;
    } else if (event.event_type === 'interaction.status_update') {
      usage = event.usage ?? usage;
      if (interaction) interaction.status = event.status;
    } else if (event.event_type === 'step.start') {
      if (steps.has(event.index)) throw new Error('Gemini repeated a streamed step.');
      const step = structuredClone(event.step);
      steps.set(event.index, step);
      open.add(event.index);
      if (step.type === 'model_output') for (const part of step.content ?? []) { if (part.type === 'text') emitText(part.text ?? ''); }
      if (step.type === 'function_call') {
        const index = callIndexes.size;
        callIndexes.set(event.index, index);
        input.onModelDelta?.({ messageId: liveMessageId, toolCallDelta: { index, id: step.id, nameDelta: step.name } });
      }
    } else if (event.event_type === 'step.delta') {
      usage = event.metadata?.total_usage ?? usage;
      const step = steps.get(event.index);
      const delta = event.delta;
      if (!step || !open.has(event.index)) throw new Error('Gemini streamed a delta outside its step.');
      if (delta.type === 'arguments_delta' && step.type === 'function_call') {
        argumentsByIndex.set(event.index, (argumentsByIndex.get(event.index) ?? '') + (delta.arguments ?? ''));
        input.onModelDelta?.({ messageId: liveMessageId,
          toolCallDelta: { index: callIndexes.get(event.index)!, argumentsDelta: delta.arguments ?? '' } });
      } else if (delta.type === 'thought_signature' && step.type === 'thought') {
        step.signature = (step.signature ?? '') + (delta.signature ?? '');
      } else if (delta.type === 'thought_summary' && step.type === 'thought') {
        if (delta.content?.type === 'text' || delta.content?.type === 'image') (step.summary ??= []).push(delta.content);
      } else if (step.type === 'model_output' && delta.type === 'text') {
        const content = step.content ??= [];
        const last = content.at(-1);
        if (last?.type === 'text') last.text = (last.text ?? '') + (delta.text ?? '');
        else content.push({ type: 'text', text: delta.text ?? '' });
        emitText(delta.text ?? '');
      } else if (step.type === 'model_output' && ['image', 'audio', 'video', 'document'].includes(delta.type)) {
        // Binary deltas are independently base64 encoded; concatenate decoded bytes.
        const part = delta as Interactions.ImageContent | Interactions.AudioContent | Interactions.VideoContent | Interactions.DocumentContent;
        const content = step.content ??= [];
        const last = content.at(-1);
        if (last?.type === part.type && 'data' in last && last.data && part.data && !part.uri) {
          last.data = Buffer.concat([Buffer.from(last.data, 'base64'), Buffer.from(part.data, 'base64')]).toString('base64');
        } else content.push(structuredClone(part));
      } else {
        throw new Error(`Gemini returned an unsupported streamed delta: ${delta.type}.`);
      }
    } else if (event.event_type === 'step.stop') {
      if (!open.delete(event.index)) throw new Error('Gemini stopped an unknown streamed step.');
      usage = event.usage ?? usage;
      const step = steps.get(event.index)!;
      if (step.type === 'function_call') {
        const args = argumentsByIndex.get(event.index);
        if (args !== undefined) step.arguments = JSON.parse(args);
        else input.onModelDelta?.({ messageId: liveMessageId, toolCallDelta: {
          index: callIndexes.get(event.index)!, argumentsDelta: JSON.stringify(step.arguments ?? {}),
        } });
      }
    }
  }
  input.signal?.throwIfAborted();
  if (!terminal || !interaction || open.size) throw new Error('Gemini interaction stream ended before completion.');
  const result = interactionResult(input.model, { ...interaction, usage,
    steps: interaction.steps?.length ? interaction.steps : [...steps.entries()].sort(([a], [b]) => a - b).map(([, step]) => step),
  });
  for (const media of result.media ?? []) input.onModelDelta?.({ messageId: liveMessageId, mediaPart: media });
  return { ...result, liveMessageId };
}
