import { MCPServerConfig } from '@/shared/types/mcp';
import {
  ClaudeConfig,
  ClaudeServerEntry,
  ImportResult,
  ToClaudeFormatOptions,
  flattenEnv,
  fromClaudeFormat,
} from './claudeFormat';

/**
 * Conversion to/from the Cline format (`cline_mcp_settings.json`).
 * See https://docs.cline.bot/mcp/configuring-mcp-servers.
 *
 * Cline is very close to the Claude format but differs in a few ways:
 *   - remote servers use `type: "streamableHttp"` (camelCase) rather than
 *     Claude's `type: "http"` / `"streamable-http"`;
 *   - every entry carries `disabled`, `autoApprove`, and a `timeout` (seconds);
 *   - omitting `type` on a remote server defaults to legacy SSE, so we always
 *     emit an explicit `type` for non-stdio transports.
 *
 * On import, Cline and Claude entries overlap enough that the tolerant
 * `fromClaudeFormat` parser handles both (it already accepts `streamableHttp`,
 * `disabled`, and `autoApprove`), so the Cline importer simply delegates to it.
 */

// Cline defaults a server's request timeout to 60s; FLUJO has no equivalent
// field, so we emit this constant on export and ignore it on import.
const CLINE_DEFAULT_TIMEOUT = 60;

interface ClineServerEntry extends ClaudeServerEntry {
  disabled: boolean;
  autoApprove: string[];
  timeout: number;
}

export function toClineFormat(
  servers: MCPServerConfig[],
  options: ToClaudeFormatOptions = {}
): ClaudeConfig {
  const proxyBaseUrl = (options.proxyBaseUrl || '').replace(/\/$/, '');
  const mcpServers: Record<string, ClineServerEntry> = {};

  for (const server of servers) {
    const disabled = (server as MCPServerConfig).disabled ?? false;
    const autoApprove = (server as MCPServerConfig).autoApprove ?? [];
    // Common to every Cline entry regardless of transport.
    const common = { disabled, autoApprove, timeout: CLINE_DEFAULT_TIMEOUT };

    // Exposed servers are re-hosted by FLUJO's mcp-proxy: emit them as the
    // recommended streamableHttp transport pointing at the proxy URL.
    if ((server as MCPServerConfig).exposeAsMcpServer) {
      mcpServers[server.name] = {
        ...common,
        type: 'streamableHttp',
        url: `${proxyBaseUrl}/mcp-proxy/${server.name}`,
      };
      continue;
    }

    const env = flattenEnv((server as MCPServerConfig).env);
    const entry: ClineServerEntry = { ...common };

    switch (server.transport) {
      case 'stdio': {
        // Cline detects stdio from the presence of `command`; no `type` field.
        entry.command = server.command;
        entry.args = server.args || [];
        if (Object.keys(env).length > 0) entry.env = env;
        break;
      }
      case 'streamable': {
        entry.type = 'streamableHttp';
        entry.url = server.serverUrl;
        if (server.headers && Object.keys(server.headers).length > 0) {
          entry.headers = flattenEnv(server.headers);
        }
        break;
      }
      case 'sse': {
        entry.type = 'sse';
        entry.url = server.serverUrl;
        if (server.headers && Object.keys(server.headers).length > 0) {
          entry.headers = flattenEnv(server.headers);
        }
        break;
      }
      case 'websocket': {
        // Cline has no native websocket transport; emit `ws` so the entry still
        // round-trips back into FLUJO without losing the URL.
        entry.type = 'ws';
        entry.url = server.websocketUrl;
        break;
      }
      default: {
        if (Object.keys(env).length > 0) entry.env = env;
      }
    }

    mcpServers[server.name] = entry;
  }

  return { mcpServers: mcpServers as Record<string, ClaudeServerEntry> };
}

export function fromClineFormat(input: string | object): ImportResult {
  return fromClaudeFormat(input);
}
