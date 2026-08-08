'use client';

import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { magicLinkPath } from '@/frontend/utils/magicLink';
import { getSelectedWorkspace } from '@/frontend/utils/workspaceSelection';
import ServerList from './ServerList';
import ServerModal from './Modals/ServerModal/index';
import { SaveAndAuthenticateResult, type ServerSetupTab } from './Modals/ServerModal/types';
import McpConnectionWizard from './McpConnectionWizard';
import ServerDetailsModal from './ServerDetailsModal';
import McpAppsDashboard, { type McpAppsDashboardSelection } from '../McpAppsDashboard';
import type { ToolTesterPrefill } from '../MCPToolManager/ToolTester';
import {
  MCP_APP_PARAM,
  MCP_APP_TOKEN_PARAM,
  MCP_APP_URI_PARAM,
  consumeQuickActionToken,
  subscribeOpenMcpApp,
  type McpAppQuickAction,
} from '@/frontend/utils/quickActions';
import { MCPServerConfig } from '@/shared/types/mcp';
import { ServerUpdateInfo, checkServerUpdates } from './utils/serverUpdates';
import { useServerStatus } from '@/frontend/hooks/useServerStatus';
import { MCP_FORMATS, getMcpFormat, McpFormatId } from '@/utils/mcp/mcpFormats';
import { createLogger } from '@/utils/logger';
import {
  Button, 
  useTheme, 
  Box, 
  Typography, 
  Paper,
  TextField,
  InputAdornment,
  IconButton,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
  Divider,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Tooltip
} from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import UploadIcon from '@mui/icons-material/Upload';
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import AddIcon from '@mui/icons-material/Add';
import SearchIcon from '@mui/icons-material/Search';
import SortIcon from '@mui/icons-material/Sort';
import SortByAlphaIcon from '@mui/icons-material/SortByAlpha';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import TerminalIcon from '@mui/icons-material/Terminal';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import StopIcon from '@mui/icons-material/Stop';
import SelectAllIcon from '@mui/icons-material/SelectAll';
import LayersIcon from '@mui/icons-material/Layers';
import LayersClearIcon from '@mui/icons-material/LayersClear';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import AppsIcon from '@mui/icons-material/Apps';
import HubRoundedIcon from '@mui/icons-material/HubRounded';
import CollapsibleCardSection from '@/frontend/components/shared/CollapsibleCardSection';
import PageHeader from '@/frontend/components/shared/PageHeader';
import {
  groupByFolder,
  groupItems,
  collectFolders,
  CardGroup,
  DEFAULT_CARD_GROUP_MODE,
} from '@/utils/shared/cardGrouping';
import { ServerSortOption, deriveServerSortGroup, sortServersFavoritesFirst } from '@/utils/shared/serverGrouping';
import { useWorkspaceUiPreference } from '@/frontend/hooks/useUiPreference';
import { useAutoFocusSearch } from '@/frontend/hooks/useAutoFocusSearch';
import ScrollNavCluster from '@/frontend/components/shared/ScrollNavCluster';
import StickySearchBar from '@/frontend/components/shared/StickySearchBar';
import { useListScrollNav } from '@/frontend/hooks/useListScrollNav';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { useTheme as useAppTheme } from '@/frontend/contexts/ThemeContext';

const log = createLogger('frontend/components/mcp/MCPServerManager');

type FilterOption = 'all' | 'connected' | 'disconnected' | 'error' | 'enabled' | 'disabled' | 'stdio' | 'websocket' | 'sse' | 'streamable';
/** How server cards are folded into collapsible sections: off, by user folder (#71), or by the active sort key (#73). */
type GroupMode = 'none' | 'folder' | 'sort';

interface ServerManagerProps {
  // Optional: notified when the add/edit modal opens/closes (kept for callers that care).
  onServerModalToggle?: (isOpen: boolean) => void;
}

