import { MCPServerConfig } from '@/shared/types/mcp';
import {
  ClaudeConfig,
  ImportResult,
  ToClaudeFormatOptions,
  toClaudeFormat,
  fromClaudeFormat,
} from './claudeFormat';
import { toClineFormat, fromClineFormat } from './clineFormat';

/**
 * Registry of import/export formats for MCP server configs. Adding a new
 * external tool's format is a matter of writing an adapter (export/import) and
 * appending it here; the MCP page's Import/Export dropdowns are driven by this
 * list, so no UI changes are needed.
 */
export type McpFormatId = 'claude' | 'cline';

export interface McpFormat {
  id: McpFormatId;
  /** Label shown in the Import/Export dropdown menus. */
  label: string;
  /** Suggested filename for the exported download. */
  fileName: string;
  /** FLUJO configs -> this tool's JSON shape. */
  export: (servers: MCPServerConfig[], options?: ToClaudeFormatOptions) => ClaudeConfig;
  /** This tool's JSON (string or parsed) -> FLUJO configs. */
  import: (input: string | object) => ImportResult;
}

export const MCP_FORMATS: McpFormat[] = [
  {
    id: 'claude',
    label: 'Claude',
    fileName: 'mcp_config.json',
    export: toClaudeFormat,
    import: fromClaudeFormat,
  },
  {
    id: 'cline',
    label: 'Cline',
    fileName: 'cline_mcp_settings.json',
    export: toClineFormat,
    import: fromClineFormat,
  },
];

export function getMcpFormat(id: McpFormatId): McpFormat {
  return MCP_FORMATS.find((f) => f.id === id) ?? MCP_FORMATS[0];
}

/**
 * Build a ready-to-paste, single-server MCP config JSON string for the
 * "Copy MCP server JSON" button on a server card (#110). Reuses the shared
 * exporter so the card's clipboard payload stays consistent with the bulk
 * export and inherits any future format changes for free.
 *
 * When a full `serverConfig` is available we call the real exporter with a
 * one-element array. For an *exposed* server the exporter emits only
 * `{ type: 'http', url: <proxy-url> }` — no env vars, no headers, no secrets —
 * which is exactly what belongs on the clipboard. When no config is passed
 * (defensive fallback) we synthesise the same proxy-only shape from the name.
 */
export function buildSingleServerJson(
  name: string,
  serverConfig: MCPServerConfig | undefined,
  proxyBaseUrl: string,
  formatId: McpFormatId = 'claude',
): string {
  const base = (proxyBaseUrl || '').replace(/\/$/, '');
  const cfg: ClaudeConfig = serverConfig
    ? getMcpFormat(formatId).export([serverConfig], { proxyBaseUrl: base })
    : { mcpServers: { [name]: { type: 'http', url: `${base}/mcp-proxy/${name}` } } };
  return JSON.stringify(cfg, null, 2);
}
