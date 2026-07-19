'use client';

import React, { useState, useEffect } from 'react';
import { createLogger } from '@/utils/logger';
import { useThemeUtils } from '@/frontend/utils/theme';

const log = createLogger('frontend/components/mcp/MCPServerManager/ServerCard');
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import ErrorIcon from '@mui/icons-material/Error';
import RefreshIcon from '@mui/icons-material/Refresh';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import LockIcon from '@mui/icons-material/Lock';
import LoginIcon from '@mui/icons-material/Login';
import KeyOffIcon from '@mui/icons-material/KeyOff';
import PublicIcon from '@mui/icons-material/Public';
import WidgetsIcon from '@mui/icons-material/Widgets';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DataObjectIcon from '@mui/icons-material/DataObject';
import DriveFileMoveOutlinedIcon from '@mui/icons-material/DriveFileMoveOutlined';
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt';
import StarIcon from '@mui/icons-material/Star';
import StarBorderIcon from '@mui/icons-material/StarBorder';
import Spinner from '@/frontend/components/shared/Spinner';
import FolderAssignMenu from '@/frontend/components/shared/FolderAssignMenu';
import { mcpService } from '@/frontend/services/mcp';
import { MCPServerConfig } from '@/shared/types/mcp';
import { buildSingleServerJson } from '@/utils/mcp/mcpFormats';
import TransportBadge from './TransportBadge';
import ServerUpdateDialog from './ServerUpdateDialog';
import { ServerUpdateInfo, shortSha } from './utils/serverUpdates';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import {
  Switch,
  Typography,
  IconButton,
  Tooltip,
  useTheme,
  alpha,
  Card,
  CardContent,
  CardActions,
  Box,
  Checkbox,
  Chip
} from '@mui/material';

interface ServerCardProps {
  name: string;
  status: 'connected' | 'disconnected' | 'error' | 'connecting' | 'initialization' | 'requires_authentication';
  path: string;
  enabled: boolean;
  transport: 'stdio' | 'websocket' | 'sse' | 'streamable';
  onToggle?: (enabled: boolean) => void;
  onRetry?: () => void;
  onDelete?: () => void;
  onClick: () => void;
  onEdit?: () => void;
  onAuthenticate?: () => void; // OAuth authentication handler
  /**
   * When true, the card is used purely to *pick* a server (#92): the whole
   * card is a single click target (via onClick), and all mutating controls
   * (enable toggle, retry, edit, delete, expose, authenticate) are hidden so
   * the picker reuses the management card body without side effects.
   */
  pickerMode?: boolean;
  error?: string; // Optional error message
  stderrOutput?: string; // Optional stderr output
  authorizationUrl?: string; // OAuth authorization URL
  selected?: boolean; // For bulk selection
  onSelect?: (selected: boolean) => void; // For bulk selection
  selectionMode?: boolean; // Whether selection mode is active
  hasOAuthTokens?: boolean; // Whether the server has OAuth tokens that can be reset
  exposeAsMcpServer?: boolean; // Whether this server is re-exposed at /mcp-proxy/<name> (#17A)
  enableMcpApps?: boolean; // Whether this server may render interactive ui:// UI resources in chat (#97)
  updateInfo?: ServerUpdateInfo; // Git update status for locally cloned servers
  installCommand?: string; // Stored install command, re-run after a git update
  buildCommand?: string; // Stored build command, re-run after a git update
  onUpdated?: () => void; // Called after a successful git update
  folder?: string; // Organizing folder (#71)
  folders?: string[]; // Existing folders on the surface, for the picker
  onSetFolder?: (folder: string | undefined) => void; // Assign/clear folder
  favorite?: boolean; // Favorite flag (#146): floats the card to the top
  onToggleFavorite?: () => void; // Toggle favorite. When omitted the star is hidden.
  builtIn?: boolean; // FLUJO's built-in internal server: not editable/deletable, always on
  /**
   * Full server config, used to build a single-server, copy-to-clipboard MCP
   * JSON via the shared exporter (#110). Optional: when absent the copy-JSON
   * button falls back to the proxy-only shape derived from `name`.
   */
  serverConfig?: MCPServerConfig;
}

