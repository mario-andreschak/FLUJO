import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  assertModelCatalogFilesystemLeaseOwned,
  withModelCatalogFilesystemLease,
  withModelCatalogFilesystemWriteLease,
} from '@/backend/services/enduringAgents/runtimeLock';
import { ExecutionExtensionError } from '@/backend/execution/extensions';
import { hasOwnerBoundFallbackMember, materializeFallbackPolicy } from '@/shared/types/model/fallbackPolicy';
import type { Model } from '@/shared/types/model';
import { StorageKey } from '@/shared/types/storage';
import { loadItem } from '@/utils/storage/backend';
import { getWorkspaceDataDir } from '@/utils/workspace';

/** A detached model and the exact filesystem generation admitted during prep. */
export interface ModelCatalogAdmission {
  readonly model: Model;
  readonly generation: string;
}

function freezeSnapshot<T>(value: T): T {
  const seen = new WeakSet<object>();
  const visit = (item: unknown): void => {
    if (!item || typeof item !== 'object' || seen.has(item)) return;
    seen.add(item);
    for (const child of Object.values(item)) visit(child);
    Object.freeze(item);
  };
  visit(value);
  return value;
}

/** Only production catalog writers and Process preparation may own this lease. */
export const withModelCatalogLease = withModelCatalogFilesystemLease;
export const withModelCatalogWriteLease = withModelCatalogFilesystemWriteLease;
export const assertModelCatalogLeaseOwned = assertModelCatalogFilesystemLeaseOwned;

async function readCatalog(): Promise<{ models: Model[]; generation: string }> {
  // The filesystem lock excludes all production catalog writes while these two
  // reads run. File identity also detects a same-content atomic replacement.
  const models = await loadItem<Model[]>(StorageKey.MODELS, []);
  if (!Array.isArray(models)) throw new ExecutionExtensionError('execution_model_catalog_invalid');
  const file = path.join(getWorkspaceDataDir(), 'db', `${StorageKey.MODELS}.json`);
  const stat = await fs.stat(file, { bigint: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  const generation = createHash('sha256')
    .update(JSON.stringify(models))
    .update(stat ? `${stat.dev}:${stat.ino}:${stat.ctimeNs}:${stat.mtimeNs}` : ':absent')
    .digest('hex');
  return { models, generation };
}

/** Must be called under withModelCatalogLease, before any prompt/resource/MCP work. */
export async function admitCatalogModel(modelId: string): Promise<ModelCatalogAdmission> {
  const { models, generation } = await readCatalog();
  const stored = models.find(model => model.id === modelId);
  if (!stored || hasOwnerBoundFallbackMember(stored, models)) {
    throw new ExecutionExtensionError('execution_model_not_found');
  }
  const model = materializeFallbackPolicy(stored, models);
  return freezeSnapshot({ model: structuredClone(model), generation });
}

/** Must be called under the same lease immediately before local key and send work. */
export async function assertCatalogAdmissionCurrent(admission: ModelCatalogAdmission): Promise<void> {
  const { models, generation } = await readCatalog();
  const stored = models.find(model => model.id === admission.model.id);
  const current = stored && !hasOwnerBoundFallbackMember(stored, models)
    ? materializeFallbackPolicy(stored, models) : null;
  if (generation !== admission.generation || !current
      || JSON.stringify(current) !== JSON.stringify(admission.model)) {
    throw new ExecutionExtensionError('execution_model_catalog_changed');
  }
}
