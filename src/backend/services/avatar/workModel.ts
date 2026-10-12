import { createHash } from 'node:crypto';
import type { Model } from '@/shared/types/model';
import { loadItem, saveItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import type { AvatarWorldSnapshot } from '@/shared/types/avatar';

interface WorkModelPreference { modelId: string; fingerprint: string; verifiedAt: number }

/** Credentials participate in invalidation but their hash never leaves storage. */
function fingerprint(model: Model): string {
  return createHash('sha256').update(JSON.stringify(model)).digest('hex');
}

export async function readAvatarWorkModel(models: Model[]): Promise<AvatarWorldSnapshot['workModel']> {
  const preference = await loadItem<WorkModelPreference | null>(StorageKey.AVATAR_WORLD, null);
  if (!preference) return null;
  const model = models.find(m => m.id === preference.modelId);
  if (!model) return null;
  return { modelId: model.id, label: model.displayName || model.name, verifiedAt: preference.verifiedAt,
    ready: preference.fingerprint === fingerprint(model) && model.supportsTools !== false };
}

/** Call only after Flujo's real model + tool test succeeds for this model. */
export async function selectVerifiedAvatarWorkModel(model: Model): Promise<void> {
  await saveItem(StorageKey.AVATAR_WORLD, { modelId: model.id, fingerprint: fingerprint(model), verifiedAt: Date.now() });
}
