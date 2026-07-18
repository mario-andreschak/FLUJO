import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { NextRequest, NextResponse } from 'next/server'; // Import NextRequest
import { promises as fs } from 'fs';
import path from 'path';
import { createLogger } from '@/utils/logger';
import { SharedState } from '@/backend/execution/flow/types';
import { Flow } from '@/shared/types/flow';
import { saveCollectionItem, assertSafeCollectionId } from '@/utils/storage/backend';
import { getDataDir } from '@/utils/paths';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import { unmarkConversationDeleted } from '@/backend/execution/flow/cancellation';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
// Use frontend type for response structure, maybe rename for clarity?
import { ConversationListItem as FrontendConversationListItem } from '@/frontend/components/Chat';

const log = createLogger('app/v1/chat/conversations/route');

// Define the structure for the list item returned by GET
// Matches the frontend type now imported as FrontendConversationListItem
interface ConversationListItem extends FrontendConversationListItem {}

// Parsed-summary cache for the list GET, keyed by file name. The sidebar now
// polls this endpoint every few seconds, and conversation files carry the FULL
// message history — re-reading and JSON.parsing every file on every poll is
// O(total bytes on disk). The summary only needs six small fields, so cache it
// per file and invalidate on mtime/size change (every write is an atomic
// replace, so a content change always moves the mtime).
const listSummaryCache = new Map<string, { mtimeMs: number; size: number; item: ConversationListItem }>();

// Define the expected structure for the POST request body
interface CreateConversationPayload {
  id: string;
  title: string;
  flowId: string | null;
  createdAt: number;
  updatedAt: number;
  /** Quick-Chats (issue #61): a self-contained flow definition to seed onto the
   *  conversation state instead of referencing a stored flow. When present, the
   *  engine resolves the flow from this snapshot; `flowId` must be the
   *  snapshot's id (quickchat-<id>). */
  flowSnapshot?: Flow;
}


