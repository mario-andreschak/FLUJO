import { modelService } from '@/backend/services/model';
import { resolveAndDecryptApiKey } from '@/backend/services/model/encryption';
import { resolveModelAdapter } from '@/shared/types/model/provider';
import type { Model } from '@/shared/types/model/model';
import type { WorkspaceAllowance } from '@/shared/types/model/allowance';
import { allowanceAccountKey, readAllowanceSnapshot, recordAllowanceSnapshot, recordAllowanceFailure, allowanceRefreshFailure } from './store';
import { projectModelAllowance } from './projection';
import { allowanceEntityModels } from './entities';
import { collectCodexAllowance, readCodexAllowanceAccountKey } from './codex';
import { collectClaudeAccountAllowance, ClaudeAllowanceError } from './claudeAccount';

const refreshes = new Map<string, Promise<void>>();

async function savedModels(): Promise<Model[]> {
  const result = await modelService.listModels();
  if (!result.success || !result.models) throw new Error('allowance_models_unavailable');
  return result.models;
}

/** GET only projects observations; it never starts a CLI or contacts a provider. */
export async function workspaceAllowance(): Promise<WorkspaceAllowance> {
  const models = await savedModels();
  const hasCodexSubscription = models.some(model => !model.fallbackPolicy
    && resolveModelAdapter(model.provider, model.adapter) === 'codex-cli' && !model.ApiKey);
  const codexKey = hasCodexSubscription ? await readCodexAllowanceAccountKey().catch(() => undefined) : undefined;
  const credentials = new Map<string, Promise<string | null>>();
  const rows = [];
  for (const model of models) {
    const adapter = resolveModelAdapter(model.provider, model.adapter);
    let accountKey: string | undefined;
    if (!model.fallbackPolicy && adapter === 'claude-cli') {
      let resolved = credentials.get(model.ApiKey);
      if (!resolved) {
        resolved = resolveAndDecryptApiKey(model.ApiKey).catch(() => null);
        credentials.set(model.ApiKey, resolved);
      }
      const credential = await resolved;
      if (credential) accountKey = allowanceAccountKey('claude', credential);
    } else if (!model.fallbackPolicy && adapter === 'codex-cli' && !model.ApiKey) {
      accountKey = codexKey;
    }
    const row = projectModelAllowance(model, accountKey, accountKey ? readAllowanceSnapshot(accountKey) : undefined);
    const failure = accountKey ? allowanceRefreshFailure(accountKey) : undefined;
    if (failure) {
      row.refreshFailed = true;
      if (row.status === 'unknown' || row.status === 'stale') row.reason = failure.reason;
      row.retryAt = failure.retryAt;
    }
    rows.push(row);
  }
  return { models: rows, entities: await allowanceEntityModels(), observedAt: new Date().toISOString() };
}

/** Explicit refresh is account telemetry only, never a model test or completion. */
export async function refreshWorkspaceAllowance(signal?: AbortSignal, modelIds?: string[]): Promise<WorkspaceAllowance> {
  const catalogue = await savedModels();
  const requested = new Set<string>();
  const expand = (ids: string[]) => {
    for (const id of ids) {
      if (requested.has(id)) continue;
      requested.add(id);
      const policy = catalogue.find(model => model.id === id)?.fallbackPolicy;
      if (policy) expand(policy.modelIds);
    }
  };
  if (modelIds) expand(modelIds);
  const models = modelIds ? catalogue.filter(model => requested.has(model.id)) : catalogue;
  const tasks = new Map<string, () => Promise<void>>();
  for (const encrypted of new Set(models.filter(model => !model.fallbackPolicy
    && resolveModelAdapter(model.provider, model.adapter) === 'claude-cli').map(model => model.ApiKey))) {
    const credential = await resolveAndDecryptApiKey(encrypted).catch(() => null);
    if (!credential) continue;
    const key = allowanceAccountKey('claude', credential);
    tasks.set(key, async () => { recordAllowanceSnapshot(key, await collectClaudeAccountAllowance(credential, { signal })); });
  }
  if (models.some(model => !model.fallbackPolicy && resolveModelAdapter(model.provider, model.adapter) === 'codex-cli' && !model.ApiKey)) {
    const key = await readCodexAllowanceAccountKey().catch(() => undefined);
    if (key) tasks.set(key, async () => {
      const result = await collectCodexAllowance({ signal });
      recordAllowanceSnapshot(result.accountKey, result.snapshot);
    });
  }
  // Account failures are independent. One failed provider must not erase the
  // other provider's reading; concurrent cards share the same account collection.
  const queue = [...tasks.entries()];
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
    for (let task = queue.shift(); task; task = queue.shift()) {
      if (signal?.aborted) break;
      const [key, collect] = task;
      const retryAt = allowanceRefreshFailure(key)?.retryAt;
      if (retryAt && Date.parse(retryAt) > Date.now()) continue;
      let pending = refreshes.get(key);
      if (!pending) {
        pending = collect().catch(error => {
          if (!signal?.aborted) recordAllowanceFailure(key, error instanceof ClaudeAllowanceError ? error.reason : 'collection-failed', error instanceof ClaudeAllowanceError ? error.retryAt : undefined);
        })
          .finally(() => refreshes.delete(key));
        refreshes.set(key, pending);
      }
      await pending;
    }
  }));
  return workspaceAllowance();
}
