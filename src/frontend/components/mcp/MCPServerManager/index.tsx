'use client';

import React, { useState, useMemo, useEffect } from 'react';
import ServerList from './ServerList';
import ServerModal from './Modals/ServerModal/index';
import ServerDetailsModal from './ServerDetailsModal';
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
  DialogActions
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
import CollapsibleCardSection from '@/frontend/components/shared/CollapsibleCardSection';
import { groupByFolder, groupItems, alphaBucket, collectFolders, CardGroup } from '@/utils/shared/cardGrouping';

const log = createLogger('frontend/components/mcp/MCPServerManager');

type SortOption = 'name-asc' | 'name-desc' | 'status-connected' | 'status-disconnected' | 'transport';
type FilterOption = 'all' | 'connected' | 'disconnected' | 'error' | 'enabled' | 'disabled' | 'stdio' | 'websocket' | 'sse' | 'streamable';
/** How server cards are folded into collapsible sections: off, by user folder (#71), or by the active sort key (#73). */
type GroupMode = 'none' | 'folder' | 'sort';

// Map the active sort key to a group bucket for a server (#73).
function deriveServerSortGroup(server: any, sortOption: SortOption): { key: string; label: string } {
  switch (sortOption) {
    case 'name-asc':
    case 'name-desc':
      return alphaBucket(server.name);
    case 'status-connected':
    case 'status-disconnected': {
      const s = server.status;
      if (s === 'connected') return { key: 'status:connected', label: 'Connected' };
      if (s === 'error') return { key: 'status:error', label: 'Error' };
      if (s === 'requires_authentication') return { key: 'status:auth', label: 'Requires authentication' };
      return { key: 'status:disconnected', label: 'Disconnected' };
    }
    case 'transport': {
      const t = server.transport || 'unknown';
      const labelMap: Record<string, string> = { stdio: 'Stdio', websocket: 'WebSocket', sse: 'SSE', streamable: 'Streamable HTTP' };
      return { key: `transport:${t}`, label: labelMap[t] || t };
    }
    default:
      return { key: 'all', label: 'All servers' };
  }
}

interface ServerManagerProps {
  // Optional: notified when the add/edit modal opens/closes (kept for callers that care).
  onServerModalToggle?: (isOpen: boolean) => void;
}