// --- GET Handler (Existing) ---
export async function GET(request: NextRequest) {
  const _lock = await assertUnlocked({ openai: true });
  if (_lock) return _lock;
  // Defense-in-depth localhost / DNS-rebinding guard (#143). Middleware guards
  // this route centrally too; kept inline for the internal control-plane sinks.
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;

  const startTime = Date.now();
  const requestId = `conv-list-${Date.now()}`;
  log.info('Handling GET request for conversation list', { requestId });

  const conversationsDir = path.join(getDataDir(), 'db', 'conversations');
  log.debug('Conversations directory path', { requestId, path: conversationsDir });

  try {
    const files = await fs.readdir(conversationsDir);
    log.debug(`Found ${files.length} items in directory`, { requestId });

    const jsonFiles = files.filter(file => file.endsWith('.json'));
    log.debug(`Found ${jsonFiles.length} JSON files`, { requestId });

    const conversationPromises = jsonFiles.map(async (file): Promise<ConversationListItem | null> => {
      const filePath = path.join(conversationsDir, file);
      const conversationIdFromFile = file.replace('.json', ''); // Extract ID from filename

      try {
        // Summary from disk, via the mtime/size cache (see listSummaryCache).
        const stats = await fs.stat(filePath);
        const cached = listSummaryCache.get(file);
        let base: ConversationListItem;
        if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
          base = cached.item;
        } else {
          const fileContent = await fs.readFile(filePath, 'utf-8');
          const state = JSON.parse(fileContent) as SharedState;

          // Ensure ID consistency if possible
          if (state.conversationId && state.conversationId !== conversationIdFromFile) {
            log.warn(`Mismatch between filename ID (${conversationIdFromFile}) and state ID (${state.conversationId})`, { requestId, filePath });
            // Decide which ID to trust - let's trust the state's ID if present
          }

          base = {
            id: state.conversationId || conversationIdFromFile, // Prefer state ID, fallback to filename
            title: state.title || 'Untitled Conversation',
            flowId: state.flowId || null,
            createdAt: state.createdAt || 0,
            updatedAt: state.updatedAt || 0,
            status: state.status,
          };
          listSummaryCache.set(file, { mtimeMs: stats.mtimeMs, size: stats.size, item: base });
        }

        // Live override: while a run is in flight the in-memory state is ahead
        // of the snapshot on disk (which is only written at run boundaries) —
        // without this, the sidebar of a resumed run reads the PREVIOUS
        // terminal status until the next persist. Memory is never staler than
        // disk here: every disk write comes from this same object.
        const live = FlowExecutor.conversationStates.get(base.id);
        let status = live?.status ?? base.status;
        const title = live?.title ?? base.title;
        const updatedAt = live?.updatedAt ?? base.updatedAt;

        // Reconcile a stale 'running' status. A conversation persists as
        // 'running' while a flow executes, but a process restart drops the
        // in-memory run (and its event channel) without flipping the stored
        // status. Such a run can never resume — re-attaching to it just hangs
        // the live view on "Working…". If the status says 'running' but this
        // process has no live event channel for it, the run is dead: report it
        // as 'error' so the sidebar is honest and the client doesn't
        // auto-reattach to a run that will never emit again.
        if (status === 'running' && executionEventBus.currentSeq(base.id) === 0) {
          log.warn(`Conversation ${base.id} is 'running' with no live run; reporting as interrupted ('error').`, { requestId });
          status = 'error';
        }

        return { ...base, title, updatedAt, status };
      } catch (parseError) {
        log.error(`Error reading or parsing conversation file: ${file}`, { requestId, filePath, error: parseError });
        // Try getting file system time as a fallback for sorting?
        try {
           const stats = await fs.stat(filePath);
           return {
              id: conversationIdFromFile,
              title: `Error Loading (${conversationIdFromFile})`,
              flowId: null,
              createdAt: stats.birthtimeMs,
              updatedAt: stats.mtimeMs,
              status: 'error'
           }
        } catch (statError) {
           log.error(`Could not get stats for errored file: ${file}`, { requestId, statError });
           return null; // Skip this file entirely if stats fail too
        }
      }
    });

    const results = await Promise.all(conversationPromises);
    // Drop cache entries for files that no longer exist (deleted conversations).
    if (listSummaryCache.size > jsonFiles.length) {
      const present = new Set(jsonFiles);
      for (const key of listSummaryCache.keys()) {
        if (!present.has(key)) listSummaryCache.delete(key);
      }
    }
    const validConversations = results.filter((conv): conv is ConversationListItem => conv !== null);
    log.debug(`Successfully processed ${validConversations.length} conversation files`, { requestId });

    // Sort by updatedAt descending
    validConversations.sort((a, b) => b.updatedAt - a.updatedAt);

    const duration = Date.now() - startTime;
    log.info(`Successfully retrieved conversation list`, { requestId, count: validConversations.length, duration: `${duration}ms` });

    return NextResponse.json(validConversations);

  } catch (error: any) {
    const duration = Date.now() - startTime;
    log.error('Error listing conversations', {
      requestId,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack, code: (error as NodeJS.ErrnoException).code } : error,
      duration: `${duration}ms`
    });

    // Check if the error is because the directory doesn't exist
    if (error.code === 'ENOENT') {
      log.warn('Conversations directory does not exist, returning empty list.', { requestId, path: conversationsDir });
      return NextResponse.json([]); // Return empty list if directory not found
    }

    return NextResponse.json({ error: 'Failed to list conversations' }, { status: 500 });
  }
}


