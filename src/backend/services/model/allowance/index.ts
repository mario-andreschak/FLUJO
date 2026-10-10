import { modelService } from '@/backend/services/model';
import { resolveAndDecryptApiKey } from '@/backend/services/model/encryption';
import { resolveModelAdapter } from '@/shared/types/model/provider';
import type { Model } from '@/shared/types/model/model';
import type { WorkspaceAllowance } from '@/shared/types/model/allowance';
import { allowanceAccountKey, readAllowanceSnapshot, recordAllowanceSnapshot } from './store';
import { projectModelAllowance } from './projection';
import { allowanceEntityModels } from './entities';
import { collectCodexAllowance, readCodexAllowanceAccountKey } from './codex';
import { getWorkspaceDataDir } from '@/utils/workspace';

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
  const rows = [];
  for (const model of models) {
    const adapter = resolveModelAdapter(model.provider, model.adapter);
    let accountKey: string | undefined;
    if (!model.fallbackPolicy && adapter === 'claude-cli') {
      const credential = await resolveAndDecryptApiKey(model.ApiKey).catch(() => null);
      if (credential) accountKey = allowanceAccountKey('claude', credential);
    } else if (!model.fallbackPolicy && adapter === 'codex-cli' && !model.ApiKey) {
      accountKey = codexKey;
    }
    rows.push(projectModelAllowance(model, accountKey, accountKey ? readAllowanceSnapshot(accountKey) : undefined));
  }
  return { models: rows, entities: await allowanceEntityModels(), observedAt: new Date().toISOString() };
}

/** Explicit refresh is account telemetry only, never a model test or completion. */
export async function refreshWorkspaceAllowance(signal?: AbortSignal): Promise<WorkspaceAllowance> {
  const models = await savedModels();
  if (models.some(model => !model.fallbackPolicy && resolveModelAdapter(model.provider, model.adapter) === 'codex-cli' && !model.ApiKey)) {
    const key = getWorkspaceDataDir();
    let pending = refreshes.get(key);
    if (!pending) {
      pending = collectCodexAllowance({ signal }).then(({ accountKey, snapshot }) => {
        recordAllowanceSnapshot(accountKey, snapshot);
      }).finally(() => refreshes.delete(key));
      refreshes.set(key, pending);
    }
    await pending;
  }
  return workspaceAllowance();
}
