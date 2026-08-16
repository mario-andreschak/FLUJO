/**
 * Resources capability of FLUJO's standalone control-plane MCP package.
 *
 * The tools side lives in internalTools.ts; this module is its resources
 * sibling: it publishes the RUN-SCOPED RESOURCES the flow engine captures
 * during runs (auto-captured tool results, `captureResource` node outputs) as
 * standard MCP resources, so flows and external MCP clients can list and read
 * a run's data artifacts through any persisted record for the package.
 *
 * MCPService loads this module via dynamic import, mirroring internalTools —
 * this file itself is dependency-light (run-resource store + event bus), but
 * keeping the loading pattern uniform means nobody has to re-derive the cycle
 * analysis when imports change here.
 *
 * Security posture: run resources are reachable across conversations (a URI
 * carries its conversationId). This matches the internal server's existing
 * posture — read_conversation already exposes any conversation's transcript —
 * under FLUJO's single-user/localhost model.
 */
import { createLogger } from '@/utils/logger';
import type { MCPResource, MCPResourceTemplate, MCPReadResourceResult, MCPServiceResponse } from '@/shared/types/mcp';
import { RUN_RESOURCE_SCHEME } from '@/shared/types/runResources';
import {
  listAllRunResources,
  readRunResource,
  parseRunResourceUri,
} from '@/backend/services/runResources';
import { isPersonaOwnedConversationState } from '@/backend/execution/flow/personaConversationOwnership';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import { decodeListCursor, encodeListCursor } from './listQuery';

const log = createLogger('backend/services/mcp/internalResources');

const RESOURCE_PAGE_SIZE = 200;

type LoadPersonaDispatchConversationIds = () => Promise<ReadonlySet<string>>;

/**
 * Ephemeral Persona runs intentionally leave no conversation snapshot after
 * completion. Their durable dispatch envelope remains authoritative, so lazily
 * index both the submitted and terminal conversation ids when state is absent.
 */
function createPersonaDispatchConversationIdLoader(): LoadPersonaDispatchConversationIds {
  let pending: Promise<ReadonlySet<string>> | undefined;
  return () => {
    if (!pending) {
      pending = import('@/backend/services/enduringAgents/personaDispatcher')
        .then(async ({ listPersonaFlowDispatches }) => {
          const conversationIds = new Set<string>();
          for (const dispatch of await listPersonaFlowDispatches()) {
            const inputConversationId = dispatch.flowInput?.conversationId;
            const outcomeConversationId = dispatch.outcome?.conversationId;
            if (inputConversationId) conversationIds.add(inputConversationId);
            if (outcomeConversationId) conversationIds.add(outcomeConversationId);
          }
          return conversationIds;
        });
    }
    return pending;
  };
}

/**
 * Persona ownership is carried by the conversation snapshot, never by the
 * public run-resource entry. Resolve it at this shared MCP boundary so both the
 * direct HTTP facade and `/mcp-proxy/flujo` enforce the same policy.
 */
async function isPersonaRunResourceConversation(
  conversationId: string,
  loadDispatchConversationIds: LoadPersonaDispatchConversationIds,
): Promise<boolean> {
  const state = await loadConversationState(conversationId);
  if (state) return isPersonaOwnedConversationState(state);
  return (await loadDispatchConversationIds()).has(conversationId);
}

function describeProducer(entry: Awaited<ReturnType<typeof listAllRunResources>>[number]): string {
  const p = entry.producedBy;
  switch (p.source) {
    case 'tool-result':
      return `Tool result of ${p.server ?? '?'}/${p.toolName ?? '?'}${p.nodeId ? ` (node ${p.nodeId})` : ''}`;
    case 'capture':
      return `Captured output of node ${p.nodeName ?? p.nodeId ?? '?'}`;
    case 'mcp-link':
      return `Resource link from ${p.server ?? '?'}/${p.toolName ?? '?'}`;
    default:
      return 'Run resource';
  }
}

