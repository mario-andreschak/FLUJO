import { flowService } from '@/backend/services/flow';
import { recordChange, type SharedEditor } from '@/backend/services/sharedItems/guard';
import type { Flow } from '@/shared/types/flow';

const ATTEMPTS = 3;
const CHANGED_SINCE_INSPECTION = 'Flow changed since inspection.';

/**
 * Change one saved flow before the thing it points at is deleted (#1389).
 * Reads the flow fresh, applies `rewrite` and saves only if nobody saved in
 * between; a save that raced is read and rewritten again. Returns a plain
 * reason when the flow could not be changed, or `null` when it was changed or
 * no longer needs a change.
 */
export async function rewriteSavedFlow(
  flowId: string,
  needsChange: (flow: Flow) => boolean,
  rewrite: (flow: Flow) => Flow,
  editor: SharedEditor | null,
): Promise<string | null> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const current = await flowService.getFlow(flowId);
    if (!current || !needsChange(current)) return null;
    const before = structuredClone(current);
    const next = rewrite(structuredClone(current));
    const result = await flowService.saveFlow(
      next,
      typeof current.updatedAt === 'number' ? { expectedUpdatedAt: current.updatedAt } : {},
    );
    if (result.success) {
      await recordChange(editor, { kind: 'flow', itemId: flowId, action: 'saved', before, after: next });
      return null;
    }
    if (result.error !== CHANGED_SINCE_INSPECTION) {
      return `Could not change flow "${current.name}": ${result.error ?? 'unknown error'}.`;
    }
  }
  return 'Another save kept changing a flow that uses this. Try again in a moment.';
}
