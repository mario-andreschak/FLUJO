import { MCPServerConfig, EnvVarValue } from '@/shared/types/mcp';

/**
 * Conversion between FLUJO's internal MCP server config and the "Claude format"
 * used by Claude Code / Claude Desktop (`.mcp.json`, `~/.claude.json`,
 * `claude mcp add-json`). See https://code.claude.com/docs/en/mcp.
 *
 * The two formats are almost identical (both keyed under `mcpServers`), but
 * differ in how the transport is named and where the URL lives:
 *
 *   FLUJO                          Claude
 *   ---------------------------    ----------------------------------------
 *   transport: 'stdio'             (no type) command/args/env
 *   transport: 'streamable'        type: 'http'  + url        (+ headers)
 *   transport: 'sse'               type: 'sse'   + url        (+ headers)
 *   transport: 'websocket'         type: 'ws'    + url        (+ headers)
 *
 * Claude also accepts `streamable-http` as an alias for `http`, and `websocket`
 * for `ws`; the importer below tolerates all of these spellings.
 */

// A single server entry in Claude format. Loosely typed because we accept a
// wide range of real-world inputs on import.
export interface ClaudeServerEntry {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  // FLUJO-native fields are also tolerated on import (re-importing our own export).
  transport?: string;
  serverUrl?: string;
  websocketUrl?: string;
  disabled?: boolean;
  autoApprove?: string[];
}

export interface ClaudeConfig {
  mcpServers: Record<string, ClaudeServerEntry>;
}

/** Flatten a FLUJO env value (string | {value, metadata}) down to a plain string. */
export function flattenEnvValue(value: EnvVarValue): string {
  if (value && typeof value === 'object' && 'value' in value) {
    return value.value;
  }
  return typeof value === 'string' ? value : '';
}

export function flattenEnv(env: Record<string, EnvVarValue> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!env) return out;
  for (const [key, value] of Object.entries(env)) {
    out[key] = flattenEnvValue(value);
  }
  return out;
}

export interface ToClaudeFormatOptions {
  /**
   * Origin used to build proxy URLs for servers flagged `exposeAsMcpServer`
   * (e.g. `http://localhost:4200`). When set, an exposed server is emitted as
   * an `http` server pointing at FLUJO's `/mcp-proxy/<name>` endpoint instead
   * of its real transport, so external apps connect through FLUJO. Defaults to
   * an empty string, yielding a relative `/mcp-proxy/<name>` URL.
   */
  proxyBaseUrl?: string;
}

/**
 * Convert FLUJO server configs into a Claude-format config object.
 * Only emits the fields Claude understands, so the result can be pasted into
 * a `.mcp.json` or fed to `claude mcp add-json`.
 */
export function toClaudeFormat(
  servers: MCPServerConfig[],
  options: ToClaudeFormatOptions = {}
): ClaudeConfig {
  const proxyBaseUrl = (options.proxyBaseUrl || '').replace(/\/$/, '');
  const mcpServers: Record<string, ClaudeServerEntry> = {};

  for (const server of servers) {
    // A server flagged "expose to external apps" is re-hosted by FLUJO's
    // mcp-proxy, so external clients should connect to the proxy URL — not the
    // server's own transport. Emit it as a bare http endpoint.
    if ((server as MCPServerConfig).exposeAsMcpServer) {
      mcpServers[server.name] = {
        type: 'http',
        url: `${proxyBaseUrl}/mcp-proxy/${server.name}`,
      };
      continue;
    }

    const entry: ClaudeServerEntry = {};
    const env = flattenEnv((server as MCPServerConfig).env);

    switch (server.transport) {
      case 'stdio': {
        // stdio is Claude's default transport, so we omit `type` to match the
        // canonical `.mcp.json` examples exactly.
        entry.command = server.command;
        entry.args = server.args || [];
        if (Object.keys(env).length > 0) entry.env = env;
        break;
      }
      case 'streamable': {
        entry.type = 'http';
        entry.url = server.serverUrl;
        if (server.headers && Object.keys(server.headers).length > 0) {
          entry.headers = server.headers;
        }
        if (Object.keys(env).length > 0) entry.env = env;
        break;
      }
      case 'sse': {
        entry.type = 'sse';
        entry.url = server.serverUrl;
        if (server.headers && Object.keys(server.headers).length > 0) {
          entry.headers = server.headers;
        }
        if (Object.keys(env).length > 0) entry.env = env;
        break;
      }
      case 'websocket': {
        entry.type = 'ws';
        entry.url = server.websocketUrl;
        if (Object.keys(env).length > 0) entry.env = env;
        break;
      }
      default: {
        // Unknown transport: emit env at least so nothing is silently dropped.
        if (Object.keys(env).length > 0) entry.env = env;
      }
    }

    mcpServers[server.name] = entry;
  }

  return { mcpServers };
}

