import { createHash } from 'node:crypto';
import { modelService } from '@/backend/services/model';
import { getCompletionAdapter } from '@/backend/services/model/adapters';
import { resolveCompletionAdapterRoute } from '@/backend/services/model/adapters/completionRoute';
import { inspectCodexLogin } from '@/backend/services/model/adapters/codexAuth';
import { harnessModelRoute } from '@/shared/harnessModelPolicy';
import type { Model } from '@/shared/types/model';
import type { HarnessOperation } from './engine';

export const modelFingerprint = (model: Model) => createHash('sha256').update(JSON.stringify(model)).digest('hex');

export class HarnessModelError extends Error {}

export async function getHarnessModel(modelId: string, fingerprint?: string) {
  const loaded = await modelService.getModel(modelId);
  const model = loaded ? structuredClone(loaded) : null;
  const route = model && harnessModelRoute(model);
  if (!model || !route) throw new HarnessModelError('Choose a keyless Codex Luna, Terra or Sol connection, or an explicit approved OpenRouter text model. Routers and fallback policies are not supported.');
  if (fingerprint && fingerprint !== modelFingerprint(model)) throw new HarnessModelError('The model configuration changed. Start a new experiment for a controlled comparison.');
  if (route === 'codex-subscription') {
    if (process.env.FLUJO_CODEX_APP_SERVER === '0') throw new HarnessModelError('Harness Lab requires the managed Codex app-server transport.');
    if ((await inspectCodexLogin()).authentication !== 'login-detected') throw new HarnessModelError('Connect a Codex ChatGPT subscription login in AI Setup first. API-key authentication is not supported for this route.');
  }
  return { model, route };
}

export async function completeHarnessOperation(model: Model, operation: HarnessOperation, signal: AbortSignal) {
  const route = harnessModelRoute(model);
  if (!route) throw new Error('Unsupported model route.');
  const apiKey = route === 'codex-subscription' ? '' : await modelService.resolveAndDecryptApiKey(model.ApiKey);
  if (apiKey === null || (route === 'openrouter' && !apiKey)) throw new Error('The selected model credentials are unavailable.');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(cancel, 180_000);
  let outputChars = 0;
  const started = Date.now();
  try {
    signal.throwIfAborted();
    const adapter = getCompletionAdapter(model);
    const result = await adapter.createCompletion({
      model, apiKey, signal: controller.signal,
      messages: [{ role: 'system', content: operation.system }, { role: 'user', content: operation.user }],
      maxTokens: 4096, maxTurns: 1, temperature: 0,
      ...(route === 'codex-subscription' ? { harnessTextOnly: true } : { readOnlyAssessment: true }),
      onModelDelta: delta => {
        outputChars += delta.contentDelta?.length ?? 0;
        if (outputChars > 32000) controller.abort();
      },
    });
    controller.signal.throwIfAborted();
    if (result.completion.model.replace(/:free$/, '') !== model.name.replace(/:free$/, '')) {
      throw new Error('The provider returned a different model identity.');
    }
    const message = result.completion.choices[0]?.message;
    if (typeof message?.content !== 'string' || !message.content.trim() || message.content.length > 32000
      || message.tool_calls?.length || result.transcript?.some(item => item.role === 'tool' || item.tool_calls?.length)
      || result.completion.choices[0]?.finish_reason === 'length') {
      throw new Error('The model did not return a complete bounded text answer.');
    }
    const tokens = result.completion.usage?.total_tokens;
    return { output: message.content, durationMs: Date.now() - started,
      tokens: typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0 ? tokens : null };
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', cancel);
  }
}

export async function harnessModelOptions() {
  const models = await modelService.loadModels();
  return models.filter(model => harnessModelRoute(model)).map(model => ({
    id: model.id, name: model.name, label: model.displayName || model.name,
    authentication: harnessModelRoute(model)!, adapter: resolveCompletionAdapterRoute(model),
  })).sort((a, b) => Number(b.authentication === 'codex-subscription') - Number(a.authentication === 'codex-subscription')
    || Number(b.name.includes('luna')) - Number(a.name.includes('luna')) || a.label.localeCompare(b.label));
}
