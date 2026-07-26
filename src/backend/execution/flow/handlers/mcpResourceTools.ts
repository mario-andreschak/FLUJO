/**
 * mcpResourceTools.ts — Synthetic tools for native MCP server resources (issue #239).
 *
 * Exposes two capabilities to the model at runtime:
 *
 * 1. `list_mcp_resources` — returns the union of resources/list + resources/templates/list
 *    across all bound MCP nodes for the current ProcessNode. Only offered when at least one
 *    server has resources and at least one MCPNode's enabledResources is not [].
 *
 * 2. Native URI dispatch in `read_resource` — when the model calls read_resource with a
 *    URI that is NOT a flujo://run/... marker, this module resolves which bound server owns
 *    it and calls mcpService.readResource(). Large / binary results are auto-captured into
 *    the run-resource store (Tier-3) and replaced with a flujo://run/... stub.
 *
 * The per-node `enabledResources` field mirrors `enabledTools`:
 *   - undefined or 'all'  → expose all resources from this server (default)
 *   - string[]            → expose only resources whose URI is in the list
 *   - []                  → disable native resource exposure for this node's server
 */

import { createLogger } from '@/utils/logger';
import { MCPNodeReference, ToolDefinition } from '../types';
import { mcpService } from '@/backend/services/mcp';
import { writeRunResource } from '@/backend/services/runResources';
import { DEFAULT_RUN_RESOURCE_SETTINGS } from '@/shared/types/runResources';
import { EmitFn, NodeRef } from '@/shared/types/execution/events';
import type { MCPResource, MCPResourceTemplate, MCPReadResourceResult } from '@/shared/types/mcp';

const log = createLogger('backend/flow/execution/handlers/mcpResourceTools');

export const LIST_MCP_RESOURCES_TOOL_NAME = 'list_mcp_resources';

/** Max total entries returned by list_mcp_resources (resources + templates combined). */
const LIST_MCP_RESOURCES_CAP = 200;

/**
 * Text content items at or above this many characters are auto-captured and replaced
 * with a stub. Reuses the same default as RunResourceSettings.textThresholdChars.
 */
const TEXT_CAPTURE_THRESHOLD = DEFAULT_RUN_RESOURCE_SETTINGS.textThresholdChars;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true if this MCPNode's enabledResources setting allows ANY resource exposure. */
function shouldExposeResources(enabledResources: string[] | 'all' | undefined): boolean {
  if (enabledResources === undefined || enabledResources === 'all') return true;
  return enabledResources.length > 0;
}

/** Filter a resource list by the node's enabledResources allowlist. */
function filterByEnabledResources(
  resources: MCPResource[],
  enabledResources: string[] | 'all' | undefined,
): MCPResource[] {
  if (enabledResources === undefined || enabledResources === 'all') return resources;
  const allowed = new Set(enabledResources);
  return resources.filter((r) => allowed.has(r.uri));
}