/** resources/list — newest-first run resources across conversations, capped. */
export async function internalListResources(cursor?: string): Promise<{
  resources: MCPResource[];
  nextCursor?: string;
  error?: string;
}> {
  try {
    let offset = cursor ? decodeListCursor(cursor) : 0;
    let hasMore = false;
    const resources: MCPResource[] = [];
    const ownership = new Map<string, Promise<boolean>>();
    const loadDispatchConversationIds = createPersonaDispatchConversationIdLoader();
    const isPersonaOwned = (conversationId: string): Promise<boolean> => {
      let pending = ownership.get(conversationId);
      if (!pending) {
        pending = isPersonaRunResourceConversation(conversationId, loadDispatchConversationIds);
        ownership.set(conversationId, pending);
      }
      return pending;
    };

    // The cursor tracks the RAW resource offset. Continue across chunks until
    // the page is full or the store is exhausted, otherwise filtered Persona
    // entries could create short pages, duplicate cursors, or skipped entries.
    outer: while (true) {
      const entries = await listAllRunResources(RESOURCE_PAGE_SIZE + 1, offset);
      if (entries.length === 0) break;
      for (const entry of entries) {
        if (await isPersonaOwned(entry.conversationId)) {
          offset += 1;
          continue;
        }
        if (resources.length === RESOURCE_PAGE_SIZE) {
          hasMore = true;
          break outer;
        }
        resources.push({
          uri: entry.uri,
          name: entry.name ?? `${entry.kind}-${entry.id.slice(0, 8)}`,
          mimeType: entry.mimeType,
          description: describeProducer(entry),
          // MCP size hint (bytes), per spec an optional annotation-ish field.
          size: entry.size,
        });
        offset += 1;
      }
      if (entries.length <= RESOURCE_PAGE_SIZE) break;
    }
    return {
      resources,
      ...(hasMore ? { nextCursor: encodeListCursor(offset) } : {}),
    };
  } catch (error) {
    log.error('internalListResources failed', error);
    return { resources: [], error: error instanceof Error ? error.message : String(error) };
  }
}

/** resources/templates/list — the run-resource URI space, RFC 6570. */
export function internalListResourceTemplates(): { resourceTemplates: MCPResourceTemplate[]; error?: string } {
  return {
    resourceTemplates: [{
      uriTemplate: `${RUN_RESOURCE_SCHEME}{conversationId}/{resourceId}`,
      name: 'Run-scoped resource',
      description: 'A data artifact captured during a flow run (tool result, node output). ' +
        'List concrete URIs via resources/list.',
    }],
  };
}

/**
 * resources/read — serve a run resource by URI. Appends read lineage and
 * announces the access on the owning conversation's live event stream so the
 * canvas/brain can light up even for reads initiated by external clients.
 */
export async function internalReadResource(uri: string): Promise<MCPServiceResponse<MCPReadResourceResult>> {
  const parsed = parseRunResourceUri(uri);
  if (!parsed) {
    return { success: false, error: `Not a run-resource URI: ${uri}`, statusCode: 400 };
  }
  try {
    if (await isPersonaRunResourceConversation(
      parsed.conversationId,
      createPersonaDispatchConversationIdLoader(),
    )) {
      return {
        success: false,
        error: 'Persona run resources require the trusted local control plane.',
        statusCode: 403,
      };
    }
    const read = await readRunResource(uri, { at: Date.now(), source: 'mcp-read' });
    if (!read) {
      return { success: false, error: `Run resource not found: ${uri}`, statusCode: 404 };
    }
    try {
      executionEventBus.emitterFor(parsed.conversationId)({
        type: 'resource:read',
        server: 'flujo',
        uri,
        name: read.entry.name,
        mimeType: read.entry.mimeType,
        size: read.entry.size,
        source: 'mcp-read',
      });
    } catch { /* observability must never fail the read */ }
    return { success: true, data: read.contents };
  } catch (error) {
    log.error(`internalReadResource failed for ${uri}`, error);
    return { success: false, error: error instanceof Error ? error.message : String(error), statusCode: 500 };
  }
}
