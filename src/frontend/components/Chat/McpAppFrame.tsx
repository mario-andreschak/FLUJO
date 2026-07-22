"use client";

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Typography, Button, Collapse, CircularProgress, Alert, Tooltip, useTheme } from '@mui/material';
import WidgetsIcon from '@mui/icons-material/Widgets';
import ShieldOutlinedIcon from '@mui/icons-material/ShieldOutlined';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import { AppBridge, PostMessageTransport, buildAllowAttribute } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { mcpService } from '@/frontend/services/mcp';
import { MAX_UI_RESOURCE_BYTES } from '@/shared/utils/mcpApps';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/Chat/McpAppFrame');

/** Must match backend/mcpApps/sandboxServer.ts. */
const SANDBOX_PROXY_READY = 'ui/notifications/sandbox-proxy-ready';
const RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';
const HOST_INFO = { name: 'FLUJO', version: '1.0.0' };
const PROXY_READY_TIMEOUT_MS = 10_000;

interface McpAppFrameProps {
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
   * Human-in-the-loop return channel: called when the app sends a `ui/message`
   * or `ui/update-model-context` (e.g. the user picked a file). The chat wires
   * this to submit a follow-up user message, resuming a waiting model. When
   * omitted (e.g. the tool tester), app messages are logged only.
   */
  onAppMessage?: (text: string) => void;
}

