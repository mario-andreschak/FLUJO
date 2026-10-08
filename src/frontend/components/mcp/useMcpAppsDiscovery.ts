'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { mcpService } from '@/frontend/services/mcp';
import { MCPServerConfig } from '@/shared/types/mcp';
import {
  extractUiResourceUri,
  isMcpAppMimeType,
  isUiResourceUri,
} from '@/shared/utils/mcpApps';
import { useI18n } from '@/frontend/contexts/I18nContext';

/**
 * Shared MCP App discovery (#396).
 *
 * Extracted verbatim from `McpAppsDashboard` so the dashboard and the
 * navigation quick-actions menu cannot drift apart in what counts as an "app":
 * the same server eligibility rules, the same `ui://` + `text/html;profile=mcp-app`
 * validation, the same tool `_meta` → resource URI association and the same
 * tool-only fallback for servers that omit UI resources from `resources/list`.
 *
 * Discovery is read-only and keeps using `mcpService`'s own cache/refresh
 * semantics — no second cache, no tool invocation.
 */

export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

export interface McpDiscoveredApp {
  serverName: string;
  uri: string;
  name: string;
  description?: string;
  mimeType: string;
  toolNames: string[];
  /** False when the app was only advertised through tool metadata. */
  listedResource: boolean;
}

export interface McpServerDiscovery {
  name: string;
  /** Installed configuration retained so card pickers can reuse ServerCard. */
  config?: MCPServerConfig;
  apps: McpDiscoveredApp[];
  error?: string;
}

export interface UseMcpAppsDiscoveryOptions {
  /** Discover only while the consuming surface is open. */
  active: boolean;
  /**
   * Retain every enabled MCP server, including servers that do not publish an
   * MCP App UI. Persona and Role pickers use this because a server's tools are
   * useful even when `enableMcpApps` is off.
   */
  includeAllServers?: boolean;
  /** #396: the quick-actions menu lists FAVORITED servers only. */
  favoritesOnly?: boolean;
  /** #396: drop servers that did not actually yield a discoverable app. */
  requireApps?: boolean;
}

export interface McpAppsDiscoveryState {
  servers: McpServerDiscovery[];
  /** Flattened apps across all retained servers, in discovery order. */
  apps: McpDiscoveredApp[];
  loading: boolean;
  refreshing: boolean;
  /** Top-level failure (config load / unexpected error), not per-server. */
  error: string | null;
  /** Per-server failures that did not discard the other servers. */
  serverErrors: McpServerDiscovery[];
  /** Increments when a discovery run starts; lets callers reset selections. */
  discoveryId: number;
  refresh: () => void;
}

/**
 * Stable identity of an app across renders and surfaces. The separator is a
 * NUL character, which cannot appear in a server name or a URI.
 */
const APP_KEY_SEPARATOR = String.fromCharCode(0);
export const mcpAppKey = (serverName: string, uri: string) =>
  `${serverName}${APP_KEY_SEPARATOR}${uri}`;

