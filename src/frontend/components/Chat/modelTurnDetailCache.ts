import type { ModelTurnView } from '@/frontend/services/chat/modelTurnInspection';

/** Only the selected, reloadable inspector snapshot may remain cached. */
export class ModelTurnDetailCache extends Map<string, ModelTurnView> {
  override set(key: string, snapshot: ModelTurnView): this {
    this.clear();
    return super.set(key, snapshot);
  }
}