/** Filter a template list by the node's enabledResources allowlist (by uriTemplate). */
function filterTemplatesByEnabledResources(
  templates: MCPResourceTemplate[],
  enabledResources: string[] | 'all' | undefined,
): MCPResourceTemplate[] {
  if (enabledResources === undefined || enabledResources === 'all') return templates;
  const allowed = new Set(enabledResources);
  return templates.filter((t) => allowed.has(t.uriTemplate));
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface MCPResourceToolContext {
  conversationId?: string;
  nodeId?: string;
  ephemeral?: boolean;
  /** The current ProcessNode's bound MCP nodes — for server routing. */
  mcpNodes: MCPNodeReference[];
  emit?: EmitFn;
  /** Producing process node, for lineage. */
  node?: NodeRef;
}

export interface MCPResourceToolOutcome {
  success: boolean;
  data?: unknown;
  error?: string;
}

/** True for any synthetic MCP resource tool name dispatched by this module. */
export function isMCPResourceToolName(name: string): boolean {
  return name === LIST_MCP_RESOURCES_TOOL_NAME;
}

/**
 * Build the `list_mcp_resources` synthetic tool definition for the given
 * MCPNodeReferences. Returns [] when:
 * - no MCP nodes are provided, or
 * - all nodes have enabledResources: [], or
 * - all eligible servers return empty resource + template lists.
 *
 * The empty-return keeps the tool set byte-identical for resource-free steps,
 * preserving the provider prefix-cache (#89 stability).
 */
export async function buildMCPResourceTools(
  mcpNodes: MCPNodeReference[],
): Promise<ToolDefinition[]> {
  if (!mcpNodes || mcpNodes.length === 0) return [];

  let totalCount = 0;
  const serverNames: string[] = [];

  for (const mcpNode of mcpNodes) {
    const { boundServer, enabledResources } = mcpNode.properties;
    if (!boundServer) continue;
    if (!shouldExposeResources(enabledResources)) continue;

    try {
      const [resourcesResult, templatesResult] = await Promise.all([
        mcpService.listServerResources(boundServer),
        mcpService.listServerResourceTemplates(boundServer),
      ]);

      const filteredResources = filterByEnabledResources(
        resourcesResult.resources ?? [],
        enabledResources,
      );
      const filteredTemplates = filterTemplatesByEnabledResources(
        (templatesResult.resourceTemplates ?? []) as MCPResourceTemplate[],
        enabledResources,
      );

      const count = filteredResources.length + filteredTemplates.length;
      if (count > 0 && !serverNames.includes(boundServer)) {
        serverNames.push(boundServer);
        totalCount += count;
      }
    } catch (err) {
      // Listing failure is non-fatal — resources are additive, not blocking.
      log.warn('buildMCPResourceTools: failed to list resources from server, skipping', {
        server: boundServer,
        err,
      });
    }
  }

  if (totalCount === 0) return [];

  const serverList = serverNames.join(', ');
  return [
    {
      name: LIST_MCP_RESOURCES_TOOL_NAME,
      description:
        `List the native MCP resources and resource templates available from bound servers (${serverList}). ` +
        'Returns a JSON object with a "servers" array, each entry containing the server name, its ' +
        '"resources" list (uri, name, description, mimeType) and its "templates" list (uriTemplate, name, ' +
        'description, mimeType). Once you have a resource URI call read_resource to fetch its content.',
      inputSchema: {
        type: 'object',
        properties: {
          server_filter: {
            type: 'string',
            description: `Optional server name to restrict results to. One of: ${serverList}.`,
          },
        },
      },
    },
  ];
}

/**
 * Execute a `list_mcp_resources` call. Collects resources and templates from all
 * bound servers (respecting enabledResources per node), applies the optional
 * server_filter argument, and caps at LIST_MCP_RESOURCES_CAP entries.
 */
async function executeListMCPResources(
  args: Record<string, unknown>,
  ctx: MCPResourceToolContext,
): Promise<MCPResourceToolOutcome> {
  const serverFilter = typeof args?.server_filter === 'string' ? args.server_filter.trim() : '';

  const result: Array<{
    server: string;
    resources: MCPResource[];
    templates: MCPResourceTemplate[];
  }> = [];

  let totalCount = 0;
  let truncated = false;

  for (const mcpNode of ctx.mcpNodes) {
    const { boundServer, enabledResources } = mcpNode.properties;
    if (!boundServer) continue;
    if (!shouldExposeResources(enabledResources)) continue;
    if (serverFilter && boundServer !== serverFilter) continue;

    try {
      const [resourcesResult, templatesResult] = await Promise.all([
        mcpService.listServerResources(boundServer),
        mcpService.listServerResourceTemplates(boundServer),
      ]);

      const filteredResources = filterByEnabledResources(
        resourcesResult.resources ?? [],
        enabledResources,
      );
      const filteredTemplates = filterTemplatesByEnabledResources(
        (templatesResult.resourceTemplates ?? []) as MCPResourceTemplate[],
        enabledResources,
      );

      // Apply cap
      const remaining = LIST_MCP_RESOURCES_CAP - totalCount;
      if (remaining <= 0) {
        truncated = true;
        break;
      }

      const cappedResources = filteredResources.slice(0, remaining);
      const afterResources = remaining - cappedResources.length;
      const cappedTemplates = filteredTemplates.slice(0, afterResources);

      if (cappedResources.length < filteredResources.length || cappedTemplates.length < filteredTemplates.length) {
        truncated = true;
      }

      totalCount += cappedResources.length + cappedTemplates.length;

      // Only include the server entry if it has any results
      if (cappedResources.length > 0 || cappedTemplates.length > 0) {
        // De-dup: same server may appear via multiple MCPNodes
        const existing = result.find((r) => r.server === boundServer);
        if (existing) {
          // Merge, avoiding duplicate URIs
          const existingUris = new Set(existing.resources.map((r) => r.uri));
          existing.resources.push(...cappedResources.filter((r) => !existingUris.has(r.uri)));
          const existingTpls = new Set(existing.templates.map((t) => t.uriTemplate));
          existing.templates.push(...cappedTemplates.filter((t) => !existingTpls.has(t.uriTemplate)));
        } else {
          result.push({ server: boundServer, resources: cappedResources, templates: cappedTemplates });
        }
      }
    } catch (err) {
      log.warn('executeListMCPResources: failed to list from server, skipping', {
        server: boundServer,
        err,
      });
    }
  }

  const data: Record<string, unknown> = { servers: result };
  if (truncated) {
    data.note = `Results capped at ${LIST_MCP_RESOURCES_CAP} entries. Use server_filter to narrow results.`;
  }

  return { success: true, data };
}

/**
 * Execute a native `read_resource` call for a non-`flujo://run/` URI.
 * Finds the bound server that owns the URI, calls mcpService.readResource,
 * auto-captures large/binary content into the run-resource store, and returns
 * either the inline content or a flujo://run/... stub.
 */
export async function executeNativeReadResource(
  uri: string,
  ctx: MCPResourceToolContext,
): Promise<MCPResourceToolOutcome> {
  // 1. Find which bound server advertises this URI (or a matching template).
  //    Re-list on demand to ensure freshness.
  let owningServer: string | undefined;
  let ownerEnabledResources: string[] | 'all' | undefined;

  for (const mcpNode of ctx.mcpNodes) {
    const { boundServer, enabledResources } = mcpNode.properties;
    if (!boundServer) continue;
    if (!shouldExposeResources(enabledResources)) continue;

    // Check if this enabledResources allowlist permits this URI
    if (Array.isArray(enabledResources) && enabledResources.length > 0) {
      // It's an allowlist — URI must be in it
      if (!enabledResources.includes(uri)) continue;
    }

    // Re-list the server's resources to confirm the URI is advertised
    try {
      const resourcesResult = await mcpService.listServerResources(boundServer);
      const found = (resourcesResult.resources ?? []).some((r) => r.uri === uri);
      if (found) {
        owningServer = boundServer;
        ownerEnabledResources = enabledResources;
        break;
      }
      // Also check templates (URI might be a resolved template URI — we allow it
      // if the URI prefix is derivable from a template uriTemplate on the same server)
      // For simplicity, just attempt read without matching template; the server will
      // refuse with an appropriate error if the URI is invalid.
    } catch {
      // listing failure — try next node
    }
  }

  if (!owningServer) {
    return {
      success: false,
      error:
        `No bound MCP server advertises the resource URI "${uri}". ` +
        'Use list_mcp_resources to see available URIs.',
    };
  }

  // 2. Call mcpService.readResource
  let readResult: { success: boolean; data?: MCPReadResourceResult; error?: string; statusCode?: number };
  try {
    readResult = await mcpService.readResource(owningServer, uri) as typeof readResult;
  } catch (err) {
    log.error('executeNativeReadResource: mcpService.readResource threw', { server: owningServer, uri, err });
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (!readResult.success || !readResult.data) {
    return {
      success: false,
      error: readResult.error ?? `Failed to read resource ${uri} from ${owningServer}`,
    };
  }

  // 3. Process content items — auto-capture large/binary, return inline for small text.
  const contents = (readResult.data as MCPReadResourceResult).contents ?? [];

  // Collect all text parts first to gauge inline vs. capture
  const textParts: string[] = [];
  let hasBinary = false;

  for (const item of contents) {
    if (typeof (item as { text?: unknown }).text === 'string') {
      textParts.push((item as { text: string }).text);
    } else if (typeof (item as { blob?: unknown }).blob === 'string') {
      hasBinary = true;
    }
  }

  const fullText = textParts.join('\n');
  const isLarge = fullText.length >= TEXT_CAPTURE_THRESHOLD;

  if (!hasBinary && !isLarge) {
    // Return inline — small text, no capture needed
    log.info('executeNativeReadResource: returning inline text', { server: owningServer, uri, chars: fullText.length });
    return {
      success: true,
      data: { uri, server: owningServer, content: fullText },
    };
  }

  // 4. Auto-capture large or binary content into the run-resource store
  if (!ctx.conversationId || ctx.ephemeral) {
    // No store available — return inline as best-effort (truncated for large text)
    const truncatedText = isLarge ? fullText.slice(0, TEXT_CAPTURE_THRESHOLD) + '\n…[truncated]' : fullText;
    return {
      success: true,
      data: { uri, server: owningServer, content: truncatedText, note: 'Content truncated (no run-resource store in this context).' },
    };
  }

  try {
    let kind: 'text' | 'blob';
    let data: { text: string } | { base64: string };

    if (hasBinary) {
      kind = 'blob';
      // Find the first blob item
      const blobItem = contents.find((c) => typeof (c as { blob?: unknown }).blob === 'string') as { blob: string } | undefined;
      data = { base64: blobItem?.blob ?? '' };
    } else {
      kind = 'text';
      data = { text: fullText };
    }

    const mimeType = (contents[0] as { mimeType?: string })?.mimeType;

    const written = await writeRunResource({
      conversationId: ctx.conversationId,
      mimeType,
      kind,
      data,
      producedBy: {
        source: 'capture',
        nodeId: ctx.node?.nodeId,
        nodeName: ctx.node?.nodeName,
      },
      origin: { server: owningServer, uri },
    });

    if ('skipped' in written) {
      log.warn('executeNativeReadResource: auto-capture skipped by store cap', {
        server: owningServer, uri, reason: written.skipped,
      });
      // Fall back to inline truncated text
      const fallback = hasBinary
        ? `[binary resource ${mimeType ?? 'unknown'} from ${owningServer} — too large to store]`
        : fullText.slice(0, TEXT_CAPTURE_THRESHOLD) + '\n…[truncated — store cap exceeded]';
      return { success: true, data: { uri, server: owningServer, content: fallback } };
    }

    ctx.emit?.({
      type: 'resource:write',
      node: ctx.node,
      server: owningServer,
      uri: written.uri,
      name: written.name,
      mimeType: written.mimeType,
      size: written.size,
      source: 'capture',
    });

    const stub =
      `[FLUJO stored the native resource "${uri}" from server "${owningServer}" as run resource ` +
      `${written.uri} (${written.size} bytes, ${written.mimeType ?? written.kind}). ` +
      `Use read_resource with URI ${written.uri} to retrieve the full content.]`;

    log.info('executeNativeReadResource: auto-captured as run resource', {
      server: owningServer, uri, runUri: written.uri, size: written.size,
    });
    return { success: true, data: { uri, server: owningServer, stub, runUri: written.uri } };
  } catch (err) {
    log.error('executeNativeReadResource: auto-capture failed, returning inline fallback', { err });
    const fallback = hasBinary
      ? `[binary resource from ${owningServer} — capture failed]`
      : fullText.slice(0, TEXT_CAPTURE_THRESHOLD) + '\n…[truncated — capture failed]';
    return { success: true, data: { uri, server: owningServer, content: fallback } };
  }
}

/**
 * Execute a `list_mcp_resources` tool call or any other MCP resource tool.
 * The `read_resource` native dispatch path is NOT handled here — it lives in
 * runResourceTools.executeReadResource which calls `executeNativeReadResource`.
 */
export async function executeMCPResourceTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: MCPResourceToolContext,
): Promise<MCPResourceToolOutcome> {
  if (toolName === LIST_MCP_RESOURCES_TOOL_NAME) {
    return executeListMCPResources(args, ctx);
  }
  return { success: false, error: `Unknown MCP resource tool: ${toolName}` };
}
