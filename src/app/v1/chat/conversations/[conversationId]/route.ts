import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs'; // Import fs promises
import path from 'path'; // Import path
import { createLogger } from '@/utils/logger';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { SharedState } from '@/backend/execution/flow/types';
import { loadItem as loadItemBackend, saveItem } from '@/utils/storage/backend'; // Import saveItem
import { StorageKey } from '@/shared/types/storage';
import { ConversationListItem } from '@/frontend/components/Chat'; // Import for response type
import { flowService } from '@/backend/services/flow';
import { modelService } from '@/backend/services/model';

const log = createLogger('app/v1/chat/conversations/[conversationId]/route');

/**
 * Context-usage snapshot for the conversation's most recent model call.
 *
 * `promptTokens` is the PROVIDER-REPORTED prompt size of the last assistant
 * turn that carried usage — the exact size of what that node's model last
 * received, no tokenizer approximation needed. `contextWindow` comes from the
 * node's bound model config (optional metadata); the frontend renders a meter
 * when both are present. Advisory: any resolution failure just omits fields.
 */
async function buildContextInfo(sharedState: SharedState): Promise<
  | {
      promptTokens: number;
      completionTokens?: number;
      nodeId?: string;
      modelDisplayName?: string;
      contextWindow?: number;
    }
  | undefined
