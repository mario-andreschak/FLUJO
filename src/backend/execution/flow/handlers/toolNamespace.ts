/**
 * Tool-name namespacing for MCP tools (#16).
 *
 * MCP has no native cross-server namespacing — disambiguating tools from
 * different servers is the host's job. The model-facing OpenAI function name
 * must additionally match ^[a-zA-Z0-9_-]{1,64}$, but FLUJO server names allow
 * spaces/dots/unicode/up to 200 chars and tool names are server-controlled, so
 * a naive `server + tool` name is frequently invalid or over-length.
 *
 * We therefore encode each (server, tool) pair into a deterministic, readable,
 * charset-safe, <=64-char name: `mcp_<slug>_<hash>`. Encoding is pure and
 * stable (same pair -> same name); decoding is a lookup against a map built from
 * the tools currently bound to the conversation (persisted on SharedState so the
 * tool-approval resume, which arrives as a separate request, can still decode).
 *
 * The human-authored prompt-binding pills (`${_-_-_server_-_-_tool}`) are a
 * separate, non-model-facing concern and are intentionally left on the legacy
 * scheme — see PromptRenderer/PromptBuilder. decodeToolName() still understands
 * the legacy `_-_-_SERVER_-_-_TOOL` runtime names so old conversations keep working.
 */

import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

const MAX_NAME_LEN = 64;
const PREFIX = 'mcp';
const LEGACY_SEP = '_-_-_';

/** Replace any character outside the OpenAI-safe set with '_'. */
function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** FNV-1a 32-bit hash, base36-encoded (<= 7 chars). Stable and dependency-free. */
export function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Deterministic, dependency-free stable stringify: object keys are emitted in
 * sorted order at every level so two semantically-identical schemas that differ
 * only in key order hash to the same value (no false "schema changed" positives).
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/**
 * Stable hash of a tool's input schema, used as part of a tool's identity token
 * (issue #255) so a re-registration that changes the schema can be detected at
 * dispatch time. `undefined`/`null` schemas hash to a fixed sentinel.
 */
export function hashSchema(schema: unknown): string {
  if (schema === undefined || schema === null) {
    return shortHash('\0no-schema');
  }
  return shortHash(stableStringify(schema));
}

export interface DecodedTool {
  server: string;
  tool: string;
  /** Per-call timeout in seconds from the tool's MCP node (-1 = no timeout;
   *  unset = 5-minute default). */
  timeout?: number;
  /** ID of the MCP node that registered this tool (issue #266 — per-node
   *  confinement: used to restrict filesystem/bash roots to the calling node's
   *  declared roots instead of the server-wide union). */
  nodeId?: string;
  /** Issue #255 — identity captured when this tool was advertised to the model:
   *  the generation of the server's MCP client at advertise time. If the client
   *  is (re)registered before the call runs the generation advances and the call
   *  is rejected as stale instead of being dispatched to a different instance.
   *  Optional so legacy maps / synthetic tools skip the staleness check. */
  clientGeneration?: number;
  /** Issue #255 — stable hash of the tool's input schema at advertise time; a
   *  mismatch at dispatch time means the tool was re-registered with a different
   *  schema. Optional so legacy maps / synthetic tools skip the check. */
  schemaHash?: string;
  /** MCP safety hints captured with the advertised tool definition. */
  annotations?: ToolAnnotations;
  /**
   * MCP Apps UI resource declared by the advertised tool definition. Carried
   * with the identity map so a cancelled/failed invocation can still notify
   * the app without re-listing tools after the call.
   */
  uiResourceUri?: string;
}

export type ToolNameMap = Record<string, DecodedTool>;

/**
 * Deterministic, OpenAI-safe model-facing name for an MCP (server, tool) pair.
 * Uses NUL to join so the hash domain is unambiguous regardless of separators in
 * the names themselves.
 */
export function encodeToolName(server: string, tool: string): string {
  const hash = shortHash(`${server}\0${tool}`);
  // Reserve room for "mcp_" + "_" + hash, fill the rest with a readable slug.
  const room = MAX_NAME_LEN - (PREFIX.length + 2 + hash.length);
  const slug = sanitize(tool).slice(0, Math.max(0, room));
  return `${PREFIX}_${slug}_${hash}`;
}

/** Build a decode map from the (server, tool) pairs currently bound to the flow. */
export function buildToolNameMap(pairs: DecodedTool[]): ToolNameMap {
  const map: ToolNameMap = {};
  for (const { server, tool } of pairs) {
    map[encodeToolName(server, tool)] = { server, tool };
  }
  return map;
}

