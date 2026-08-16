import OpenAI from 'openai';
import type { FlujoChatMessage, McpAppModelContextMap } from '@/shared/types/chat';
import { withMcpAppModelContext } from '@/backend/mcpApps/modelContext';
import {
  buildNodeContext,
  collapseNodeOutputs,
  deriveModelInputView,
  scopeMessagesForInput,
  toApiMessages,
} from './buildNodeContext';
import type { ModelInputSnapshot } from './types';

export interface ModelInputMaterializationBaseArgs {
  canonicalMessages: readonly FlujoChatMessage[];
  systemMessage: FlujoChatMessage;
  collapsedNodeIds?: ReadonlySet<string>;
}

export interface ModelInputMaterializationBase {
  threaded: FlujoChatMessage[];
  folded: FlujoChatMessage[];
}

export interface FinalizeModelInputMaterializationArgs
  extends ModelInputMaterializationBase {
  systemContent: string | null;
  inputMode?: 'full-history' | 'latest-message' | 'isolated';
  isolatedPrompt?: string;
  /**
   * Content replacements resolved outside this pure pipeline. Execution may
   * perform resource reads/events before supplying them; preview supplies only
   * values from explicitly read-only resolvers.
   */
  wireContentByMessageId?: ReadonlyMap<string, FlujoChatMessage['content']>;
  mcpAppContexts?: McpAppModelContextMap;
  additionalWireMessages?: readonly FlujoChatMessage[];
}

export interface ModelInputMaterialization {
  threaded: FlujoChatMessage[];
  folded: FlujoChatMessage[];
  scoped: FlujoChatMessage[];
  wireMessages: FlujoChatMessage[];
  providerMessages: OpenAI.ChatCompletionMessageParam[];
  snapshot: ModelInputSnapshot;
  wireChanged: boolean;
}

function cloneMessage(message: FlujoChatMessage): FlujoChatMessage {
  return structuredClone(message);
}

/**
 * Start the immutable model-input pipeline with canonical, scope-local history.
 * Display-only nested projections are excluded by construction.
 */
export function prepareModelInputMaterialization(
  args: ModelInputMaterializationBaseArgs,
): ModelInputMaterializationBase {
  const canonical = args.canonicalMessages
    .filter(message => (message.depth ?? 0) === 0)
    .map(cloneMessage);
  const threaded = buildNodeContext(canonical, cloneMessage(args.systemMessage));
  const folded = collapseNodeOutputs(
    threaded,
    args.collapsedNodeIds ?? new Set<string>(),
  );
  return { threaded, folded };
}

/**
 * Complete the immutable wire projection. This function never mutates canonical
 * history, SharedState, tools, logs, resources, provider sessions, or storage.
 */
export function finalizeModelInputMaterialization(
  args: FinalizeModelInputMaterializationArgs,
): ModelInputMaterialization {
  let folded = args.folded.map(message => {
    const replacement = message.id
      ? args.wireContentByMessageId?.get(message.id)
      : undefined;
    return replacement === undefined
      ? cloneMessage(message)
      : { ...cloneMessage(message), content: structuredClone(replacement) } as FlujoChatMessage;
  });

  const inputMode = args.inputMode ?? 'full-history';
  let scoped = scopeMessagesForInput(
    folded,
    inputMode,
    args.isolatedPrompt,
  );

  scoped = withMcpAppModelContext(scoped, args.mcpAppContexts);
  if (args.additionalWireMessages?.length) {
    scoped = [
      ...scoped,
      ...args.additionalWireMessages.map(cloneMessage),
    ];
  }

  const snapshot = deriveModelInputView({
    threaded: args.threaded,
    foldedView: folded,
    scopedView: scoped,
    systemContent: args.systemContent,
    inputMode,
  });
  const wireMessages = snapshot.wireMessages.map(cloneMessage);

  return {
    threaded: args.threaded,
    folded,
    scoped,
    wireMessages,
    providerMessages: toApiMessages(wireMessages),
    snapshot,
    wireChanged:
      args.folded !== args.threaded
      || folded.length !== args.threaded.length
      || scoped.length !== args.threaded.length
      || Boolean(args.wireContentByMessageId?.size)
      || Boolean(args.mcpAppContexts && Object.keys(args.mcpAppContexts).length)
      || Boolean(args.additionalWireMessages?.length)
      || inputMode !== 'full-history',
  };
}

/** Convenience entry point for callers that need no asynchronous resolution. */
export function materializeModelInput(
  args: ModelInputMaterializationBaseArgs
    & Omit<FinalizeModelInputMaterializationArgs, keyof ModelInputMaterializationBase>,
): ModelInputMaterialization {
  const base = prepareModelInputMaterialization(args);
  return finalizeModelInputMaterialization({ ...args, ...base });
}
