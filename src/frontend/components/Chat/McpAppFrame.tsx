"use client";

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Box, Typography, Button, Collapse, CircularProgress, Alert, Tooltip, useTheme } from '@mui/material';
import WidgetsIcon from '@mui/icons-material/Widgets';
import ShieldOutlinedIcon from '@mui/icons-material/ShieldOutlined';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import {
  AppBridge,
  PostMessageTransport,
  buildAllowAttribute,
  McpUiResourceCspSchema,
  McpUiResourcePermissionsSchema,
} from '@modelcontextprotocol/ext-apps/app-bridge';
import type {
  McpUiHostContext,
  McpUiDisplayMode,
  McpUiResourceCsp,
  McpUiResourcePermissions,
  McpUiUpdateModelContextRequest,
} from '@modelcontextprotocol/ext-apps/app-bridge';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type {
  JSONRPCMessage,
  MessageExtraInfo,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { useI18n } from '@/frontend/contexts/I18nContext';
import type {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import { mcpService } from '@/frontend/services/mcp';
import {
  MAX_UI_RESOURCE_BYTES,
  extractUiResourceUri,
  isMcpAppMimeType,
} from '@/shared/utils/mcpApps';
import { createLogger } from '@/utils/logger';
import packageMetadata from '../../../../package.json';

const log = createLogger('frontend/components/Chat/McpAppFrame');

/** Must match backend/mcpApps/sandboxServer.ts. */
const SANDBOX_PROXY_READY = 'ui/notifications/sandbox-proxy-ready';
const HOST_INFO = { name: 'FLUJO', version: packageMetadata.version };
const PROXY_READY_TIMEOUT_MS = 10_000;
const RESOURCE_TEARDOWN_TIMEOUT_MS = 1_000;
const SAFE_OPEN_LINK_PROTOCOLS = new Set(['https:', 'http:']);
const ALL_DISPLAY_MODES: McpUiDisplayMode[] = ['inline', 'fullscreen', 'pip'];
// The backend currently serializes app context into a synthetic text message;
// only text blocks and structuredContent survive that pipeline losslessly.
const SUPPORTED_CONTEXT_BLOCK_TYPES = new Set(['text']);
export const MAX_MCP_APP_CONTEXT_BYTES = 256 * 1024;
const MAX_APP_DIMENSION_PX = 6_000;

export interface McpAppFrameProps {
  /** Conversation that owns app-created server state, when hosted from chat. */
  conversationId?: string;
  /** Server that owns the `ui://` resource. */
  serverName: string;
  /** The `ui://…` resource URI to read and render. */
  uri: string;
  /** Raw tool name that triggered this app (for sendToolInput labeling / context). */
  toolName?: string;
  /** JSON string of the arguments the tool was called with (pushed as tool-input). */
  toolArgs?: string;
  /** JSON string of the tool result content (pushed as tool-result). */
  toolResultContent?: string;
  /**
   * Stable identity for this particular tool delivery. Persistent hosts use it
   * to deliver a new input/result pair even when the serialized values happen
   * to be identical to the previous invocation.
   */
  toolUpdateId?: string | number;
  /**
   * Cancellation outcome for the current tool delivery. When present, the host
   * sends tool-input followed by tool-cancelled instead of a tool result.
   */
  toolCancelledReason?: string;
  /** Whether the triggering tool invocation failed. */
  toolIsError?: boolean;
  /**
   * Human-in-the-loop return channel for `ui/message`. The chat submits the
   * text as a follow-up user message, resuming a waiting model.
   */
  onAppMessage?: (text: string) => boolean | Promise<boolean>;
  /**
   * Future-turn-only channel for `ui/update-model-context`. Each callback
   * carries the host-owned app identity and the untouched protocol payload;
   * callers replace the prior value for that identity without starting a turn.
   */
  onUpdateModelContext?: (
    appKey: string,
    context: McpUiUpdateModelContextRequest['params'],
  ) => boolean | Promise<boolean>;
  /**
   * #216: when the app requests the `pip` display mode (or the user pops it
   * out), the parent is asked to claim it into the docked canvas surface.
   * Optional — when omitted (inline chat timeline), pip is treated like inline.
   */
  onRequestDock?: () => void;
  /**
   * #216: fired once after handshake with whether the app advertised `pip`
   * support (`availableDisplayModes` includes `pip`). Lets the parent surface a
   * "dock this" affordance passively — no server metadata required.
   */
  onDockable?: (dockable: boolean) => void;
  /** Reports the complete display-mode declaration discovered at handshake. */
  onAvailableDisplayModes?: (modes: McpUiDisplayMode[]) => void;
  /**
   * Controlled display mode for a persistent host. DevCanvasDock uses this to
   * keep the app informed when its verified fullscreen/pip presentation changes.
   */
  hostDisplayMode?: McpUiDisplayMode;
  /**
   * Ask the owning surface to perform a display transition. The callback must
   * return the mode actually applied (which may remain unchanged).
   */
  onRequestDisplayMode?: (
    mode: McpUiDisplayMode,
    appModes: McpUiDisplayMode[],
  ) => McpUiDisplayMode | Promise<McpUiDisplayMode>;
  /** Close the owning surface after an app-initiated teardown request. */
  onRequestClose?: () => void;
  /**
   * Parent-owned teardown registry. Canvas owners use this to await the View's
   * acknowledgement (bounded to one second) before removing its React subtree.
   */
  onRegisterTeardown?: (
    appKey: string,
    teardown: (() => Promise<void>) | null,
  ) => void;
  /** Optional owner-unique registry key (defaults to `serverName::uri`). */
  teardownRegistrationKey?: string;
  /**
   * #216: render as a persistent host inside the DevCanvasDock. The frame
   * auto-mounts after the trust/consent decision (a bubble click for external
   * apps, or the first-party policy for built-ins), drops its own collapse
   * chrome, and fills its container. It is shown/hidden via CSS only (`visible`)
   * — NEVER unmounted on tab switch — so the live iframe/bridge is never
   * reparented (the load-bearing invariant).
   */
  docked?: boolean;
  /** #216: CSS-only visibility for a docked host (tab switch / collapse). */
  visible?: boolean;
  /**
   * Mount and reveal the app immediately. The server-level `enableMcpApps`
   * permission remains the trust gate; this only removes the extra launch
   * click after that permission has already been granted.
   */
  defaultExpanded?: boolean;
  /** Promote a revealed app to the persistent canvas as soon as it declares pip support. */
  autoDock?: boolean;
}

/**
 * Flatten stable single-block (and SDK-array compatibility) ui/message text.
 * The host advertises text only, so mixed/unsupported or empty content is
 * rejected instead of being acknowledged and silently discarded.
 */
export function contentToText(params: any): string {
  if (params?.role !== 'user') {
    throw new Error('This host accepts ui/message only with role "user"');
  }
  const content = params?.content;
  const blocks = Array.isArray(content)
    ? content
    : content && typeof content === 'object'
      ? [content]
      : [];
  if (
    blocks.length === 0
    || blocks.some((block: any) => (
      block?.type !== 'text'
      || typeof block.text !== 'string'
    ))
  ) {
    throw new Error('This host accepts text-only ui/message content');
  }
  const text = blocks.map((block: any) => block.text).join('\n').trim();
  if (!text) throw new Error('ui/message text must not be empty');
  return text;
}

/** UTF-8 byte length of a JSON payload, or Infinity when it cannot serialize. */
export function jsonUtf8ByteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return Infinity;
  }
}

