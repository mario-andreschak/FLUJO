import { NextRequest, NextResponse } from 'next/server'; // Import NextRequest
import { promises as fs } from 'fs';
import path from 'path';
import { createLogger } from '@/utils/logger';
import { SharedState } from '@/backend/execution/flow/types';
import { saveItem } from '@/utils/storage/backend'; // Import saveItem directly
// Use frontend type for response structure, maybe rename for clarity?
import { ConversationListItem as FrontendConversationListItem } from '@/frontend/components/Chat';

const log = createLogger('app/v1/chat/conversations/route');

// Define the structure for the list item returned by GET
// Matches the frontend type now imported as FrontendConversationListItem
interface ConversationListItem extends FrontendConversationListItem {}

// Define the expected structure for the POST request body
interface CreateConversationPayload {
  id: string;
  title: string;
  flowId: string | null;
  createdAt: number;
  updatedAt: number;
}


// --- GET Handler (Existing) ---
export async function GET() {
  const startTime = Date.now();
  const requestId = `conv-list-${Date.now()}`;
  log.info('Handling GET request for conversation list', { requestId });

  const conversationsDir = path.join(process.cwd(), 'db', 'conversations');
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
        const fileContent = await fs.readFile(filePath, 'utf-8');
        const state = JSON.parse(fileContent) as SharedState;

        // Basic validation and data extraction
        const id = state.conversationId || conversationIdFromFile; // Prefer state ID, fallback to filename
        const title = state.title || 'Untitled Conversation'; // Fallback title
        const createdAt = state.createdAt || 0; // Fallback timestamp
        const updatedAt = state.updatedAt || 0; // Fallback timestamp
        const flowId = state.flowId || null; // Use null if missing
        const status = state.status;

        // Ensure ID consistency if possible
        if (state.conversationId && state.conversationId !== conversationIdFromFile) {
          log.warn(`Mismatch between filename ID (${conversationIdFromFile}) and state ID (${state.conversationId})`, { requestId, filePath });
          // Decide which ID to trust - let's trust the state's ID if present
        }

        return {
          id,
          title,
          flowId,
          createdAt,
          updatedAt,
          status
        };
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
  const conversationsDir = path.join(process.cwd(), 'db', 'conversations');
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

    // Save the initial state using the imported saveItem function
    // Note: saveItem expects StorageKey enum, but we are saving to a dynamic path.
    // This suggests the storage utility might need adjustment or we bypass type safety here.
    // Let's assume for now saveItem can handle this path structure, potentially needing a cast.
    // TODO: Review storageService.saveItem signature and usage for dynamic paths.
    await saveItem(`conversations/${conversationId}` as any, initialState); // Using 'as any' to bypass StorageKey type for now
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