const ServerManager: React.FC<ServerManagerProps> = ({ onServerModalToggle }) => {
  const router = useRouter();
  const { t, tp, formatNumber } = useI18n();
  const {
    servers,
    isLoading,
    loadError,
    connectingServers,
    toggleServer,
    retryServer,
    deleteServer,
    addServer,
    updateServer,
    setServerFolder,
    setServerFavorite,
    saveEnv
  } = useServerStatus();

  const [showAddModal, setShowAddModal] = useState(false);
  const [showConnectionWizard, setShowConnectionWizard] = useState(false);
  const [initialSetupTab, setInitialSetupTab] = useState<ServerSetupTab>('spotlight');
  const [editingServer, setEditingServer] = useState<MCPServerConfig | null>(null);
  // Import/export dialog + format-dropdown state.
  const [showImportModal, setShowImportModal] = useState(false);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [importFormat, setImportFormat] = useState<McpFormatId>('claude');
  const [exportMenuAnchor, setExportMenuAnchor] = useState<null | HTMLElement>(null);
  const [importMenuAnchor, setImportMenuAnchor] = useState<null | HTMLElement>(null);
  // Name of the server whose details modal (Tools/Resources/Prompts/Env) is open.
  const [detailsServerName, setDetailsServerName] = useState<string | null>(null);
  // #374: whether THIS instance pushed the `?server=` history entry (vs. it
  // being present on initial load from a deep link) — see handleOpenDetails.
  const detailsPushedByUsRef = useRef(false);
  const [toolPrefill, setToolPrefill] = useState<ToolTesterPrefill | undefined>();
  const [showAppsDashboard, setShowAppsDashboard] = useState(false);
  // #396: app the MCP Apps dashboard should preview when opened from the
  // navigation quick-actions menu (held in state so its identity is stable).
  const [appsSelection, setAppsSelection] = useState<McpAppsDashboardSelection | null>(null);
  // Git update status per repository rootPath (locally cloned stdio servers).
  const [updates, setUpdates] = useState<Record<string, ServerUpdateInfo>>({});

  // Paths of servers that live in a local clone. A stable string key keeps the
  // effect from re-firing on every status poll of the servers array.
  const gitServerPathsKey = useMemo(
    () =>
      Array.from(
        new Set(
          servers
            .filter((s) => s.transport === 'stdio' && s.rootPath)
            .map((s) => s.rootPath)
        )
      ).join('|'),
    [servers]
  );

  useEffect(() => {
    const paths = gitServerPathsKey.split('|').filter(Boolean);
    if (paths.length === 0) return;
    let cancelled = false;
    // Results are cached (10 min TTL) inside checkServerUpdates, so this stays
    // cheap even if the server list re-materializes.
    checkServerUpdates(paths)
      .then((results) => {
        if (!cancelled) setUpdates((prev) => ({ ...prev, ...results }));
      })
      .catch((err) => log.warn('Server update check failed', err));
    return () => {
      cancelled = true;
    };
  }, [gitServerPathsKey]);

  const handleServerUpdated = async (serverName: string, rootPath: string) => {
    // Re-check every clone, not just the updated one: several servers can share a
    // repository (monorepo clones like modelcontextprotocol/servers), and the pull
    // just cleared the badge for all of them.
    log.info(`Server ${serverName} updated from git, refreshing update status`);
    const paths = gitServerPathsKey.split('|').filter(Boolean);
    const results = await checkServerUpdates(paths.length > 0 ? paths : [rootPath], true);
    setUpdates((prev) => ({ ...prev, ...results }));
  };

  // Open the details modal only for ENABLED servers — a disabled server has no live
  // connection, so there's nothing to inspect (no modal, per design).
  const handleOpenDetails = (serverName: string) => {
    const server = servers.find((s) => s.name === serverName);
    if (!server || server.disabled) {
      log.debug(`Not opening details for ${serverName} (missing or disabled)`);
      return;
    }
    setDetailsServerName(serverName);
    // #374: opening the modal is a real history entry, so Back closes it
    // instead of leaving the page. `detailsPushedByUsRef` remembers whether
    // this instance pushed the entry (vs. it being the initial deep-linked
    // URL) so handleCloseDetails knows whether router.back() is safe.
    detailsPushedByUsRef.current = true;
    router.push(magicLinkPath({ kind: 'mcp-server', id: serverName }));
  };

  // While the details modal is open, a browser Back should close it (and only
  // it) rather than leaving `/mcp` entirely — mirrors the FlowBuilder's
  // history-guarded editor (#374).
  useEffect(() => {
    if (typeof window === 'undefined' || !detailsServerName) return;
    const handlePopState = () => {
      const query = new URLSearchParams(window.location.search);
      if (!query.get('server')) {
        detailsPushedByUsRef.current = false;
        setDetailsServerName(null);
        setToolPrefill(undefined);
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [detailsServerName]);

  // `?server=<id>` alone is the magic link (#374): opens the details modal and
  // stays in the URL (durable) so Back/Forward and refresh keep it in sync,
  // cleared on close. `?server=<id>&tool=<name>[&args=<json>]` is the older,
  // one-shot tool-tester deep link — it still consumes/clears immediately.
  useEffect(() => {
    if (typeof window === 'undefined' || servers.length === 0) return;
    const query = new URLSearchParams(window.location.search);
    const serverName = query.get('server');
    if (!serverName) return;
    const toolName = query.get('tool');
    const server = servers.find((candidate) => candidate.name === serverName);
    if (!server || server.disabled) return;
    if (toolName) {
      let argumentsPrefill: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(query.get('args') || '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) argumentsPrefill = parsed;
      } catch { /* malformed query arguments safely become an empty object */ }
      setToolPrefill({ toolName, arguments: argumentsPrefill });
    }
    setDetailsServerName(serverName);
    if (toolName) {
      router.replace('/mcp');
    }
  }, [servers, router]);

  // #396: quick actions hand an MCP target to the page that already owns the
  // dashboard and the Tool Tester. A linked tool reuses the pre-existing
  // `?server=&tool=` deep link above; an app opens the dashboard preselected.
  // Nothing here invokes a tool.
  const openMcpQuickTarget = useCallback((request: McpAppQuickAction) => {
    if (request.toolName) {
      setShowAppsDashboard(false);
      setToolPrefill({ toolName: request.toolName, arguments: {} });
      setDetailsServerName(request.serverName);
      return;
    }
    setAppsSelection(request.uri ? { serverName: request.serverName, uri: request.uri } : null);
    setShowAppsDashboard(true);
  }, []);

  // Route intent, for when this page was not mounted yet. One-shot: the token
  // is claimed and the params are dropped so a refresh does not reopen it.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const query = new URLSearchParams(window.location.search);
    const serverName = query.get(MCP_APP_PARAM);
    if (!serverName) return;
    if (!consumeQuickActionToken(query.get(MCP_APP_TOKEN_PARAM))) return;
    openMcpQuickTarget({ serverName, uri: query.get(MCP_APP_URI_PARAM) || undefined });
    router.replace('/mcp');
  }, [openMcpQuickTarget, router]);

  // In-page intent, for when the menu is used while `/mcp` is already open
  // (pushing the same route would not re-run the effect above).
  useEffect(() => subscribeOpenMcpApp((request, token) => {
    if (!consumeQuickActionToken(token)) return;
    openMcpQuickTarget(request);
  }), [openMcpQuickTarget]);

  const handleCloseDetails = () => {
    const name = detailsServerName;
    setDetailsServerName(null);
    setToolPrefill(undefined);
    if (detailsPushedByUsRef.current) {
      // Pop the entry this instance pushed when it opened the modal, so Back
      // afterwards leaves `/mcp` instead of re-opening it.
      detailsPushedByUsRef.current = false;
      router.back();
    } else if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('server')) {
      // The modal was opened from a deep link with nothing safe to pop back to.
      router.replace('/mcp');
    }
    // Opening the modal (Tool tester / resources) self-heals a stale connection via the
    // backend's reconnect-on-use; refresh this card's status so it stops showing a stale
    // "crashed" message without a full page reload.
    if (name) {
      retryServer(name);
    }
  };

  const handleEnvRestart = async (serverName: string) => {
    await toggleServer(serverName, false);
    await toggleServer(serverName, true);
  };

  const detailsServer = detailsServerName
    ? servers.find((s) => s.name === detailsServerName) || null
    : null;
  
  // Toolbar state. The view preferences (#93) persist across navigation via
  // localStorage; search + the transient menu anchors stay session-scoped.
  const [searchTerm, setSearchTerm] = useState('');
  // #372: place the caret in the search field automatically and keep the field
  // visible while the server list scrolls. Unlike the Flows dashboard, this page
  // has no height-constrained ancestor, so the list Box below never becomes its
  // own scrollport — the document scrolls instead. The toolbar therefore needs
  // the same `StickySearchBar mode="page"` wrapper as Models/Automations.
  const searchInputRef = useAutoFocusSearch();
  const [sortOption, setSortOption] = useWorkspaceUiPreference<ServerSortOption>('flujo-ui:mcp:sort', 'name-asc');
  const [filterOption, setFilterOption] = useWorkspaceUiPreference<FilterOption>('flujo-ui:mcp:filter', 'all');
  const [sortAnchorEl, setSortAnchorEl] = useState<null | HTMLElement>(null);
  const [groupMode, setGroupMode] = useWorkspaceUiPreference<GroupMode>('flujo-ui:mcp:group', DEFAULT_CARD_GROUP_MODE);
  const [groupAnchorEl, setGroupAnchorEl] = useState<null | HTMLElement>(null);
  // Collapsed sections persisted as a string[] and re-derived into a Set.
  const [collapsedList, setCollapsedList] = useWorkspaceUiPreference<string[]>('flujo-ui:mcp:collapsed', []);
  const collapsedKeys = useMemo(() => new Set(collapsedList), [collapsedList]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedServers, setSelectedServers] = useState<Set<string>>(new Set());
  const [bulkActionDialog, setBulkActionDialog] = useState<{open: boolean; action: 'enable' | 'disable' | null}>({open: false, action: null});
  
  const theme = useTheme();
  const { visualStyle } = useAppTheme();
  const modern = visualStyle === 'modern';

  const openServerSetup = (tab: ServerSetupTab = 'spotlight') => {
    setShowConnectionWizard(false);
    setEditingServer(null);
    setInitialSetupTab(tab);
    setShowAddModal(true);
    onServerModalToggle?.(true);
  };

  const handleConnectApp = () => {
    setEditingServer(null);
    if (modern) {
      setShowConnectionWizard(true);
      return;
    }
    openServerSetup();
  };

  const handleServerToggle = async (serverName: string, enabled: boolean) => {
    log.debug(`Toggling server ${serverName} to ${enabled ? 'enabled' : 'disabled'}`);
    await toggleServer(serverName, enabled);
  };

  const handleServerRetry = async (serverName: string) => {
    log.debug(`Retrying pulling server status for server: ${serverName}`);
    await retryServer(serverName);
  };

  const handleServerDelete = async (serverName: string) => {
    log.debug(`Deleting server: ${serverName}`);
    await deleteServer(serverName);
  };

  const handleEditServer = (server: MCPServerConfig) => {
    log.debug(`Editing server: ${server.name}`);
    setEditingServer(server);
    setShowAddModal(true);
    onServerModalToggle?.(true);
  };

  const handleAddServer = async (config: MCPServerConfig) => {
    log.debug(`Adding server: ${config.name}`);
    await addServer(config);
    setShowAddModal(false);
    setEditingServer(null); // Ensure editing server is reset
    onServerModalToggle?.(false);
  };

  const handleUpdateServer = async (config: MCPServerConfig) => {
    // Pass the original name so a rename targets the existing server (PUT /{oldName})
    // instead of creating a duplicate under the new name. editingServer holds the server
    // as it was opened, so its name is the current (pre-edit) storage key.
    const originalName = editingServer?.name;
    log.debug(
      `Updating server: ${originalName ?? config.name}` +
        (originalName && originalName !== config.name ? ` -> ${config.name}` : '')
    );
    await updateServer(config, originalName);
    setShowAddModal(false);
    setEditingServer(null);
    onServerModalToggle?.(false);
  };

  // "Save & Authenticate" from the Add/Edit modal (remote OAuth servers). Persist the
  // server first — OAuth binds tokens/DCR client info by server name on disk, and the
  // popup's callback resumes by reloading that saved config — then run the same
  // initiate → popup flow the card banner uses. The modal stays open (this component owns
  // it and stays mounted) until the popup resolves, so a cancelled sign-in returns the
  // user to the form instead of a half-configured card.
  const handleSaveAndAuthenticate = async (config: MCPServerConfig): Promise<SaveAndAuthenticateResult> => {
    log.debug(`Save & Authenticate for server: ${config.name}`);
    const closeModal = () => {
      setShowAddModal(false);
      setEditingServer(null);
      onServerModalToggle?.(false);
    };

    try {
      // editingServer is the server as opened, so its name is the current storage key.
      if (editingServer) {
        await updateServer(config, editingServer.name);
      } else {
        await addServer(config);
      }

      const response = await fetch('/api/oauth/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverName: config.name }),
      });
      const data = await response.json();

      if (!response.ok) {
        // No DCR: the provider needs a manually pre-registered client (id/secret).
        if (data.needsClientCredentials) {
          return { status: 'needs_client_credentials', error: data.error };
        }
        return { status: 'error', error: data.error || t('mcp.server.oauthFailed') };
      }

      if (data.alreadyAuthorized || !data.authorizationUrl) {
        // A stored (or refreshed) token was still valid — no popup needed.
        closeModal();
        await retryServer(config.name);
        return { status: 'authorized' };
      }

      const { openOAuthPopup } = await import('@/frontend/utils/oauth');
      await openOAuthPopup({
        url: data.authorizationUrl,
        windowName: `oauth_${config.name}`,
      });
      // Resolved only when the callback returned oauth_success. Reconnect so the server
      // picks up the freshly stored tokens (mirrors the card banner's post-auth restart).
      closeModal();
      await retryServer(config.name);
      return { status: 'authorized' };
    } catch (error) {
      log.warn(`Save & Authenticate failed for ${config.name}:`, error);
      return { status: 'error', error: error instanceof Error ? error.message : t('mcp.server.unknownError') };
    }
  };

  const handleExportConfig = (formatId: McpFormatId) => {
    const format = getMcpFormat(formatId);
    log.debug(`Exporting server configurations in ${format.label} format`);
    setExportMenuAnchor(null);

    // Emit the selected tool's shape (`type`/`url` rather than FLUJO's
    // `transport`/`serverUrl`) so the file can be pasted into that tool's
    // config. Servers exposed via FLUJO's mcp-proxy are emitted as http URLs
    // against this origin (e.g. http://localhost:4200/mcp-proxy/<name>).
    const config = format.export(servers as unknown as MCPServerConfig[], {
      proxyBaseUrl: typeof window !== 'undefined' ? window.location.origin : '',
      workspace: getSelectedWorkspace(),
    });

    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = format.fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const openImportDialog = (formatId: McpFormatId) => {
    setImportFormat(formatId);
    setImportText('');
    setImportError(null);
    setImportMenuAnchor(null);
    setShowImportModal(true);
  };

  const handleImportConfig = async () => {
    const format = getMcpFormat(importFormat);
    log.debug(`Importing server configurations from ${format.label} format`);
    setImportError(null);

    const { servers: parsedServers, errors } = format.import(importText);

    if (parsedServers.length === 0) {
      setImportError(
        errors.length > 0
          ? errors.join('\n')
          : t('mcp.server.noImportServers')
      );
      return;
    }

    setIsImporting(true);
    const existingNames = new Set(servers.map((s) => s.name));
    let added = 0;
    let updated = 0;
    const failures: string[] = [];

    // Import sequentially so backend connection attempts don't stampede.
    for (const config of parsedServers) {
      try {
        if (existingNames.has(config.name)) {
          await updateServer(config);
          updated++;
        } else {
          await addServer(config);
          existingNames.add(config.name);
          added++;
        }
      } catch (e) {
        failures.push((e as Error).message
          ? `“${config.name}”: ${(e as Error).message}`
          : t('mcp.server.importEntryFailed', { name: config.name }));
      }
    }

    setIsImporting(false);

    const allProblems = [...errors, ...failures];
    if (added === 0 && updated === 0) {
      setImportError(
        allProblems.length > 0 ? allProblems.join('\n') : t('mcp.server.noneImported')
      );
      return;
    }

    // Some succeeded — close the dialog. Keep partial errors visible if any.
    log.info(`Imported MCP servers: ${added} added, ${updated} updated`);
    if (allProblems.length > 0) {
      setImportError(
        t('mcp.server.partialImport', {
          added: formatNumber(added),
          updated: formatNumber(updated),
          problems: allProblems.join('\n'),
        })
      );
    } else {
      setShowImportModal(false);
      setImportText('');
    }
  };

  const handleCloseImport = () => {
    setShowImportModal(false);
    setImportText('');
    setImportError(null);
  };

  // Filter and sort servers
  const filteredAndSortedServers = useMemo(() => {
    log.debug('Filtering and sorting servers', { searchTerm, sortOption, filterOption });
    
    // First filter by search term
    let result = servers;
    
    if (searchTerm.trim() !== '') {
      const lowerCaseSearch = searchTerm.toLowerCase();
      result = servers.filter(server => 
        server.name.toLowerCase().includes(lowerCaseSearch) ||
        server.rootPath?.toLowerCase().includes(lowerCaseSearch)
      );
    }
    
    // Then filter by status/transport/enabled state
    if (filterOption !== 'all') {
      result = result.filter(server => {
        switch (filterOption) {
          case 'connected':
            return server.status === 'connected';
          case 'disconnected':
            return server.status === 'disconnected';
          case 'error':
            return server.status === 'error';
          case 'enabled':
            return !server.disabled;
          case 'disabled':
            return server.disabled;
          case 'stdio':
          case 'websocket':
          case 'sse':
          case 'streamable':
            return server.transport === filterOption;
          default:
            return true;
        }
      });
    }
    
    // Finally sort favorites-first (#146), then by the active key (shared helper —
    // see utils/shared/serverGrouping.ts).
    return sortServersFavoritesFirst(result, sortOption);
  }, [servers, searchTerm, sortOption, filterOption]);

  // Persist scroll position + back-to-top (#185); re-restore once the list loads.
  const { ref: scrollRef, clusterProps: scrollNavProps } = useListScrollNav<HTMLDivElement>(
    'flujo-ui:scroll:mcp',
    { deps: [isLoading, filteredAndSortedServers.length], groupsEnabled: groupMode !== 'none' },
  );

  // Distinct folders currently in use, for the "Move to folder" picker (#71).
  const folders = useMemo(() => collectFolders(servers, (s: any) => s.folder), [servers]);

  // Grouped view of the filtered/sorted servers, driven by the active group mode.
  const sortLabel = (option: ServerSortOption) => t(`mcp.server.sort.${option}`);
  const filterLabel = (option: FilterOption) => {
    switch (option) {
      case 'connected': return t('mcp.status.connected');
      case 'disconnected': return t('mcp.status.disconnected');
      case 'error': return t('mcp.status.error');
      case 'enabled': return t('mcp.server.enable');
      case 'disabled': return t('mcp.server.disable');
      case 'stdio': return t('mcp.server.transport.stdio');
      case 'websocket': return t('mcp.server.transport.websocket');
      case 'sse': return t('mcp.server.transport.sse');
      case 'streamable': return t('mcp.server.transport.streamable');
      default: return option;
    }
  };

  // The AI installer persists an exact, approved Registry plan on the backend. For
  // OAuth recommendations, finish the same initiate → popup flow without saving a
  // duplicate config from the wizard.
  const handleAiAuthenticate = async (serverName: string): Promise<void> => {
    const response = await fetch('/api/oauth/initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverName }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || (data.needsClientCredentials
        ? t('mcp.ai.clientCredentialsRequired')
        : t('mcp.server.oauthFailed')));
    }
    if (!data.alreadyAuthorized && data.authorizationUrl) {
      const { openOAuthPopup } = await import('@/frontend/utils/oauth');
      await openOAuthPopup({ url: data.authorizationUrl, windowName: `oauth_${serverName}` });
    }
    await retryServer(serverName);
  };

  const handleAiInstalled = async (serverName: string): Promise<void> => {
    await retryServer(serverName);
    setShowConnectionWizard(false);
  };

  const serverGroups = useMemo<CardGroup<any>[]>(() => {
    if (groupMode === 'folder') return groupByFolder(
      filteredAndSortedServers,
      (s: any) => s.folder,
      t('mcp.server.ungrouped'),
    );
    if (groupMode === 'sort') return groupItems(filteredAndSortedServers, (s: any) => {
      const group = deriveServerSortGroup(s, sortOption);
      if (group.key === 'status:connected') return { ...group, label: t('mcp.status.connected') };
      if (group.key === 'status:error') return { ...group, label: t('mcp.status.error') };
      if (group.key === 'status:auth') return { ...group, label: t('mcp.server.requiresAuth') };
      if (group.key === 'status:disconnected') return { ...group, label: t('mcp.status.disconnected') };
      if (group.key === 'transport:stdio') return { ...group, label: t('mcp.server.transport.stdio') };
      if (group.key === 'transport:websocket') return { ...group, label: t('mcp.server.transport.websocket') };
      if (group.key === 'transport:sse') return { ...group, label: t('mcp.server.transport.sse') };
      if (group.key === 'transport:streamable') return { ...group, label: t('mcp.server.transport.streamable') };
      return group;
    });
    return [];
  }, [groupMode, filteredAndSortedServers, sortOption, t]);

  const toggleCollapsed = (key: string) => {
    setCollapsedList((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  };

  const handleGroupChange = (mode: GroupMode) => {
    setGroupMode(mode);
    setGroupAnchorEl(null);
  };

  // Bulk action handlers
  const handleBulkEnable = async () => {
    log.debug('Bulk enabling servers', { selectedServers: Array.from(selectedServers) });
    const promises = Array.from(selectedServers).map(serverName => 
      handleServerToggle(serverName, true)
    );
    await Promise.all(promises);
    setSelectedServers(new Set());
    setBulkActionDialog({open: false, action: null});
  };

  const handleBulkDisable = async () => {
    log.debug('Bulk disabling servers', { selectedServers: Array.from(selectedServers) });
    const promises = Array.from(selectedServers).map(serverName => 
      handleServerToggle(serverName, false)
    );
    await Promise.all(promises);
    setSelectedServers(new Set());
    setBulkActionDialog({open: false, action: null});
  };

  const handleSelectAll = () => {
    if (selectedServers.size === filteredAndSortedServers.length) {
      setSelectedServers(new Set());
    } else {
      setSelectedServers(new Set(filteredAndSortedServers.map(s => s.name)));
    }
  };

  const handleServerSelect = (serverName: string, selected: boolean) => {
    const newSelection = new Set(selectedServers);
    if (selected) {
      newSelection.add(serverName);
    } else {
      newSelection.delete(serverName);
    }
    setSelectedServers(newSelection);
  };

  // Sort menu handlers
  const handleSortMenuOpen = (event: React.MouseEvent<HTMLElement>) => {
    setSortAnchorEl(event.currentTarget);
  };

  const handleSortMenuClose = () => {
    setSortAnchorEl(null);
  };

  const handleSortChange = (option: ServerSortOption) => {
    setSortOption(option);
    handleSortMenuClose();
  };

  // Render the server list for a subset (whole list or one collapsible group).
  const renderServers = (items: any[]) => (
    <ServerList
      servers={items.map((server: any) => ({
        ...server,
        tools: [] // Add empty tools array to match the ServerList interface
      }))}
      isLoading={isLoading}
      loadError={loadError}
      onServerSelect={handleOpenDetails}
      onServerToggle={handleServerToggle}
      onServerRetry={handleServerRetry}
      onServerDelete={handleServerDelete}
      onServerEdit={handleEditServer}
      selectionMode={selectionMode}
      selectedServers={selectedServers}
      onServerSelectionChange={handleServerSelect}
      updates={updates}
      onServerUpdated={handleServerUpdated}
      folders={folders}
      onServerSetFolder={setServerFolder}
      onServerToggleFavorite={setServerFavorite}
    />
  );

  return (
    <Box sx={{ color: 'text.primary' }}>
      <PageHeader
        eyebrowKey="mcp.server.eyebrow"
        titleKey="mcp.server.title"
        descriptionKey="mcp.server.description"
        icon={HubRoundedIcon}
        actions={(
          <>
          <Button
            variant="outlined"
            color="primary"
            onClick={(e) => setImportMenuAnchor(e.currentTarget)}
            startIcon={<UploadIcon />}
            endIcon={<ArrowDropDownIcon />}
            sx={{
              textTransform: 'none',
              fontWeight: 500,
            }}
          >
            {t('mcp.server.import')}
          </Button>
          <Menu
            anchorEl={importMenuAnchor}
            open={Boolean(importMenuAnchor)}
            onClose={() => setImportMenuAnchor(null)}
          >
            {MCP_FORMATS.map((format) => (
              <MenuItem key={format.id} onClick={() => openImportDialog(format.id)}>
                <ListItemText primary={t('mcp.server.format', { name: format.label })} />
              </MenuItem>
            ))}
          </Menu>
          <Button
            variant="contained"
            color="primary"
            onClick={(e) => setExportMenuAnchor(e.currentTarget)}
            startIcon={<DownloadIcon />}
            endIcon={<ArrowDropDownIcon />}
            sx={{
              textTransform: 'none',
              fontWeight: 500,
              boxShadow: 1,
            }}
          >
            {t('mcp.server.export')}
          </Button>
          <Menu
            anchorEl={exportMenuAnchor}
            open={Boolean(exportMenuAnchor)}
            onClose={() => setExportMenuAnchor(null)}
          >
            {MCP_FORMATS.map((format) => (
              <MenuItem key={format.id} onClick={() => handleExportConfig(format.id)}>
                <ListItemText primary={t('mcp.server.format', { name: format.label })} />
              </MenuItem>
            ))}
          </Menu>
          <Button
            variant="contained"
            color="primary"
            data-tour="add-mcp-server"
            onClick={handleConnectApp}
            startIcon={<AddIcon />}
            sx={{
              textTransform: 'none',
              fontWeight: 500,
              boxShadow: 1,
            }}
          >
            {modern ? t('mcp.server.connectApp') : t('mcp.server.add')}
          </Button>
          </>
        )}
      />

      {/* Toolbar with search, sort, and bulk actions */}
      {/* #372: the outer spacing lives on the sticky wrapper (as padding rather
          than the Paper's margin) so the pinned strip stays fully opaque and
          scrolled cards cannot bleed through above/below the toolbar. */}
      <StickySearchBar mode="page" sx={{ pt: 3, pb: 1.5 }}>
      <Paper
        elevation={0}
        variant="outlined"
        sx={{ mx: { xs: 2, md: 3, lg: 4 }, p: 1.2, borderRadius: 3 }}
      >
        <Box sx={{ 
          display: 'flex', 
          flexDirection: { xs: 'column', sm: 'row' }, 
          gap: 1,
          alignItems: { xs: 'stretch', sm: 'center' },
          justifyContent: 'space-between'
        }}>
          {/* Search field */}
          <TextField
            placeholder={t('mcp.server.search')}
            variant="outlined"
            size="small"
            fullWidth
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            inputRef={searchInputRef}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            }}
            sx={{ maxWidth: { sm: 300 } }}
          />
          
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
            {/* Selection mode toggle */}
            <Button
              size="small"
              variant={selectionMode ? 'contained' : 'outlined'}
              onClick={() => {
                setSelectionMode(!selectionMode);
                if (selectionMode) {
                  setSelectedServers(new Set());
                }
              }}
              startIcon={<SelectAllIcon />}
            >
              {t('mcp.server.select')}
            </Button>
            
            {/* Bulk actions - only show when in selection mode */}
            {selectionMode && (
              <>
                <Button
                  size="small"
                  onClick={handleSelectAll}
                  disabled={filteredAndSortedServers.length === 0}
                >
                  {selectedServers.size === filteredAndSortedServers.length && selectedServers.size > 0
                    ? t('mcp.server.deselectAll')
                    : t('mcp.server.selectAll')}
                </Button>
                
                {selectedServers.size > 0 && (
                  <>
                    <Button
                      size="small"
                      variant="contained"
                      color="success"
                      onClick={() => setBulkActionDialog({open: true, action: 'enable'})}
                      startIcon={<PlayArrowIcon />}
                    >
                      {t('mcp.server.enableCount', { count: formatNumber(selectedServers.size) })}
                    </Button>
                    <Button
                      size="small"
                      variant="contained"
                      color="error"
                      onClick={() => setBulkActionDialog({open: true, action: 'disable'})}
                      startIcon={<StopIcon />}
                    >
                      {t('mcp.server.disableCount', { count: formatNumber(selectedServers.size) })}
                    </Button>
                  </>
                )}
              </>
            )}
            
            <Button
              size="small"
              aria-label={t('mcp.server.openApps')}
              onClick={() => setShowAppsDashboard(true)}
              color={showAppsDashboard ? 'primary' : 'inherit'}
              variant={showAppsDashboard ? 'contained' : 'outlined'}
              startIcon={<AppsIcon fontSize="small" />}
              sx={{ whiteSpace: 'nowrap', backgroundColor: showAppsDashboard ? undefined : theme.palette.background.default }}
            >
              {t('mcp.apps.title')}
            </Button>

            {/* Group-by button (#71 folders / #73 sort-fold) */}
            <IconButton
              size="small"
              onClick={(e) => setGroupAnchorEl(e.currentTarget)}
              color={groupMode !== 'none' ? 'primary' : 'default'}
              sx={{
                border: `1px solid ${theme.palette.divider}`,
                backgroundColor: theme.palette.background.default
              }}
              title={t('mcp.server.groupCards')}
              aria-label={t('mcp.server.groupCards')}
            >
              <LayersIcon fontSize="small" />
            </IconButton>

            {/* Sort button */}
            <IconButton 
              size="small" 
              onClick={handleSortMenuOpen}
              aria-label={t('mcp.server.sort')}
              sx={{ 
                border: `1px solid ${theme.palette.divider}`,
                backgroundColor: theme.palette.background.default
              }}
            >
              <SortIcon fontSize="small" />
            </IconButton>
          </Box>
        </Box>
      </Paper>
      </StickySearchBar>
      
      {/* Statistics bar */}
      <Box sx={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        mb: 2,
        px: 3
      }}>
        <Typography variant="body2" color="textSecondary">
          {tp('mcp.server.count', servers.length, {
            shown: formatNumber(filteredAndSortedServers.length),
            total: formatNumber(servers.length),
          })}
          {searchTerm && t('mcp.server.matching', { search: searchTerm })}
          {filterOption !== 'all' && t('mcp.server.filtered', { filter: filterLabel(filterOption) })}
        </Typography>
        
        <Typography variant="body2" color="textSecondary">
          {t('mcp.server.sortedBy', { sort: sortLabel(sortOption) })}
        </Typography>
      </Box>

      <Box ref={scrollRef} sx={{ px: 2, flex: 1, overflow: 'auto' }}>
        {groupMode === 'none' || isLoading || loadError || filteredAndSortedServers.length === 0 ? (
          renderServers(filteredAndSortedServers)
        ) : (
          serverGroups.map((group) => (
            <CollapsibleCardSection
              key={group.key}
              groupKey={group.key}
              label={group.label}
              count={group.items.length}
              expanded={!collapsedKeys.has(group.key)}
              onToggle={() => toggleCollapsed(group.key)}
              showFolderIcon={groupMode === 'folder'}
            >
              {renderServers(group.items)}
            </CollapsibleCardSection>
          ))
        )}
      </Box>

      {/* Group-by menu */}
      <Menu
        anchorEl={groupAnchorEl}
        open={Boolean(groupAnchorEl)}
        onClose={() => setGroupAnchorEl(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <MenuItem selected={groupMode === 'none'} onClick={() => handleGroupChange('none')}>
          <ListItemIcon><LayersClearIcon fontSize="small" /></ListItemIcon>
          <ListItemText primary={t('mcp.server.group.none')} />
        </MenuItem>
        <MenuItem selected={groupMode === 'folder'} onClick={() => handleGroupChange('folder')}>
          <ListItemIcon><FolderOutlinedIcon fontSize="small" /></ListItemIcon>
          <ListItemText primary={t('mcp.server.group.folder')} />
        </MenuItem>
        <MenuItem selected={groupMode === 'sort'} onClick={() => handleGroupChange('sort')}>
          <ListItemIcon><LayersIcon fontSize="small" /></ListItemIcon>
          <ListItemText primary={t('mcp.server.group.sort')} />
        </MenuItem>
      </Menu>

      {/* Sort menu */}
      <Menu
        anchorEl={sortAnchorEl}
        open={Boolean(sortAnchorEl)}
        onClose={handleSortMenuClose}
        anchorOrigin={{
          vertical: 'bottom',
          horizontal: 'right',
        }}
        transformOrigin={{
          vertical: 'top',
          horizontal: 'right',
        }}
      >
        <MenuItem onClick={() => handleSortChange('name-asc')}>
          <ListItemIcon>
            <SortByAlphaIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary={sortLabel('name-asc')} />
        </MenuItem>
        <MenuItem onClick={() => handleSortChange('name-desc')}>
          <ListItemIcon>
            <SortByAlphaIcon fontSize="small" sx={{ transform: 'scaleX(-1)' }} />
          </ListItemIcon>
          <ListItemText primary={sortLabel('name-desc')} />
        </MenuItem>
        <Divider />
        <MenuItem onClick={() => handleSortChange('status-connected')}>
          <ListItemIcon>
            <CheckCircleIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary={sortLabel('status-connected')} />
        </MenuItem>
        <MenuItem onClick={() => handleSortChange('status-disconnected')}>
          <ListItemIcon>
            <CancelIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary={sortLabel('status-disconnected')} />
        </MenuItem>
        <Divider />
        <MenuItem onClick={() => handleSortChange('transport')}>
          <ListItemIcon>
            <TerminalIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary={sortLabel('transport')} />
        </MenuItem>
      </Menu>

      {/* Bulk action confirmation dialog */}
      <Dialog
        open={bulkActionDialog.open}
        onClose={() => setBulkActionDialog({open: false, action: null})}
      >
        <DialogTitle>
          {bulkActionDialog.action === 'enable' ? t('mcp.server.enableTitle') : t('mcp.server.disableTitle')}
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            {bulkActionDialog.action === 'enable'
              ? tp('mcp.server.confirmEnable', selectedServers.size)
              : tp('mcp.server.confirmDisable', selectedServers.size)}
          </DialogContentText>
          <Box sx={{ mt: 2 }}>
            {Array.from(selectedServers).map(serverName => (
              <Typography key={serverName} variant="body2" sx={{ ml: 2 }}>
                • {serverName}
              </Typography>
            ))}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setBulkActionDialog({open: false, action: null})}>
            {t('mcp.server.cancel')}
          </Button>
          <Button 
            onClick={bulkActionDialog.action === 'enable' ? handleBulkEnable : handleBulkDisable}
            variant="contained"
            color={bulkActionDialog.action === 'enable' ? 'success' : 'error'}
          >
            {bulkActionDialog.action === 'enable' ? t('mcp.server.enable') : t('mcp.server.disable')}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Import-from-Claude-format dialog */}
      <Dialog
        open={showImportModal}
        onClose={handleCloseImport}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>{t('mcp.server.importTitle', { format: getMcpFormat(importFormat).label })}</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            {t('mcp.server.importHelp', {
              format: getMcpFormat(importFormat).label,
              example: '{ "mcpServers": { ... } }',
            })}
          </DialogContentText>
          <TextField
            multiline
            minRows={10}
            maxRows={20}
            fullWidth
            value={importText}
            onChange={(e) => {
              setImportText(e.target.value);
              if (importError) setImportError(null);
            }}
            placeholder={'{\n  "mcpServers": {\n    "my-server": {\n      "command": "npx",\n      "args": ["-y", "my-mcp-server"],\n      "env": { "API_KEY": "..." }\n    }\n  }\n}'}
            variant="outlined"
            spellCheck={false}
            InputProps={{ sx: { fontFamily: 'monospace', fontSize: '0.85rem' } }}
            disabled={isImporting}
          />
          {importError && (
            <DialogContentText
              component="pre"
              sx={{ mt: 2, color: 'error.main', whiteSpace: 'pre-wrap', fontSize: '0.85rem' }}
            >
              {importError}
            </DialogContentText>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCloseImport} disabled={isImporting}>
            {t('mcp.server.cancel')}
          </Button>
          <Button
            onClick={handleImportConfig}
            variant="contained"
            color="primary"
            disabled={isImporting || importText.trim() === ''}
            startIcon={<UploadIcon />}
          >
            {isImporting ? t('mcp.server.importing') : t('mcp.server.import')}
          </Button>
        </DialogActions>
      </Dialog>

      <ServerModal
        isOpen={showAddModal}
        onAdd={handleAddServer}
        onClose={() => {
          setShowAddModal(false);
          setEditingServer(null);
          onServerModalToggle?.(false);
        }}
        initialConfig={editingServer}
        initialTab={initialSetupTab}
        onUpdate={handleUpdateServer}
        onRestartAfterUpdate={handleServerRetry}
        onSaveAndAuthenticate={handleSaveAndAuthenticate}
      />

      {modern ? (
        <McpConnectionWizard
          open={showConnectionWizard}
          onClose={() => setShowConnectionWizard(false)}
          onChooseSetup={openServerSetup}
          onManualCreation={() => openServerSetup('spotlight')}
          onInstalled={handleAiInstalled}
          onAuthenticate={handleAiAuthenticate}
        />
      ) : null}

      <ServerDetailsModal
        server={detailsServer ? { name: detailsServer.name, status: detailsServer.status, env: detailsServer.env } : null}
        onClose={handleCloseDetails}
        onSaveEnv={saveEnv}
        onServerRestart={handleEnvRestart}
        toolPrefill={toolPrefill}
      />

      <McpAppsDashboard
        open={showAppsDashboard}
        onClose={() => {
          setShowAppsDashboard(false);
          setAppsSelection(null);
        }}
        initialSelection={appsSelection}
        onOpenToolTester={(serverName, toolName) => {
          setShowAppsDashboard(false);
          setToolPrefill({ toolName, arguments: {} });
          setDetailsServerName(serverName);
        }}
      />

      <ScrollNavCluster {...scrollNavProps} />
    </Box>
  );
};

export default ServerManager;