export const appNameFromUri = (uri: string): string => {
  const tail = uri.replace(/^ui:\/\//i, '').split('/').filter(Boolean).at(-1);
  if (!tail) return uri;
  try {
    return decodeURIComponent(tail).replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  } catch {
    return tail.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  }
};

export const readableError = (error: unknown, fallback: string): string => {
  if (typeof error === 'string' && error.trim()) return error;
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
};

export function useMcpAppsDiscovery({
  active,
  includeAllServers = false,
  favoritesOnly = false,
  requireApps = false,
}: UseMcpAppsDiscoveryOptions): McpAppsDiscoveryState {
  const { t } = useI18n();
  const [servers, setServers] = useState<McpServerDiscovery[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discoveryId, setDiscoveryId] = useState(0);
  const requestIdRef = useRef(0);
  const lastReturnRefreshAtRef = useRef(0);

  const discover = useCallback(async (refresh = false) => {
    const requestId = ++requestIdRef.current;
    setDiscoveryId((current) => current + 1);
    setError(null);
    if (refresh) setRefreshing(true);
    else setLoading(true);

    try {
      const configsResult = await mcpService.loadServerConfigs();
      if (requestId !== requestIdRef.current) return;
      if (!Array.isArray(configsResult)) {
        setServers([]);
        setError(readableError(
          (configsResult as { error?: unknown } | null)?.error,
          t('mcp.apps.configFailed'),
        ));
        return;
      }

      const eligible = (configsResult as MCPServerConfig[]).filter((server) => (
        server.disabled !== true
        && (includeAllServers || server.enableMcpApps === true)
        && (!favoritesOnly || server.favorite === true)
      ));

      const discoveries = await Promise.all(eligible.map(async (server): Promise<McpServerDiscovery> => {
        // Ordinary MCP servers are valid Persona/Role choices. They have no App
        // UI to discover, so keep their config without making unsupported
        // resources/list calls or describing that absence as an error.
        if (server.enableMcpApps !== true) {
          return { name: server.name, config: server, apps: [] };
        }
        if (refresh) {
          mcpService.clearCapabilitiesCache(server.name);
          mcpService.clearToolsCache(server.name);
        }

        const [resourceResult, toolResult] = await Promise.all([
          mcpService.listServerResources(server.name),
          mcpService.listServerTools(server.name),
        ]);
        const toolsByResource = new Map<string, string[]>();
        for (const tool of Array.isArray(toolResult?.tools) ? toolResult.tools : []) {
          const uri = extractUiResourceUri(tool?._meta);
          if (!uri || typeof tool?.name !== 'string' || !tool.name.trim()) continue;
          const linked = toolsByResource.get(uri) || [];
          // A server may advertise the same tool twice (paging/duplicates);
          // the menu renders one entry per tool, so deduplicate here.
          if (!linked.includes(tool.name)) linked.push(tool.name);
          toolsByResource.set(uri, linked);
        }

        if (resourceResult?.error && toolsByResource.size === 0) {
          return {
            name: server.name,
            config: server,
            apps: [],
            error: readableError(resourceResult.error, t('mcp.apps.discoveryUnavailable')),
          };
        }

        const appsByUri = new Map<string, McpDiscoveredApp>();
        for (const resource of Array.isArray(resourceResult?.resources) ? resourceResult.resources : []) {
          if (!isUiResourceUri(resource?.uri) || !isMcpAppMimeType(resource?.mimeType)) continue;
          const title = typeof resource.title === 'string' && resource.title.trim()
            ? resource.title.trim()
            : typeof resource.name === 'string' && resource.name.trim()
              ? resource.name.trim()
              : resource.uri;
          // Keyed by URI, so a resource listed twice yields a single app.
          appsByUri.set(resource.uri, {
            serverName: server.name,
            uri: resource.uri,
            name: title,
            description: typeof resource.description === 'string' && resource.description.trim()
              ? resource.description.trim()
              : undefined,
            mimeType: resource.mimeType ?? MCP_APP_MIME_TYPE,
            toolNames: toolsByResource.get(resource.uri) || [],
            listedResource: true,
          });
        }

        // MCP Apps are primarily discovered through tool metadata, and the
        // extension explicitly permits servers to omit UI-only resources from
        // resources/list. Include those linked URIs as launchable candidates;
        // McpAppFrame still performs the authoritative resources/read MIME,
        // URI, CSP, and HTML validation before anything is rendered.
        for (const [uri, toolNames] of toolsByResource) {
          if (appsByUri.has(uri)) continue;
          appsByUri.set(uri, {
            serverName: server.name,
            uri,
            name: appNameFromUri(uri),
            mimeType: MCP_APP_MIME_TYPE,
            toolNames,
            listedResource: false,
          });
        }

        return {
          name: server.name,
          config: server,
          apps: Array.from(appsByUri.values()),
        };
      }));

      if (requestId !== requestIdRef.current) return;
      // #396: "publishes apps" is a discovery outcome, not just configuration
      // intent — a favorited, opted-in server that yields nothing is dropped.
      // Servers that failed keep their error so the surface can scope it.
      setServers(requireApps
        ? discoveries.filter((server) => server.apps.length > 0 || server.error)
        : discoveries);
    } catch (caught) {
      if (requestId === requestIdRef.current) {
        setServers([]);
        setError(readableError(caught, t('mcp.apps.discoveryFailed')));
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [favoritesOnly, includeAllServers, requireApps, t]);

  useEffect(() => {
    if (!active) {
      // Abandon in-flight results so a late response cannot repopulate a
      // surface the user already closed.
      requestIdRef.current += 1;
      return;
    }
    void discover(false);
  }, [active, discover]);

  useEffect(() => {
    if (!active) return;
    const onServerConfigChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ serverName?: string }>).detail;
      if (!detail?.serverName) return;
      mcpService.clearCapabilitiesCache(detail.serverName);
      mcpService.clearToolsCache(detail.serverName);
      void discover(true);
    };
    window.addEventListener('flujo:mcp-server-config-changed', onServerConfigChanged);
    return () => window.removeEventListener('flujo:mcp-server-config-changed', onServerConfigChanged);
  }, [active, discover]);

  useEffect(() => {
    if (!active) return;
    const refreshOnReturn = () => {
      const now = Date.now();
      // Browsers commonly emit focus and visibilitychange together. Treat
      // them as one return event while still refreshing after another window
      // may have installed or changed an MCP server.
      if (now - lastReturnRefreshAtRef.current < 250) return;
      lastReturnRefreshAtRef.current = now;
      void discover(true);
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refreshOnReturn();
    };
    window.addEventListener('focus', refreshOnReturn);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.removeEventListener('focus', refreshOnReturn);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [active, discover]);

  const apps = useMemo(() => servers.flatMap((server) => server.apps), [servers]);
  const serverErrors = useMemo(() => servers.filter((server) => server.error), [servers]);
  const refresh = useCallback(() => { void discover(true); }, [discover]);

  return { servers, apps, loading, refreshing, error, serverErrors, discoveryId, refresh };
}
