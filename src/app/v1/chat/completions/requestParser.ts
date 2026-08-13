import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import OpenAI from 'openai';
import { ChatCompletionMetadata } from '@/shared/types'; // Import the new shared type
import type { McpAppModelContextMap } from '@/shared/types/chat';
import {
  BehaviorSlotKeySchema,
  EnduringAgentIdSchema,
} from '@/shared/types/enduringAgent';
import { parseMcpAppModelContexts } from '@/backend/mcpApps/modelContext';
import { requireFunctionToolCalls, requireFunctionTools } from '@/shared/types/openai';

const log = createLogger('app/v1/chat/completions/requestParser');

export class InvalidPersonaChatMetadataError extends Error {
  readonly code = 'invalid_persona_metadata';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidPersonaChatMetadataError';
  }
}

export interface PersonaChatCompletionTarget {
  personaId: string;
  behaviorSlotKey?: string;
  idempotencyKey?: string;
}

function optionalPersonaMetadataString(
  value: unknown,
  field: string,
  validate: (candidate: string) => boolean,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new InvalidPersonaChatMetadataError(`metadata.${field} must be a string.`);
  }
  const candidate = value.trim();
  if (!validate(candidate)) {
    throw new InvalidPersonaChatMetadataError(`metadata.${field} is invalid.`);
  }
  return candidate;
}

