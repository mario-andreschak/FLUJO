import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import OpenAI from 'openai';
import { ChatCompletionMetadata } from '@/shared/types'; // Import the new shared type
import type { McpAppModelContextMap } from '@/shared/types/chat';
import type { McpSkillSelection } from '@/shared/types/mcp';
import {
  BehaviorSlotKeySchema,
  EnduringAgentIdSchema,
} from '@/shared/types/enduringAgent';
import { parseMcpAppModelContexts } from '@/backend/mcpApps/modelContext';
import { parseMcpSkillSelections } from '@/backend/services/mcp/skillModelContext';
import { requireFunctionToolCalls, requireFunctionTools } from '@/shared/types/openai';
import { acquireChatIngress, CHAT_INGRESS_LIMITS, finishChatInputParsing, preflightChatJson, readChatJson, refuseChatInput, type ChatIngressPermit } from '@/utils/http/chatIngress';

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
  /** Exact approved MCP Skill identities selected for this conversation turn. */
  mcpSkillSelections?: McpSkillSelection[];
  /** Parsed internal response-shaping flag; public callers should use metadata. */
  compactToolPayloads?: boolean;
  /** Parsed stateful-chat flag: append request messages to saved history. */
  appendMessages?: boolean;
}

// Define a new interface for the parsed result including the extracted flags
export interface ParsedChatCompletionRequest extends Omit<ChatCompletionRequest, 'metadata' | 'conversation_id'> { // Omit metadata and deprecated conversation_id
  flujo: boolean;
  conversation_id?: string; // Keep conversation_id here for the result
  requireApproval: boolean;
  flujodebug: boolean; // Add flujodebug here
  processNodeId?: string; // Add processNodeId for message edits
  compactToolPayloads: boolean;
  appendMessages: boolean;
  /** Validated trusted-control-plane Persona target, never forwarded as model input. */
  personaTarget?: PersonaChatCompletionTarget;
}

// Parse request parameters from either query string or body
export async function parseRequestParameters(request: NextRequest, permit?: ChatIngressPermit): Promise<ParsedChatCompletionRequest> {
  const owned = permit ?? acquireChatIngress(request);
  try { return await parseAdmittedRequest(request, owned); }
  finally { if (!permit) owned.release(); }
}

async function parseAdmittedRequest(request: NextRequest, permit: ChatIngressPermit): Promise<ParsedChatCompletionRequest> {
  const startTime = Date.now();
  const requestId = `req-${Date.now()}`;
  log.debug('Parsing request parameters', { requestId, method: request.method });
  
  if (request.method === 'GET') {
    // Extract parameters from query string
    let parameters = 1;
    for (let index = request.url.indexOf('?') + 1; index < request.url.length; index++) {
      if (request.url[index] === '&' && ++parameters > CHAT_INGRESS_LIMITS.queryParameters) refuseChatInput('CHAT_INPUT_TOO_LARGE');
    }
    const url = new URL(request.url);
    
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
      modelCharacters: model.length,
      messageContentLength: messageContent.length,
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
      appendMessages: false,
    };

    const duration = Date.now() - startTime;
    log.info('GET request parameters parsed successfully', {
      requestId,
      duration: `${duration}ms`,
      modelCharacters: model.length,
      stream
    });
    
    finishChatInputParsing(permit, request.url.length, parameters * 2);
    return result;
  } else {
    // Parse the request body for POST
    log.debug('Parsing request body for POST', { requestId });
    try {
      const contentType = request.headers.get('content-type') || '';
      log.debug('Request content type', { requestId, contentTypeCharacters: contentType.length });
      
      const decoded = await readChatJson(request, permit);
      const data = decoded.data as ChatCompletionRequest;
      if (typeof data.model !== 'string' || !Array.isArray(data.messages)
        || data.messages.some(message => !message || typeof message !== 'object' || Array.isArray(message))
        || (data.metadata !== undefined && (!data.metadata || typeof data.metadata !== 'object' || Array.isArray(data.metadata)))) {
        refuseChatInput('CHAT_INPUT_INVALID');
      }
      // Nested JSON strings also receive a lexical limit before their parsers.
      let metadataValues = 0;
      for (const serialized of [data.metadata?.mcpAppContexts, data.metadata?.mcpSkills]) {
        if (typeof serialized === 'string') metadataValues += preflightChatJson(Buffer.from(serialized));
      }
      if (decoded.values + metadataValues > CHAT_INGRESS_LIMITS.values) refuseChatInput('CHAT_INPUT_TOO_LARGE');

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
      const appendMessages = data.metadata?.appendMessages === "true";
      const personaTarget = parsePersonaTarget(data.metadata);
      const parsedAppContexts = parseMcpAppModelContexts(data.metadata?.mcpAppContexts);
      const parsedSkillSelections = parseMcpSkillSelections(data.metadata?.mcpSkills);
      if (parsedAppContexts.error) {
        log.warn('Ignoring invalid MCP App model context metadata', {
          requestId,
          invalidContextMetadata: true,
        });
      }
      if (parsedSkillSelections.error) {
        log.warn('Ignoring invalid MCP Skill selection metadata', {
          requestId,
          invalidSkillMetadata: true,
        });
      }

      const duration = Date.now() - startTime;
      log.info('POST request body parsed successfully', {
        requestId,
        duration: `${duration}ms`,
        modelCharacters: data.model.length,
        hasMessages: !!data.messages,
        messageCount: data.messages?.length || 0,
        stream: !!data.stream,
        temperature: data.temperature,
        flujo,
        hasConversationId: Boolean(conversationId),
        requireApproval,
        flujodebug,
        personaTargeted: Boolean(personaTarget),
      });

      // Remove metadata and deprecated conversation_id before returning
      const { metadata, conversation_id: deprecated_conv_id, ...restData } = data;

      // Return the rest of the data object along with the extracted flags and processNodeId
      finishChatInputParsing(permit, decoded.characters, decoded.values + metadataValues, decoded.rawBytes);
      return { 
        ...restData, 
        flujo, 
        conversation_id: conversationId, 
        requireApproval, 
        flujodebug,
        compactToolPayloads,
        appendMessages,
        ...(personaTarget ? { personaTarget } : {}),
        mcpAppContexts: parsedAppContexts.contexts,
        mcpSkillSelections: parsedSkillSelections.selections,
        processNodeId: data.processNodeId ?? data.metadata?.processNodeId,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      log.error('Error parsing request body', {
        requestId,
        errorName: error instanceof Error ? error.name : 'Error',
        duration: `${duration}ms`,
        // Worker control tokens and other credentials arrive in headers.
        // Header names are sufficient for request-shape diagnostics.
        headerNames: Array.from(request.headers.keys())
      });
      throw error;
    }
  }
}
