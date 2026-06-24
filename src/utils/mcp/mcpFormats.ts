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
