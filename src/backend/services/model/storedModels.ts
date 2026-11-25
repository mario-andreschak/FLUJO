import { v5 as uuidv5 } from 'uuid';
import type { Model } from '@/shared/types/model';
import { StorageKey } from '@/shared/types/storage';
import { loadItem } from '@/utils/storage/backend';

/** Namespace of the ids given to models that were saved without one (#1350). */
const MISSING_MODEL_ID_NAMESPACE = '9dde3939-7b78-498c-a6d6-e0e91dc97fbc';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasId = (model: Record<string, unknown>): boolean =>
  typeof model.id === 'string' && model.id.trim() !== '';

/**
 * Gives every stored model without an id one, so it can be read, edited and
 * deleted again. The id comes from the record's place and content (never its
 * key), so every reader gets the same id until it is written back.
 */
export function withStoredModelIds(stored: Model[]): { models: Model[]; healed: number } {
  if (!Array.isArray(stored) || stored.every(model => !isRecord(model) || hasId(model))) {
    return { models: stored, healed: 0 };
  }
  const taken = new Set(stored.filter(model => isRecord(model) && hasId(model)).map(model => model.id));
  let healed = 0;
  const models = stored.map((model, index) => {
    if (!isRecord(model) || hasId(model)) return model;
    const { ApiKey: _key, ...described } = model;
    void _key;
    const seed = `${index}:${JSON.stringify(described)}`;
    let id = uuidv5(seed, MISSING_MODEL_ID_NAMESPACE);
    for (let attempt = 1; taken.has(id); attempt += 1) id = uuidv5(`${attempt}:${seed}`, MISSING_MODEL_ID_NAMESPACE);
    taken.add(id);
    healed += 1;
    return { ...model, id };
  });
  return { models, healed };
}

/** The stored models, each with an id. `healed` counts ids not yet written back. */
export async function loadStoredModels(): Promise<{ models: Model[]; healed: number }> {
  return withStoredModelIds(await loadItem<Model[]>(StorageKey.MODELS, []));
}
