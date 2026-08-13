"use client";

import React, { useState, useEffect, useRef } from "react";
import { createLogger } from "@/utils/logger";
import { useThemeUtils } from "@/frontend/utils/theme";

const log = createLogger("frontend/components/mcp/MCPServerManager/ServerCard");
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import CancelIcon from "@mui/icons-material/Cancel";
import ErrorIcon from "@mui/icons-material/Error";
import RefreshIcon from "@mui/icons-material/Refresh";
import EditIcon from "@mui/icons-material/Edit";
import DeleteIcon from "@mui/icons-material/Delete";
import LockIcon from "@mui/icons-material/Lock";
import LoginIcon from "@mui/icons-material/Login";
import KeyOffIcon from "@mui/icons-material/KeyOff";
import PublicIcon from "@mui/icons-material/Public";
import WidgetsIcon from "@mui/icons-material/Widgets";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import CopyLinkButton from "@/frontend/components/shared/CopyLinkButton";
import DataObjectIcon from "@mui/icons-material/DataObject";
import DriveFileMoveOutlinedIcon from "@mui/icons-material/DriveFileMoveOutlined";
import SystemUpdateAltIcon from "@mui/icons-material/SystemUpdateAlt";
import StarIcon from "@mui/icons-material/Star";
import StarBorderIcon from "@mui/icons-material/StarBorder";
import Spinner from "@/frontend/components/shared/Spinner";
import FolderAssignMenu from "@/frontend/components/shared/FolderAssignMenu";
import { mcpService } from "@/frontend/services/mcp";
import { MCPStdioOAuthStatus, MCPServerConfig } from "@/shared/types/mcp";
import { buildSingleServerJson } from "@/utils/mcp/mcpFormats";
import { getSelectedWorkspace, withWorkspaceUrl } from "@/frontend/utils/workspaceSelection";
import TransportBadge from "./TransportBadge";
import ServerLogo from "./ServerLogo";
import ServerUpdateDialog from "./ServerUpdateDialog";
import { ServerUpdateInfo, shortSha } from "./utils/serverUpdates";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import Button from "@mui/material/Button";
import Snackbar from "@mui/material/Snackbar";
import Alert from "@mui/material/Alert";
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
  Chip,
} from "@mui/material";
import { useI18n } from "@/frontend/contexts/I18nContext";

interface ServerCardProps {
  name: string;
  status:
    | "connected"
    | "disconnected"
    | "error"
    | "connecting"
    | "initialization"
    | "requires_authentication";
  path: string;
  enabled: boolean;
  transport: "stdio" | "websocket" | "sse" | "streamable";
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
  /** The surrounding CardPickerGrid owns semantics and keyboard activation. */
  selectionManaged?: boolean;
  /** Disabled picker cards remain readable but cannot be activated. */
  disabled?: boolean;
  error?: string; // Optional error message
  stderrOutput?: string; // Optional stderr output
  authorizationUrl?: string; // OAuth authorization URL
  selected?: boolean; // For bulk selection
  onSelect?: (selected: boolean) => void; // For bulk selection
  selectionMode?: boolean; // Whether selection mode is active
  hasOAuthTokens?: boolean; // Whether the server has OAuth tokens that can be reset
  stdioOAuth?: MCPStdioOAuthStatus;
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
  /**
   * Full server config, used to build a single-server, copy-to-clipboard MCP
   * JSON via the shared exporter (#110). Optional: when absent the copy-JSON
   * button falls back to the proxy-only shape derived from `name`.
   */
  serverConfig?: MCPServerConfig;
}