const ServerCard: React.FC<ServerCardProps> = ({
  name,
  status,
  path,
  enabled,
  transport,
  onToggle = () => {},
  onRetry = () => {},
  onDelete = () => {},
  onClick,
  onEdit = () => {},
  onAuthenticate,
  pickerMode = false,
  error,
  stderrOutput,
  authorizationUrl,
  selected = false,
  onSelect,
  selectionMode = false,
  hasOAuthTokens = false,
  exposeAsMcpServer = false,
  enableMcpApps = false,
  updateInfo,
  installCommand,
  buildCommand,
  onUpdated,
  folder,
  folders = [],
  onSetFolder,
  favorite = false,
  onToggleFavorite,
  builtIn = false,
  serverConfig,
}) => {
  const [showErrorModal, setShowErrorModal] = useState(false);
  const [folderAnchorEl, setFolderAnchorEl] = useState<null | HTMLElement>(null);
  const [showUpdateDialog, setShowUpdateDialog] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  const [toastSeverity, setToastSeverity] = useState<'success' | 'error'>('success');
  const [isPolling, setIsPolling] = useState(false);
  const [isResettingTokens, setIsResettingTokens] = useState(false);
  // Local optimistic state for the "expose as MCP server" toggle (#17A).
  const [exposed, setExposed] = useState(exposeAsMcpServer);
  // Local optimistic state for the "MCP Apps" opt-in toggle (#97).
  const [appsEnabled, setAppsEnabled] = useState(enableMcpApps);
  const muiTheme = useTheme();

  // Keep the toggle in sync if the parent reloads configs.
  useEffect(() => {
    setExposed(exposeAsMcpServer);
  }, [exposeAsMcpServer]);

  useEffect(() => {
    setAppsEnabled(enableMcpApps);
  }, [enableMcpApps]);

  // The URL external MCP clients paste in. Only meaningful in the browser.
  const proxyUrl =
    typeof window !== 'undefined' ? `${window.location.origin}/mcp-proxy/${encodeURIComponent(name)}` : '';

  const handleToggleExpose = async (checked: boolean) => {
    setExposed(checked); // optimistic
    const result = await mcpService.updateServerConfig(name, { exposeAsMcpServer: checked });
    if ('success' in result && result.success) {
      setToastMessage(
        checked ? 'Server is now exposed to external apps.' : 'Server is no longer exposed.',
      );
      setToastSeverity('success');
    } else {
      setExposed(!checked); // revert
      setToastMessage('Failed to update exposure setting.');
      setToastSeverity('error');
    }
    setShowToast(true);
  };

  const handleToggleApps = async (checked: boolean) => {
    setAppsEnabled(checked); // optimistic
    const result = await mcpService.updateServerConfig(name, { enableMcpApps: checked });
    if ('success' in result && result.success) {
      setToastMessage(
        checked
          ? 'This server may now render interactive apps in chat (sandboxed).'
          : 'Interactive apps disabled for this server.',
      );
      setToastSeverity('success');
    } else {
      setAppsEnabled(!checked); // revert
      setToastMessage('Failed to update the MCP Apps setting.');
      setToastSeverity('error');
    }
    setShowToast(true);
  };

  const handleCopyProxyUrl = () => {
    navigator.clipboard.writeText(proxyUrl);
    setToastMessage('Endpoint URL copied to clipboard.');
    setToastSeverity('success');
    setShowToast(true);
  };

  // Copy a ready-to-paste, single-server MCP config JSON to the clipboard (#110).
  // Scoped to the exposed/built-in blocks, whose exported shape is proxy-only
  // (`{ type:'http', url }`) — so no env vars, headers or secrets ever leak.
  const handleCopyServerJson = () => {
    const base = typeof window !== 'undefined' ? window.location.origin : '';
    navigator.clipboard.writeText(buildSingleServerJson(name, serverConfig, base));
    setToastMessage('Server JSON copied to clipboard.');
    setToastSeverity('success');
    setShowToast(true);
  };
  
  const statusColor = {
    connected: 'success.main',
    disconnected: 'text.secondary',
    error: 'error.main',
    connecting: 'info.main',
    initialization: 'info.main',
    requires_authentication: 'warning.main',
  }[status];
  
  // Poll for status updates when server is connecting or initializing
  useEffect(() => {
    if ((status === 'connecting' || status === 'initialization') && enabled && !pickerMode) {
      setIsPolling(true);
      const timer = setTimeout(() => {
        log.debug(`Polling status for server: ${name}`);
        onRetry();
      }, 2000);
      
      return () => {
        clearTimeout(timer);
        setIsPolling(false);
      };
    } else if (status !== 'connecting' && status !== 'initialization') {
      setIsPolling(false);
    }
  }, [status, enabled, name, onRetry]);
  
  // Reference to store the timeout ID
  const [retryTimeoutId, setRetryTimeoutId] = useState<ReturnType<typeof setTimeout> | null>(null);
  
  // Clear the timeout when component unmounts or when status changes
  useEffect(() => {
    return () => {
      if (retryTimeoutId) {
        clearTimeout(retryTimeoutId);
      }
    };
  }, [retryTimeoutId]);
  
  // Handle retry button click
  const handleRetryClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    log.debug(`Retry button clicked for server: ${name}`);
    
    // Clear any existing timeout
    if (retryTimeoutId) {
      clearTimeout(retryTimeoutId);
    }
    
    // Set polling immediately to show spinner right away
    setIsPolling(true);
    
    // Then call the retry function
    onRetry();
    
    // If status doesn't change to 'connecting' or 'initialization' within 10 seconds, stop showing spinner
    const timeoutId = setTimeout(() => {
      if (status !== 'connecting' && status !== 'initialization') {
        setIsPolling(false);
      }
      setRetryTimeoutId(null);
    }, 10000);
    
    // Store the timeout ID
    setRetryTimeoutId(timeoutId);
  };

  // Handle reset OAuth tokens button click
  const handleResetOAuthTokens = async (e: React.MouseEvent) => {
    e.stopPropagation();
    log.debug(`Reset OAuth tokens button clicked for server: ${name}`);
    
    setIsResettingTokens(true);
    
    try {
      const response = await fetch('/api/oauth/reset', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ serverName: name }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to reset OAuth tokens');
      }

      const result = await response.json();
      log.info(`OAuth tokens reset successfully for ${name}`, result);
      
      setToastMessage('OAuth tokens reset successfully. Server will require re-authentication.');
      setToastSeverity('success');
      setShowToast(true);
      
      // Trigger a retry to update the server status
      setTimeout(() => {
        onRetry();
      }, 500);
      
    } catch (error) {
      log.error(`Failed to reset OAuth tokens for ${name}`, error);
      setToastMessage(`Failed to reset OAuth tokens: ${error instanceof Error ? error.message : 'Unknown error'}`);
      setToastSeverity('error');
      setShowToast(true);
    } finally {
      setIsResettingTokens(false);
    }
  };

  const { getThemeValue, getThemeColor, colors } = useThemeUtils();
  
  // Extract restart logic into a reusable function
  const handleServerRestart = () => {
    log.debug(`Server restart initiated for: ${name}`);
    
    // Disable the server
    onToggle(false);
    
    // Wait a short time for the disconnect to complete
    setTimeout(() => {
      // Enable the server
      onToggle(true);
      log.info(`Server ${name} restarted`);
    }, 1000);
  };
  
  return (
    <Card 
      role={pickerMode ? 'button' : undefined}
      aria-pressed={pickerMode ? selected : undefined}
      sx={{ 
        cursor: 'pointer',
        position: 'relative',
        height: pickerMode ? '100%' : undefined,
        transition: 'box-shadow 0.3s ease, border-color 0.12s ease',
        border: (theme) =>
          pickerMode && selected ? `2px solid ${theme.palette.primary.main}` : '2px solid transparent',
        '&:hover': {
          boxShadow: 3
        }
      }}
      onClick={() => {
        log.debug(`Server card clicked: ${name}`);
        onClick();
      }}
    >
      {/* Favorite star (#146): mirrors FlowCard — top-left, warning color when
          active. Hidden for the built-in server (its config is never persisted). */}
      {onToggleFavorite && !builtIn && (
        <Tooltip title={favorite ? 'Remove from favorites' : 'Add to favorites'} arrow placement="top">
          <IconButton
            size="small"
            aria-label={favorite ? 'remove from favorites' : 'add to favorites'}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite();
            }}
            sx={{
              position: 'absolute',
              top: 4,
              left: 4,
              zIndex: 2,
              color: favorite ? muiTheme.palette.warning.main : muiTheme.palette.text.secondary,
              backgroundColor: alpha(muiTheme.palette.background.paper, 0.6),
              '&:hover': { backgroundColor: alpha(muiTheme.palette.background.paper, 0.9) },
            }}
          >
            {favorite ? <StarIcon fontSize="small" /> : <StarBorderIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
      )}
      <CardContent sx={{ pb: 1 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', flex: 1 }}>
            {selectionMode && onSelect && (
              <Checkbox
                checked={selected}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => onSelect(e.target.checked)}
                size="small"
                sx={{ mr: 1, p: 0.5 }}
              />
            )}
            <Typography variant="h6" component="h3" sx={{ flex: 1 }}>
              {name}
            </Typography>
          </Box>
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 0.5 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              {updateInfo?.updateAvailable && (
                <Tooltip
                  title={`Update available: ${shortSha(updateInfo.localSha)} → ${shortSha(updateInfo.remoteSha)}. Click to update.`}
                >
                  <Chip
                    icon={<SystemUpdateAltIcon />}
                    label="Update"
                    color="warning"
                    size="small"
                    onClick={(e) => {
                      e.stopPropagation();
                      log.debug(`Update badge clicked for server: ${name}`);
                      setShowUpdateDialog(true);
                    }}
                  />
                </Tooltip>
              )}
              {builtIn ? (
                <Tooltip title="FLUJO's built-in server — can be enabled or disabled below, but not edited or removed.">
                  <Chip label="Built-in" color="primary" size="small" />
                </Tooltip>
              ) : (
                <TransportBadge transport={transport} size="small" />
              )}
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center' }}>
              {status === 'connected' && <CheckCircleIcon color="success" sx={{ mr: 0.5 }} fontSize="small" />}
              {status === 'disconnected' && <CancelIcon color="action" sx={{ mr: 0.5 }} fontSize="small" />}
              {status === 'error' && <ErrorIcon color="error" sx={{ mr: 0.5 }} fontSize="small" />}
              {status === 'requires_authentication' && <LockIcon color="warning" sx={{ mr: 0.5 }} fontSize="small" />}
              {(status === 'connecting' || status === 'initialization') && <Spinner size="small" color="primary" sx={{ mr: 0.5 }} />}
              <Typography variant="body2" color={statusColor}>
                {status === 'requires_authentication' ? 'Requires Authentication' : status}
              </Typography>
            </Box>
          </Box>
        </Box>
        
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ mb: 1, fontSize: '0.875rem' }}
          noWrap
          title={builtIn ? undefined : path}
        >
          {builtIn ? "FLUJO's own backend API — flow authoring, execution and server management as MCP tools." : path}
        </Typography>

        {/* Built-in server: always exposed at its proxy endpoint — read-only URL, no toggle */}
        {builtIn && !pickerMode && (
          <Box sx={{ mt: 1, mb: 1, p: 1, borderRadius: 1, border: '1px solid', borderColor: 'divider' }} onClick={(e) => e.stopPropagation()}>
            <Box sx={{ display: 'flex', alignItems: 'center' }}>
              <PublicIcon fontSize="small" sx={{ mr: 0.5, color: 'primary.main' }} />
              <Tooltip title="External MCP clients (Claude Code, Claude Desktop, Cursor, …) can drive FLUJO through this local endpoint.">
                <Typography variant="body2" sx={{ fontWeight: 500 }}>
                  Exposed to external apps
                </Typography>
              </Tooltip>
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', mt: 0.5 }}>
              <Typography
                variant="caption"
                sx={{ flex: 1, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={proxyUrl}
              >
                {proxyUrl}
              </Typography>
              <Tooltip title="Copy endpoint URL">
                <IconButton size="small" onClick={handleCopyProxyUrl}>
                  <ContentCopyIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title="Copy MCP server JSON">
                <IconButton size="small" onClick={handleCopyServerJson}>
                  <DataObjectIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Box>
          </Box>
        )}

        {/* Expose to external apps (#17A) */}
        {!builtIn && !pickerMode && (
        <Box
          sx={{ mt: 1, mb: 1, p: 1, borderRadius: 1, border: '1px solid', borderColor: 'divider' }}
          onClick={(e) => e.stopPropagation()}
        >
          <Box sx={{ display: 'flex', alignItems: 'center' }}>
            <PublicIcon fontSize="small" sx={{ mr: 0.5, color: exposed ? 'primary.main' : 'text.disabled' }} />
            <Switch
              checked={exposed}
              onChange={(e) => handleToggleExpose(e.target.checked)}
              size="small"
            />
            <Tooltip title="Re-expose this server's tools to external MCP clients (Claude Desktop, Cursor, …) at a local URL.">
              <Typography variant="body2" sx={{ fontWeight: 500 }}>
                Expose to external apps
              </Typography>
            </Tooltip>
          </Box>
          {exposed && (
            <Box sx={{ display: 'flex', alignItems: 'center', mt: 0.5 }}>
              <Typography
                variant="caption"
                sx={{ flex: 1, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={proxyUrl}
              >
                {proxyUrl}
              </Typography>
              <Tooltip title="Copy endpoint URL">
                <IconButton size="small" onClick={handleCopyProxyUrl}>
                  <ContentCopyIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title="Copy MCP server JSON">
                <IconButton size="small" onClick={handleCopyServerJson}>
                  <DataObjectIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Box>
          )}
        </Box>
        )}

        {/* MCP Apps opt-in (#97): let this server render interactive ui:// UI
            resources in chat, read-only and sandboxed. Off by default. */}
        {!builtIn && !pickerMode && (
        <Box
          sx={{ mt: 1, mb: 1, p: 1, borderRadius: 1, border: '1px solid', borderColor: 'divider' }}
          onClick={(e) => e.stopPropagation()}
        >
          <Box sx={{ display: 'flex', alignItems: 'center' }}>
            <WidgetsIcon fontSize="small" sx={{ mr: 0.5, color: appsEnabled ? 'primary.main' : 'text.disabled' }} />
            <Switch
              checked={appsEnabled}
              onChange={(e) => handleToggleApps(e.target.checked)}
              size="small"
            />
            <Tooltip title="Allow this server's tools to render interactive apps (MCP Apps / ui:// resources) in chat. Rendered read-only in a strict sandbox. Only enable for servers you trust.">
              <Typography variant="body2" sx={{ fontWeight: 500 }}>
                Render interactive apps
              </Typography>
            </Tooltip>
          </Box>
        </Box>
        )}

        {status === 'error' && (
          <Box sx={{ mt: 1, mb: 1 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.5 }}>
              <Typography variant="body2" fontWeight="medium" color="error">
                Error:
              </Typography>
              <Button 
                size="small"
                color="primary"
                onClick={(e) => {
                  e.stopPropagation();
                  log.debug(`View full error clicked for server: ${name}`);
                  setShowErrorModal(true);
                }}
              >
                View Full Error
              </Button>
            </Box>
            <Box sx={{ 
              maxHeight: '80px', 
              overflow: 'auto', 
              p: 1, 
              borderRadius: 1, 
              bgcolor: (theme) => getThemeColor('error.background'),
              color: (theme) => getThemeColor('error.text'),
              border: '1px solid',
              borderColor: (theme) => getThemeColor('error.border'),
              fontSize: '0.75rem',
              fontWeight: 500,
              whiteSpace: 'pre-wrap'
            }}>
              {error || 'Unknown error'}
            </Box>
          </Box>
        )}

        {status === 'requires_authentication' && !pickerMode && (
          <Box sx={{ mt: 1, mb: 1 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
              <Typography variant="body2" fontWeight="medium" color="warning.main">
                Authentication Required
              </Typography>
            </Box>
            <Button
              variant="contained"
              color="warning"
              size="small"
              startIcon={<LoginIcon />}
              onClick={async (e) => {
                e.stopPropagation();
                log.debug(`Authenticate button clicked for server: ${name}`);
                
                if (onAuthenticate) {
                  onAuthenticate();
                } else {
                  // Fallback: Call OAuth initiation API directly
                  try {
                    const response = await fetch('/api/oauth/initiate', {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                      },
                      body: JSON.stringify({ serverName: name }),
                    });

                    if (!response.ok) {
                      const errorData = await response.json();
                      throw new Error(errorData.error || 'Failed to initiate OAuth');
                    }

                    const { authorizationUrl, alreadyAuthorized } = await response.json();

                    if (alreadyAuthorized || !authorizationUrl) {
                      // The server already had a usable (or successfully refreshed) token -
                      // no popup needed, just refresh this card's status.
                      log.info(`Server ${name} already authorized, no popup needed`);
                      handleServerRestart();
                      return;
                    }

                    // Open OAuth popup
                    const { openOAuthPopup } = await import('@/frontend/utils/oauth');

                    await openOAuthPopup({
                      url: authorizationUrl,
                      windowName: `oauth_${name}`,
                      onSuccess: (result) => {
                        log.info(`OAuth authentication successful for ${name}`, result);
                        log.info(`Automatically restarting server ${name} after OAuth completion`);
                        // Restart the server to ensure it reconnects with new OAuth tokens
                        handleServerRestart();
                      },
                      onError: (error) => {
                        log.error(`OAuth authentication failed for ${name}`, error);
                        setToastMessage('OAuth authentication failed');
                        setToastSeverity('error');
                        setShowToast(true);
                      },
                    });
                  } catch (error) {
                    log.error(`Failed to start OAuth authentication for ${name}`, error);
                    setToastMessage('Failed to start OAuth authentication');
                    setToastSeverity('error');
                    setShowToast(true);
                  }
                }
              }}
              sx={{ width: '100%' }}
            >
              Authenticate with {name}
            </Button>
          </Box>
        )}
      </CardContent>

      {/* Built-in server: only an enable/disable toggle (issue #170) — no edit/delete. */}
      {builtIn && !pickerMode && onToggle && (
        <CardActions sx={{ justifyContent: 'flex-start', px: 2, py: 1 }} onClick={(e) => e.stopPropagation()}>
          <Box sx={{ display: 'flex', alignItems: 'center' }}>
            <Switch
              checked={enabled}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                log.debug(`Built-in server ${name} toggle changed to: ${e.target.checked}`);
                onToggle(e.target.checked);
              }}
              color="primary"
              size="small"
            />
            <Typography
              variant="body2"
              sx={{ ml: 0.5, fontWeight: 500, color: enabled ? 'primary.main' : 'text.secondary' }}
            >
              {enabled ? 'Enabled' : 'Disabled'}
            </Typography>
          </Box>
        </CardActions>
      )}

      {!builtIn && !pickerMode && (
      <CardActions sx={{ justifyContent: 'space-between', px: 2, py: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center' }}>
          <Switch
            checked={enabled}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              log.debug(`Server ${name} toggle changed to: ${e.target.checked}`);
              onToggle(e.target.checked);
            }}
            color="primary"
            size="small"
          />
          <Typography 
            variant="body2" 
            sx={{ 
              ml: 0.5, 
              fontWeight: 500,
              color: enabled ? 'primary.main' : 'text.secondary'
            }}
          >
            {enabled ? 'Enabled' : 'Disabled'}
          </Typography>
          
          {enabled && (
            <Tooltip title="Restart server">
              <IconButton
                size="small"
                onClick={(e) => {
                  e.stopPropagation();
                  log.debug(`Restart button clicked for server: ${name}`);
                  handleServerRestart();
                }}
                sx={{ ml: 1 }}
              >
                <RefreshIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
        </Box>
        
        <Box>
          <Tooltip title="Retry connection">
            <IconButton 
              color="primary" 
              onClick={handleRetryClick}
              disabled={isPolling}
              size="small"
            >
              {isPolling ? <Spinner size="small" color="primary" /> : <RefreshIcon />}
            </IconButton>
          </Tooltip>
          
          {/* Reset OAuth Tokens button - only show for streamable servers with OAuth tokens */}
          {transport === 'streamable' && hasOAuthTokens && (
            <Tooltip title="Reset OAuth tokens">
              <IconButton 
                color="warning" 
                onClick={handleResetOAuthTokens}
                disabled={isResettingTokens}
                size="small"
              >
              {isResettingTokens ? <Spinner size="small" color="primary" /> : <KeyOffIcon />}
              </IconButton>
            </Tooltip>
          )}
          
          {onSetFolder && (
            <Tooltip title={folder ? `Folder: ${folder}` : 'Move to folder'}>
              <IconButton
                color={folder ? 'primary' : 'default'}
                onClick={(e) => {
                  e.stopPropagation();
                  setFolderAnchorEl(e.currentTarget);
                }}
                size="small"
              >
                <DriveFileMoveOutlinedIcon />
              </IconButton>
            </Tooltip>
          )}

          <Tooltip title="Edit server">
            <IconButton 
              color="primary" 
              onClick={(e) => {
                e.stopPropagation();
                onEdit();
              }}
              size="small"
            >
              <EditIcon />
            </IconButton>
          </Tooltip>
          
          <Tooltip title="Delete server">
            <IconButton
              color="error"
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              size="small"
            >
              <DeleteIcon />
            </IconButton>
          </Tooltip>
        </Box>
      </CardActions>
      )}

      {onSetFolder && (
        <FolderAssignMenu
          anchorEl={folderAnchorEl}
          open={Boolean(folderAnchorEl)}
          currentFolder={folder}
          folders={folders}
          onClose={() => setFolderAnchorEl(null)}
          onAssign={(f) => onSetFolder(f)}
        />
      )}

      {/* Error Modal */}
      <Dialog 
        open={showErrorModal} 
        onClose={() => {
          log.debug(`Error modal closed for server: ${name}`);
          setShowErrorModal(false);
        }}
        maxWidth="md"
        fullWidth
        onClick={(e) => e.stopPropagation()}
      >
        <DialogTitle component="div">
          Error Details for {name}
        </DialogTitle>
        <DialogContent>
          <Box sx={{ 
            p: 2, 
            borderRadius: 1, 
            bgcolor: (theme) => getThemeColor('error.background'),
            color: (theme) => getThemeColor('error.text'),
            border: '1px solid',
            borderColor: (theme) => getThemeColor('error.border'),
            fontFamily: 'monospace',
            fontSize: '0.875rem',
            fontWeight: 500,
            whiteSpace: 'pre-wrap',
            overflow: 'auto',
            maxHeight: '300px',
            mb: 2
          }}>
            {error || 'Unknown error'}
          </Box>
          
          {stderrOutput && (
            <Box sx={{ mt: 2 }}>
              <Typography variant="h6" gutterBottom>
                Stderr Output:
              </Typography>
              <Box sx={{ 
                p: 2, 
                borderRadius: 1, 
                bgcolor: 'background.paper',
                border: '1px solid',
                borderColor: 'divider',
                fontFamily: 'monospace',
                fontSize: '0.875rem',
                whiteSpace: 'pre-wrap',
                overflow: 'auto',
                maxHeight: '300px'
              }}>
                {stderrOutput}
              </Box>
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShowErrorModal(false)}>Close</Button>
          <Button 
            onClick={() => {
              const textToCopy = [
                error || 'Unknown error',
                stderrOutput ? `\n\nStderr Output:\n${stderrOutput}` : ''
              ].join('');
              navigator.clipboard.writeText(textToCopy);
              log.debug(`Error copied to clipboard for server: ${name}`);
              setToastMessage('Error message copied to clipboard');
              setToastSeverity('success');
              setShowToast(true);
            }}
            color="primary"
          >
            Copy to Clipboard
          </Button>
        </DialogActions>
      </Dialog>
      
      {/* Git update dialog for locally cloned servers */}
      {updateInfo && (
        <ServerUpdateDialog
          open={showUpdateDialog}
          onClose={() => setShowUpdateDialog(false)}
          serverName={name}
          rootPath={path}
          installCommand={installCommand}
          buildCommand={buildCommand}
          enabled={enabled}
          updateInfo={updateInfo}
          onToggle={onToggle}
          onUpdated={onUpdated}
        />
      )}

      {/* Toast notification */}
      <Snackbar
        open={showToast}
        autoHideDuration={3000}
        onClose={() => setShowToast(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={() => setShowToast(false)} severity={toastSeverity} sx={{ width: '100%' }}>
          {toastMessage || 'Error message copied to clipboard'}
        </Alert>
      </Snackbar>
    </Card>
  );
};

export default ServerCard;