/**
 * Resolve a model-emitted function name back to its (server, tool). Tries the
 * provided map first, then falls back to the legacy `_-_-_SERVER_-_-_TOOL` scheme
 * so conversations created before this change still decode.
 */
export function decodeToolName(name: string, map?: ToolNameMap): DecodedTool | null {
  if (map && map[name]) {
    return map[name];
  }
  if (name.includes(LEGACY_SEP)) {
    const parts = name.split(LEGACY_SEP);
    if (parts.length === 3) {
      const legacyPair = { server: parts[1], tool: parts[2] };
      // Once a conversation has an advertised map, legacy spellings are valid
      // only as aliases for a bound pair. Otherwise a model could fabricate
      // `_-_-_<server>_-_-_<tool>` and bypass the advertised tool set.
      if (map) {
        return Object.values(map).find(
          (candidate) =>
            candidate.server === legacyPair.server
            && candidate.tool === legacyPair.tool,
        ) ?? null;
      }
      return legacyPair;
    }
  }
  return null;
}

/** Synthetic FLUJO tool names that are always internal (no MCP server dispatch needed). */
const SYNTHETIC_INTERNAL_TOOLS = new Set([
  'write_resource',
  'read_resource',
  'list_mcp_resources',
]);

/**
 * Whether a function name is an internal MCP tool (vs. an external/passthrough
 * tool or a handoff). Used to route tool calls in the flujo=false path.
 */
export function isInternalToolName(name: string, map?: ToolNameMap): boolean {
  if (map && map[name]) {
    return true;
  }
  if (SYNTHETIC_INTERNAL_TOOLS.has(name)) {
    return true;
  }
  return name.includes(LEGACY_SEP);
}

/**
 * Minimal MCP-service surface the staleness guard needs (issue #255). Passed in
 * rather than imported so toolNamespace stays dependency-free and there is no
 * service ↔ handler import cycle.
 */
export interface ToolIdentityService {
  /** Current client for a server, or undefined if none/closed. */
  getClient(serverName: string): unknown | undefined;
  /** Monotonic (re)registration counter for a server's client (0 if never set). */
  getClientGeneration(serverName: string): number;
  /** Current schema hash advertised for (server, tool), if known. */
  getToolSchemaHash(serverName: string, toolName: string): string | undefined;
}

export type ToolIdentityResult = { ok: true } | { ok: false; reason: string };

/**
 * Guard (issue #255): decide whether a decoded tool call is still safe to
 * dispatch, or whether the tool set changed underneath it after the model
 * planned the call (server reconnected / re-registered, or its schema changed).
 *
 * Defensive-only: on any mismatch it returns `ok:false` with a model-facing
 * reason string — callers turn that into a tool-result ERROR and skip dispatch,
 * never redirecting silently to a re-created server. When nothing reconnected
 * and the schema is unchanged (or the entry carries no identity — legacy /
 * synthetic tools) it returns `ok:true` and behaviour is unchanged.
 */
export function assertToolIdentityFresh(
  name: string,
  decoded: DecodedTool,
  svc: ToolIdentityService,
): ToolIdentityResult {
  // Legacy `_-_-_` names and synthetic/non-MCP tools carry no identity — skip.
  if (decoded.clientGeneration === undefined && decoded.schemaHash === undefined) {
    return { ok: true };
  }

  // The server slot is gone entirely (renamed / removed) — the model must re-check.
  if (!svc.getClient(decoded.server)) {
    return {
      ok: false,
      reason: `Unknown tool: "${name}" (server "${decoded.server}") is no longer available. The tool set has changed — re-check your available tools before calling again.`,
    };
  }

  // The client was (re)registered after this call was planned — different instance.
  if (
    decoded.clientGeneration !== undefined &&
    decoded.clientGeneration !== svc.getClientGeneration(decoded.server)
  ) {
    return {
      ok: false,
      reason: `Stale tool call: the MCP tool "${name}" was re-registered (server "${decoded.server}" reconnected) after this call was planned. The tool set has changed — re-check your available tools before calling again.`,
    };
  }

  // The tool's input schema changed since it was advertised.
  if (decoded.schemaHash !== undefined) {
    const current = svc.getToolSchemaHash(decoded.server, decoded.tool);
    if (current !== undefined && current !== decoded.schemaHash) {
      return {
        ok: false,
        reason: `Stale tool call: the input schema for "${name}" on server "${decoded.server}" changed after this call was planned. The tool set has changed — re-check your available tools before calling again.`,
      };
    }
  }

  return { ok: true };
}