interface AuthorizationPromptState {
  sessionId: string;
  authorizationId: string;
  url: string;
  origin: string;
  hasPunycode: boolean;
  message?: string;
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
  selectionManaged = false,
  disabled = false,
  error,
  stderrOutput,
  authorizationUrl,
  selected = false,
  onSelect,
  selectionMode = false,
  hasOAuthTokens = false,
  stdioOAuth,
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
  serverConfig,
}) => {
  const { t } = useI18n();
  const [showErrorModal, setShowErrorModal] = useState(false);
  const [folderAnchorEl, setFolderAnchorEl] = useState<null | HTMLElement>(
    null,
  );
  const [showUpdateDialog, setShowUpdateDialog] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  const [toastSeverity, setToastSeverity] = useState<"success" | "error">(
    "success",
  );
  const [isPolling, setIsPolling] = useState(false);
  const [isResettingTokens, setIsResettingTokens] = useState(false);
  const [isPreparingAuthorization, setIsPreparingAuthorization] =
    useState(false);
  const [authorizationPrompt, setAuthorizationPrompt] =
    useState<AuthorizationPromptState | null>(null);
  const authorizationPromptRef = useRef<AuthorizationPromptState | null>(null);
  const authorizationPrepareAbortRef = useRef<AbortController | null>(null);
  const authorizationPollRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
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

  useEffect(
    () => () => {
      if (authorizationPollRef.current)
        clearInterval(authorizationPollRef.current);
      authorizationPrepareAbortRef.current?.abort();
      const prompt = authorizationPromptRef.current;
      if (prompt) {
        void fetch(
          `/api/mcp/servers/${encodeURIComponent(name)}/stdio-oauth/start`,
          {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionId: prompt.sessionId,
              action: "cancel",
            }),
            keepalive: true,
          },
        );
      }
    },
    [name],
  );

  // The URL external MCP clients paste in. Only meaningful in the browser.
  const proxyUrl =
    typeof window !== "undefined"
      ? withWorkspaceUrl(`${window.location.origin}/mcp-proxy/${encodeURIComponent(name)}`)
      : "";

  const handleToggleExpose = async (checked: boolean) => {
    setExposed(checked); // optimistic
    const result = await mcpService.updateServerConfig(name, {
      exposeAsMcpServer: checked,
    });
    if ("success" in result && result.success) {
      setToastMessage(
        checked ? t("mcp.card.exposed") : t("mcp.card.notExposed"),
      );
      setToastSeverity("success");
    } else {
      setExposed(!checked); // revert
      setToastMessage(t("mcp.card.exposureFailed"));
      setToastSeverity("error");
    }
    setShowToast(true);
  };

  const handleToggleApps = async (checked: boolean) => {
    setAppsEnabled(checked); // optimistic
    const result = await mcpService.updateServerConfig(name, {
      enableMcpApps: checked,
    });
    if ("success" in result && result.success) {
      setToastMessage(
        checked ? t("mcp.card.appsEnabled") : t("mcp.card.appsDisabled"),
      );
      setToastSeverity("success");
    } else {
      setAppsEnabled(!checked); // revert
      setToastMessage(t("mcp.card.appsFailed"));
      setToastSeverity("error");
    }
    setShowToast(true);
  };

  const handleCopyProxyUrl = () => {
    navigator.clipboard.writeText(proxyUrl);
    setToastMessage(t("mcp.card.endpointCopied"));
    setToastSeverity("success");
    setShowToast(true);
  };

  // Copy a ready-to-paste, single-server MCP config JSON to the clipboard (#110).
  // Scoped to exposed servers, whose exported shape is proxy-only
  // (`{ type:'http', url }`) — so no env vars, headers or secrets ever leak.
  const handleCopyServerJson = () => {
    const base = typeof window !== "undefined" ? window.location.origin : "";
    navigator.clipboard.writeText(
      buildSingleServerJson(name, serverConfig, base, 'claude', getSelectedWorkspace()),
    );
    setToastMessage(t("mcp.card.jsonCopied"));
    setToastSeverity("success");
    setShowToast(true);
  };

  const statusColor = {
    connected: "success.main",
    disconnected: "text.secondary",
    error: "error.main",
    connecting: "info.main",
    initialization: "info.main",
    requires_authentication: "warning.main",
  }[status];

  // Poll for status updates when server is connecting or initializing
  useEffect(() => {
    if (
      (status === "connecting" || status === "initialization") &&
      enabled &&
      !pickerMode
    ) {
      setIsPolling(true);
      const timer = setTimeout(() => {
        log.debug(`Polling status for server: ${name}`);
        onRetry();
      }, 2000);

      return () => {
        clearTimeout(timer);
        setIsPolling(false);
      };
    } else if (status !== "connecting" && status !== "initialization") {
      setIsPolling(false);
    }
  }, [status, enabled, name, onRetry]);

  // Reference to store the timeout ID
  const [retryTimeoutId, setRetryTimeoutId] = useState<ReturnType<
    typeof setTimeout
  > | null>(null);

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
      if (status !== "connecting" && status !== "initialization") {
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
      const response = await fetch("/api/oauth/reset", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ serverName: name }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || t("mcp.card.resetFailed"));
      }

      const result = await response.json();
      log.info(`OAuth tokens reset successfully for ${name}`, result);

      setToastMessage(t("mcp.card.resetSuccess"));
      setToastSeverity("success");
      setShowToast(true);

      // Trigger a retry to update the server status
      setTimeout(() => {
        onRetry();
      }, 500);
    } catch (error) {
      log.error(`Failed to reset OAuth tokens for ${name}`, error);
      setToastMessage(
        t("mcp.card.resetError", {
          error:
            error instanceof Error ? error.message : t("mcp.card.unknownError"),
        }),
      );
      setToastSeverity("error");
      setShowToast(true);
    } finally {
      setIsResettingTokens(false);
    }
  };

  const pendingAuthorization = stdioOAuth?.authorizations.find(
    (authorization) => authorization.state !== "ready",
  );
  const requiredAuthorization =
    stdioOAuth?.blockingAuthorization ?? pendingAuthorization;
  const authorizationBlocksUnattended = Boolean(
    stdioOAuth?.blockingAuthorization,
  );

  const startAuthorizationStatusPolling = () => {
    if (authorizationPollRef.current)
      clearInterval(authorizationPollRef.current);
    let attempts = 0;
    authorizationPollRef.current = setInterval(() => {
      attempts += 1;
      onRetry();
      if (attempts >= 60 && authorizationPollRef.current) {
        clearInterval(authorizationPollRef.current);
        authorizationPollRef.current = null;
      }
    }, 2_000);
  };

  useEffect(() => {
    if (!pendingAuthorization && authorizationPollRef.current) {
      clearInterval(authorizationPollRef.current);
      authorizationPollRef.current = null;
    }
  }, [pendingAuthorization]);

  const handleAuthenticate = async () => {
    log.debug(`Authenticate button clicked for server: ${name}`);

    if (requiredAuthorization) {
      setIsPreparingAuthorization(true);
      const abortController = new AbortController();
      authorizationPrepareAbortRef.current = abortController;
      try {
        const response = await fetch(
          `/api/mcp/servers/${encodeURIComponent(name)}/stdio-oauth/start`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ authorizationId: requiredAuthorization.id }),
            signal: abortController.signal,
          },
        );
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.error || t("mcp.card.externalAuthStartFailed"));
        if (data.alreadyReady) {
          onRetry();
          return;
        }
        if (!data.sessionId || !data.url || !data.origin) {
          throw new Error(t("mcp.card.externalAuthNoUrl"));
        }
        authorizationPromptRef.current = data;
        setAuthorizationPrompt(data);
      } catch (authError) {
        log.error(
          `Failed to prepare external authorization for ${name}`,
          authError,
        );
        setToastMessage(
          authError instanceof Error
            ? authError.message
            : t("mcp.card.externalAuthStartFailed"),
        );
        setToastSeverity("error");
        setShowToast(true);
      } finally {
        if (authorizationPrepareAbortRef.current === abortController) {
          authorizationPrepareAbortRef.current = null;
        }
        setIsPreparingAuthorization(false);
      }
      return;
    }

    if (onAuthenticate) {
      onAuthenticate();
      return;
    }

    // Transport OAuth remains the fallback for remote Streamable HTTP servers.
    try {
      const response = await fetch("/api/oauth/initiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverName: name }),
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || t("mcp.card.oauthInitiateFailed"));
      }

      const { authorizationUrl, alreadyAuthorized } = await response.json();
      if (alreadyAuthorized || !authorizationUrl) {
        handleServerRestart();
        return;
      }

      const { openOAuthPopup } = await import("@/frontend/utils/oauth");
      await openOAuthPopup({
        url: authorizationUrl,
        windowName: `oauth_${name}`,
        onSuccess: () => handleServerRestart(),
        onError: (authError) => {
          log.error(`OAuth authentication failed for ${name}`, authError);
          setToastMessage(t("mcp.card.oauthFailed"));
          setToastSeverity("error");
          setShowToast(true);
        },
      });
    } catch (authError) {
      log.error(`Failed to start OAuth authentication for ${name}`, authError);
      setToastMessage(t("mcp.card.oauthStartFailed"));
      setToastSeverity("error");
      setShowToast(true);
    }
  };

  const dismissAuthorizationPrompt = (action: "cancel" | "decline") => {
    if (authorizationPrompt) {
      void fetch(
        `/api/mcp/servers/${encodeURIComponent(name)}/stdio-oauth/start`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: authorizationPrompt.sessionId,
            action,
          }),
        },
      );
    }
    authorizationPromptRef.current = null;
    setAuthorizationPrompt(null);
  };

  const closeAuthorizationPrompt = () => dismissAuthorizationPrompt("cancel");
  const declineAuthorizationPrompt = () =>
    dismissAuthorizationPrompt("decline");

  const confirmAndOpenAuthorization = async () => {
    if (!authorizationPrompt) return;

    // Reserve the popup synchronously on the explicit second click; navigating
    // it after the confirmation round-trip then remains allowed by popup blockers.
    const popup = window.open(
      "about:blank",
      `external_auth_${name}`,
      "popup,width=720,height=820,resizable=yes,scrollbars=yes",
    );
    try {
      const response = await fetch(
        `/api/mcp/servers/${encodeURIComponent(name)}/stdio-oauth/confirm`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: authorizationPrompt.sessionId }),
        },
      );
      const data = await response.json();
      if (!response.ok || !data.url) {
        throw new Error(data.error || t("mcp.card.externalAuthStartFailed"));
      }
      if (popup) {
        popup.opener = null;
        popup.location.replace(data.url);
      } else {
        window.open(data.url, "_blank", "noopener,noreferrer");
      }
      authorizationPromptRef.current = null;
      setAuthorizationPrompt(null);
      startAuthorizationStatusPolling();
    } catch (authError) {
      popup?.close();
      setToastMessage(
        authError instanceof Error
          ? authError.message
          : t("mcp.card.externalAuthStartFailed"),
      );
      setToastSeverity("error");
      setShowToast(true);
    }
  };

  const { getThemeColor, visualStyle } = useThemeUtils();
  const modern = visualStyle === "modern";
  const statusLabel = () => {
    switch (status) {
      case "connected":
        return t("mcp.status.connected");
      case "disconnected":
        return t("mcp.status.disconnected");
      case "error":
        return t("mcp.status.error");
      case "connecting":
        return t("mcp.status.connecting");
      case "initialization":
        return t("mcp.status.initialization");
      case "requires_authentication":
        return t("mcp.card.requiresAuth");
    }
  };

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

  const statusIcon = () => {
    if (status === "connected") {
      return <CheckCircleIcon color="success" fontSize="small" />;
    }
    if (status === "disconnected") {
      return <CancelIcon color="action" fontSize="small" />;
    }
    if (status === "error") {
      return <ErrorIcon color="error" fontSize="small" />;
    }
    if (status === "requires_authentication") {
      return <LockIcon color="warning" fontSize="small" />;
    }
    return <Spinner size="small" color="primary" />;
  };

  /**
   * Picker mode (#393) shows connection state as an icon only so long server
   * names stay readable. The localized status text is preserved as the tooltip
   * and as the accessible name, and the wrapper stays non-interactive because
   * the whole card is the click target.
   */
  const compactStatusIndicator = (
    <Tooltip title={statusLabel() ?? ""} arrow placement="top" disableInteractive>
      <Box
        component="span"
        role="img"
        tabIndex={pickerMode ? -1 : 0}
        aria-label={statusLabel() ?? ""}
        data-testid="server-status-compact"
        sx={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          width: 26,
          height: 26,
          lineHeight: 0,
          outlineOffset: 2,
          color: statusColor,
          "& svg": { fontSize: 18 },
        }}
      >
        {statusIcon()}
      </Box>
    </Tooltip>
  );

  const updateBadge = updateInfo?.updateAvailable ? (
    <Tooltip
      title={t("mcp.card.updateAvailable", {
        local: shortSha(updateInfo.localSha),
        remote: shortSha(updateInfo.remoteSha),
      })}
    >
      <Chip
        icon={<SystemUpdateAltIcon />}
        label={t("mcp.card.update")}
        color="warning"
        size="small"
        onClick={(e) => {
          e.stopPropagation();
          log.debug(`Update badge clicked for server: ${name}`);
          setShowUpdateDialog(true);
        }}
      />
    </Tooltip>
  ) : null;

  return (
    <Card
      data-tutorial-server-name={name}
      role={pickerMode && !selectionManaged ? "button" : undefined}
      aria-pressed={pickerMode && !selectionManaged ? selected : undefined}
      aria-disabled={disabled || undefined}
      tabIndex={pickerMode && !selectionManaged && !disabled ? 0 : undefined}
      sx={{
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.58 : 1,
        position: "relative",
        display: modern ? "flex" : undefined,
        flexDirection: modern ? "column" : undefined,
        height: pickerMode || modern ? "100%" : undefined,
        overflow: "hidden",
        transition:
          modern
            ? "transform 220ms cubic-bezier(0.2, 0.75, 0.2, 1), box-shadow 220ms ease, border-color 180ms ease"
            : "transform 200ms ease, box-shadow 200ms ease, border-color 180ms ease",
        border: (theme) =>
          `1px solid ${pickerMode && selected
            ? theme.palette.primary.main
            : modern
              ? alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.2 : 0.14)
              : theme.palette.divider}`,
        background: modern
          ? `linear-gradient(145deg, ${alpha(muiTheme.palette.background.paper, muiTheme.palette.mode === "dark" ? 0.78 : 0.82)}, ${alpha(muiTheme.palette.background.paper, muiTheme.palette.mode === "dark" ? 0.62 : 0.68)} 62%, ${alpha(muiTheme.palette.primary.main, 0.055)})`
          : undefined,
        backdropFilter: modern ? "blur(18px) saturate(135%)" : undefined,
        WebkitBackdropFilter: modern ? "blur(18px) saturate(135%)" : undefined,
        boxShadow:
          pickerMode && selected
            ? `0 0 0 3px ${alpha(muiTheme.palette.primary.main, 0.13)}`
            : modern
              ? `0 16px 45px ${alpha(muiTheme.palette.common.black, muiTheme.palette.mode === "dark" ? 0.2 : 0.07)}`
              : undefined,
        "&::before": modern
          ? {
              content: '""',
              position: "absolute",
              inset: "0 0 auto 0",
              height: 2,
              zIndex: 1,
              background: `linear-gradient(90deg, ${muiTheme.palette.primary.main}, ${muiTheme.palette.secondary.main}, transparent 82%)`,
              opacity: pickerMode && selected ? 1 : 0.68,
            }
          : undefined,
        "&:hover": {
          borderColor: alpha(muiTheme.palette.primary.main, 0.38),
          boxShadow: modern
            ? `0 24px 64px ${alpha(muiTheme.palette.primary.main, muiTheme.palette.mode === "dark" ? 0.18 : 0.13)}`
            : `0 22px 60px ${alpha(muiTheme.palette.primary.main, 0.12)}`,
          transform: "translateY(-4px)",
        },
      }}
      onClick={() => {
        if (disabled) return;
        log.debug(`Server card clicked: ${name}`);
        onClick();
      }}
      onKeyDown={pickerMode && !selectionManaged && !disabled ? (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      } : undefined}
    >
      {/* Favorite star (#146): mirrors FlowCard — top-left, warning color when active. */}
      {onToggleFavorite && (
        <Tooltip
          title={
            favorite ? t("mcp.card.favoriteRemove") : t("mcp.card.favoriteAdd")
          }
          arrow
          placement="top"
        >
          <IconButton
            size="small"
            aria-label={
              favorite
                ? t("mcp.card.favoriteRemove")
                : t("mcp.card.favoriteAdd")
            }
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite();
            }}
            sx={{
              position: "absolute",
              top: modern ? 10 : 4,
              left: modern ? undefined : 4,
              right: modern ? 10 : undefined,
              zIndex: 2,
              color: favorite
                ? muiTheme.palette.warning.main
                : muiTheme.palette.text.secondary,
              backgroundColor: alpha(
                muiTheme.palette.background.paper,
                modern ? 0.72 : 0.6,
              ),
              backdropFilter: modern ? "blur(10px)" : undefined,
              "&:hover": {
                backgroundColor: alpha(muiTheme.palette.background.paper, 0.9),
              },
            }}
          >
            {favorite ? (
              <StarIcon fontSize="small" />
            ) : (
              <StarBorderIcon fontSize="small" />
            )}
          </IconButton>
        </Tooltip>
      )}
      <CardContent
        sx={
          modern
            ? { p: 2, pb: 1.5, flexGrow: 1, "&:last-child": { pb: 1.5 } }
            : { pb: 1 }
        }
      >
        {modern ? (
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1.4,
              minWidth: 0,
              mb: pickerMode ? 0 : 1.5,
              pr: onToggleFavorite ? 4.5 : 0,
            }}
          >
            {selectionMode && onSelect && (
              <Checkbox
                checked={selected}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => onSelect(e.target.checked)}
                size="small"
                sx={{ p: 0.5 }}
              />
            )}
            <ServerLogo name={name} config={serverConfig} size={50} />
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography
                variant="h6"
                component="h3"
                noWrap
                title={name}
                sx={
                  pickerMode
                    ? {
                        color: "text.primary",
                        fontWeight: 700,
                        fontSize: "1.02rem",
                        lineHeight: 1.35,
                      }
                    : undefined
                }
              >
                {name}
              </Typography>
              {path && path !== "." && (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  noWrap
                  component="div"
                  title={path}
                  sx={{ mt: 0.15 }}
                >
                  {path}
                </Typography>
              )}
              {!pickerMode && (
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 0.55,
                    mt: path && path !== "." ? 0.45 : 0.3,
                    color: statusColor,
                  }}
                >
                  <Box sx={{ display: "flex", fontSize: 17, "& svg": { fontSize: 17 } }}>
                    {statusIcon()}
                  </Box>
                  <Typography variant="caption" sx={{ color: "inherit", fontWeight: 650 }}>
                    {statusLabel()}
                  </Typography>
                </Box>
              )}
            </Box>
            <Box
              sx={{
                display: "flex",
                flexDirection: pickerMode ? "row" : "column",
                alignItems: pickerMode ? "center" : "flex-end",
                alignSelf: pickerMode ? "center" : "stretch",
                justifyContent: pickerMode ? "flex-end" : "space-between",
                flexShrink: 0,
                gap: pickerMode ? 0.75 : 0.5,
              }}
            >
              {updateBadge}
              {pickerMode && compactStatusIndicator}
              <TransportBadge transport={transport} size="small" compact={pickerMode} />
            </Box>
          </Box>
        ) : (
          <>
            <Box
              sx={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                mb: 1,
              }}
            >
              <Box sx={{ display: "flex", alignItems: "center", flex: 1, minWidth: 0 }}>
                {selectionMode && onSelect && (
                  <Checkbox
                    checked={selected}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => onSelect(e.target.checked)}
                    size="small"
                    sx={{ mr: 1, p: 0.5 }}
                  />
                )}
                <Typography
                  variant="h6"
                  component="h3"
                  noWrap={pickerMode}
                  title={pickerMode ? name : undefined}
                  sx={{
                    flex: 1,
                    minWidth: 0,
                    ...(pickerMode
                      ? {
                          color: "text.primary",
                          fontWeight: 700,
                          fontSize: "1.02rem",
                          lineHeight: 1.35,
                        }
                      : {}),
                  }}
                >
                  {name}
                </Typography>
              </Box>
              <Box
                sx={{
                  display: "flex",
                  flexDirection: pickerMode ? "row" : "column",
                  alignItems: pickerMode ? "center" : "flex-end",
                  flexShrink: 0,
                  gap: pickerMode ? 0.75 : 0.5,
                }}
              >
                <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                  {updateBadge}
                  <TransportBadge transport={transport} size="small" compact={pickerMode} />
                </Box>
                <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                  {pickerMode ? (
                    compactStatusIndicator
                  ) : (
                    <>
                      {statusIcon()}
                      <Typography variant="body2" color={statusColor}>
                        {statusLabel()}
                      </Typography>
                    </>
                  )}
                </Box>
              </Box>
            </Box>

            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ mb: 1, fontSize: "0.875rem" }}
              noWrap
              title={path}
            >
              {path}
            </Typography>
          </>
        )}

        {!pickerMode && (modern ? (
          <Box
            onClick={(e) => e.stopPropagation()}
            sx={{
              display: "grid",
              gridTemplateColumns: { xs: "1fr", sm: "repeat(2, minmax(0, 1fr))" },
              overflow: "hidden",
              borderRadius: 3,
              border: `1px solid ${alpha(muiTheme.palette.primary.main, 0.12)}`,
              bgcolor: alpha(
                muiTheme.palette.background.default,
                muiTheme.palette.mode === "dark" ? 0.38 : 0.34,
              ),
            }}
          >
            <Tooltip title={t("mcp.card.exposeHelp")} placement="top">
              <Box
                sx={{
                  minWidth: 0,
                  display: "flex",
                  alignItems: "center",
                  gap: 0.8,
                  px: 1.15,
                  py: 0.8,
                  borderRight: { sm: `1px solid ${alpha(muiTheme.palette.divider, 0.75)}` },
                }}
              >
                <Box
                  sx={{
                    width: 28,
                    height: 28,
                    borderRadius: 2,
                    display: "grid",
                    placeItems: "center",
                    flexShrink: 0,
                    color: exposed ? "primary.main" : "text.disabled",
                    bgcolor: alpha(muiTheme.palette.primary.main, exposed ? 0.12 : 0.045),
                  }}
                >
                  <PublicIcon sx={{ fontSize: 17 }} />
                </Box>
                <Typography
                  variant="caption"
                  noWrap
                  sx={{ flex: 1, minWidth: 0, fontWeight: 650, color: exposed ? "text.primary" : "text.secondary" }}
                >
                  {t("mcp.card.expose")}
                </Typography>
                <Switch
                  checked={exposed}
                  onChange={(e) => handleToggleExpose(e.target.checked)}
                  size="small"
                  inputProps={{ "aria-label": t("mcp.card.expose") }}
                />
              </Box>
            </Tooltip>

            <Tooltip title={t("mcp.card.appsHelp")} placement="top">
              <Box
                sx={{
                  minWidth: 0,
                  display: "flex",
                  alignItems: "center",
                  gap: 0.8,
                  px: 1.15,
                  py: 0.8,
                }}
              >
                <Box
                  sx={{
                    width: 28,
                    height: 28,
                    borderRadius: 2,
                    display: "grid",
                    placeItems: "center",
                    flexShrink: 0,
                    color: appsEnabled ? "secondary.main" : "text.disabled",
                    bgcolor: alpha(muiTheme.palette.secondary.main, appsEnabled ? 0.12 : 0.045),
                  }}
                >
                  <WidgetsIcon sx={{ fontSize: 17 }} />
                </Box>
                <Typography
                  variant="caption"
                  noWrap
                  sx={{ flex: 1, minWidth: 0, fontWeight: 650, color: appsEnabled ? "text.primary" : "text.secondary" }}
                >
                  {t("mcp.card.apps")}
                </Typography>
                <Switch
                  checked={appsEnabled}
                  onChange={(e) => handleToggleApps(e.target.checked)}
                  size="small"
                  color="secondary"
                  inputProps={{ "aria-label": t("mcp.card.apps") }}
                />
              </Box>
            </Tooltip>

            {exposed && (
              <Box
                sx={{
                  gridColumn: "1 / -1",
                  display: "flex",
                  alignItems: "center",
                  minWidth: 0,
                  pl: 1.35,
                  pr: 0.55,
                  py: 0.45,
                  borderTop: `1px solid ${alpha(muiTheme.palette.divider, 0.75)}`,
                  bgcolor: alpha(muiTheme.palette.background.paper, 0.35),
                }}
              >
                <Typography
                  variant="caption"
                  sx={{
                    flex: 1,
                    minWidth: 0,
                    color: "text.secondary",
                    fontFamily: "monospace",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={proxyUrl}
                >
                  {proxyUrl}
                </Typography>
                <Tooltip title={t("mcp.card.copyEndpoint")}>
                  <IconButton size="small" onClick={handleCopyProxyUrl} sx={{ color: "text.secondary" }}>
                    <ContentCopyIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Tooltip title={t("mcp.card.copyJson")}>
                  <IconButton size="small" onClick={handleCopyServerJson} sx={{ color: "text.secondary" }}>
                    <DataObjectIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                <CopyLinkButton target={{ kind: "mcp-server", id: name }} sx={{ color: "text.secondary" }} />
              </Box>
            )}
          </Box>
        ) : (
          <>
            {/* Legacy theme keeps the original stacked controls. */}
            <Box
              sx={{
                mt: 1,
                mb: 1,
                p: 1.1,
                borderRadius: 2.5,
                border: "1px solid",
                borderColor: "divider",
                bgcolor: alpha(muiTheme.palette.background.default, 0.42),
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <Box sx={{ display: "flex", alignItems: "center" }}>
                <PublicIcon
                  fontSize="small"
                  sx={{ mr: 0.5, color: exposed ? "primary.main" : "text.disabled" }}
                />
                <Switch
                  checked={exposed}
                  onChange={(e) => handleToggleExpose(e.target.checked)}
                  size="small"
                />
                <Tooltip title={t("mcp.card.exposeHelp")}>
                  <Typography variant="body2" sx={{ fontWeight: 500 }}>
                    {t("mcp.card.expose")}
                  </Typography>
                </Tooltip>
              </Box>
              {exposed && (
                <Box sx={{ display: "flex", alignItems: "center", mt: 0.5 }}>
                  <Typography
                    variant="caption"
                    sx={{
                      flex: 1,
                      fontFamily: "monospace",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={proxyUrl}
                  >
                    {proxyUrl}
                  </Typography>
                  <Tooltip title={t("mcp.card.copyEndpoint")}>
                    <IconButton size="small" onClick={handleCopyProxyUrl}>
                      <ContentCopyIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title={t("mcp.card.copyJson")}>
                    <IconButton size="small" onClick={handleCopyServerJson}>
                      <DataObjectIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <CopyLinkButton target={{ kind: "mcp-server", id: name }} />
                </Box>
              )}
            </Box>

            <Box
              sx={{
                mt: 1,
                mb: 1,
                p: 1.1,
                borderRadius: 2.5,
                border: "1px solid",
                borderColor: "divider",
                bgcolor: alpha(muiTheme.palette.background.default, 0.42),
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <Box sx={{ display: "flex", alignItems: "center" }}>
                <WidgetsIcon
                  fontSize="small"
                  sx={{ mr: 0.5, color: appsEnabled ? "primary.main" : "text.disabled" }}
                />
                <Switch
                  checked={appsEnabled}
                  onChange={(e) => handleToggleApps(e.target.checked)}
                  size="small"
                />
                <Tooltip title={t("mcp.card.appsHelp")}>
                  <Typography variant="body2" sx={{ fontWeight: 500 }}>
                    {t("mcp.card.apps")}
                  </Typography>
                </Tooltip>
              </Box>
            </Box>
          </>
        ))}

        {status === "error" && modern && (
          <Box
            sx={{
              mt: 1,
              display: "flex",
              alignItems: "center",
              gap: 0.8,
              minWidth: 0,
              px: 1.1,
              py: 0.65,
              borderRadius: 2.5,
              color: "error.main",
              bgcolor: alpha(muiTheme.palette.error.main, 0.07),
              border: `1px solid ${alpha(muiTheme.palette.error.main, 0.16)}`,
            }}
          >
            <ErrorIcon sx={{ fontSize: 18, flexShrink: 0 }} />
            <Typography variant="caption" noWrap sx={{ flex: 1, minWidth: 0, fontWeight: 650 }}>
              {error || t("mcp.card.errorLabel")}
            </Typography>
            <Button
              size="small"
              color="error"
              onClick={(e) => {
                e.stopPropagation();
                setShowErrorModal(true);
              }}
              sx={{ flexShrink: 0, minWidth: 0, px: 0.8 }}
            >
              {t("mcp.card.viewError")}
            </Button>
          </Box>
        )}

        {status === "error" && !modern && (
          <Box sx={{ mt: 1, mb: 1 }}>
            <Box
              sx={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                mb: 0.5,
              }}
            >
              <Typography variant="body2" fontWeight="medium" color="error">
                {t("mcp.card.errorLabel")}
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
                {t("mcp.card.viewError")}
              </Button>
            </Box>
            <Box
              sx={{
                maxHeight: "80px",
                overflow: "auto",
                p: 1,
                borderRadius: 1,
                bgcolor: (theme) => getThemeColor("error.background"),
                color: (theme) => getThemeColor("error.text"),
                border: "1px solid",
                borderColor: (theme) => getThemeColor("error.border"),
                fontSize: "0.75rem",
                fontWeight: 500,
                whiteSpace: "pre-wrap",
              }}
            >
              {error || t("mcp.card.unknownError")}
            </Box>
          </Box>
        )}

        {(status === "requires_authentication" || requiredAuthorization) &&
          !pickerMode && (
            <Box sx={{ mt: 1, mb: 1 }}>
              <Box
                sx={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  mb: 1,
                }}
              >
                <Typography
                  variant="body2"
                  fontWeight="medium"
                  color="warning.main"
                >
                  {requiredAuthorization
                    ? t(
                        authorizationBlocksUnattended
                          ? "mcp.card.externalAuthRequired"
                          : "mcp.card.externalAuthAvailable",
                        {
                          provider: requiredAuthorization.label,
                        },
                      )
                    : t("mcp.card.authRequired")}
                </Typography>
              </Box>
              <Button
                variant="contained"
                color="warning"
                size="small"
                startIcon={<LoginIcon />}
                onClick={async (e) => {
                  e.stopPropagation();
                  await handleAuthenticate();
                }}
                disabled={isPreparingAuthorization}
                sx={{ width: "100%" }}
              >
                {isPreparingAuthorization
                  ? t("mcp.card.externalAuthPreparing")
                  : t("mcp.card.authenticate", {
                      server: requiredAuthorization?.label ?? name,
                    })}
              </Button>
            </Box>
          )}
      </CardContent>

      {!pickerMode && (
        <CardActions
          sx={{
            justifyContent: "space-between",
            px: modern ? 1.5 : 2,
            py: modern ? 0.75 : 1,
            borderTop: modern ? `1px solid ${alpha(muiTheme.palette.divider, 0.72)}` : undefined,
            bgcolor: modern ? alpha(muiTheme.palette.background.paper, 0.28) : undefined,
          }}
        >
          <Box sx={{ display: "flex", alignItems: "center" }}>
            <Switch
              data-tutorial-server-toggle={name}
              checked={enabled}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                log.debug(
                  `Server ${name} toggle changed to: ${e.target.checked}`,
                );
                onToggle(e.target.checked);
              }}
              color="primary"
              size="small"
            />
            <Typography
              variant="body2"
              sx={{
                ml: modern ? 0.2 : 0.5,
                fontWeight: modern ? 650 : 500,
                fontSize: modern ? "0.76rem" : undefined,
                color: enabled ? "primary.main" : "text.secondary",
              }}
            >
              {enabled ? t("mcp.card.enabled") : t("mcp.card.disabled")}
            </Typography>

            {enabled && !modern && (
              <Tooltip title={t("mcp.card.restart")}>
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

          <Box sx={{ display: "flex", alignItems: "center", gap: modern ? 0.15 : 0 }}>
            {modern && enabled && status === "connected" && (
              <Tooltip title={t("mcp.card.restart")}>
                <IconButton
                  size="small"
                  onClick={(e) => {
                    e.stopPropagation();
                    log.debug(`Server restart initiated from compact actions: ${name}`);
                    handleServerRestart();
                  }}
                  sx={{ color: "text.secondary", "&:hover": { color: "primary.main" } }}
                >
                  <RefreshIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}

            {(!modern || status !== "connected") && (
              <Tooltip title={t("mcp.card.retry")}>
                <IconButton
                  color={modern ? "default" : "primary"}
                  onClick={handleRetryClick}
                  disabled={isPolling}
                  size="small"
                  sx={modern ? { color: "text.secondary", "&:hover": { color: "primary.main" } } : undefined}
                >
                  {isPolling ? (
                    <Spinner size="small" color="primary" />
                  ) : (
                    <RefreshIcon />
                  )}
                </IconButton>
              </Tooltip>
            )}

            {/* Reset OAuth Tokens button - only show for streamable servers with OAuth tokens */}
            {transport === "streamable" && hasOAuthTokens && (
              <Tooltip title={t("mcp.card.resetTokens")}>
                <IconButton
                  color={modern ? "default" : "warning"}
                  onClick={handleResetOAuthTokens}
                  disabled={isResettingTokens}
                  size="small"
                  sx={modern ? { color: "text.secondary", "&:hover": { color: "warning.main" } } : undefined}
                >
                  {isResettingTokens ? (
                    <Spinner size="small" color="primary" />
                  ) : (
                    <KeyOffIcon />
                  )}
                </IconButton>
              </Tooltip>
            )}

            {onSetFolder && (
              <Tooltip
                title={
                  folder
                    ? t("mcp.card.folder", { folder })
                    : t("mcp.card.moveFolder")
                }
              >
                <IconButton
                  color={modern ? "default" : folder ? "primary" : "default"}
                  onClick={(e) => {
                    e.stopPropagation();
                    setFolderAnchorEl(e.currentTarget);
                  }}
                  size="small"
                  sx={modern ? { color: folder ? "primary.main" : "text.secondary", "&:hover": { color: "primary.main" } } : undefined}
                >
                  <DriveFileMoveOutlinedIcon />
                </IconButton>
              </Tooltip>
            )}

            <Tooltip title={t("mcp.card.edit")}>
              <IconButton
                color={modern ? "default" : "primary"}
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit();
                }}
                size="small"
                sx={modern ? { color: "text.secondary", "&:hover": { color: "primary.main" } } : undefined}
              >
                <EditIcon />
              </IconButton>
            </Tooltip>

            <Tooltip title={t("mcp.card.delete")}>
              <IconButton
                color={modern ? "default" : "error"}
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete();
                }}
                size="small"
                sx={modern ? { color: "text.secondary", "&:hover": { color: "error.main", bgcolor: alpha(muiTheme.palette.error.main, 0.08) } } : undefined}
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

      {/* The extension URL is never opened on the first click. Show the exact
          destination and require a second explicit confirmation. */}
      <Dialog
        open={Boolean(authorizationPrompt)}
        onClose={closeAuthorizationPrompt}
        maxWidth="sm"
        fullWidth
        onClick={(e) => e.stopPropagation()}
      >
        <DialogTitle>{t("mcp.card.externalAuthReviewTitle")}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 2 }}>
            {authorizationPrompt?.message ||
              t("mcp.card.externalAuthReviewBody")}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {t("mcp.card.externalAuthDestination")}
          </Typography>
          <Typography variant="body2" fontWeight={700} sx={{ mt: 0.5 }}>
            {authorizationPrompt?.origin}
          </Typography>
          {authorizationPrompt?.hasPunycode && (
            <Alert severity="warning" sx={{ mt: 1.5 }}>
              {t("mcp.card.externalAuthPunycodeWarning")}
            </Alert>
          )}
          <Box
            sx={{
              mt: 1,
              p: 1.5,
              borderRadius: 1,
              border: "1px solid",
              borderColor: "divider",
              bgcolor: "background.default",
              fontFamily: "monospace",
              fontSize: "0.75rem",
              overflowWrap: "anywhere",
            }}
          >
            {authorizationPrompt?.url}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeAuthorizationPrompt} color="inherit">
            {t("mcp.card.externalAuthCancel")}
          </Button>
          <Button onClick={declineAuthorizationPrompt}>
            {t("mcp.card.externalAuthDecline")}
          </Button>
          <Button variant="contained" onClick={confirmAndOpenAuthorization}>
            {t("mcp.card.externalAuthOpen")}
          </Button>
        </DialogActions>
      </Dialog>

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
          {t("mcp.card.errorTitle", { server: name })}
        </DialogTitle>
        <DialogContent>
          <Box
            sx={{
              p: 2,
              borderRadius: 1,
              bgcolor: (theme) => getThemeColor("error.background"),
              color: (theme) => getThemeColor("error.text"),
              border: "1px solid",
              borderColor: (theme) => getThemeColor("error.border"),
              fontFamily: "monospace",
              fontSize: "0.875rem",
              fontWeight: 500,
              whiteSpace: "pre-wrap",
              overflow: "auto",
              maxHeight: "300px",
              mb: 2,
            }}
          >
            {error || t("mcp.card.unknownError")}
          </Box>

          {stderrOutput && (
            <Box sx={{ mt: 2 }}>
              <Typography variant="h6" gutterBottom>
                {t("mcp.card.stderr")}
              </Typography>
              <Box
                sx={{
                  p: 2,
                  borderRadius: 1,
                  bgcolor: "background.paper",
                  border: "1px solid",
                  borderColor: "divider",
                  fontFamily: "monospace",
                  fontSize: "0.875rem",
                  whiteSpace: "pre-wrap",
                  overflow: "auto",
                  maxHeight: "300px",
                }}
              >
                {stderrOutput}
              </Box>
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShowErrorModal(false)}>
            {t("mcp.card.close")}
          </Button>
          <Button
            onClick={() => {
              const textToCopy = [
                error || t("mcp.card.unknownError"),
                stderrOutput
                  ? `\n\n${t("mcp.card.stderr")}\n${stderrOutput}`
                  : "",
              ].join("");
              navigator.clipboard.writeText(textToCopy);
              log.debug(`Error copied to clipboard for server: ${name}`);
              setToastMessage(t("mcp.card.errorCopied"));
              setToastSeverity("success");
              setShowToast(true);
            }}
            color="primary"
          >
            {t("mcp.card.copyClipboard")}
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
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert
          onClose={() => setShowToast(false)}
          severity={toastSeverity}
          sx={{ width: "100%" }}
        >
          {toastMessage || t("mcp.card.errorCopied")}
        </Alert>
      </Snackbar>
    </Card>
  );
};

export default ServerCard;
