import { createHash } from 'node:crypto';
import { isOwnerCredentialBoundModel, type Model } from '@/shared/types/model';
import {
  DEFAULT_FALLBACK_TRIGGERS, validateFallbackPolicy,
  type FallbackTrigger, type ModelRouteReceipt,
} from '@/shared/types/model/fallbackPolicy';
import { normalizeMaxTokens } from '@/shared/types/model';
import { isSelfOrchestratingAdapter, normalizeModelTemperature } from '@/shared/types/model/provider';
import { loadItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { workspaceCacheKey } from '@/utils/workspace';
import { resolveAndDecryptApiKey } from '../encryption';
import { parseRetryAfterMs } from '@/backend/execution/flow/retryAfter';
import { isFlowExecutionAuthorityError } from '@/backend/execution/flow/executionAuthority';
import type { CompletionAdapter, CompletionInput, CompletionResult } from './types';
import { executionExtensionSinglePhysicalAttempt, ExecutionExtensionError } from '@/backend/execution/extensions';

const cooldowns = new Map<string, { until: number; reason: FallbackTrigger }>();

/** Read error facts locally; raw messages/bodies never enter route receipts. */
export function fallbackReason(error: unknown): FallbackTrigger | undefined {
  if (isFlowExecutionAuthorityError(error)) return undefined;
  const root = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const details = (root.details ?? root.error ?? root) as Record<string, unknown>;
  const status = Number(root.status ?? details?.status ?? details?.statusCode ?? details?.code);
  const signature = `${root.name ?? ''} ${root.code ?? ''} ${details?.code ?? ''} ${root.message ?? ''} ${details?.message ?? ''}`;
  if (/abort|cancel|authority|budget_denied|spending_authority/i.test(signature)) return undefined;
  if (status === 401 || status === 403) return undefined;
  if (status === 429 || /rate[_ -]?limit|usage[_ -]?limit|session[_ -]?limit|insufficient_quota|quota[_ -]?(exceeded|exhausted)|reached your limit/i.test(signature)) return 'rate_limit';
  if (status === 408 || status === 504 || /TimeoutError|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(signature)) return 'timeout';
  if ((status >= 500 && status <= 599) || /APIConnectionError|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|overloaded_error/i.test(signature)) return 'unavailable';
  return undefined;
}

export class FallbackRoutingError extends Error {
  readonly code = 'fallback_exhausted';
  readonly status = 503;
  constructor(readonly routing: ModelRouteReceipt) {
    super('No eligible model in the fallback policy completed the request.');
    this.name = 'FallbackRoutingError';
  }
}

export class FallbackAdapter implements CompletionAdapter {
  constructor(private readonly adapterFor: (model: Model) => CompletionAdapter) {}

  createCompletion(input: CompletionInput): Promise<CompletionResult> {
    return this.route(input, false);
  }
  createStreamCompletion(input: CompletionInput): Promise<CompletionResult> {
    return this.route(input, true);
  }

  private async route(input: CompletionInput, stream: boolean): Promise<CompletionResult> {
    await executionExtensionSinglePhysicalAttempt(input.executionExtensionContext, input.model);
    if (input.executionExtensionContext || isOwnerCredentialBoundModel(input.model)) {
      throw new ExecutionExtensionError('execution_model_fallback_forbidden');
    }
    const models = await loadItem<Model[]>(StorageKey.MODELS, []);
    const invalid = validateFallbackPolicy(input.model, models);
    if (invalid) throw new Error(invalid);
    const policy = input.model.fallbackPolicy!;
    const routing: ModelRouteReceipt = { policyId: input.model.id, attempts: [] };
    const triggers = policy.triggers ?? DEFAULT_FALLBACK_TRIGGERS;
    const now = Date.now();
    for (const [key, value] of cooldowns) if (value.until <= now) cooldowns.delete(key);

    for (const id of policy.modelIds) {
      input.signal?.throwIfAborted();
      const model = models.find(item => item.id === id)!;
      const requiredModalities = new Set<string>();
      for (const message of input.messages) {
        if (!Array.isArray(message.content)) continue;
        for (const part of message.content) {
          if (part.type === 'image_url') requiredModalities.add('image');
          if (part.type === 'input_audio') requiredModalities.add('audio');
        }
      }
      const incompatibleMedia = [...requiredModalities].some(modality =>
        (model.inputModalities?.length && !model.inputModalities.includes(modality)) ||
        (modality === 'image' && model.visionInputCapability === 'unsupported'));
      if ((input.tools?.length && (model.supportsTools === false ||
          (input.directCompletion && isSelfOrchestratingAdapter(model.adapter)))) || incompatibleMedia) {
        routing.attempts.push({ modelId: id, outcome: 'incompatible' });
        continue;
      }
      // A configuration/credential change immediately invalidates stale cooldowns.
      const fingerprint = createHash('sha256').update(JSON.stringify({ model, policy })).digest('hex');
      const cooldownKey = workspaceCacheKey('model-fallback', input.model.id, id, fingerprint);
      const cooldown = cooldowns.get(cooldownKey);
      if (cooldown && cooldown.until > Date.now()) {
        routing.attempts.push({ modelId: id, outcome: 'cooldown', reason: cooldown.reason });
        continue;
      }
      let observable = false;
      const markObservable = () => { observable = true; };
      try {
        await input.beforeModelDispatch?.();
        const key = await resolveAndDecryptApiKey(model.ApiKey);
        const apiKey = key ?? (model.adapter === 'codex-cli' && !model.ApiKey?.trim() ? '' : null);
        if (apiKey === null) throw new Error('Failed to resolve a policy member credential.');
        await input.onRoutingModel?.(model);
        const memberInput: CompletionInput = {
          ...input, model, apiKey,
          temperature: input.temperatureOverride ?? normalizeModelTemperature(model.temperature, model.provider, model.adapter, model.name),
          maxTokens: input.maxTokens ?? normalizeMaxTokens(model.maxTokens),
          maxTurns: input.maxTurns ?? model.maxTurns,
          // A native thread belongs to one model; never resume a policy's other member.
          sessionResume: false, codexSession: undefined, onCodexSessionChange: undefined,
          consumeSteeringMessages: input.consumeSteeringMessages
            ? () => { const messages = input.consumeSteeringMessages!(); if (messages.length) markObservable(); return messages; }
            : undefined,
          steering: input.steering ? {
            subscribe: listener => input.steering!.subscribe(listener),
            take: async () => { const delivery = await input.steering!.take(); if (delivery) markObservable(); return delivery; },
          } : undefined,
          onModelDelta: delta => { markObservable(); input.onModelDelta?.(delta); },
          onTranscriptMessage: message => { markObservable(); input.onTranscriptMessage?.(message); },
          onToolProgress: progress => { markObservable(); input.onToolProgress?.(progress); },
          beforeToolDispatch: async () => {
            await input.beforeToolDispatch?.();
            markObservable();
          },
          requestToolApproval: input.requestToolApproval
            ? async call => { markObservable(); return input.requestToolApproval!(call); }
            : undefined,
          localToolExecutors: input.localToolExecutors
            ? Object.fromEntries(Object.entries(input.localToolExecutors).map(([name, executor]) => [
                name, async (args: Record<string, unknown>) => { markObservable(); return executor(args); },
              ]))
            : undefined,
        };
        const adapter = this.adapterFor(model);
        const result = stream && adapter.createStreamCompletion
          ? await adapter.createStreamCompletion(memberInput)
          : await adapter.createCompletion(memberInput);
        input.signal?.throwIfAborted();
        const inBandError = (result.completion as unknown as { error?: unknown })?.error;
        if (inBandError) throw inBandError;
        if (!result.completion?.choices?.length) throw new Error('Invalid response from policy member.');
        routing.attempts.push({ modelId: id, outcome: 'completed' });
        routing.selectedModelId = id;
        return { ...result, routing };
      } catch (error) {
        input.signal?.throwIfAborted();
        const reason = fallbackReason(error);
        routing.attempts.push({ modelId: id, outcome: 'failed', ...(reason ? { reason } : {}) });
        if (observable || !reason || !triggers.includes(reason)) throw error;
        const root = error && typeof error === 'object' ? error as { headers?: Headers | Record<string, string> } : {};
        const retryAfter = root.headers instanceof Headers ? root.headers.get('retry-after') : root.headers?.['retry-after'];
        const delay = Math.min(3600_000, Math.max((policy.cooldownSeconds ?? 60) * 1000, parseRetryAfterMs(retryAfter) ?? 0));
        if (delay > 0) {
          if (cooldowns.size >= 1000) cooldowns.delete(cooldowns.keys().next().value!);
          cooldowns.set(cooldownKey, { until: Date.now() + delay, reason });
        }
      }
    }
    throw new FallbackRoutingError(routing);
  }
}
