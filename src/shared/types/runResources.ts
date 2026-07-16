/**
 * Run-scoped resources (Tier 3 data flow).
 *
 * A run resource is a data artifact produced during a flow run — a captured
 * tool result (screenshot, generated file, big text output), a node's
 * `captureResource` output, or a native MCP resource_link a tool returned.
 * Each one gets a `flujo://run/<conversationId>/<id>` URI and is served back
 * through the internal "flujo" MCP server (resources/list + resources/read),
 * so both later flow steps and external MCP clients can address it.
 *
 * The registry entry carries lineage: which node/tool call produced it
 * (`producedBy`) and every read since (`readBy`) — this is what makes data
 * *trackable* through a flow rather than an opaque blob inside a message.
 *
 * Shared (browser + backend) on purpose: the frontend renders entries in the
 * run-data panel; only the store implementation is backend-only.
 */

/** URI prefix for all run-scoped resources. */
export const RUN_RESOURCE_SCHEME = 'flujo://run/';

export type RunResourceKind = 'text' | 'image' | 'audio' | 'blob' | 'link';

/** How a resource came to exist. */
export type RunResourceSource = 'tool-result' | 'capture' | 'mcp-link';

export interface RunResourceProducer {
  source: RunResourceSource;
  /** Flow node that was executing when the resource was produced. */
  nodeId?: string;
  nodeName?: string;
  /** MCP server of the producing tool call (source 'tool-result'/'mcp-link'). */
  server?: string;
  toolName?: string;
  /**
   * OpenAI tool_call_id of the producing call. This is the stable lineage key:
   * runFlow regenerates tool-MESSAGE ids after processToolCalls, so message ids
   * must never be used here.
   */
  toolCallId?: string;
}

export interface RunResourceAccess {
  /** ms since epoch. */
  at: number;
  /** Mechanism of the read — mirrors ResourceReadEvent['source'] minus 'pill'
   * (pills read via the MCP layer and arrive here as 'mcp-read'). */
  source: 'res-ref' | 'node' | 'mcp-read';
  nodeId?: string;
}

export interface RunResourceEntry {
  /** uuid; also the payload file stem on disk. */
  id: string;
  /** flujo://run/<conversationId>/<id> */
  uri: string;
  conversationId: string;
  /**
   * Optional stable name (from `captureResource`), unique per conversation:
   * writing the same name again replaces the previous entry, so `${res:NAME}`
   * always resolves to the latest value (mirrors captureVariable semantics).
   */
  name?: string;
  mimeType?: string;
  /** Bytes stored on disk (0 for kind 'link' — no payload). */
  size: number;
  kind: RunResourceKind;
  /** How the payload file is encoded on disk. */
  encoding: 'utf8' | 'base64';
  createdAt: number;
  producedBy: RunResourceProducer;
  /**
   * Native MCP identity when the artifact originated on another server
   * (resource_link / embedded resource): where it can also be read directly.
   */
  origin?: { server: string; uri: string };
  readBy: RunResourceAccess[];
}

export interface RunResourceSettings {
  /** Master switch for auto-capturing tool results. Default true. */
  autoCaptureEnabled: boolean;
  /**
   * Text content items at or above this many characters are captured as run
   * resources; shorter ones ("file exists", small listings) stay inline only.
   */
  textThresholdChars: number;
  /** Per-resource payload cap; larger writes are skipped (kept inline). */
  maxResourceBytes: number;
  /** Total payload budget per conversation; writes beyond it are skipped. */
  maxConversationBytes: number;
  /**
   * When true, LARGE TEXT tool results are also replaced in the tool message
   * by a head-excerpt + resource-URI stub. Off by default: mutating text
   * results is lossy and can break flows that parse tool output — binary
   * items are always stubbed regardless (base64 in a message helps nobody).
   */
  replaceLargeTextWithStub: boolean;
}

export const DEFAULT_RUN_RESOURCE_SETTINGS: RunResourceSettings = {
  autoCaptureEnabled: true,
  textThresholdChars: 8192,
  maxResourceBytes: 50 * 1024 * 1024,
  maxConversationBytes: 256 * 1024 * 1024,
  replaceLargeTextWithStub: false,
};