export interface ImportResult {
  /** Successfully parsed server configs, ready to be added to FLUJO. */
  servers: MCPServerConfig[];
  /** Per-server problems that prevented import (keyed by the offending name). */
  errors: string[];
}

/** Map a Claude `type` (or FLUJO `transport`) value to a FLUJO transport. */
function resolveTransport(entry: ClaudeServerEntry): MCPServerConfig['transport'] | null {
  // Prefer an explicit FLUJO transport when re-importing our own export.
  const raw = (entry.transport || entry.type || '').toString().toLowerCase().trim();

  if (!raw) {
    // No type given: Claude treats this as stdio (it expects command/args).
    return 'stdio';
  }
  switch (raw) {
    case 'stdio':
      return 'stdio';
    case 'http':
    case 'streamable-http':
    case 'streamable':
    case 'streamablehttp':
      return 'streamable';
    case 'sse':
      return 'sse';
    case 'ws':
    case 'websocket':
      return 'websocket';
    default:
      return null;
  }
}

/**
 * Parse a Claude-format JSON string (or already-parsed object) into FLUJO
 * server configs. Tolerates: a top-level `{ mcpServers: {...} }` wrapper or a
 * bare `{ "name": {...} }` map; missing `type` (stdio); the `http`,
 * `streamable-http`, `sse`, `ws`/`websocket` type aliases; and FLUJO-native
 * fields when re-importing an earlier export.
 */
export function fromClaudeFormat(input: string | object): ImportResult {
  const errors: string[] = [];
  const servers: MCPServerConfig[] = [];

  let parsed: unknown;
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input);
    } catch (e) {
      return { servers, errors: [`Invalid JSON: ${(e as Error).message}`] };
    }
  } else {
    parsed = input;
  }

  if (!parsed || typeof parsed !== 'object') {
    return { servers, errors: ['Expected a JSON object.'] };
  }

  // Accept either { mcpServers: {...} } or a bare { name: {...} } map.
  const root = parsed as Record<string, unknown>;
  const serverMap = (root.mcpServers && typeof root.mcpServers === 'object'
    ? root.mcpServers
    : root) as Record<string, ClaudeServerEntry>;

  if (Object.keys(serverMap).length === 0) {
    return { servers, errors: ['No servers found. Expected an "mcpServers" object.'] };
  }

  for (const [name, rawEntry] of Object.entries(serverMap)) {
    if (!rawEntry || typeof rawEntry !== 'object') {
      errors.push(`"${name}": entry is not an object.`);
      continue;
    }
    const entry = rawEntry as ClaudeServerEntry;
    const transport = resolveTransport(entry);
    if (!transport) {
      errors.push(`"${name}": unknown transport type "${entry.type || entry.transport}".`);
      continue;
    }

    // Env values arrive as plain strings in Claude format; FLUJO's EnvVarValue
    // accepts strings directly, so they pass through unchanged.
    const env: Record<string, EnvVarValue> = {};
    if (entry.env && typeof entry.env === 'object') {
      for (const [k, v] of Object.entries(entry.env)) {
        env[k] = typeof v === 'string' ? v : String(v ?? '');
      }
    }

    const base = {
      name,
      env,
      disabled: entry.disabled ?? false,
      autoApprove: Array.isArray(entry.autoApprove) ? entry.autoApprove : [],
      rootPath: '',
      _buildCommand: '',
      _installCommand: '',
    };

    if (transport === 'stdio') {
      if (!entry.command || typeof entry.command !== 'string') {
        errors.push(`"${name}": stdio server is missing a "command".`);
        continue;
      }
      servers.push({
        ...base,
        transport: 'stdio',
        command: entry.command,
        args: Array.isArray(entry.args) ? entry.args : [],
      } as MCPServerConfig);
    } else if (transport === 'websocket') {
      const url = entry.url || entry.websocketUrl;
      if (!url) {
        errors.push(`"${name}": websocket server is missing a "url".`);
        continue;
      }
      servers.push({
        ...base,
        transport: 'websocket',
        websocketUrl: url,
      } as MCPServerConfig);
    } else {
      // streamable | sse
      const url = entry.url || entry.serverUrl;
      if (!url) {
        errors.push(`"${name}": ${transport} server is missing a "url".`);
        continue;
      }
      const headers =
        entry.headers && typeof entry.headers === 'object' ? entry.headers : undefined;
      servers.push({
        ...base,
        transport,
        serverUrl: url,
        ...(headers ? { headers } : {}),
      } as MCPServerConfig);
    }
  }

  return { servers, errors };
}
