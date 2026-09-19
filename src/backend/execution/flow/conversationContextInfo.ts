import type { SharedState } from './types';
import type { ConversationContextInfo } from '@/shared/types/model/contextUsage';
import { flowService } from '@/backend/services/flow';
import { modelService } from '@/backend/services/model';
import { contextUsageFromCompletion } from '@/backend/services/model/adapters/contextUsage';
import { resolveOpenRouterMediaRoute } from '@/backend/services/model/adapters/openrouterMediaRouting';

/** Last reported context is a snapshot, never a sum of agent-run token usage. */
export async function buildContextInfo(state: SharedState): Promise<ConversationContextInfo | undefined> {
  const message = state.messages?.findLast(msg => msg.contextUsage !== undefined || msg.usage);
  if (!message) return undefined;
  const info: ConversationContextInfo = { nodeId: message.processNodeId };
  let model;
  try {
    if (message.processNodeId && state.flowId) {
      const flow = await flowService.getFlow(state.flowId);
      const modelId = flow?.nodes.find(node => node.id === message.processNodeId)?.data?.properties?.boundModel;
      if (typeof modelId === 'string') model = await modelService.getModel(modelId);
    }
  } catch {
    // A saved runtime snapshot remains useful even if its model was removed.
  }
  if (model) info.modelDisplayName = model.displayName || model.name;
  if (message.contextUsage !== undefined) {
    return { ...info, ...message.contextUsage };
  }
  // Historical SDK records contain aggregate run usage. Do not reinterpret it
  // as context, even when it happens to be below the configured window.
  if (!model || model.adapter === 'codex-cli' || model.provider === 'codex'
    || model.adapter === 'claude-cli' || model.provider === 'claude-subscription') return info;
  if (message.usage && !resolveOpenRouterMediaRoute(model).useMediaRoute) {
    Object.assign(info, contextUsageFromCompletion({
      prompt_tokens: message.usage.promptTokens,
      completion_tokens: message.usage.completionTokens,
    }, model.contextWindow, model.adapter === 'gemini'));
  }
  return info;
}