const ServerManager: React.FC<ServerManagerProps> = ({ onServerModalToggle }) => {
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
    saveEnv
  } = useServerStatus();

  const [showAddModal, setShowAddModal] = useState(false);
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
  };

  const handleCloseDetails = () => {
    const name = detailsServerName;
    setDetailsServerName(null);
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
  
  // Toolbar state
  const [searchTerm, setSearchTerm] = useState('');
  const [sortOption, setSortOption] = useState<SortOption>('name-asc');
  const [filterOption, setFilterOption] = useState<FilterOption>('all');
  const [sortAnchorEl, setSortAnchorEl] = useState<null | HTMLElement>(null);
  const [groupMode, setGroupMode] = useState<GroupMode>('none');
  const [groupAnchorEl, setGroupAnchorEl] = useState<null | HTMLElement>(null);
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedServers, setSelectedServers] = useState<Set<string>>(new Set());
  const [bulkActionDialog, setBulkActionDialog] = useState<{open: boolean; action: 'enable' | 'disable' | null}>({open: false, action: null});
  
  const theme = useTheme();

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
          : 'No servers found in the pasted configuration.'
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
        failures.push(`"${config.name}": ${(e as Error).message || 'failed to import'}`);
      }
    }

    setIsImporting(false);

    const allProblems = [...errors, ...failures];
    if (added === 0 && updated === 0) {
      setImportError(
        allProblems.length > 0 ? allProblems.join('\n') : 'No servers could be imported.'
      );
      return;
    }

    // Some succeeded — close the dialog. Keep partial errors visible if any.
    log.info(`Imported MCP servers: ${added} added, ${updated} updated`);
    if (allProblems.length > 0) {
      setImportError(
        `Imported ${added} added / ${updated} updated. Some entries were skipped:\n${allProblems.join('\n')}`
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
    
    // Finally sort
    return [...result].sort((a, b) => {
      switch (sortOption) {
        case 'name-asc':
          return a.name.localeCompare(b.name);
        case 'name-desc':
          return b.name.localeCompare(a.name);
        case 'status-connected':
          if (a.status === 'connected' && b.status !== 'connected') return -1;
          if (a.status !== 'connected' && b.status === 'connected') return 1;
          return a.name.localeCompare(b.name);
        case 'status-disconnected':
          if (a.status === 'disconnected' && b.status !== 'disconnected') return -1;
          if (a.status !== 'disconnected' && b.status === 'disconnected') return 1;
          return a.name.localeCompare(b.name);
        case 'transport':
          const transportOrder = ['stdio', 'websocket', 'sse', 'streamable'];
          const aIndex = transportOrder.indexOf(a.transport);
          const bIndex = transportOrder.indexOf(b.transport);
          if (aIndex !== bIndex) return aIndex - bIndex;
          return a.name.localeCompare(b.name);
        default:
          return 0;
      }
    });
  }, [servers, searchTerm, sortOption, filterOption]);

  // Distinct folders currently in use, for the "Move to folder" picker (#71).
  const folders = useMemo(() => collectFolders(servers, (s: any) => s.folder), [servers]);

  // Grouped view of the filtered/sorted servers, driven by the active group mode.
  const serverGroups = useMemo<CardGroup<any>[]>(() => {
    if (groupMode === 'folder') return groupByFolder(filteredAndSortedServers, (s: any) => s.folder);
    if (groupMode === 'sort') return groupItems(filteredAndSortedServers, (s: any) => deriveServerSortGroup(s, sortOption));
    return [];
  }, [groupMode, filteredAndSortedServers, sortOption]);

  const toggleCollapsed = (key: string) => {
    setCollapsedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
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

  const handleSortChange = (option: SortOption) => {
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
    />
  );

  return (
    <Box sx={{ color: 'text.primary' }}>
      <Box
        sx={{
          p: 2,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        <Typography variant="h5">MCP</Typography>
        <Box sx={{ display: 'flex', gap: 1 }}>
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
            Import
          </Button>
          <Menu
            anchorEl={importMenuAnchor}
            open={Boolean(importMenuAnchor)}
            onClose={() => setImportMenuAnchor(null)}
          >
            {MCP_FORMATS.map((format) => (
              <MenuItem key={format.id} onClick={() => openImportDialog(format.id)}>
                <ListItemText primary={`${format.label} format`} />
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
            Export
          </Button>
          <Menu
            anchorEl={exportMenuAnchor}
            open={Boolean(exportMenuAnchor)}
            onClose={() => setExportMenuAnchor(null)}
          >
            {MCP_FORMATS.map((format) => (
              <MenuItem key={format.id} onClick={() => handleExportConfig(format.id)}>
                <ListItemText primary={`${format.label} format`} />
              </MenuItem>
            ))}
          </Menu>
          <Button
            variant="contained"
            color="primary"
            data-tour="add-mcp-server"
            onClick={() => {
              // Ensure editing server is null when adding a new server
              setEditingServer(null);
              setShowAddModal(true);
              onServerModalToggle?.(true);
            }}
            startIcon={<AddIcon />}
            sx={{
              textTransform: 'none',
              fontWeight: 500,
              boxShadow: 1,
            }}
          >
            Add Server
          </Button>
        </Box>
      </Box>

      {/* Toolbar with search, sort, and bulk actions */}
      <Paper elevation={1} sx={{ m: 2, mb: 1, p: 1 }}>
        <Box sx={{ 
          display: 'flex', 
          flexDirection: { xs: 'column', sm: 'row' }, 
          gap: 1,
          alignItems: { xs: 'stretch', sm: 'center' },
          justifyContent: 'space-between'
        }}>
          {/* Search field */}
          <TextField
            placeholder="Search servers..."
            variant="outlined"
            size="small"
            fullWidth
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
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
              Select
            </Button>
            
            {/* Bulk actions - only show when in selection mode */}
            {selectionMode && (
              <>
                <Button
                  size="small"
                  onClick={handleSelectAll}
                  disabled={filteredAndSortedServers.length === 0}
                >
                  {selectedServers.size === filteredAndSortedServers.length ? 'Deselect All' : 'Select All'}
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
                      Enable ({selectedServers.size})
                    </Button>
                    <Button
                      size="small"
                      variant="contained"
                      color="error"
                      onClick={() => setBulkActionDialog({open: true, action: 'disable'})}
                      startIcon={<StopIcon />}
                    >
                      Disable ({selectedServers.size})
                    </Button>
                  </>
                )}
              </>
            )}
            
            {/* Group-by button (#71 folders / #73 sort-fold) */}
            <IconButton
              size="small"
              onClick={(e) => setGroupAnchorEl(e.currentTarget)}
              color={groupMode !== 'none' ? 'primary' : 'default'}
              sx={{
                border: `1px solid ${theme.palette.divider}`,
                backgroundColor: theme.palette.background.default
              }}
              title="Group cards"
            >
              <LayersIcon fontSize="small" />
            </IconButton>

            {/* Sort button */}
            <IconButton 
              size="small" 
              onClick={handleSortMenuOpen}
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
      
      {/* Statistics bar */}
      <Box sx={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        mb: 2,
        px: 3
      }}>
        <Typography variant="body2" color="textSecondary">
          {filteredAndSortedServers.length} of {servers.length} servers
          {searchTerm && ` matching "${searchTerm}"`}
          {filterOption !== 'all' && ` (filtered by ${filterOption})`}
        </Typography>
        
        <Typography variant="body2" color="textSecondary">
          Sorted by: {
            sortOption === 'name-asc' ? 'Name (A-Z)' :
            sortOption === 'name-desc' ? 'Name (Z-A)' :
            sortOption === 'status-connected' ? 'Connected first' :
            sortOption === 'status-disconnected' ? 'Disconnected first' :
            'Transport type'
          }
        </Typography>
      </Box>

      <Box sx={{ px: 2, flex: 1, overflow: 'auto' }}>
        {groupMode === 'none' || isLoading || loadError || filteredAndSortedServers.length === 0 ? (
          renderServers(filteredAndSortedServers)
        ) : (
          serverGroups.map((group) => (
            <CollapsibleCardSection
              key={group.key}
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
          <ListItemText primary="No grouping" />
        </MenuItem>
        <MenuItem selected={groupMode === 'folder'} onClick={() => handleGroupChange('folder')}>
          <ListItemIcon><FolderOutlinedIcon fontSize="small" /></ListItemIcon>
          <ListItemText primary="By folder" />
        </MenuItem>
        <MenuItem selected={groupMode === 'sort'} onClick={() => handleGroupChange('sort')}>
          <ListItemIcon><LayersIcon fontSize="small" /></ListItemIcon>
          <ListItemText primary="By sort setting" />
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
          <ListItemText primary="Name (A-Z)" />
        </MenuItem>
        <MenuItem onClick={() => handleSortChange('name-desc')}>
          <ListItemIcon>
            <SortByAlphaIcon fontSize="small" sx={{ transform: 'scaleX(-1)' }} />
          </ListItemIcon>
          <ListItemText primary="Name (Z-A)" />
        </MenuItem>
        <Divider />
        <MenuItem onClick={() => handleSortChange('status-connected')}>
          <ListItemIcon>
            <CheckCircleIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary="Connected first" />
        </MenuItem>
        <MenuItem onClick={() => handleSortChange('status-disconnected')}>
          <ListItemIcon>
            <CancelIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary="Disconnected first" />
        </MenuItem>
        <Divider />
        <MenuItem onClick={() => handleSortChange('transport')}>
          <ListItemIcon>
            <TerminalIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary="Transport type" />
        </MenuItem>
      </Menu>

      {/* Bulk action confirmation dialog */}
      <Dialog
        open={bulkActionDialog.open}
        onClose={() => setBulkActionDialog({open: false, action: null})}
      >
        <DialogTitle>
          {bulkActionDialog.action === 'enable' ? 'Enable Servers' : 'Disable Servers'}
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            Are you sure you want to {bulkActionDialog.action} {selectedServers.size} server{selectedServers.size > 1 ? 's' : ''}?
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
            Cancel
          </Button>
          <Button 
            onClick={bulkActionDialog.action === 'enable' ? handleBulkEnable : handleBulkDisable}
            variant="contained"
            color={bulkActionDialog.action === 'enable' ? 'success' : 'error'}
          >
            {bulkActionDialog.action === 'enable' ? 'Enable' : 'Disable'}
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
        <DialogTitle>Import MCP Servers — {getMcpFormat(importFormat).label} format</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            Paste a {getMcpFormat(importFormat).label}-style MCP configuration (the{' '}
            <code>{'{ "mcpServers": { ... } }'}</code> JSON). FLUJO adds each server, preserving
            commands, args, environment variables, URLs and custom headers. A server whose name
            already exists is updated.
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
            Cancel
          </Button>
          <Button
            onClick={handleImportConfig}
            variant="contained"
            color="primary"
            disabled={isImporting || importText.trim() === ''}
            startIcon={<UploadIcon />}
          >
            {isImporting ? 'Importing...' : 'Import'}
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
        onUpdate={handleUpdateServer}
        onRestartAfterUpdate={handleServerRetry}
      />

      <ServerDetailsModal
        server={detailsServer ? { name: detailsServer.name, status: detailsServer.status, env: detailsServer.env } : null}
        onClose={handleCloseDetails}
        onSaveEnv={saveEnv}
        onServerRestart={handleEnvRestart}
      />
    </Box>
  );
};

export default ServerManager;