function parsePersonaTarget(
  metadata: ChatCompletionMetadata | undefined,
): PersonaChatCompletionTarget | undefined {
  const personaId = optionalPersonaMetadataString(
    metadata?.personaId,
    'personaId',
    (candidate) => EnduringAgentIdSchema.safeParse(candidate).success,
  );
  const behaviorSlotKey = optionalPersonaMetadataString(
    metadata?.behaviorSlotKey,
    'behaviorSlotKey',
    (candidate) => BehaviorSlotKeySchema.safeParse(candidate).success,
  );
  const idempotencyKey = optionalPersonaMetadataString(
    metadata?.idempotencyKey,
    'idempotencyKey',
    (candidate) => candidate.length > 0 && candidate.length <= 512,
  );
  if (!personaId && (behaviorSlotKey || idempotencyKey)) {
    throw new InvalidPersonaChatMetadataError(
      'metadata.personaId is required when Persona routing metadata is supplied.',
    );
  }
  return personaId
    ? {
        personaId,
        ...(behaviorSlotKey ? { behaviorSlotKey } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      }
    : undefined;
}

// Types for better TypeScript support using OpenAI SDK types directly
export interface ChatCompletionRequest {
  model: string;
  messages: Array<OpenAI.ChatCompletionMessageParam>;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  user?: string;
  // Tool definitions (standard OpenAI semantics). Only honored on direct
  // `model-` completions, where they are passed through to the provider and
  // any tool_calls are returned to the CLIENT for execution. The flow path
  // manages its own MCP tools and ignores this field.
  tools?: Array<OpenAI.ChatCompletionFunctionTool>;
  // Custom extension for conversation state management (DEPRECATED - use metadata)
  conversation_id?: string;
  // Use the strict metadata type
  metadata?: ChatCompletionMetadata;
  // Node ID to start processing from (for message edits)
  processNodeId?: string;
  /** Validated, future-turn-only context supplied by mounted MCP Apps. */
  mcpAppContexts?: McpAppModelContextMap;
  /** Parsed internal response-shaping flag; public callers should use metadata. */
  compactToolPayloads?: boolean;
}

// Define a new interface for the parsed result including the extracted flags
export interface ParsedChatCompletionRequest extends Omit<ChatCompletionRequest, 'metadata' | 'conversation_id'> { // Omit metadata and deprecated conversation_id
  flujo: boolean;
  conversation_id?: string; // Keep conversation_id here for the result
  requireApproval: boolean;
  flujodebug: boolean; // Add flujodebug here
  processNodeId?: string; // Add processNodeId for message edits
  compactToolPayloads: boolean;
  /** Validated trusted-control-plane Persona target, never forwarded as model input. */
  personaTarget?: PersonaChatCompletionTarget;
}

// Parse request parameters from either query string or body
export async function parseRequestParameters(request: NextRequest): Promise<ParsedChatCompletionRequest> { // Update return type
  const startTime = Date.now();
  const requestId = `req-${Date.now()}`;
  log.debug('Parsing request parameters', { requestId, method: request.method, url: request.url });
  
  if (request.method === 'GET') {
    // Extract parameters from query string
    const url = new URL(request.url);
    log.debug('Parsing GET request query parameters', {
      requestId,
      searchParams: Object.fromEntries(url.searchParams)
    });
    
    const model = url.searchParams.get('model') || '';
    const messageContent = url.searchParams.get('message') || '';
    const stream = url.searchParams.get('stream') === 'true';
    const temperature = parseFloat(url.searchParams.get('temperature') || '0');
    // parseInt(... || '0') yields 0 when the param is absent; a 0/negative cap
    // must normalize to undefined so it doesn't shadow the per-model default.
    const parsedMaxTokens = parseInt(url.searchParams.get('max_tokens') || '0', 10);
    const max_tokens = Number.isFinite(parsedMaxTokens) && parsedMaxTokens > 0 ? parsedMaxTokens : undefined;
    
    log.debug('Extracted parameters from query string', {
      requestId,
      model,
      messageContentLength: messageContent.length,
      messageContentPreview: messageContent.length > 50 ?
        `${messageContent.substring(0, 50)}...` : messageContent,
      stream,
      temperature: isNaN(temperature) ? undefined : temperature,
      max_tokens
    });
    
    const result = {
      model,
      messages: [
        {
          role: 'user',
          content: messageContent
        } as OpenAI.ChatCompletionMessageParam
      ],
      stream,
      temperature: isNaN(temperature) ? undefined : temperature,
      max_tokens,
      // Add flags for GET requests (always false as metadata isn't supported)
      flujo: false,
      requireApproval: false, // Always false for GET
      flujodebug: false, // Always false for GET
      compactToolPayloads: false,
    };

    const duration = Date.now() - startTime;
    log.info('GET request parameters parsed successfully', {
      requestId,
      duration: `${duration}ms`,
      model,
      stream
    });
    
    return result;
  } else {
    // Parse the request body for POST
    log.debug('Parsing request body for POST', { requestId });
    try {
      const contentType = request.headers.get('content-type') || '';
      log.debug('Request content type', { requestId, contentType });
      
      const data: ChatCompletionRequest = await request.json(); // Add type annotation

      // `personaTarget` is an internal parsed field, not a public wire field.
      // Rejecting it here prevents an unvalidated top-level JSON property from
      // surviving the later object spread when validated metadata is absent.
      if ('personaTarget' in (data as ChatCompletionRequest & { personaTarget?: unknown })) {
        throw new InvalidPersonaChatMetadataError(
          'Persona routing must be supplied through request metadata.',
        );
      }

      // SDK 7 models tools and tool calls as function/custom unions. FLUJO's
      // execution protocol is function-only, so reject unsupported wire shapes
      // before they can create an unanswerable assistant/tool transcript.
      requireFunctionTools(data.tools);
      for (const message of data.messages ?? []) {
        if (message.role === 'assistant') {
          requireFunctionToolCalls(message.tool_calls);
        }
      }

      // Extract flags from the strictly typed metadata
      const flujo = data.metadata?.flujo === "true";
      // Prefer conversationId (camelCase) from metadata, fallback to deprecated body field
      const conversationId = data.metadata?.conversationId || data.conversation_id;
      const requireApproval = data.metadata?.requireApproval === "true";
      const flujodebug = data.metadata?.flujodebug === "true"; // Extract flujodebug
      const compactToolPayloads = data.metadata?.compactToolPayloads === "true";
      const personaTarget = parsePersonaTarget(data.metadata);
      const parsedAppContexts = parseMcpAppModelContexts(data.metadata?.mcpAppContexts);
      if (parsedAppContexts.error) {
        log.warn('Ignoring invalid MCP App model context metadata', {
          requestId,
          error: parsedAppContexts.error,
        });
      }

      const duration = Date.now() - startTime;
      log.info('POST request body parsed successfully', {
        requestId,
        duration: `${duration}ms`,
        model: data.model,
        hasMessages: !!data.messages,
        messageCount: data.messages?.length || 0,
        stream: !!data.stream,
        temperature: data.temperature,
        flujo,
        conversationId,
        requireApproval,
        flujodebug,
        personaTargeted: Boolean(personaTarget),
      });

      // Remove metadata and deprecated conversation_id before returning
      const { metadata, conversation_id: deprecated_conv_id, ...restData } = data;

      // Return the rest of the data object along with the extracted flags and processNodeId
      return { 
        ...restData, 
        flujo, 
        conversation_id: conversationId, 
        requireApproval, 
        flujodebug,
        compactToolPayloads,
        ...(personaTarget ? { personaTarget } : {}),
        mcpAppContexts: parsedAppContexts.contexts,
        processNodeId: data.processNodeId // Pass through processNodeId if provided
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      log.error('Error parsing request body', {
        requestId,
        error,
        duration: `${duration}ms`,
        headers: Object.fromEntries(request.headers)
      });
      throw error;
    }
  }
}

// Helper function to log detailed request information
// Currently disabled but kept for future use
export async function _logRequestDetails(request: NextRequest) {
  return; // for now return early
  log.debug('Request details', { 
    url: request.url,
    method: request.method,
    headers: Object.fromEntries(request.headers)
  });
  
  if (request.nextUrl.search) {
    log.debug('Query parameters', { params: Object.fromEntries(request.nextUrl.searchParams) });
  }
  
  try {
    // Clone the request to avoid consuming the body
    const clonedRequest = request.clone();
    const contentType = request.headers.get('content-type') || '';
    
    if (contentType.includes('application/json')) {
      try {
        const body = await clonedRequest.json();
        // Truncate messages content if present
        if (body && body.messages && Array.isArray(body.messages)) {
          const truncatedBody = { ...body };
          // Use OpenAI type instead of custom interface
          type Message = OpenAI.ChatCompletionMessageParam;
          
          truncatedBody.messages = body.messages.map((msg: Message) => {
            if (msg && msg.content && typeof msg.content === 'string' && msg.content.length > 100) {
              return {
                ...msg,
                content: msg.content.substring(0, 100) + `... (${msg.content.length - 100} more characters)`
              };
            }
            return msg;
          });
          log.debug('Request body (JSON, truncated)', truncatedBody);
        } else {
          log.debug('Request body (JSON)', body);
        }
      } catch (error) {
        log.debug('Failed to parse JSON body', error);
      }
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
      try {
        const formData = await clonedRequest.formData();
        log.debug('Request body (Form)', Object.fromEntries(formData));
      } catch (error) {
        log.debug('Failed to parse form data', error);
      }
    } else {
      try {
        const text = await clonedRequest.text();
        const truncatedText = text.length > 100 ? 
          text.substring(0, 100) + `... (${text.length - 100} more characters)` : text;
        log.debug('Request body (Text, truncated)', { text: truncatedText });
      } catch (error) {
        log.debug('Failed to read request text', error);
      }
    }
  } catch (error) {
    log.debug('Failed to process request body', error);
  }
}