/** Flatten MCP content blocks (or structured content) to a single text line. */
function contentToText(params: any): string {
  const blocks = Array.isArray(params?.content) ? params.content : [];
  const text = blocks
    .map((b: any) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
  if (text) return text;
  if (params?.structuredContent && typeof params.structuredContent === 'object') {
    return JSON.stringify(params.structuredContent);
  }
  return '';
}

/** CSP + permission block a UI resource declares under `_meta.ui`. */
interface AppResource {
  html: string;
  csp?: unknown;
  permissions?: Record<string, unknown> | undefined;
}

/** Module-level cache of the sandbox port (one fetch per session). */
let sandboxPortPromise: Promise<number> | null = null;
async function resolveSandboxBaseUrl(): Promise<string> {
  if (!sandboxPortPromise) {
    sandboxPortPromise = fetch('/api/mcp/app-sandbox')
      .then((r) => r.json())
      .then((d) => (typeof d?.port === 'number' ? d.port : 4201))
      .catch(() => 4201);
  }
  const port = await sandboxPortPromise;
  // Host and sandbox share a hostname and differ only by port → distinct
  // origins. Using the browser's own hostname keeps the referrer check happy
  // whether FLUJO is reached via localhost, 127.0.0.1, or a LAN address.
  return `${window.location.protocol}//${window.location.hostname}:${port}/sandbox.html`;
}

/** Pull the renderable HTML + `_meta.ui` CSP/permissions out of a ReadResourceResult. */
function extractAppResource(readData: unknown): AppResource {
  const contents = (readData as { contents?: Array<Record<string, any>> } | null | undefined)?.contents;
  if (!Array.isArray(contents) || contents.length === 0) {
    throw new Error('Resource has no contents');
  }
  const entry =
    contents.find((c) => typeof c.mimeType === 'string' && c.mimeType.replace(/\s+/g, '').startsWith(RESOURCE_MIME_TYPE.replace(/\s+/g, '')) && (typeof c.text === 'string' || typeof c.blob === 'string')) ||
    contents.find((c) => typeof c.text === 'string' || typeof c.blob === 'string');
  if (!entry) throw new Error('Resource has no HTML body');

  const html = typeof entry.text === 'string' ? entry.text : atob(entry.blob);
  const byteLength = new TextEncoder().encode(html).length;
  if (byteLength > MAX_UI_RESOURCE_BYTES) {
    throw new Error(`Resource exceeds the ${Math.round(MAX_UI_RESOURCE_BYTES / 1024)} KiB size cap`);
  }
  const uiMeta = (entry._meta ?? entry.meta)?.ui;
  return { html, csp: uiMeta?.csp, permissions: uiMeta?.permissions };
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
function makeClientShim(serverName: string): Client {
  const shim = {
    getServerCapabilities: () => ({ tools: {}, resources: {} }),
    setNotificationHandler: () => { /* no listChanged advertised */ },
    request: async (req: { method: string; params?: any }) => {
      const { method, params } = req;
      if (method === 'tools/call') {
        // App-initiated tool call. Scoped to the app's own server (the shim is
        // bound to serverName); the per-server MCP Apps opt-in gates whether the
        // app renders at all, so reaching here already implies user consent.
        log.info(`MCP App tools/call: ${serverName}/${params?.name}`);
        const r = await mcpService.callTool(serverName, params.name, params.arguments ?? {});
        if (!r || r.success === false) throw new Error(r?.error || `Tool call failed: ${params?.name}`);
        return r.data;
      }
      if (method === 'resources/read') {
        const r = await mcpService.readResource(serverName, params.uri);
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

function safeParse(raw: string | undefined): any {
  if (!raw) return undefined;
  try { return JSON.parse(raw); } catch { return undefined; }
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
const McpAppFrame: React.FC<McpAppFrameProps> = ({ serverName, uri, toolName, toolArgs, toolResultContent, onAppMessage }) => {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [displayMode, setDisplayMode] = useState<'inline' | 'fullscreen'>('inline');

  const containerRef = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const bridgeRef = useRef<AppBridge | null>(null);
  const mountedRef = useRef(false);
  // Always call the latest callback without remounting the bridge on prop change.
  const onAppMessageRef = useRef(onAppMessage);
  useEffect(() => { onAppMessageRef.current = onAppMessage; }, [onAppMessage]);

  const teardown = useCallback(() => {
    try { bridgeRef.current?.close(); } catch { /* noop */ }
    bridgeRef.current = null;
    if (iframeRef.current && iframeRef.current.parentNode) {
      iframeRef.current.parentNode.removeChild(iframeRef.current);
    }
    iframeRef.current = null;
    mountedRef.current = false;
  }, []);

  const mount = useCallback(async () => {
    if (mountedRef.current || !containerRef.current) return;
    mountedRef.current = true;
    setLoading(true);
    setError(null);
    try {
      // 1. Read the app HTML + CSP/permissions.
      const read = await mcpService.readResource(serverName, uri);
      if (!read || read.success === false) throw new Error(read?.error || 'Failed to read the UI resource.');
      const app = extractAppResource(read.data);

      // 2. Resolve the foreign sandbox origin.
      const sandboxBase = await resolveSandboxBaseUrl();

      // 3. Create the OUTER (sandbox-proxy) iframe.
      const iframe = document.createElement('iframe');
      iframe.title = `MCP App: ${uri}`;
      iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
      iframe.referrerPolicy = 'origin'; // the sandbox validates the embedder via referrer
      const allow = buildAllowAttribute(app.permissions as any);
      if (allow) iframe.setAttribute('allow', allow);
      iframe.style.cssText = 'width:100%;min-height:120px;height:200px;border:none;border-radius:4px;background:#fff;';
      containerRef.current.appendChild(iframe);
      iframeRef.current = iframe;

      // 4. Wait for the proxy to signal readiness, then point it at the sandbox.
      const proxyReady = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          window.removeEventListener('message', onMsg);
          reject(new Error('Timed out waiting for the sandbox proxy.'));
        }, PROXY_READY_TIMEOUT_MS);
        const onMsg = (ev: MessageEvent) => {
          if (ev.source === iframe.contentWindow && ev.data?.method === SANDBOX_PROXY_READY) {
            clearTimeout(timer);
            window.removeEventListener('message', onMsg);
            resolve();
          }
        };
        window.addEventListener('message', onMsg);
      });

      const sandboxUrl = new URL(sandboxBase);
      if (app.csp) sandboxUrl.searchParams.set('csp', JSON.stringify(app.csp));
      iframe.src = sandboxUrl.href;
      await proxyReady;

      // 5. Build the bridge and wire host callbacks BEFORE connecting.
      const bridge = new AppBridge(
        makeClientShim(serverName),
        HOST_INFO,
        { openLinks: {}, serverTools: {}, serverResources: {}, updateModelContext: { text: {} } },
        {
          hostContext: {
            theme: theme.palette.mode === 'dark' ? 'dark' : 'light',
            platform: 'web',
            displayMode: 'inline',
            availableDisplayModes: ['inline', 'fullscreen'],
            containerDimensions: { maxHeight: 6000 },
          },
        },
      );
      bridgeRef.current = bridge;

      bridge.onopenlink = async ({ url }) => {
        window.open(url, '_blank', 'noopener,noreferrer');
        return {};
      };
      // Sandboxed iframes can't trigger downloads; the app delegates to the host
      // (this runs in FLUJO's origin). Save each embedded resource's text/blob.
      bridge.ondownloadfile = async ({ contents }) => {
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
      bridge.onloggingmessage = (params) => log.debug('MCP App log', params?.data);
      // Human-in-the-loop: the app hands a message/selection back to the model.
      bridge.onmessage = async (params) => {
        const text = contentToText(params);
        if (text) {
          if (onAppMessageRef.current) onAppMessageRef.current(text);
          else log.info(`MCP App message (no chat sink): ${text}`);
        }
        return {};
      };
      bridge.onupdatemodelcontext = async (params) => {
        // FLUJO has no separate "pending context" store yet, so we surface a
        // context update the same way — as a follow-up message to the model.
        const text = contentToText(params);
        if (text) {
          if (onAppMessageRef.current) onAppMessageRef.current(text);
          else log.info(`MCP App context update (no chat sink): ${text}`);
        }
        return {};
      };
      bridge.onsizechange = async ({ width, height }) => {
        if (typeof height === 'number' && height > 0) iframe.style.height = `${height}px`;
        if (typeof width === 'number' && width > 0) iframe.style.minWidth = `min(${width}px, 100%)`;
      };
      bridge.onrequestdisplaymode = async ({ mode }) => {
        const next = mode === 'fullscreen' ? 'fullscreen' : 'inline';
        setDisplayMode(next);
        bridge.sendHostContextChange({ displayMode: next });
        return { mode: next };
      };

      // 6. Handshake, then push the triggering tool's input + result.
      bridge.oninitialized = () => {
        const args = safeParse(toolArgs);
        if (args && typeof args === 'object') bridge.sendToolInput({ arguments: args });
        const resultData = safeParse(toolResultContent);
        if (resultData && typeof resultData === 'object') {
          // Stored content may be the CallToolResult itself ({content:[…]}) or a
          // bare payload; wrap the latter so the app always gets a valid result.
          const result = Array.isArray(resultData.content) ? resultData : { content: [{ type: 'text', text: toolResultContent }] };
          bridge.sendToolResult(result);
        }
        setLoading(false);
      };

      await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
      await bridge.sendSandboxResourceReady({ html: app.html, csp: app.csp as any, permissions: app.permissions as any });
    } catch (e) {
      log.warn(`Failed to mount MCP App ${uri} from ${serverName}`, e);
      setError(e instanceof Error ? e.message : 'Failed to load the app.');
      setLoading(false);
      teardown();
    }
  }, [serverName, uri, toolArgs, toolResultContent, theme.palette.mode, teardown]);

  const handleToggle = useCallback(() => {
    const next = !expanded;
    setExpanded(next);
    if (next) {
      // Mount after the Collapse has rendered its container.
      setTimeout(() => { void mount(); }, 0);
    }
  }, [expanded, mount]);

  // Keep the app's theme in sync with FLUJO's.
  useEffect(() => {
    bridgeRef.current?.sendHostContextChange({ theme: theme.palette.mode === 'dark' ? 'dark' : 'light' });
  }, [theme.palette.mode]);

  // Tear down on unmount.
  useEffect(() => () => teardown(), [teardown]);

  return (
    <Box
      sx={{
        mt: 1,
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 1,
        overflow: 'hidden',
        ...(displayMode === 'fullscreen'
          ? { position: 'fixed', inset: 16, zIndex: 1300, bgcolor: 'background.paper', boxShadow: 6 }
          : {}),
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1, py: 0.5, bgcolor: 'action.hover' }}>
        <WidgetsIcon fontSize="small" color="primary" />
        <Typography variant="body2" sx={{ fontWeight: 500 }}>
          Interactive app from {serverName}
        </Typography>
        <Tooltip title="Runs in a separate-origin sandbox (no access to FLUJO's origin, cookies, storage, or DOM). Its tool calls are brokered through this server only.">
          <ShieldOutlinedIcon fontSize="small" color="action" />
        </Tooltip>
        {expanded && (
          <Tooltip title={displayMode === 'fullscreen' ? 'Exit fullscreen' : 'Fullscreen'}>
            <Button
              size="small"
              onClick={() => {
                const next = displayMode === 'fullscreen' ? 'inline' : 'fullscreen';
                setDisplayMode(next);
                bridgeRef.current?.sendHostContextChange({ displayMode: next });
              }}
              sx={{ minWidth: 0, ml: 'auto' }}
            >
              {displayMode === 'fullscreen' ? <FullscreenExitIcon fontSize="small" /> : <FullscreenIcon fontSize="small" />}
            </Button>
          </Tooltip>
        )}
        <Button
          size="small"
          onClick={handleToggle}
          startIcon={expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
          sx={{ ml: expanded ? 0 : 'auto' }}
        >
          {expanded ? 'Hide' : 'Open app'}
        </Button>
      </Box>

      <Collapse in={expanded} unmountOnExit onExited={teardown}>
        <Box sx={{ p: 1, height: displayMode === 'fullscreen' ? 'calc(100vh - 100px)' : 'auto' }}>
          {loading && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 2, justifyContent: 'center' }}>
              <CircularProgress size={16} thickness={6} />
              <Typography variant="body2" color="text.secondary">Loading the app…</Typography>
            </Box>
          )}
          {error && <Alert severity="error" sx={{ my: 1 }}>{error}</Alert>}
          <Box ref={containerRef} sx={{ width: '100%', height: displayMode === 'fullscreen' ? '100%' : 'auto', display: error ? 'none' : 'block' }} />
        </Box>
      </Collapse>
    </Box>
  );
};

export default McpAppFrame;