// --- POST Handler (New) ---
export async function POST(req: NextRequest) {
  const _lock = await assertUnlocked({ openai: true });
  if (_lock) return _lock;
  // Defense-in-depth localhost / DNS-rebinding guard (#143).
  const notLocal = assertLocalRequest(req);
  if (notLocal) return notLocal;

  const startTime = Date.now();
  const requestId = `conv-create-${Date.now()}`;
  log.info('Handling POST request to create conversation', { requestId });

  let payload: CreateConversationPayload;
  try {
    payload = await req.json();
    log.debug('Received payload', { requestId, payload: JSON.stringify(payload) }); // Use JSON.stringify for verbose logging
  } catch (error) {
    log.warn('Invalid JSON in request body', { requestId, error });
    return NextResponse.json({ error: 'Invalid request body: Must be valid JSON' }, { status: 400 });
  }

  // Basic validation
  if (!payload || typeof payload !== 'object') {
    return NextResponse.json({ error: 'Invalid request body: Must be an object' }, { status: 400 });
  }
  if (!payload.id || typeof payload.id !== 'string') {
    return NextResponse.json({ error: 'Invalid request body: Missing or invalid "id" (string)' }, { status: 400 });
  }
  // Path-traversal guard (issue #126): the id becomes a filesystem path, so an
  // id like "../encryption_key" would escape db/conversations/ and overwrite an
  // arbitrary .json file. Reject anything outside the safe id charset with 400.
  try {
    assertSafeCollectionId(payload.id);
  } catch {
    return NextResponse.json(
      { error: 'Invalid request body: "id" must match ^[A-Za-z0-9_-]{1,64}$' },
      { status: 400 });
  }
  if (!payload.title || typeof payload.title !== 'string') {
    payload.title = 'New Conversation'; // Default title if missing
    log.warn('Missing title in payload, using default', { requestId, conversationId: payload.id });
  }
  // Validate flowId: Must be a non-null string as SharedState requires it
  if (typeof payload.flowId !== 'string' || !payload.flowId) {
     return NextResponse.json({ error: 'Invalid request body: Missing or invalid "flowId" (must be a non-empty string)' }, { status: 400 });
  }
  if (typeof payload.createdAt !== 'number' || typeof payload.updatedAt !== 'number') {
     log.warn('Missing or invalid timestamps in payload, using current time', { requestId, conversationId: payload.id });
     const now = Date.now();
     payload.createdAt = payload.createdAt || now;
     payload.updatedAt = payload.updatedAt || now;
   }


  const conversationId = payload.id;
  // Explicitly creating a conversation under an id clears any deleted-id
  // tombstone (which would otherwise silently block its persistence).
  unmarkConversationDeleted(conversationId);
  const conversationsDir = path.join(getDataDir(), 'db', 'conversations');
  const filePath = path.join(conversationsDir, `${conversationId}.json`);

  try {
    // Ensure the directory exists (storageService might handle this, but explicit check is safer)
    await fs.mkdir(conversationsDir, { recursive: true });

    // Check if file already exists to prevent accidental overwrite (optional but good practice)
    try {
      await fs.access(filePath);
      log.warn(`Conversation file already exists, potentially overwriting`, { requestId, conversationId, filePath });
      // Decide on behavior: return error, allow overwrite, etc. Let's allow overwrite for now.
      // return NextResponse.json({ error: `Conversation with ID ${conversationId} already exists` }, { status: 409 }); // 409 Conflict
    } catch (accessError: any) {
      if (accessError.code !== 'ENOENT') {
        throw accessError; // Re-throw unexpected errors
      }
      // File doesn't exist, proceed normally
    }

    // Create the initial SharedState
    const initialState: SharedState = {
      conversationId: conversationId,
      title: payload.title,
      flowId: payload.flowId, // Now guaranteed to be a string by validation
      // Quick-Chats (issue #61): seed the in-memory flow snapshot so the engine
      // resolves the flow from the conversation state rather than the store.
      ...(payload.flowSnapshot ? { flowSnapshot: payload.flowSnapshot } : {}),
      trackingInfo: { // Initialize required tracking info
        executionId: `exec-${conversationId}-${startTime}`, // Generate an initial execution ID
        startTime: startTime,
        nodeExecutionTracker: [],
      },
      messages: [], // Start with empty messages
      status: undefined, // Initial status should be undefined or a valid state
      createdAt: payload.createdAt,
      updatedAt: payload.updatedAt,
      // Add other necessary initial fields from SharedState if any
      // e.g., currentStep: null, history: [], etc.
      // Removed 'variables: {}' as it's not in SharedState type
    };

    // Save the initial state via the collection API, which validates the id
    // intrinsically (assertSafeCollectionId) and resolves to the identical
    // on-disk path (db/conversations/<id>.json) — no data migration required.
    await saveCollectionItem('conversations', conversationId, initialState);
    log.info(`Successfully saved initial state for conversation`, { requestId, conversationId, filePath });

    // Prepare the response body (matching ConversationListItem)
    const responseItem: ConversationListItem = {
      id: initialState.conversationId!, // Assert non-null as it's validated from payload.id
      title: initialState.title,
      flowId: initialState.flowId, // This is string | null in ConversationListItem
      createdAt: initialState.createdAt,
      updatedAt: initialState.updatedAt,
      status: initialState.status, // This is 'running' | ... | undefined in both types
    };

    const duration = Date.now() - startTime;
    log.info(`Successfully created conversation`, { requestId, conversationId, duration: `${duration}ms` });

    return NextResponse.json(responseItem, { status: 201 }); // 201 Created

  } catch (error: any) {
    const duration = Date.now() - startTime;
    log.error('Error creating conversation', {
      requestId,
      conversationId,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error,
      duration: `${duration}ms`
    });
    return NextResponse.json({ error: 'Failed to create conversation state' }, { status: 500 });
  }
}
