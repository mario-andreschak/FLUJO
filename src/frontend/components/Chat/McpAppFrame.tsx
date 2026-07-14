"use client";

import React, { useCallback, useState } from 'react';
import { Box, Typography, Button, Collapse, CircularProgress, Alert, Tooltip } from '@mui/material';
import WidgetsIcon from '@mui/icons-material/Widgets';
import ShieldOutlinedIcon from '@mui/icons-material/ShieldOutlined';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import { mcpService } from '@/frontend/services/mcp';
import {
  MCP_APP_IFRAME_SANDBOX,
  buildAppSrcDoc,
  extractAppHtml,
  type UIResourceMeta,
} from '@/shared/utils/mcpApps';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/Chat/McpAppFrame');

interface McpAppFrameProps {
  /** Server that owns the `ui://` resource. */
  serverName: string;
  /** The `ui://…` resource URI to read and render. */
  uri: string;
}

/**
 * MCP Apps (SEP-1865, #97) — Phase 1 renderer.
 *
 * Renders a tool's linked `ui://` UI resource as a READ-ONLY, strictly
 * sandboxed iframe inside the chat tool-call timeline. The HTML is fetched
 * on-demand (only when the user expands the app) via the existing
 * `resources/read` endpoint, wrapped in a self-contained document carrying a
 * default-deny CSP derived from the resource's `_meta.ui`, and shown in an
 * `<iframe sandbox="allow-scripts">` — NO `allow-same-origin`, so it cannot
 * touch FLUJO's origin, cookies, storage, or DOM.
 *
 * There is deliberately NO iframe->host message bridge here: an app cannot call
 * tools or read resources in Phase 1. That interactive bridge is a gated
 * Phase 2 that must first pass the plan's security review.
 */
const McpAppFrame: React.FC<McpAppFrameProps> = ({ serverName, uri }) => {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [srcDoc, setSrcDoc] = useState<string | null>(null);

  const loadResource = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await mcpService.readResource(serverName, uri);
      if (!response || response.success === false) {
        setError(response?.error || 'Failed to read the UI resource.');
        return;
      }
      const extracted = extractAppHtml(response.data);
      if ('error' in extracted) {
        setError(extracted.error);
        return;
      }
      setSrcDoc(buildAppSrcDoc(extracted.html, extracted.meta as UIResourceMeta | undefined));
    } catch (e) {
      log.warn(`Failed to load MCP App resource ${uri} from ${serverName}`, e);
      setError(e instanceof Error ? e.message : 'Failed to load the UI resource.');
    } finally {
      setLoading(false);
    }
  }, [serverName, uri]);

  const handleToggle = useCallback(() => {
    const next = !expanded;
    setExpanded(next);
    // Lazy-load on first expand only.
    if (next && srcDoc === null && !loading) {
      void loadResource();
    }
  }, [expanded, srcDoc, loading, loadResource]);

  return (
    <Box sx={{ mt: 1, border: '1px solid', borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 1,
          py: 0.5,
          bgcolor: 'action.hover',
        }}
      >
        <WidgetsIcon fontSize="small" color="primary" />
        <Typography variant="body2" sx={{ fontWeight: 500 }}>
          Interactive app from {serverName}
        </Typography>
        <Tooltip title="Rendered read-only in a strict sandbox (no same-origin access, no network unless the app declares it). The app cannot call tools in this view.">
          <ShieldOutlinedIcon fontSize="small" color="action" />
        </Tooltip>
        <Button
          size="small"
          onClick={handleToggle}
          startIcon={expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
          sx={{ ml: 'auto' }}
        >
          {expanded ? 'Hide' : 'Open app'}
        </Button>
      </Box>

      <Collapse in={expanded} unmountOnExit>
        <Box sx={{ p: 1 }}>
          {loading && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 2, justifyContent: 'center' }}>
              <CircularProgress size={16} thickness={6} />
              <Typography variant="body2" color="text.secondary">
                Loading the app…
              </Typography>
            </Box>
          )}
          {error && (
            <Alert severity="error" sx={{ my: 1 }}>
              {error}
            </Alert>
          )}
          {!loading && !error && srcDoc !== null && (
            <Box
              component="iframe"
              title={`MCP App: ${uri}`}
              srcDoc={srcDoc}
              sandbox={MCP_APP_IFRAME_SANDBOX}
              referrerPolicy="no-referrer"
              sx={{
                width: '100%',
                height: 420,
                border: 'none',
                borderRadius: 1,
                bgcolor: '#fff',
              }}
            />
          )}
        </Box>
      </Collapse>
    </Box>
  );
};

export default McpAppFrame;
