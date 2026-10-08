import type { ModelTurnSnapshot } from '@/shared/types/modelTurn';

/** Only the selected, reloadable inspector snapshot may remain cached. */
export class ModelTurnDetailCache extends Map<string, ModelTurnSnapshot> {
  override set(key: string, snapshot: ModelTurnSnapshot): this {
    this.clear();
    return super.set(key, snapshot);
  }
}
