// Local implementation of PocketFlow for debugging
import { BaseNode } from '../pocketflow';
import { createLogger } from '@/utils/logger';
import { SharedState, StaticEntry, StaticNodeParams } from '../types';
import { FlujoChatMessage } from '@/shared/types/chat';
import { FlujoFunctionToolCall } from '@/shared/types/openai';
import { resolveRunVars } from '@/utils/shared/resolveRunVars';
import { resolveRunResourceRefs } from '../resolveRunResourceRefs';
import { FEATURES } from '@/config/features';

const log = createLogger('backend/flow/execution/nodes/StaticNode');

/**
 * Static node (issue #358) — a deterministic, non-LLM, pass-through node that
 * INJECTS pre-authored entries into the conversation when execution traverses
 * it, then hands off to its first successor unchanged.
 *
 * Unlike the SignalNode (which is deliberately transparent and must never touch
 * the conversation), the whole point of this node is to mutate
 * `sharedState.messages`, mechanically the way `StartNode.post` injects its
 * system message. Use it for few-shot scaffolding, canned instructions, or
 * pre-seeded tool-call/result pairs.
 *
 * Entry kinds:
 *  - `message`  → one message with the authored role/content.
 *  - `toolCall` → TWO messages: a synthetic `assistant` turn carrying a
 *    `tool_calls` entry, immediately followed by the matching `role: 'tool'`
 *    result with the same `tool_call_id`. Well-formed pairing is mandatory,
 *    otherwise provider adapters reject the history — invalid `argumentsJson`
 *    therefore fails loudly at execution time.
 *
 * Text fields support `${var:NAME}` (run scratchpad, Tier 2c) and `${res:NAME}`
 * (run resources, Tier 3), resolved in the same order as ProcessNode.
 *
 * Re-entry: by default the node appends on every traversal; with
 * `injectOnce: true` it injects only once per run (tracked on sharedState).
 */
export class StaticNode extends BaseNode {
  async prep(
    _sharedState: SharedState,
    node_params?: StaticNodeParams
  ): Promise<{ entries: StaticEntry[]; injectOnce: boolean }> {
    const entries = Array.isArray(node_params?.properties?.entries)
      ? (node_params!.properties!.entries as StaticEntry[])
      : [];
    const injectOnce = node_params?.properties?.injectOnce === true;
    log.info('prep() started', { nodeId: node_params?.id, entryCount: entries.length, injectOnce });
    return { entries, injectOnce };
  }

  async execCore(): Promise<Record<string, never>> {
    // No work: the injection happens in post(), where run context is in scope.
    return {};
  }

  async post(
    prepResult: { entries: StaticEntry[]; injectOnce: boolean },
    _execResult: unknown,
    sharedState: SharedState,
    node_params?: StaticNodeParams
  ): Promise<string> {
    const nodeId = node_params?.id || 'unknown';
    log.info('post() started', { nodeId, entryCount: prepResult.entries.length });

    if (FEATURES.ENABLE_EXECUTION_TRACKER && Array.isArray(sharedState.trackingInfo.nodeExecutionTracker)) {
      sharedState.trackingInfo.nodeExecutionTracker.push({
        nodeType: 'StaticNode',
        nodeId,
        nodeName: node_params?.properties?.name || 'Static',
        timestamp: new Date().toISOString(),
      });
    }

    const state = sharedState as SharedState & { staticInjected?: Record<string, boolean> };
    const alreadyInjected = state.staticInjected?.[nodeId] === true;

    if (prepResult.injectOnce && alreadyInjected) {
      log.info('injectOnce: skipping repeat injection', { nodeId });
    } else if (prepResult.entries.length > 0) {
      if (!Array.isArray(sharedState.messages)) {
        sharedState.messages = [];
      }

      const resolve = async (value: string): Promise<string> =>
        resolveRunResourceRefs(
          resolveRunVars(value ?? '', sharedState.variables),
          sharedState.ephemeral ? undefined : sharedState.conversationId,
          sharedState.emit,
          { nodeId }
        );

      const messages: FlujoChatMessage[] = [];
      for (const entry of prepResult.entries) {
        if (entry.kind === 'message') {
          messages.push({
            role: entry.role,
            content: await resolve(entry.content),
            id: crypto.randomUUID(),
            timestamp: Date.now(),
          } as FlujoChatMessage);
          continue;
        }

        if (entry.kind === 'toolCall') {
          const toolName = (entry.toolName ?? '').trim();
          if (!toolName) {
            throw new Error(`Static node ${nodeId}: a tool-call entry requires a tool name.`);
          }
          const argumentsJson = (await resolve(entry.argumentsJson ?? '')).trim() || '{}';
          try {
            JSON.parse(argumentsJson);
          } catch {
            throw new Error(
              `Static node ${nodeId}: tool-call entry for "${toolName}" has invalid JSON arguments.`
            );
          }

          const toolCallId = `call_static_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
          const toolCall: FlujoFunctionToolCall = {
            id: toolCallId,
            type: 'function',
            function: { name: toolName, arguments: argumentsJson },
          };

          messages.push({
            role: 'assistant',
            content: '',
            tool_calls: [toolCall],
            id: crypto.randomUUID(),
            timestamp: Date.now(),
          } as FlujoChatMessage);
          messages.push({
            role: 'tool',
            tool_call_id: toolCallId,
            content: await resolve(entry.result ?? ''),
            id: crypto.randomUUID(),
            timestamp: Date.now(),
          } as FlujoChatMessage);
          continue;
        }

        throw new Error(`Static node ${nodeId}: unknown entry kind.`);
      }

      sharedState.messages.push(...messages);
      state.staticInjected = { ...(state.staticInjected ?? {}), [nodeId]: true };
      log.info('Injected static messages', { nodeId, messageCount: messages.length });
    }

    // Pass through to the first successor.
    const actions = this.successors instanceof Map
      ? Array.from(this.successors.keys())
      : Object.keys(this.successors || {});
    return actions.length > 0 ? actions[0] : 'default';
  }

  _clone(): BaseNode {
    return new StaticNode();
  }
}