> {
  try {
    const messages = sharedState.messages || [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== 'assistant' || !msg.usage) continue;

      const info: {
        promptTokens: number;
        completionTokens?: number;
        nodeId?: string;
        modelDisplayName?: string;
        contextWindow?: number;
      } = {
        promptTokens: msg.usage.promptTokens,
        completionTokens: msg.usage.completionTokens,
        nodeId: msg.processNodeId,
      };

      if (msg.processNodeId && sharedState.flowId) {
        const flow = await flowService.getFlow(sharedState.flowId);
        const node = (flow as any)?.nodes?.find((n: any) => n.id === msg.processNodeId);
        const boundModelId = node?.data?.properties?.boundModel;
        if (boundModelId) {
          const model = await modelService.getModel(boundModelId);
          if (model) {
            info.modelDisplayName = model.displayName || model.name;
            info.contextWindow = model.contextWindow;
          }
        }
      }
      return info;
    }
  } catch (error) {
    log.warn('buildContextInfo failed; omitting context info', { error });
  }
  return undefined;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> } // Reverted to using params destructuring
) {
  const awaitedParams = await params; // Await the params object
  const conversationId = awaitedParams.conversationId; // Access conversationId from awaited params
  const requestId = `conv-get-${Date.now()}`;
  log.info('Handling GET request for conversation state', { requestId, conversationId });

  if (!conversationId) { // Check using the variable
    log.warn('Missing conversationId parameter', { requestId });
    return NextResponse.json({ error: 'Missing conversationId parameter' }, { status: 400 });
  }

  try {
    let sharedState: SharedState | undefined = undefined;
    let stateSource: 'memory' | 'storage' | 'not_found' = 'not_found';

    // 1. Check in-memory state first (most up-to-date during execution)
    // Use variable
    if (FlowExecutor.conversationStates.has(conversationId)) {
      sharedState = FlowExecutor.conversationStates.get(conversationId);
      stateSource = 'memory';
      log.debug(`Found conversation state in memory`, { requestId, conversationId });
    } else {
      // 2. If not in memory, try loading from storage
      log.debug(`Conversation state not in memory, trying storage`, { requestId, conversationId });
      // Use variable
      const storageKey = `conversations/${conversationId}` as StorageKey;
      try {
        sharedState = await loadItemBackend<SharedState>(storageKey, undefined as any);
        if (sharedState) {
          stateSource = 'storage';
          log.debug(`Found conversation state in storage`, { requestId, conversationId });
          // Optional: Add to in-memory map if loaded from storage?
          // FlowExecutor.conversationStates.set(conversationId, sharedState);
        } else {
          log.info(`Conversation state not found in storage`, { requestId, conversationId });
        }
      } catch (storageError) {
        log.warn(`Error loading conversation state from storage`, { requestId, conversationId, error: storageError });
        // Continue, maybe it's just not created yet or error is transient
      }
    }

    // 3. Handle based on whether state was found
    if (sharedState) {
      // --- Ensure all messages have IDs before returning ---
      const messagesWithIds = (sharedState.messages || []).map(msg => ({
        ...msg,
        id: msg.id || crypto.randomUUID() // Add ID if missing
      }));
      // --- End ID check ---

      // Use variable for logging
      log.info(`Returning conversation state`, { requestId, conversationId, stateSource, messageCount: messagesWithIds.length, status: sharedState.status });

      // Construct the response object matching the structure expected by the frontend's Conversation type
      // Note: We are not explicitly typing with the frontend 'Conversation' type here to avoid backend importing frontend types.
      const conversationData = {
        id: sharedState.conversationId || conversationId, // Prefer state ID, fallback to param
        title: sharedState.title || 'Untitled Conversation',
        messages: messagesWithIds, // Use messages with guaranteed IDs
        flowId: sharedState.flowId || null, // Ensure flowId is included
        requireApproval: sharedState.requireApproval ?? false, // Per-conversation tool-approval setting
        createdAt: sharedState.createdAt || 0,
        updatedAt: sharedState.updatedAt || Date.now(), // Use current time if missing
        status: sharedState.status,
        // Aggregated token totals (accumulated by runFlow, persisted with the
        // state) + the context snapshot of the latest model call — powers the
        // chat header's token counter and context meter.
        usage: sharedState.usage,
        contextInfo: await buildContextInfo(sharedState),
      };

      // Return the full conversation data
      return NextResponse.json(conversationData);
    } else {
      // Use variable for logging
      log.warn(`Conversation state not found`, { requestId, conversationId });
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

  } catch (error) {
    // Use variable for logging
    log.error('Error retrieving conversation state', {
      requestId,
      conversationId, // Use variable
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// PATCH handler to update conversation properties (e.g., flowId)
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const conversationId = (await params).conversationId;
  const requestId = `conv-patch-${Date.now()}`;
  log.info('Handling PATCH request for conversation', { requestId, conversationId });

  if (!conversationId) {
    log.warn('Missing conversationId parameter', { requestId });
    return NextResponse.json({ error: 'Missing conversationId parameter' }, { status: 400 });
  }

  let updateData: Partial<SharedState>;
  try {
    updateData = await request.json();
    log.debug('Received update data', { requestId, conversationId, updateData: JSON.stringify(updateData) });
  } catch (error) {
    log.warn('Invalid JSON in PATCH request body', { requestId, conversationId, error });
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  // Build the set of allowed updates from whichever recognized fields are present
  // (flowId and/or requireApproval). Other fields are ignored.
  const allowedUpdates: Partial<SharedState> = {};
  if ('flowId' in updateData) {
    if (typeof updateData.flowId !== 'string' && updateData.flowId !== null) {
      log.warn('Invalid flowId in PATCH request body', { requestId, conversationId });
      return NextResponse.json({ error: 'Invalid flowId in request body' }, { status: 400 });
    }
    allowedUpdates.flowId = updateData.flowId;
  }
  if ('requireApproval' in updateData) {
    if (typeof updateData.requireApproval !== 'boolean') {
      log.warn('Invalid requireApproval in PATCH request body', { requestId, conversationId });
      return NextResponse.json({ error: 'requireApproval must be a boolean' }, { status: 400 });
    }
    allowedUpdates.requireApproval = updateData.requireApproval;
  }
  if (Object.keys(allowedUpdates).length === 0) {
    log.warn('No updatable fields in PATCH request body', { requestId, conversationId, updateData: JSON.stringify(updateData) });
    return NextResponse.json({ error: 'No updatable fields provided (flowId, requireApproval)' }, { status: 400 });
  }


  const storageKey = `conversations/${conversationId}` as StorageKey;

  try {
    // 1. Load existing state from storage
    const existingState = await loadItemBackend<SharedState>(storageKey, undefined as any);

    if (!existingState) {
      log.warn(`Conversation state not found for PATCH`, { requestId, conversationId });
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    // 2. Update the state. Settings-only changes (e.g. toggling requireApproval)
    // must NOT bump updatedAt — otherwise flipping a checkbox would re-sort the
    // conversation to the top. Only content/flow changes refresh the timestamp.
    const SETTINGS_ONLY_FIELDS = new Set(['requireApproval']);
    const isSettingsOnly = Object.keys(allowedUpdates).every(k => SETTINGS_ONLY_FIELDS.has(k));
    const nextUpdatedAt = isSettingsOnly ? existingState.updatedAt : Date.now();

    const updatedState: SharedState = {
      ...existingState,
      ...allowedUpdates, // Apply validated updates
      updatedAt: nextUpdatedAt,
    };

    // 3. Save updated state back to storage
    await saveItem(storageKey, updatedState);
    log.info(`Successfully updated and saved conversation state`, { requestId, conversationId, updatedFields: Object.keys(allowedUpdates) });

    // 4. Update in-memory state if it exists
    if (FlowExecutor.conversationStates.has(conversationId)) {
      const inMemoryState = FlowExecutor.conversationStates.get(conversationId);
      if (inMemoryState) {
         const updatedInMemoryState = { ...inMemoryState, ...allowedUpdates, updatedAt: updatedState.updatedAt };
         FlowExecutor.conversationStates.set(conversationId, updatedInMemoryState);
         log.debug(`Updated conversation state in memory`, { requestId, conversationId });
      }
    }

    // 5. Return updated summary
    const updatedSummary: ConversationListItem = {
      id: conversationId, // Use the conversationId from params
      title: updatedState.title,
      flowId: updatedState.flowId,
      createdAt: updatedState.createdAt,
      updatedAt: updatedState.updatedAt,
      status: updatedState.status || 'completed', // Provide a default status if needed
    };
    return NextResponse.json(updatedSummary, { status: 200 });

  } catch (error) {
    log.error('Error updating conversation state', {
      requestId,
      conversationId,
      storageKey,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error
    });
    return NextResponse.json({ error: 'Internal server error during update' }, { status: 500 });
  }
}


// DELETE handler to remove conversation state
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const conversationId = (await params).conversationId; // Direct access instead of destructuring
  const requestId = `conv-delete-${Date.now()}`;
  log.info('Handling DELETE request for conversation', { requestId, conversationId });

  if (!conversationId) {
    log.warn('Missing conversationId parameter', { requestId });
    return NextResponse.json({ error: 'Missing conversationId parameter' }, { status: 400 });
  }

  const conversationsDir = path.join(process.cwd(), 'db', 'conversations');
  const filePath = path.join(conversationsDir, `${conversationId}.json`);
  log.debug('Target file path for deletion', { requestId, filePath });

  try {
    // Attempt to delete the file from storage
    await fs.unlink(filePath);
    log.info(`Successfully deleted conversation file from storage`, { requestId, conversationId });

    // Also remove from in-memory state if it exists
    if (FlowExecutor.conversationStates.has(conversationId)) {
      FlowExecutor.conversationStates.delete(conversationId);
      log.debug(`Removed conversation state from memory`, { requestId, conversationId });
    }

    return new Response(null, { status: 204 }); // Success, No Content

  } catch (error: any) {
    log.error('Error deleting conversation', {
      requestId,
      conversationId,
      filePath,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack, code: (error as NodeJS.ErrnoException).code } : error
    });

    // If the error is file not found, it's arguably successful from the client's perspective
    if (error.code === 'ENOENT') {
      log.warn('Conversation file not found during delete, treating as success (already deleted).', { requestId, conversationId });
       // Also remove from in-memory state just in case
      if (FlowExecutor.conversationStates.has(conversationId)) {
        FlowExecutor.conversationStates.delete(conversationId);
        log.debug(`Removed potentially orphaned conversation state from memory`, { requestId, conversationId });
      }
      return new Response(null, { status: 204 }); // Success, No Content
    }

    return NextResponse.json({ error: 'Failed to delete conversation' }, { status: 500 });
  }
}
