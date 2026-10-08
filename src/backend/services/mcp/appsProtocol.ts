import type { MCPToolResponse } from '@/shared/types/mcp';

/** Stable MCP Apps extension identifier (spec revision 2026-01-26). */
export const MCP_APPS_EXTENSION_ID = 'io.modelcontextprotocol/ui';

/** Stable MCP Apps protocol revision implemented by the host and built-in Views. */
export const MCP_APPS_PROTOCOL_VERSION = '2026-01-26';

/** HTML resource type FLUJO can render for an opted-in MCP Apps server. */
export const MCP_APP_RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';

export type ToolAudience = 'model' | 'app';
export type ToolListAudience = ToolAudience | 'all';
/** Origin of a tool invocation. Host/manual automation is not an MCP visibility audience. */
export type ToolCallSource = ToolAudience | 'host';

const DEFAULT_TOOL_VISIBILITY: readonly ToolAudience[] = ['model', 'app'];

type ToolWithMeta = Pick<MCPToolResponse, 'name' | '_meta'>;

/**
 * Read `_meta.ui.visibility` using the stable MCP Apps rules.
 *
 * Omission defaults to both audiences. An explicitly malformed declaration is
 * fail-closed instead of being treated as omitted: a server must not gain model
 * or app access by supplying an invalid value that the core MCP Tool schema does
 * not understand.
 */
export function getToolVisibility(tool: Pick<ToolWithMeta, '_meta'>): readonly ToolAudience[] {
  const meta = tool._meta;
  if (meta === undefined) return DEFAULT_TOOL_VISIBILITY;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return [];

  const metaRecord = meta as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(metaRecord, 'ui')) {
    return DEFAULT_TOOL_VISIBILITY;
  }
  const ui = metaRecord.ui;
  if (!ui || typeof ui !== 'object' || Array.isArray(ui)) return [];

  const uiRecord = ui as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(uiRecord, 'visibility')) {
    return DEFAULT_TOOL_VISIBILITY;
  }

  const declared = uiRecord.visibility;
  if (
    !Array.isArray(declared) ||
    !declared.every((scope): scope is ToolAudience => scope === 'model' || scope === 'app')
  ) {
    return [];
  }

  return Array.from(new Set(declared));
}

export function isToolVisibleTo(
  tool: Pick<ToolWithMeta, '_meta'>,
  audience: ToolAudience
): boolean {
  return getToolVisibility(tool).includes(audience);
}

/** Preserve raw definitions for `all`; otherwise enforce the requested audience. */
export function filterToolsForAudience<T extends Pick<ToolWithMeta, '_meta'>>(
  tools: T[],
  audience: ToolListAudience
): T[] {
  return audience === 'all' ? tools : tools.filter((tool) => isToolVisibleTo(tool, audience));
}

export type ToolVisibilityCheck =
  | { allowed: true }
  | { allowed: false; error: string; statusCode: 403 | 404 };

/**
 * Authorize a named call against the definitions returned by the same server.
 * The caller supplies definitions from the connection it is about to call, so
 * an app can never authorize against one server and dispatch to another.
 */
export function checkToolCallVisibility(
  tools: ToolWithMeta[],
  serverName: string,
  toolName: string,
  audience: ToolAudience
): ToolVisibilityCheck {
  const tool = tools.find((candidate) => candidate.name === toolName);
  if (!tool) {
    return {
      allowed: false,
      error: `Tool '${toolName}' was not found on MCP server '${serverName}'.`,
      statusCode: 404,
    };
  }

  if (!isToolVisibleTo(tool, audience)) {
    return {
      allowed: false,
      error: `Tool '${toolName}' on MCP server '${serverName}' is not callable by ${audience === 'app' ? 'MCP Apps' : 'the model'}.`,
      statusCode: 403,
    };
  }

  return { allowed: true };
}
