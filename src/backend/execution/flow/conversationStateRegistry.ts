import type { SharedState } from './types';
import { DEFAULT_WORKSPACE, getCurrentWorkspace } from '@/utils/workspace';

/**
 * The live in-memory conversation-state map, workspace-scoped and
 * global-backed so every Next.js module instance shares ONE map.
 *
 * This module deliberately has no runtime dependencies on the execution
 * engine. Consumers that sit inside the FlowExecutor -> ProcessNode ->
 * ModelHandler import cycle (the conversation-log bus tap, streamed-message
 * folding, cancellation checks, todo/meeting tools) import it statically.
 * They previously lazily required the FlowExecutor module at runtime, which
 * resolved to a module object without `FlowExecutor` in the production
 * webpack bundle. Every bus event was then silently refused and nothing
 * reached the conversation log until the end-of-turn snapshot (issue #1319).
 */
declare global {
  var __flujo_conversation_states: Map<string, SharedState> | undefined;
  var __flujo_conversation_states_by_workspace: Map<string, Map<string, SharedState>> | undefined;
}

export function getConversationStates(): Map<string, SharedState> {
  const workspace = getCurrentWorkspace();
  if (workspace === DEFAULT_WORKSPACE) {
    return global.__flujo_conversation_states ??= new Map<string, SharedState>();
  }
  const byWorkspace = global.__flujo_conversation_states_by_workspace ??= new Map();
  let states = byWorkspace.get(workspace);
  if (!states) {
    states = new Map<string, SharedState>();
    byWorkspace.set(workspace, states);
  }
  return states;
}
