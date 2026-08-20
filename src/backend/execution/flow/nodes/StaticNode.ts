// Local implementation of PocketFlow for debugging
import { BaseNode } from '../pocketflow';
import { createLogger } from '@/utils/logger';
import { SharedState, StaticEntry, StaticNodeParams } from '../types';
import { FlujoChatMessage } from '@/shared/types/chat';
import { FlujoFunctionToolCall } from '@/shared/types/openai';
import { resolveRunVars } from '@/utils/shared/resolveRunVars';
import { resolveRunResourceRefs } from '../resolveRunResourceRefs';
import { FEATURES } from '@/config/features';
import { mcpService } from '@/backend/services/mcp';
import { DEFAULT_TOOL_CALL_TIMEOUT_SECONDS } from '@/shared/types/mcp';
import type { ModelMediaPart } from '@/shared/types/model/media';
import {
  PERSONA_MEMORY_GATEWAY_SERVER,
  executePersonaMemoryMaintenanceCommit,
} from '../handlers/personaMemoryGateway';

const log = createLogger('backend/flow/execution/nodes/StaticNode');

/**
 * Static node (issue #358) — a non-LLM, pass-through node that
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
 *  - `toolCall` → executes the connected MCP tool when `executionMode` is
 *    `real`, or uses the authored deterministic result for `mock`/legacy
 *    entries. It then appends a paired assistant tool-call and tool-result
 *    message. Well-formed pairing is mandatory, otherwise provider adapters
 *    reject the history — invalid `argumentsJson` therefore fails loudly.
 *
 * Text fields support `${var:NAME}` (run scratchpad, Tier 2c) and `${res:NAME}`
 * (run resources, Tier 3), resolved in the same order as ProcessNode.
 *
 * Re-entry (issue #381): by default the node appends on every traversal; with
 * `injectOnce: true` it injects only once per **logical run**. The dedupe key is
 * `(sharedState.logicalRunId, nodeId)`, stored in `sharedState.staticInjected`, so
 * an approval/debug resume of the same run does not re-inject while a new user turn
 * (new logical run) does. Subflow runs carry their own SharedState and therefore
 * their own markers. See docs/features/flows/static-node.md#re-entry-semantics.
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

    // "Once" means once per logical run (one user turn), not once per conversation:
    // the marker stores the run that injected, so a persisted map from an earlier turn
    // can never suppress this run's injection.
    const runId = sharedState.logicalRunId ?? 'no-run';
    const alreadyInjected = sharedState.staticInjected?.[nodeId] === runId;

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
          { nodeId },
          sharedState,
        );

      const messages: FlujoChatMessage[] = [];
      for (const entry of prepResult.entries) {
        if (entry.kind === 'message') {
          let content = await resolve(entry.content);
          const media: ModelMediaPart[] = [];
          for (const attachment of entry.attachments ?? []) {
            if (
              attachment.type === 'document'
              && typeof attachment.content === 'string'
              && !attachment.content.startsWith('data:')
            ) {
              const documentText = await resolve(attachment.content);
              content += `${content ? '\n\n' : ''}[DOCUMENT${attachment.originalName ? `: ${attachment.originalName}` : ''}]\n${documentText}`;
              continue;
            }

            const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(attachment.content ?? '');
            if (!match) continue;
            media.push({
              type: attachment.type === 'document' ? 'file' : attachment.type,
              mimeType: attachment.mimeType || match[1],
              data: match[2],
              name: attachment.originalName,
              transcript: attachment.transcript,
            });
          }
          messages.push({
            role: entry.role,
            content,
            ...(media.length > 0 ? { media } : {}),
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

          const executionMode = entry.executionMode === 'real' ? 'real' : 'mock';
          const serverName = (entry.serverName ?? '').trim();
          let resultContent = executionMode === 'mock' ? await resolve(entry.result ?? '') : '';

          if (executionMode === 'real') {
            if (!serverName) {
              throw new Error(`Static node ${nodeId}: real tool call "${toolName}" requires an MCP server.`);
            }
            const args = JSON.parse(argumentsJson) as Record<string, unknown>;
            const callResult = serverName === PERSONA_MEMORY_GATEWAY_SERVER
              ? await executePersonaMemoryMaintenanceCommit(toolName, args, {
                  variables: sharedState.variables,
                  conversationId: sharedState.conversationId,
                  executionAuthority: sharedState.executionAuthority,
                  personaAttribution: sharedState.personaAttribution,
                })
              : await (async () => {
                  const binding = node_params?.properties?.mcpNodes?.find(
                    (candidate) => candidate.properties?.boundServer === serverName,
                  );
                  if (!binding || !binding.properties.enabledTools?.includes(toolName)) {
                    throw new Error(
                      `Static node ${nodeId}: real tool call "${toolName}" is not enabled on its connected MCP server "${serverName}".`,
                    );
                  }
                  // Register the connected MCP node's roots before dispatch, matching
                  // Process-node tool preparation. This makes both roots/list and the
                  // built-in filesystem/bash confinement see the authored overlay even
                  // when a Static node is the first consumer to touch the server.
                  mcpService.setNodeRoots(serverName, binding.id, binding.properties.roots);
                  return mcpService.callTool(
                    serverName,
                    toolName,
                    args,
                    binding.properties.toolTimeout ?? DEFAULT_TOOL_CALL_TIMEOUT_SECONDS,
                    undefined,
                    binding.id,
                  );
                })();
            resultContent = callResult.success
              ? JSON.stringify(callResult.data ?? null)
              : `Error: ${callResult.error || `Tool ${toolName} failed`}`;
          }

          messages.push({
            role: 'assistant',
            content: '',
            tool_calls: [toolCall],
            ...(serverName ? {
              mcpToolCalls: { [toolCallId]: { serverName, toolName } },
            } : {}),
            id: crypto.randomUUID(),
            timestamp: Date.now(),
          } as FlujoChatMessage);
          messages.push({
            role: 'tool',
            tool_call_id: toolCallId,
            content: resultContent,
            id: crypto.randomUUID(),
            timestamp: Date.now(),
          } as FlujoChatMessage);
          continue;
        }

        throw new Error(`Static node ${nodeId}: unknown entry kind.`);
      }

      sharedState.messages.push(...messages);
      // Drop markers left by earlier logical runs while writing this one, so the map
      // cannot grow unbounded over a long conversation.
      const markers: Record<string, string> = {};
      for (const [id, marker] of Object.entries(sharedState.staticInjected ?? {})) {
        if (marker === runId) markers[id] = marker;
      }
      markers[nodeId] = runId;
      sharedState.staticInjected = markers;
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
