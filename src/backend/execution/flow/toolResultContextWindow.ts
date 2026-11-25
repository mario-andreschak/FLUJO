import type { Flow } from '@/shared/types/flow/flow';
import { flowService } from '@/backend/services/flow';
import { modelService } from '@/backend/services/model';
import { createLogger } from '@/utils/logger';

const log = createLogger('backend/execution/flow/toolResultContextWindow');

/**
 * Context window (tokens) of the model bound to the Process node whose tool
 * calls are running, so the tool result size limit (#1226) can size 'auto'
 * and its safety ceiling for that model. Both lookups are cached. Any gap
 * (no node, fallback policy without a window, removed model) returns
 * undefined and the limit assumes a 128K-token window instead.
 */
export async function resolveToolCallContextWindow(state: {
  flowId?: string;
  flowSnapshot?: Flow;
  currentNodeId?: string;
}): Promise<number | undefined> {
  if (!state.currentNodeId) return undefined;
  try {
    const flow = state.flowSnapshot ?? (state.flowId ? await flowService.getFlow(state.flowId) : null);
    const modelId = flow?.nodes.find(node => node.id === state.currentNodeId)?.data?.properties?.boundModel;
    if (typeof modelId !== 'string' || !modelId) return undefined;
    const contextWindow = (await modelService.getModel(modelId))?.contextWindow;
    return typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0
      ? contextWindow
      : undefined;
  } catch (error) {
    log.debug('Could not read the model context window for tool results; assuming 128K tokens', error);
    return undefined;
  }
}
