/**
 * Resources capability of FLUJO's built-in internal MCP server ("flujo").
 *
 * The tools side lives in internalTools.ts; this module is its resources
 * sibling: it publishes the RUN-SCOPED RESOURCES the flow engine captures
 * during runs (auto-captured tool results, `captureResource` node outputs) as
 * standard MCP resources, so both flows (via resource pills bound to the
 * "flujo" server) and external MCP clients (via /mcp-proxy/flujo) can list
 * and read a run's data artifacts.
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
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import { INTERNAL_SERVER_NAME } from './internalServerConfig';

const log = createLogger('backend/services/mcp/internalResources');

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
export async function internalListResources(): Promise<{ resources: MCPResource[]; error?: string }> {
  try {
    const entries = await listAllRunResources(200);
    const resources: MCPResource[] = entries.map((entry) => ({
      uri: entry.uri,
      name: entry.name ?? `${entry.kind}-${entry.id.slice(0, 8)}`,
      mimeType: entry.mimeType,
      description: describeProducer(entry),
      // MCP size hint (bytes), per spec an optional annotation-ish field.
      size: entry.size,
    }));
    return { resources };
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
    const read = await readRunResource(uri, { at: Date.now(), source: 'mcp-read' });
    if (!read) {
      return { success: false, error: `Run resource not found: ${uri}`, statusCode: 404 };
    }
    try {
      executionEventBus.emitterFor(parsed.conversationId)({
        type: 'resource:read',
        server: INTERNAL_SERVER_NAME,
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
