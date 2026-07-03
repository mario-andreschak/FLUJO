"use client";

import React, { useState, useCallback } from 'react';
import {
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Box,
  Typography,
  CircularProgress,
  Chip,
} from '@mui/material';
import FactCheckIcon from '@mui/icons-material/FactCheck';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { FlowNode } from '@/frontend/types/flow/flow';
import { Edge } from '@xyflow/react';
import { validateFlow, FlowValidationIssue } from '@/utils/shared/flowValidation';
import { modelService } from '@/frontend/services/model';
import { mcpService } from '@/frontend/services/mcp';
import { MCPServerConfig } from '@/shared/types/mcp';
import { createLogger } from '@/utils/logger';

const log = createLogger('components/flow/FlowBuilder/FlowValidationButton');

interface FlowValidationButtonProps {
  nodes: FlowNode[];
  edges: Edge[];
}

/**
 * Toolbar action that runs the flow consistency checks (deleted/renamed models or MCP
 * servers, missing Start/Finish nodes, unreachable nodes, dangling tool references, …) and
 * lists what it finds. Clicking an issue opens the offending node's properties modal via the
 * `editNode` event the Canvas already listens for, so the user can jump straight to the fix.
 */
export const FlowValidationButton: React.FC<FlowValidationButtonProps> = ({ nodes, edges }) => {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [issues, setIssues] = useState<FlowValidationIssue[] | null>(null);

  const runCheck = useCallback(async () => {
    setLoading(true);
    try {
      // Load the current models and servers so we can detect deleted/renamed references.
      // Crucially, only pass a context when the load genuinely SUCCEEDED — a failed load
      // must leave it undefined so validateFlow SKIPS those checks rather than reporting
      // every binding as "deleted". A legitimately empty list ([]) still runs the checks.
      // Both service calls preserve that distinction: tryLoadModels returns null on
      // failure, loadServerConfigs returns {error} instead of an array.
      const models = (await modelService.tryLoadModels()) ?? undefined;

      // Server live status isn't needed — names (and the disabled flag) are enough to
      // catch renames/deletions; a disabled server is reported as unavailable.
      const configs = await mcpService.loadServerConfigs();
      const servers = Array.isArray(configs)
        ? (configs as MCPServerConfig[]).map(s => ({ name: s.name, status: s.disabled ? 'disabled' : undefined }))
        : undefined;

      const result = validateFlow({ nodes, edges } as any, { models, servers });
      setIssues(result.issues);
    } catch (error) {
      log.warn('Flow validation failed to run', error);
      setIssues([]);
    } finally {
      setLoading(false);
    }
  }, [nodes, edges]);

  const handleOpen = useCallback(() => {
    setOpen(true);
    setIssues(null);
    runCheck();
  }, [runCheck]);

  // Reuse the Canvas's existing 'editNode' listener to open the node's properties modal.
  const goToNode = useCallback((nodeId?: string) => {
    if (!nodeId) return;
    setOpen(false);
    document.dispatchEvent(new CustomEvent('editNode', { detail: { nodeId } }));
  }, []);

  const errorCount = issues?.filter((i) => i.severity === 'error').length ?? 0;
  const warningCount = (issues?.length ?? 0) - errorCount;

  return (
    <>
      <Button
        variant="outlined"
        color="primary"
        onClick={handleOpen}
        startIcon={<FactCheckIcon />}
        sx={{ textTransform: 'none' }}
      >
        Check Flow
      </Button>

      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle component="div" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <span>Flow Check</span>
          {issues && (
            <Box sx={{ display: 'flex', gap: 1, ml: 1 }}>
              {errorCount > 0 && <Chip size="small" color="error" label={`${errorCount} error${errorCount === 1 ? '' : 's'}`} />}
              {warningCount > 0 && <Chip size="small" color="warning" label={`${warningCount} warning${warningCount === 1 ? '' : 's'}`} />}
            </Box>
          )}
        </DialogTitle>
        <DialogContent dividers>
          {loading ? (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 3, justifyContent: 'center' }}>
              <CircularProgress size={22} />
              <Typography color="text.secondary">Checking flow…</Typography>
            </Box>
          ) : issues && issues.length === 0 ? (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 3, justifyContent: 'center' }}>
              <CheckCircleIcon color="success" />
              <Typography>No problems found — this flow looks runnable.</Typography>
            </Box>
          ) : (
            <List dense disablePadding>
              {(issues ?? []).map((issue, i) => {
                const clickable = !!issue.nodeId;
                const content = (
                  <>
                    <ListItemIcon sx={{ minWidth: 36 }}>
                      {issue.severity === 'error' ? (
                        <ErrorOutlineIcon color="error" fontSize="small" />
                      ) : (
                        <WarningAmberIcon color="warning" fontSize="small" />
                      )}
                    </ListItemIcon>
                    <ListItemText
                      primary={issue.message}
                      secondary={clickable ? `Node: ${issue.nodeLabel ?? issue.nodeId} — click to open` : undefined}
                    />
                  </>
                );
                return clickable ? (
                  <ListItemButton key={i} onClick={() => goToNode(issue.nodeId)} alignItems="flex-start">
                    {content}
                  </ListItemButton>
                ) : (
                  <ListItem key={i} alignItems="flex-start">
                    {content}
                  </ListItem>
                );
              })}
            </List>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={runCheck} disabled={loading}>
            Re-check
          </Button>
          <Button onClick={() => setOpen(false)} variant="contained">
            Close
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
};

export default FlowValidationButton;