/** Validate the modalities and byte cap this host advertises and preserves. */
export function validateModelContext(
  context: unknown,
): string | null {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    return 'ui/update-model-context params must be an object';
  }
  const candidate = context as {
    content?: unknown;
    structuredContent?: unknown;
  };
  if (candidate.content !== undefined) {
    if (!Array.isArray(candidate.content)) {
      return 'Model context content must be an array';
    }
    for (const block of candidate.content) {
      if (
        !block
        || typeof block !== 'object'
        || Array.isArray(block)
        || !SUPPORTED_CONTEXT_BLOCK_TYPES.has((block as { type?: unknown }).type as string)
      ) {
        return 'Model context contains a modality this host did not advertise';
      }
    }
  }
  if (
    candidate.structuredContent !== undefined
    && (
      !candidate.structuredContent
      || typeof candidate.structuredContent !== 'object'
      || Array.isArray(candidate.structuredContent)
    )
  ) {
    return 'Model structuredContent must be an object';
  }
  if (jsonUtf8ByteLength(context) > MAX_MCP_APP_CONTEXT_BYTES) {
    return `Model context exceeds ${MAX_MCP_APP_CONTEXT_BYTES} bytes`;
  }
  return null;
}

/**
 * Stable SEP-1865 uses one ContentBlock for ui/message while ext-apps 1.x
 * validates its compatibility array shape. Normalize at the transport boundary
 * before AppBridge schema validation so conforming Views reach the handler.
 */
export function normalizeStableAppMessage<T extends JSONRPCMessage>(message: T): T {
  const request = message as T & {
    method?: unknown;
    params?: { content?: unknown };
  };
  if (
    request.method !== 'ui/message'
    || !request.params
    || Array.isArray(request.params.content)
    || !request.params.content
    || typeof request.params.content !== 'object'
  ) return message;
  return {
    ...message,
    params: {
      ...request.params,
      content: [request.params.content],
    },
  } as T;
}

function createStablePostMessageTransport(
  eventTarget: Window,
  eventSource: MessageEventSource,
): Transport {
  const inner = new PostMessageTransport(eventTarget, eventSource);
  const wrapper: Transport = {
    start: async () => {
      inner.onmessage = <T extends JSONRPCMessage>(
        message: T,
        extra?: MessageExtraInfo,
      ) => {
        wrapper.onmessage?.(normalizeStableAppMessage(message), extra);
      };
      inner.onerror = (transportError) => wrapper.onerror?.(transportError);
      inner.onclose = () => wrapper.onclose?.();
      await inner.start();
    },
    send: (message: JSONRPCMessage, options?: TransportSendOptions) => (
      inner.send(message, options)
    ),
    close: () => inner.close(),
    setProtocolVersion: (version: string) => inner.setProtocolVersion?.(version),
  };
  return wrapper;
}

/** CSP + permission block a UI resource declares under `_meta.ui`. */
interface AppResource {
  html: string;
  csp?: McpUiResourceCsp;
  permissions?: McpUiResourcePermissions;
}

interface SandboxEndpointResponse {
  port?: number;
  token?: string;
  url?: string;
}

interface BrowserLocation {
  origin: string;
  protocol: string;
}

/** Validate discovery data and build the authenticated browser-visible URL. */
export function buildSandboxUrl(
  data: SandboxEndpointResponse,
  host: BrowserLocation,
): string {
  if (typeof data.token !== 'string' || data.token.length === 0) {
    throw new Error('Sandbox endpoint discovery returned invalid credentials');
  }

  let sandboxUrl: URL;
  if (data.url !== undefined) {
    if (typeof data.url !== 'string') {
      throw new Error('Sandbox endpoint discovery returned an invalid public URL');
    }
    try {
      sandboxUrl = new URL(data.url);
    } catch {
      throw new Error('Sandbox endpoint discovery returned an invalid public URL');
    }
    if (
      (sandboxUrl.protocol !== 'http:' && sandboxUrl.protocol !== 'https:')
      || sandboxUrl.username
      || sandboxUrl.password
    ) {
      throw new Error('Sandbox public URL must be an absolute HTTP(S) URL without credentials');
    }
    if (host.protocol === 'https:' && sandboxUrl.protocol !== 'https:') {
      throw new Error('HTTPS FLUJO deployments require an HTTPS MCP Apps sandbox URL');
    }
  } else {
    if (host.protocol !== 'http:') {
      throw new Error(
        'MCP Apps on HTTPS require Public or Local Network access and an HTTPS proxy for sandbox port 4201',
      );
    }
    if (
      !Number.isInteger(data.port)
      || (data.port as number) < 1
      || (data.port as number) > 65_535
    ) {
      throw new Error('Sandbox endpoint discovery returned an invalid port');
    }
    sandboxUrl = new URL('/sandbox.html', host.origin);
    sandboxUrl.port = String(data.port);
  }

  if (sandboxUrl.origin === host.origin) {
    throw new Error('MCP Apps sandbox must use a distinct origin from FLUJO');
  }
  sandboxUrl.searchParams.set('token', data.token);
  return sandboxUrl.href;
}

/** Module-level cache of the authenticated sandbox endpoint (one fetch/session). */
let sandboxEndpointPromise: Promise<SandboxEndpointResponse> | null = null;
async function resolveSandboxBaseUrl(): Promise<string> {
  if (!sandboxEndpointPromise) {
    sandboxEndpointPromise = fetch('/api/mcp/app-sandbox').then(async (response) => {
      if (!response.ok) {
        throw new Error(`Sandbox endpoint discovery failed (${response.status})`);
      }
      return await response.json() as SandboxEndpointResponse;
    }).catch((error) => {
      // Allow a later mount to retry a transient startup failure.
      sandboxEndpointPromise = null;
      throw error;
    });
  }
  return buildSandboxUrl(await sandboxEndpointPromise, window.location);
}

function decodeBase64Utf8(blob: string): string {
  const bytes = Uint8Array.from(atob(blob), (character) => character.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function sanitizeCspOrigins(
  values: string[] | undefined,
  schemes: Array<'https' | 'wss'>,
): string[] {
  const sanitized: string[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    if (value.length === 0 || value.length > 2_048 || /[^\x21-\x7e]/.test(value)) continue;
    const match = /^(https|wss):\/\/(\*\.)?([^/:?#]+)(?::(\d{1,5}))?$/i.exec(value);
    if (!match || !schemes.includes(match[1].toLowerCase() as 'https' | 'wss')) continue;
    const labels = match[3].split('.');
    if (
      match[3].length > 253
      || labels.some((label) => (
        label.length === 0
        || label.length > 63
        || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
      ))
    ) continue;
    const port = match[4] ? Number(match[4]) : undefined;
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)) continue;
    const dedupeKey = value.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    sanitized.push(value);
    if (sanitized.length >= 64) break;
  }
  return sanitized;
}

/**
 * Mirror the sandbox server's fail-closed CSP grant so ui/initialize advertises
 * the policy actually applied, not the app's broader untrusted request.
 */
export function sanitizeGrantedCsp(csp: McpUiResourceCsp): McpUiResourceCsp {
  return {
    connectDomains: sanitizeCspOrigins(csp.connectDomains, ['https', 'wss']),
    resourceDomains: sanitizeCspOrigins(csp.resourceDomains, ['https']),
    frameDomains: sanitizeCspOrigins(csp.frameDomains, ['https']),
    baseUriDomains: sanitizeCspOrigins(csp.baseUriDomains, ['https']),
  };
}

/**
 * The inner View intentionally has an opaque origin. Origin-bound browser
 * capabilities (camera, microphone, and geolocation) therefore cannot be
 * granted truthfully. Clipboard write remains available through the explicit
 * Permission Policy delegation and still requires the browser's user-activation
 * checks.
 */
export function sanitizeGrantedPermissions(
  permissions: McpUiResourcePermissions,
): McpUiResourcePermissions | undefined {
  return permissions.clipboardWrite ? { clipboardWrite: {} } : undefined;
}

/**
 * Pull the exact requested MCP App HTML resource and its granted sandbox
 * policy out of a ReadResourceResult. Arbitrary text/blob fallback is
 * intentionally forbidden: a server must return the requested URI with the
 * stable MCP Apps MIME type.
 */
export function extractAppResource(readData: unknown, expectedUri: string): AppResource {
  const contents = (readData as { contents?: Array<Record<string, any>> } | null | undefined)?.contents;
  if (!Array.isArray(contents) || contents.length === 0) {
    throw new Error('Resource has no contents');
  }
  const entry = contents.find((content) => (
    content.uri === expectedUri
    && typeof content.mimeType === 'string'
    && isMcpAppMimeType(content.mimeType)
    && (typeof content.text === 'string' || typeof content.blob === 'string')
  ));
  if (!entry) {
    throw new Error(`Resource ${expectedUri} did not return MCP App HTML`);
  }

  let html: string;
  try {
    html = typeof entry.text === 'string' ? entry.text : decodeBase64Utf8(entry.blob);
  } catch {
    throw new Error(`Resource ${expectedUri} contains invalid base64 UTF-8 HTML`);
  }
  const byteLength = new TextEncoder().encode(html).length;
  if (byteLength > MAX_UI_RESOURCE_BYTES) {
    throw new Error(`Resource exceeds the ${Math.round(MAX_UI_RESOURCE_BYTES / 1024)} KiB size cap`);
  }
  const uiMeta = (entry._meta ?? entry.meta)?.ui;
  const csp = McpUiResourceCspSchema.safeParse(uiMeta?.csp);
  if (uiMeta?.csp !== undefined && !csp.success) {
    throw new Error(`Resource ${expectedUri} declares an invalid CSP policy`);
  }
  const permissions = McpUiResourcePermissionsSchema.safeParse(uiMeta?.permissions);
  if (uiMeta?.permissions !== undefined && !permissions.success) {
    throw new Error(`Resource ${expectedUri} declares invalid sandbox permissions`);
  }
  return {
    html,
    csp: csp.success ? sanitizeGrantedCsp(csp.data) : undefined,
    permissions: permissions.success
      ? sanitizeGrantedPermissions(permissions.data)
      : undefined,
  };
}

/** Validate an app-provided external link against FLUJO's narrow allowlist. */
export function getSafeOpenLinkUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (!SAFE_OPEN_LINK_PROTOCOLS.has(parsed.protocol)) return null;
    if (parsed.username || parsed.password) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * A minimal browser stand-in for the MCP SDK `Client` that AppBridge drives.
 * AppBridge only ever calls `getServerCapabilities()` and
 * `request({method, params}, schema, {signal})` on it (plus a
 * `setNotificationHandler` we do not use because we never advertise
 * listChanged). We proxy the two request methods that matter — `tools/call`
 * and `resources/read` — through FLUJO's existing backend API, which keeps the
 * app calls subject to the same server the app came from.
 */
function makeClientShim(
  serverName: string,
  ownerScope: string,
  onAccessRevoked: (message: string) => void,
): Client {
  const shim = {
    getServerCapabilities: () => ({ tools: {}, resources: {} }),
    setNotificationHandler: () => { /* no listChanged advertised */ },
    request: async (
      req: { method: string; params?: any },
      _resultSchema?: unknown,
      options?: { signal?: AbortSignal },
    ) => {
      const { method, params } = req;
      if (method === 'tools/call') {
        // App-initiated tool call. Scoped to the app's own server (the shim is
        // bound to serverName). The dedicated backend path additionally checks
        // `_meta.ui.visibility` before dispatch, so model-only tools cannot be
        // reached through the app bridge.
        log.info(`MCP App tools/call: ${serverName}/${params?.name}`);
        const r = await mcpService.callToolFromApp(
          serverName,
          params.name,
          params.arguments ?? {},
          undefined,
          options?.signal,
          ownerScope,
        );
        if (r?.httpStatus === 403) {
          const message = r?.error || 'MCP Apps access was disabled for this server';
          onAccessRevoked(message);
          throw new Error(message);
        }
        if (!r || r.success === false) throw new Error(r?.error || `Tool call failed: ${params?.name}`);
        return r.data;
      }
      if (method === 'resources/read') {
        const r = await mcpService.readResourceFromApp(serverName, params.uri);
        if (r?.httpStatus === 403) {
          const message = r?.error || 'MCP Apps access was disabled for this server';
          onAccessRevoked(message);
          throw new Error(message);
        }
        if (!r || r.success === false) throw new Error(r?.error || `Resource read failed: ${params?.uri}`);
        return r.data;
      }
      if (method === 'resources/list') return { resources: [] };
      if (method === 'resources/templates/list') return { resourceTemplates: [] };
      throw new Error(`MCP App requested unsupported method: ${method}`);
    },
  };
  return shim as unknown as Client;
}

function safeParse(raw: string | undefined): unknown {
  if (!raw) return undefined;
  try { return JSON.parse(raw); } catch { return undefined; }
}

function buildToolArguments(raw: string | undefined): Record<string, unknown> {
  const parsed = safeParse(raw);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

/**
 * Normalize a stored tool-result string into a valid MCP CallToolResult for the
 * bridge: pass a real `{content:[…]}` through, otherwise wrap the raw text.
 * Returns null when there is nothing to push.
 */
export function buildToolResult(
  raw: string | undefined,
  isError: boolean | undefined = undefined,
): any | null {
  if (raw === undefined) {
    return isError === true ? { content: [], isError: true } : null;
  }
  const resultData = safeParse(raw);
  if (resultData && typeof resultData === 'object') {
    return Array.isArray((resultData as { content?: unknown }).content)
      ? {
          ...resultData,
          ...(isError === true ? { isError: true } : {}),
        }
      : {
          content: [{ type: 'text', text: raw }],
          ...(isError === true ? { isError: true } : {}),
        };
  }
  return {
    content: [{ type: 'text', text: raw }],
    ...(isError === true ? { isError: true } : {}),
  };
}

/** Deliver one complete invocation in the protocol-mandated input-first order. */
export async function deliverToolOutcome(
  bridge: Pick<AppBridge, 'sendToolInput' | 'sendToolResult' | 'sendToolCancelled'>,
  args: string | undefined,
  resultContent: string | undefined,
  cancelledReason: string | undefined,
  isError: boolean | undefined = undefined,
): Promise<void> {
  await bridge.sendToolInput({ arguments: buildToolArguments(args) });
  if (cancelledReason !== undefined) {
    await bridge.sendToolCancelled({ reason: cancelledReason });
    return;
  }
  const result = buildToolResult(resultContent, isError);
  if (result) await bridge.sendToolResult(result);
}

/** A transition is valid only when both the host and the app declared it. */
export function canUseDisplayMode(
  mode: McpUiDisplayMode,
  hostModes: McpUiDisplayMode[],
  appModes: McpUiDisplayMode[],
): boolean {
  return hostModes.includes(mode) && appModes.includes(mode);
}

/**
 * Every fresh View starts in the protocol's inline baseline. Once its own
 * capabilities are known, a canvas host may promote it to pip/fullscreen.
 * `null` means a canvas View cannot be represented because pip was not
 * declared by the app.
 */
export function getVerifiedPostHandshakeDisplayMode(
  requestedMode: McpUiDisplayMode,
  docked: boolean,
  hostModes: McpUiDisplayMode[],
  appModes: McpUiDisplayMode[],
): McpUiDisplayMode | null {
  if (docked) {
    if (!canUseDisplayMode('pip', hostModes, appModes)) return null;
    if (
      requestedMode === 'fullscreen'
      && canUseDisplayMode('fullscreen', hostModes, appModes)
    ) {
      return 'fullscreen';
    }
    return 'pip';
  }
  return requestedMode === 'fullscreen'
    && canUseDisplayMode('fullscreen', hostModes, appModes)
    ? 'fullscreen'
    : 'inline';
}

export interface InlineSize {
  width?: number;
  height?: number;
}

/** Clamp finite View size requests to the inline host's real bounds. */
export function clampInlineSize(
  requested: InlineSize,
  containerWidth: number,
): InlineSize {
  const result: InlineSize = {};
  if (Number.isFinite(requested.width) && (requested.width as number) > 0) {
    const finiteContainer = Number.isFinite(containerWidth) && containerWidth > 0
      ? containerWidth
      : MAX_APP_DIMENSION_PX;
    result.width = Math.min(requested.width as number, finiteContainer, MAX_APP_DIMENSION_PX);
  }
  if (Number.isFinite(requested.height) && (requested.height as number) > 0) {
    result.height = Math.min(requested.height as number, MAX_APP_DIMENSION_PX);
  }
  return result;
}

function measureHostDimensions(
  element: HTMLElement,
  docked: boolean,
): McpUiHostContext['containerDimensions'] {
  const bounds = element.getBoundingClientRect();
  const width = Math.max(1, Math.round(bounds.width || element.clientWidth || 1));
  if (docked) {
    const height = Math.max(1, Math.round(bounds.height || element.clientHeight || 1));
    return { width, height };
  }
  return { width, maxHeight: MAX_APP_DIMENSION_PX };
}

export async function resolveHostToolInfo(
  serverName: string,
  uri: string,
  triggeringToolName: string | undefined,
): Promise<{ tool: Tool } | undefined> {
  try {
    const listed = await mcpService.listServerTools(serverName);
    const tools = Array.isArray(listed.tools) ? listed.tools : [];
    const tool = triggeringToolName
      ? tools.find((candidate) => candidate?.name === triggeringToolName)
      : tools.find((candidate) => extractUiResourceUri(candidate?._meta) === uri);
    if (
      tool?.name
      && tool?.inputSchema
      && extractUiResourceUri(tool._meta) === uri
    ) {
      return { tool: tool as Tool };
    }
  } catch (toolInfoError) {
    log.debug('Could not resolve the full MCP App tool definition', toolInfoError);
  }
  return undefined;
}

/**
 * MCP Apps (SEP-1865 / spec 2026-01-26, #97) — Phase 2 interactive renderer.
 *
 * Renders a tool's linked `ui://` UI resource as a LIVE, bidirectionally
 * connected app inside the chat tool-call timeline, using the official
 * `@modelcontextprotocol/ext-apps` host bridge. The app runs inside a
 * double-iframe sandbox: FLUJO embeds a foreign-origin sandbox proxy (served by
 * backend/mcpApps/sandboxServer.ts) which in turn hosts the app HTML — so the
 * app never shares FLUJO's origin, cookies, storage, or DOM. The bridge pushes
 * the tool input/result to the app and brokers the app's own `tools/call` /
 * `resources/read` back through FLUJO's MCP layer (same server only).
 */
const McpAppFrame: React.FC<McpAppFrameProps> = ({
  conversationId,
  serverName,
  uri,
  toolName,
  toolArgs,
  toolResultContent,
  toolUpdateId,
  toolCancelledReason,
  toolIsError,
  onAppMessage,
  onUpdateModelContext,
  onRequestDock,
  onDockable,
  onAvailableDisplayModes,
  hostDisplayMode,
  onRequestDisplayMode,
  onRequestClose,
  onRegisterTeardown,
  teardownRegistrationKey,
  docked = false,
  visible = true,
  defaultExpanded = false,
  autoDock = false,
}) => {
  const { t } = useI18n();
  const theme = useTheme();
  const frameInstanceId = useId();
  const ownerScope = useMemo(
    () => conversationId
      ? `conversation:${conversationId}`
      : `app:${serverName}:${uri}:${frameInstanceId}`,
    [conversationId, frameInstanceId, serverName, uri],
  );
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [displayMode, setDisplayMode] = useState<McpUiDisplayMode>(docked ? 'pip' : 'inline');
  const [floatingRect, setFloatingRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [appDisplayModes, setAppDisplayModes] = useState<McpUiDisplayMode[]>([]);
  const effectiveDisplayMode = hostDisplayMode ?? displayMode;
  const hostDisplayModes = useMemo<McpUiDisplayMode[]>(
    () => docked
      ? ['pip', 'fullscreen']
      : ['inline', 'fullscreen', ...(onRequestDock ? ['pip' as const] : [])],
    [docked, onRequestDock],
  );

  const containerRef = useRef<HTMLDivElement | null>(null);
  const frameRootRef = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const inlineHeightRef = useRef(200);
  const bridgeRef = useRef<AppBridge | null>(null);
  const mountedRef = useRef(false);
  // Invalidates every async continuation from an older mount. This prevents a
  // slow resource read/handshake (or a late event from its bridge) from
  // resurrecting a collapsed app or tearing down a newer replacement.
  const mountGenerationRef = useRef(0);
  const initializedRef = useRef(false);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const teardownPromiseRef = useRef<Promise<void> | null>(null);
  const dockHandoffRef = useRef(false);
  const componentAliveRef = useRef(true);
  const appDisplayModesRef = useRef<McpUiDisplayMode[]>([]);
  const displayModeRef = useRef<McpUiDisplayMode>(effectiveDisplayMode);
  const hostDisplayModesRef = useRef(hostDisplayModes);
  const toolDeliveryChainRef = useRef<Promise<void>>(Promise.resolve());
  const lastDeliveryRef = useRef<string | number | undefined>(undefined);
  const latestToolDeliveryRef = useRef({
    args: toolArgs,
    resultContent: toolResultContent,
    cancelledReason: toolCancelledReason,
    isError: toolIsError,
    updateId: toolUpdateId,
  });

  useEffect(() => {
    if (docked || effectiveDisplayMode !== 'fullscreen' || typeof window === 'undefined') return;
    setFloatingRect((current) => {
      if (current) return current;
      const width = Math.min(Math.max(520, Math.round(window.innerWidth * 0.86)), window.innerWidth - 24);
      const height = Math.min(Math.max(360, Math.round(window.innerHeight * 0.84)), window.innerHeight - 24);
      return {
        x: Math.round((window.innerWidth - width) / 2),
        y: Math.round((window.innerHeight - height) / 2),
        width,
        height,
      };
    });
  }, [docked, effectiveDisplayMode]);

  const startFullscreenDrag = useCallback((event: React.PointerEvent) => {
    if (effectiveDisplayMode !== 'fullscreen' || !frameRootRef.current) return;
    if ((event.target as HTMLElement).closest('button,[role="button"]')) return;
    event.preventDefault();
    const rect = frameRootRef.current.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    const onMove = (move: PointerEvent) => {
      const maxX = Math.max(0, window.innerWidth - 120);
      const maxY = Math.max(0, window.innerHeight - 56);
      setFloatingRect({
        x: Math.min(Math.max(rect.left + move.clientX - startX, 0), maxX),
        y: Math.min(Math.max(rect.top + move.clientY - startY, 0), maxY),
        width: rect.width,
        height: rect.height,
      });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.userSelect = previousUserSelect;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [effectiveDisplayMode]);
  latestToolDeliveryRef.current = {
    args: toolArgs,
    resultContent: toolResultContent,
    cancelledReason: toolCancelledReason,
    isError: toolIsError,
    updateId: toolUpdateId,
  };
  // Always call the latest callback without remounting the bridge on prop change.
  const onAppMessageRef = useRef(onAppMessage);
  useEffect(() => { onAppMessageRef.current = onAppMessage; }, [onAppMessage]);
  const onUpdateModelContextRef = useRef(onUpdateModelContext);
  useEffect(() => { onUpdateModelContextRef.current = onUpdateModelContext; }, [onUpdateModelContext]);
  const onRequestDockRef = useRef(onRequestDock);
  useEffect(() => { onRequestDockRef.current = onRequestDock; }, [onRequestDock]);
  const autoDockRef = useRef(autoDock);
  useEffect(() => { autoDockRef.current = autoDock; }, [autoDock]);
  const onDockableRef = useRef(onDockable);
  useEffect(() => { onDockableRef.current = onDockable; }, [onDockable]);
  const onAvailableDisplayModesRef = useRef(onAvailableDisplayModes);
  useEffect(() => {
    onAvailableDisplayModesRef.current = onAvailableDisplayModes;
  }, [onAvailableDisplayModes]);
  const onRequestDisplayModeRef = useRef(onRequestDisplayMode);
  useEffect(() => { onRequestDisplayModeRef.current = onRequestDisplayMode; }, [onRequestDisplayMode]);
  const onRequestCloseRef = useRef(onRequestClose);
  useEffect(() => { onRequestCloseRef.current = onRequestClose; }, [onRequestClose]);
  const dockedRef = useRef(docked);
  useEffect(() => { dockedRef.current = docked; }, [docked]);
  useEffect(() => {
    displayModeRef.current = effectiveDisplayMode;
  }, [effectiveDisplayMode]);
  useEffect(() => {
    hostDisplayModesRef.current = hostDisplayModes;
  }, [hostDisplayModes]);

  /**
   * Graceful shutdown is asynchronous, while React effect cleanup cannot be.
   * Capture and detach the instance refs synchronously, then keep the captured
   * iframe alive for at most one second while the view handles
   * `ui/resource-teardown`. A newer mount cannot be closed by the old cleanup.
   */
  const teardown = useCallback((): Promise<void> => {
    if (teardownPromiseRef.current) return teardownPromiseRef.current;
    mountGenerationRef.current += 1;
    const bridge = bridgeRef.current;
    const iframe = iframeRef.current;
    const wasInitialized = initializedRef.current;
    bridgeRef.current = null;
    iframeRef.current = null;
    initializedRef.current = false;
    mountedRef.current = false;
    appDisplayModesRef.current = [];
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;

    const pending = (async () => {
      if (bridge && wasInitialized) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            bridge.teardownResource({}, { timeout: RESOURCE_TEARDOWN_TIMEOUT_MS }),
            new Promise<void>((resolve) => {
              timeout = setTimeout(resolve, RESOURCE_TEARDOWN_TIMEOUT_MS);
            }),
          ]);
        } catch (teardownError) {
          log.debug('MCP App did not acknowledge resource teardown', teardownError);
        } finally {
          if (timeout) clearTimeout(timeout);
        }
      }

      try { await bridge?.close(); } catch { /* best effort */ }
      iframe?.remove();
    })();
    teardownPromiseRef.current = pending;
    void pending.finally(() => {
      if (teardownPromiseRef.current === pending) teardownPromiseRef.current = null;
    });
    return pending;
  }, []);

  /**
   * A pip transition changes View ownership. Finish the old inline View's
   * graceful teardown before asking the parent to create the fresh canvas
   * View, so two live bridges never claim the same app instance.
   */
  const handoffToDock = useCallback(() => {
    if (dockHandoffRef.current || !onRequestDockRef.current) return;
    dockHandoffRef.current = true;
    void teardown()
      .then(() => {
        if (!componentAliveRef.current) return;
        onRequestDockRef.current?.();
        setExpanded(false);
      })
      .finally(() => {
        dockHandoffRef.current = false;
      });
  }, [teardown]);

  const queueToolDelivery = useCallback((
    bridge: AppBridge,
    args: string | undefined,
    resultContent: string | undefined,
    cancelledReason: string | undefined,
    isError: boolean | undefined,
  ) => {
    toolDeliveryChainRef.current = toolDeliveryChainRef.current
      .catch(() => undefined)
      .then(async () => {
        if (bridgeRef.current !== bridge || !initializedRef.current) return;
        await deliverToolOutcome(bridge, args, resultContent, cancelledReason, isError);
      })
      .catch((deliveryError) => {
        log.warn('MCP App tool delivery failed', deliveryError);
      });
  }, []);

  const mount = useCallback(async () => {
    if (teardownPromiseRef.current) await teardownPromiseRef.current;
    if (mountedRef.current || !containerRef.current) return;
    const generation = mountGenerationRef.current + 1;
    mountGenerationRef.current = generation;
    const isCurrentMount = () => (
      mountGenerationRef.current === generation
      && mountedRef.current
    );
    mountedRef.current = true;
    setAppDisplayModes([]);
    setLoading(true);
    setError(null);
    try {
      // 1. Read the app HTML + CSP/permissions.
      const [read, toolInfo] = await Promise.all([
        mcpService.readResourceFromApp(serverName, uri),
        resolveHostToolInfo(serverName, uri, toolName),
      ]);
      if (!isCurrentMount()) return;
      if (read?.httpStatus === 403) {
        throw new Error(read?.error || t('chat.app.accessDisabled'));
      }
      if (!read || read.success === false) throw new Error(read?.error || t('chat.app.readFailed'));
      const app = extractAppResource(read.data, uri);

      // 2. Resolve the foreign sandbox origin.
      const sandboxBase = await resolveSandboxBaseUrl();
      if (!isCurrentMount() || !containerRef.current) return;

      // 3. Create the OUTER (sandbox-proxy) iframe.
      const iframe = document.createElement('iframe');
      iframe.title = t('chat.app.frameTitle', { uri });
      iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      iframe.referrerPolicy = 'origin'; // the sandbox validates the embedder via referrer
      const allow = buildAllowAttribute(app.permissions as any);
      if (allow) iframe.setAttribute('allow', allow);
      iframe.style.cssText = dockedRef.current || displayModeRef.current === 'fullscreen'
        ? 'width:100%;height:100%;border:none;background:#fff;'
        : 'width:100%;min-height:120px;height:200px;border:none;border-radius:4px;background:#fff;';
      containerRef.current.appendChild(iframe);
      iframeRef.current = iframe;

      // 4. Wait for the proxy to signal readiness, then point it at the sandbox.
      // Pin both WindowProxy and origin: a redirect (or a misconfigured public
      // endpoint) must not be able to impersonate FLUJO's trusted relay.
      const sandboxUrl = new URL(sandboxBase);
      if (app.csp) sandboxUrl.searchParams.set('csp', JSON.stringify(app.csp));
      const expectedSandboxOrigin = sandboxUrl.origin;
      const proxyReady = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          window.removeEventListener('message', onMsg);
          reject(new Error(t('chat.app.proxyTimeout')));
        }, PROXY_READY_TIMEOUT_MS);
        const onMsg = (ev: MessageEvent) => {
          if (
            ev.source === iframe.contentWindow
            && ev.origin === expectedSandboxOrigin
            && ev.data?.jsonrpc === '2.0'
            && ev.data?.method === SANDBOX_PROXY_READY
          ) {
            clearTimeout(timer);
            window.removeEventListener('message', onMsg);
            resolve();
          }
        };
        window.addEventListener('message', onMsg);
      });

      iframe.src = sandboxUrl.href;
      await proxyReady;
      if (!isCurrentMount() || iframeRef.current !== iframe) return;

      // 5. Build the bridge and wire host callbacks BEFORE connecting.
      // The app has not declared any display-mode capability yet. Initialize
      // every fresh View in the protocol's inline baseline, then promote it
      // only after its ui/initialize declaration has been verified.
      const requestedDisplayMode = displayModeRef.current;
      const initialDisplayMode: McpUiDisplayMode = 'inline';
      displayModeRef.current = initialDisplayMode;
      const revokeAccess = (message: string) => {
        if (
          mountGenerationRef.current !== generation
          || bridgeRef.current !== bridge
        ) return;
        setError(message);
        setLoading(false);
        void teardown();
      };
      const bridge = new AppBridge(
        makeClientShim(serverName, ownerScope, revokeAccess),
        HOST_INFO,
        {
          openLinks: {},
          serverTools: {},
          serverResources: {},
          logging: {},
          ...(onAppMessageRef.current ? { message: { text: {} } } : {}),
          ...(onUpdateModelContextRef.current
            ? {
                updateModelContext: {
                  text: {},
                  structuredContent: {},
                },
              }
            : {}),
          sandbox: {
            csp: app.csp,
            permissions: app.permissions,
          },
        },
        {
          hostContext: {
            ...(toolInfo ? { toolInfo } : {}),
            theme: theme.palette.mode === 'dark' ? 'dark' : 'light',
            platform: 'web',
            displayMode: initialDisplayMode,
            availableDisplayModes: hostDisplayModesRef.current,
            containerDimensions: measureHostDimensions(
              containerRef.current,
              dockedRef.current,
            ),
            locale: navigator.language,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            userAgent: navigator.userAgent,
            deviceCapabilities: {
              touch: navigator.maxTouchPoints > 0,
              hover: window.matchMedia?.('(hover: hover)').matches ?? false,
            },
          },
        },
      );
      bridgeRef.current = bridge;
      const isActiveBridge = () => (
        isCurrentMount()
        && bridgeRef.current === bridge
      );

      bridge.onopenlink = async ({ url }) => {
        if (!isActiveBridge()) return { isError: true };
        const safeUrl = getSafeOpenLinkUrl(url);
        if (!safeUrl) {
          log.warn('MCP App open-link rejected by URL policy', { serverName, uri });
          return { isError: true };
        }
        const opened = window.open(safeUrl, '_blank', 'noopener,noreferrer');
        if (!opened) return { isError: true };
        opened.opener = null;
        return {};
      };
      // Sandboxed iframes can't trigger downloads; the app delegates to the host
      // (this runs in FLUJO's origin). Save each embedded resource's text/blob.
      bridge.ondownloadfile = async ({ contents }) => {
        if (!isActiveBridge()) return { isError: true };
        try {
          for (const c of (contents as any[]) ?? []) {
            const resource = c?.resource;
            if (!resource) continue;
            const name = (typeof resource.uri === 'string' ? resource.uri.split('/').pop() : '') || 'download';
            const mime = typeof resource.mimeType === 'string' ? resource.mimeType : 'application/octet-stream';
            let blob: Blob;
            if (typeof resource.blob === 'string') {
              const bytes = Uint8Array.from(atob(resource.blob), (ch) => ch.charCodeAt(0));
              blob = new Blob([bytes], { type: mime });
            } else {
              blob = new Blob([String(resource.text ?? '')], { type: mime });
            }
            const objUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = objUrl;
            a.download = name;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(objUrl), 4000);
          }
          return {};
        } catch (e) {
          log.warn('MCP App download failed', e);
          return { isError: true };
        }
      };
      bridge.onloggingmessage = (params) => {
        if (isActiveBridge()) log.debug('MCP App log', params?.data);
      };
      // Human-in-the-loop: the app hands a message/selection back to the model.
      bridge.onmessage = async (params) => {
        if (!isActiveBridge()) return {};
        if (!onAppMessageRef.current) {
          throw new Error('This host cannot deliver ui/message in this surface');
        }
        const text = contentToText(params);
        const delivered = await onAppMessageRef.current(text);
        if (!delivered) throw new Error('ui/message was not delivered');
        return {};
      };
      bridge.onupdatemodelcontext = async (params) => {
        if (!isActiveBridge()) return {};
        const validationError = validateModelContext(params);
        if (validationError) throw new Error(validationError);
        const appKey = `${serverName}::${uri}`;
        if (!onUpdateModelContextRef.current) {
          throw new Error('This host cannot preserve model context in this surface');
        }
        const accepted = await onUpdateModelContextRef.current(appKey, params);
        if (!accepted) throw new Error('MCP App model context was not stored');
        return {};
      };
      bridge.onsizechange = async ({ width, height }) => {
        if (!isActiveBridge()) return;
        if (dockedRef.current) return; // a docked host fills its container height
        const containerWidth = containerRef.current?.getBoundingClientRect().width
          || containerRef.current?.clientWidth
          || 0;
        const clamped = clampInlineSize({ width, height }, containerWidth);
        if (clamped.height !== undefined) {
          inlineHeightRef.current = clamped.height;
          if (displayModeRef.current !== 'fullscreen') iframe.style.height = `${clamped.height}px`;
        }
        if (clamped.width !== undefined) {
          iframe.style.width = `${clamped.width}px`;
          iframe.style.maxWidth = '100%';
        }
      };
      bridge.onrequestdisplaymode = async ({ mode }) => {
        if (!isActiveBridge()) return { mode: displayModeRef.current };
        const current = displayModeRef.current;
        const appModes = appDisplayModesRef.current;
        if (!canUseDisplayMode(mode, hostDisplayModesRef.current, appModes)) {
          return { mode: current };
        }


        // Moving an inline View into the canvas is a handoff to a different
        // View, not a display-mode mutation of this bridge. Return the old
        // View's truthful current mode, then tear it down before creating the
        // canvas owner.
        if (
          mode === 'pip'
          && !dockedRef.current
          && onRequestDockRef.current
        ) {
          setTimeout(handoffToDock, 0);
          return { mode: current };
        }
        let actual = current;
        if (onRequestDisplayModeRef.current) {
          actual = await onRequestDisplayModeRef.current(mode, [...appModes]);
        } else {
          actual = mode;
        }

        // A parent must not be able to accidentally return an undeclared mode.
        if (
          actual !== current
          && !canUseDisplayMode(actual, hostDisplayModesRef.current, appModes)
        ) {
          actual = current;
        }
        if (actual !== current) {
          displayModeRef.current = actual;
        setDisplayMode(actual);
        await bridge.sendHostContextChange({ displayMode: actual });
        }
        return { mode: actual };
      };
      bridge.onrequestteardown = () => {
        if (!isActiveBridge()) return;
        // App-initiated close gets the full graceful window before its owning
        // surface is removed. User/React unmounts use the same best-effort
        // teardown path from effect cleanup.
        void teardown().finally(() => {
          if (onRequestCloseRef.current) onRequestCloseRef.current();
          else {
            displayModeRef.current = 'inline';
            setDisplayMode('inline');
            setExpanded(false);
          }
        });
      };

      // 6. Handshake, then push the triggering tool's input + result.
      bridge.oninitialized = () => {
        if (!isActiveBridge()) return;
        const declaredModes = bridge.getAppCapabilities()?.availableDisplayModes;
        const modes = Array.isArray(declaredModes)
          ? [...new Set(declaredModes.filter(
              (mode): mode is McpUiDisplayMode => ALL_DISPLAY_MODES.includes(mode),
            ))]
          : [];
        appDisplayModesRef.current = modes;
        setAppDisplayModes(modes);
        onDockableRef.current?.(modes.includes('pip'));
        onAvailableDisplayModesRef.current?.([...modes]);

        if (
          autoDockRef.current
          && modes.includes('pip')
          && !dockedRef.current
          && onRequestDockRef.current
        ) {
          setTimeout(handoffToDock, 0);
        }

        initializedRef.current = true;
        const verifiedDisplayMode = getVerifiedPostHandshakeDisplayMode(
          requestedDisplayMode,
          dockedRef.current,
          hostDisplayModesRef.current,
          modes,
        );
        if (verifiedDisplayMode === null) {
          setError(t('chat.app.canvasUnsupported'));
          setLoading(false);
          void teardown();
          return;
        }
        displayModeRef.current = verifiedDisplayMode;
        setDisplayMode(verifiedDisplayMode);
        if (verifiedDisplayMode !== initialDisplayMode) {
          void bridge.sendHostContextChange({ displayMode: verifiedDisplayMode });
        }

        const dimensionsTarget = containerRef.current;
        if (dimensionsTarget && typeof ResizeObserver !== 'undefined') {
          const sendMeasuredDimensions = () => {
            if (!isActiveBridge() || !initializedRef.current) return;
            const bounds = dimensionsTarget.getBoundingClientRect();
            if (
              bounds.width <= 0
              || (dockedRef.current && bounds.height <= 0)
            ) return;
            void bridge.sendHostContextChange({
              containerDimensions: measureHostDimensions(
                dimensionsTarget,
                dockedRef.current,
              ),
            });
          };
          resizeObserverRef.current?.disconnect();
          resizeObserverRef.current = new ResizeObserver(sendMeasuredDimensions);
          resizeObserverRef.current.observe(dimensionsTarget);
          sendMeasuredDimensions();
        }

        const delivery = latestToolDeliveryRef.current;
        const deliveryKey = delivery.updateId
          ?? `${delivery.args ?? ''}\u0000${delivery.resultContent ?? ''}\u0000${delivery.cancelledReason ?? ''}\u0000${delivery.isError ?? ''}`;
        lastDeliveryRef.current = deliveryKey;
        if (
          delivery.args !== undefined
          || delivery.resultContent !== undefined
          || delivery.cancelledReason !== undefined
          || delivery.isError === true
        ) {
          queueToolDelivery(
            bridge,
            delivery.args,
            delivery.resultContent,
            delivery.cancelledReason,
            delivery.isError,
          );
        }
        setLoading(false);
      };

      await bridge.connect(createStablePostMessageTransport(
        iframe.contentWindow!,
        iframe.contentWindow!,
      ));
      if (!isActiveBridge()) return;
      await bridge.sendSandboxResourceReady({ html: app.html, csp: app.csp as any, permissions: app.permissions as any });
    } catch (e) {
      if (!isCurrentMount()) return;
      log.warn(`Failed to mount MCP App ${uri} from ${serverName}`, e);
      setError(e instanceof Error ? e.message : t('chat.app.loadFailed'));
      setLoading(false);
      void teardown();
    }
  }, [
    handoffToDock,
    ownerScope,
    queueToolDelivery,
    serverName,
    teardown,
    theme.palette.mode,
    toolName,
    uri,
    t,
  ]);

  const handleToggle = useCallback(() => {
    const next = !expanded;
    if (!next && displayModeRef.current === 'fullscreen') {
      displayModeRef.current = 'inline';
      setDisplayMode('inline');
      void bridgeRef.current?.sendHostContextChange({ displayMode: 'inline' });
    }
    setExpanded(next);
    if (next) {
      // Mount after the Collapse has rendered its container.
      setTimeout(() => { void mount(); }, 0);
    }
  }, [expanded, mount]);

  // #216: a docked host auto-mounts after the upstream trust/consent decision
  // and then stays mounted for the life of the tab — visibility is CSS-only,
  // so the live iframe/bridge is never reparented.
  useEffect(() => {
    if (docked && !mountedRef.current) void mount();
  }, [docked, mount]);

  // An opted-in app should be visible without a second consent-like click.
  // Wait for the expanded container to exist, then mount exactly as the manual
  // toggle does. The docked path above remains independently auto-mounted.
  useEffect(() => {
    if (!docked && defaultExpanded && expanded && !mountedRef.current) {
      const timer = window.setTimeout(() => { void mount(); }, 0);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [defaultExpanded, docked, expanded, mount]);

  // The proxy iframe used to keep its original 200px inline height after the
  // host entered fullscreen, leaving a large blank panel around terminals and
  // other fixed-height apps. Make the live iframe follow its presentation and
  // restore the last app-requested inline height when fullscreen closes.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    if (docked || effectiveDisplayMode === 'fullscreen') {
      iframe.style.width = '100%';
      iframe.style.height = '100%';
      iframe.style.minHeight = '0';
      iframe.style.borderRadius = '0';
      return;
    }
    iframe.style.width = '100%';
    iframe.style.height = `${inlineHeightRef.current}px`;
    iframe.style.minHeight = '120px';
    iframe.style.borderRadius = '4px';
  }, [docked, effectiveDisplayMode]);

  // Stable MCP Apps delivers at most one input/outcome pair to a View. A later
  // invocation for the same canvas identity therefore gets a fresh View, after
  // the prior one completes its bounded graceful teardown.
  useEffect(() => {
    const deliveryKey = toolUpdateId
      ?? `${toolArgs ?? ''}\u0000${toolResultContent ?? ''}\u0000${toolCancelledReason ?? ''}\u0000${toolIsError ?? ''}`;
    if (!initializedRef.current || !bridgeRef.current) return;
    if (deliveryKey === lastDeliveryRef.current) return;
    lastDeliveryRef.current = deliveryKey;
    void teardown().then(() => {
      if (!componentAliveRef.current) return;
      if (dockedRef.current || expanded) void mount();
    });
  }, [
    expanded,
    mount,
    teardown,
    toolArgs,
    toolCancelledReason,
    toolIsError,
    toolResultContent,
    toolUpdateId,
  ]);

  // The dock owns its presentation. Only propagate parent transitions that the
  // app itself declared; unsupported state changes are ignored fail-closed.
  useEffect(() => {
    if (!hostDisplayMode || !initializedRef.current || !bridgeRef.current) return;
    if (displayModeRef.current === hostDisplayMode) return;
    if (!canUseDisplayMode(
      hostDisplayMode,
      hostDisplayModesRef.current,
      appDisplayModesRef.current,
    )) return;
    displayModeRef.current = hostDisplayMode;
    setDisplayMode(hostDisplayMode);
    void bridgeRef.current.sendHostContextChange({ displayMode: hostDisplayMode });
  }, [hostDisplayMode]);

  // Keep the app's theme in sync with FLUJO's.
  useEffect(() => {
    if (!initializedRef.current || !bridgeRef.current) return;
    void bridgeRef.current?.sendHostContextChange({
      theme: theme.palette.mode === 'dark' ? 'dark' : 'light',
    });
  }, [theme.palette.mode]);

  useEffect(() => {
    const appKey = teardownRegistrationKey ?? `${serverName}::${uri}`;
    onRegisterTeardown?.(appKey, teardown);
    return () => onRegisterTeardown?.(appKey, null);
  }, [onRegisterTeardown, serverName, teardown, teardownRegistrationKey, uri]);

  // A server can revoke MCP Apps while a historical View is open. React to the
  // successful config mutation immediately; backend app-origin routes also
  // enforce the same gate for every subsequent resource/tool request.
  useEffect(() => {
    const onServerConfigChanged = (event: Event) => {
      const detail = (event as CustomEvent<{
        serverName?: string;
        config?: { enableMcpApps?: boolean; disabled?: boolean };
      }>).detail;
      if (
        detail?.serverName !== serverName
        || (
          detail.config?.enableMcpApps !== false
          && detail.config?.disabled !== true
        )
      ) return;
      setError(t('chat.app.accessDisabled'));
      setLoading(false);
      void teardown().finally(() => {
        if (dockedRef.current) onRequestCloseRef.current?.();
      });
    };
    window.addEventListener('flujo:mcp-server-config-changed', onServerConfigChanged);
    return () => {
      window.removeEventListener('flujo:mcp-server-config-changed', onServerConfigChanged);
    };
  }, [serverName, teardown, t]);

  // Tear down on unmount and prevent pending restart continuations.
  useEffect(() => {
    componentAliveRef.current = true;
    return () => {
      componentAliveRef.current = false;
      void teardown();
    };
  }, [teardown]);

  // #216: docked host — no collapse chrome (the dock owns the tab UI), fills its
  // container, and toggles visibility via CSS only (never unmounts on switch).
  if (docked) {
    return (
      <Box
        sx={{
          height: '100%',
          width: '100%',
          minHeight: 0,
          display: 'flex',
          visibility: visible ? 'visible' : 'hidden',
          pointerEvents: visible ? 'auto' : 'none',
          flexDirection: 'column',
        }}
      >
        {loading && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 2, justifyContent: 'center' }}>
            <CircularProgress size={16} thickness={6} />
            <Typography variant="body2" color="text.secondary">{t('chat.app.loading')}</Typography>
          </Box>
        )}
        {error && <Alert severity="error" sx={{ m: 1 }}>{error}</Alert>}
        <Box ref={containerRef} sx={{ flex: 1, minHeight: 0, width: '100%', display: error ? 'none' : 'block' }} />
      </Box>
    );
  }

  const canToggleFullscreen = appDisplayModes.includes('inline')
    && appDisplayModes.includes('fullscreen')
    && hostDisplayModes.includes('fullscreen');
  const canRequestDock = appDisplayModes.includes('inline')
    && appDisplayModes.includes('pip')
    && hostDisplayModes.includes('pip')
    && Boolean(onRequestDock);

  return (
    <Box
      ref={frameRootRef}
      sx={{
        mt: 1,
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 1,
        overflow: 'hidden',
        ...(displayMode === 'fullscreen'
          ? {
              position: 'fixed',
              left: floatingRect?.x ?? 16,
              top: floatingRect?.y ?? 16,
              width: floatingRect?.width ?? 'calc(100vw - 32px)',
              height: floatingRect?.height ?? 'calc(100vh - 32px)',
              minWidth: 480,
              minHeight: 320,
              maxWidth: '100vw',
              maxHeight: '100vh',
              zIndex: 1300,
              bgcolor: 'background.paper',
              boxShadow: 6,
              resize: 'both',
              display: 'flex',
              flexDirection: 'column',
            }
          : {}),
      }}
    >
      <Box
        onPointerDown={startFullscreenDrag}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 1,
          py: 0.5,
          bgcolor: 'action.hover',
          cursor: displayMode === 'fullscreen' ? 'move' : 'default',
          userSelect: 'none',
          flexShrink: 0,
        }}
      >
        <WidgetsIcon fontSize="small" color="primary" />
        <Typography variant="body2" sx={{ fontWeight: 500 }}>
          {t('chat.app.fromServer', { server: serverName })}
        </Typography>
        <Tooltip title={t('chat.app.sandboxHelp')}>
          <ShieldOutlinedIcon fontSize="small" color="action" />
        </Tooltip>
        <Box sx={{ flex: 1 }} />
        {expanded && canRequestDock && (
          <Button
            size="small"
            onClick={handoffToDock}
          >
            {t('chat.app.canvas')}
          </Button>
        )}
        {expanded && (
          <Tooltip
            title={canToggleFullscreen
              ? (displayMode === 'fullscreen' ? t('chat.app.exitFullscreen') : t('chat.app.fullscreen'))
              : t('chat.app.fullscreenUnsupported')}
          >
            <span>
              <Button
                size="small"
                disabled={!canToggleFullscreen}
                onClick={() => {
                  const next = displayMode === 'fullscreen' ? 'inline' : 'fullscreen';
                  if (!canUseDisplayMode(next, hostDisplayModes, appDisplayModes)) return;
                  displayModeRef.current = next;
                  setDisplayMode(next);
                  void bridgeRef.current?.sendHostContextChange({ displayMode: next });
                }}
                sx={{ minWidth: 0 }}
              >
                {displayMode === 'fullscreen' ? <FullscreenExitIcon fontSize="small" /> : <FullscreenIcon fontSize="small" />}
              </Button>
            </span>
          </Tooltip>
        )}
        <Button
          size="small"
          onClick={handleToggle}
          startIcon={expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
        >
          {expanded ? t('chat.app.hide') : t('chat.app.open')}
        </Button>
      </Box>

      <Collapse
        in={expanded}
        onExited={() => { void teardown(); }}
        sx={displayMode === 'fullscreen' ? {
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          '& .MuiCollapse-wrapper, & .MuiCollapse-wrapperInner': {
            height: '100%',
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
          },
        } : undefined}
      >
        <Box sx={{ p: 1, height: displayMode === 'fullscreen' ? '100%' : 'auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {loading && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 2, justifyContent: 'center' }}>
              <CircularProgress size={16} thickness={6} />
              <Typography variant="body2" color="text.secondary">{t('chat.app.loading')}</Typography>
            </Box>
          )}
          {error && <Alert severity="error" sx={{ my: 1 }}>{error}</Alert>}
          <Box ref={containerRef} sx={{ width: '100%', flex: displayMode === 'fullscreen' ? 1 : undefined, minHeight: 0, height: displayMode === 'fullscreen' ? '100%' : 'auto', display: error ? 'none' : 'block' }} />
        </Box>
      </Collapse>
    </Box>
  );
};

export default McpAppFrame;
