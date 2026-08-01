"use client";

import React, { useState, useCallback, useEffect, useId, useRef } from 'react';
import {
  Button,
  ClickAwayListener,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Box,
  Typography,
  CircularProgress,
  Chip,
  Divider,
  Paper,
  Popper,
} from '@mui/material';
import FactCheckIcon from '@mui/icons-material/FactCheck';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { FlowNode } from '@/frontend/types/flow/flow';
import { Edge } from '@xyflow/react';
import {
  validateFlow,
  FlowValidationIssue,
  type FileAccessMcpServerSnapshot,
  type FileAccessMcpSnapshot,
  type FileAccessMcpUsability,
} from '@/utils/shared/flowValidation';
import { modelService } from '@/frontend/services/model';
import { mcpService } from '@/frontend/services/mcp';
import { MCPServerConfig } from '@/shared/types/mcp';
import { createLogger } from '@/utils/logger';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { localizeFlowIssue } from '@/frontend/i18n/flowValidation';

const log = createLogger('components/flow/FlowBuilder/FlowValidationButton');

interface FlowValidationButtonProps {
  nodes: FlowNode[];
  edges: Edge[];
}

function fileAccessSnapshot(
  name: string,
  configs: MCPServerConfig[],
  usabilityByName: Map<string, FileAccessMcpUsability>
): FileAccessMcpServerSnapshot {
  const config = configs.find((candidate) => candidate.name === name);
  if (!config) {
    return { configured: false, disabled: false, usability: 'unavailable' };
  }
  const disabled = !!config.disabled;
  return {
    configured: true,
    disabled,
    usability: disabled ? 'unavailable' : (usabilityByName.get(name) ?? 'unknown'),
    roots: config.roots,
    rootPath: config.rootPath,
  };
}

/**
 * Toolbar action that runs the flow consistency checks (deleted/renamed models or MCP
 * servers, missing Start/Finish nodes, unreachable nodes, dangling tool references, …) and
 * lists what it finds. Clicking an issue opens the offending node's properties modal via the
 * `editNode` event the Canvas already listens for, so the user can jump straight to the fix.
 */
export const FlowValidationButton: React.FC<FlowValidationButtonProps> = ({ nodes, edges }) => {
  const { t, tp } = useI18n();
  const [open, setOpen] = useState(false);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [loading, setLoading] = useState(false);
  const [issues, setIssues] = useState<FlowValidationIssue[] | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const triggerId = useId();
  const dialogId = useId();
  const dialogTitleId = useId();

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      dialogRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const closeAndRestoreFocus = useCallback(() => {
    setOpen(false);
    window.requestAnimationFrame(() => {
      triggerRef.current?.focus();
    });
  }, []);

  const handleClickAway = useCallback(() => {
    const focusWasInside = dialogRef.current?.contains(document.activeElement);
    setOpen(false);
    if (focusWasInside) {
      window.requestAnimationFrame(() => {
        triggerRef.current?.focus();
      });
    }
  }, []);

  const runCheck = useCallback(async () => {
    setLoading(true);
    setCheckError(null);
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
      const loadedConfigs = Array.isArray(configs) ? (configs as MCPServerConfig[]) : undefined;
      const servers = loadedConfigs?.map(s => ({
        name: s.name,
        status: s.disabled ? 'disabled' : undefined,
      }));

      // Gather live tool lists for servers attached to this flow, plus every server
      // that declares host-path access. A successful empty list is still a known/connected
      // result; failures remain unknown and suppress conclusions about file access.
      const serverTools: Record<string, string[]> = {};
      const toolListUsability = new Map<string, FileAccessMcpUsability>();
      const fileAccessConfigs = loadedConfigs?.filter((config) => !!config.hostPathAccess) ?? [];
      const fileAccessNames = new Set(fileAccessConfigs.map((config) => config.name));
      if (loadedConfigs) {
        const disabledByName = new Map(loadedConfigs.map(s => [s.name, !!s.disabled]));
        const flowServers = new Set<string>();
        for (const n of nodes as any[]) {
          const nodeType = n?.data?.type ?? n?.type;
          const bound = n?.data?.properties?.boundServer;
          if (nodeType === 'mcp' && typeof bound === 'string' && bound) flowServers.add(bound);
        }
        for (const { name, disabled } of fileAccessConfigs) {
          if (!disabled) flowServers.add(name);
        }

        await Promise.all([...flowServers].map(async (name) => {
          if (disabledByName.get(name)) return;
          try {
            const res = await mcpService.listServerTools(name);
            if (!res.error && Array.isArray(res.tools)) {
              serverTools[name] = res.tools
                .map((tool: { name?: string }) => tool?.name)
                .filter((x): x is string => typeof x === 'string');
              toolListUsability.set(name, 'usable');
            } else if (fileAccessNames.has(name)) {
              toolListUsability.set(name, 'unknown');
            }
          } catch (error) {
            if (fileAccessNames.has(name)) toolListUsability.set(name, 'unknown');
            log.debug(`Could not gather MCP tool list for "${name}" during the flow check`, error);
          }
        }));
      }

      const fileAccessMcp: FileAccessMcpSnapshot | undefined = loadedConfigs
        ? Object.fromEntries(fileAccessConfigs.map((config) => [
            config.name,
            fileAccessSnapshot(config.name, loadedConfigs, toolListUsability),
          ]))
        : undefined;

      const result = validateFlow(
        { nodes, edges } as any,
        { models, servers, serverTools, fileAccessMcp }
      );
      setIssues(result.issues);
    } catch (error) {
      log.warn('Flow validation failed to run', error);
      setIssues(null);
      setCheckError(t('flows.validation.failed'));
    } finally {
      setLoading(false);
    }
  }, [nodes, edges, t]);

  const handleOpen = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    setAnchorEl(event.currentTarget);
    setOpen(true);
    setIssues(null);
    setCheckError(null);
    runCheck();
  }, [runCheck]);

  // Reveal the offending node in the persistent inspector instead of swapping
  // one blocking dialog for another.
  const goToNode = useCallback((nodeId?: string) => {
    if (!nodeId) return;
    closeAndRestoreFocus();
    document.dispatchEvent(new CustomEvent('selectNode', { detail: { nodeId } }));
  }, [closeAndRestoreFocus]);

  const errorCount = issues?.filter((i) => i.severity === 'error').length ?? 0;
  const warningCount = (issues?.length ?? 0) - errorCount;

  return (
    <>
      <Button
        ref={triggerRef}
        id={triggerId}
        variant="outlined"
        color="primary"
        onClick={handleOpen}
        startIcon={<FactCheckIcon />}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={dialogId}
        sx={{ textTransform: 'none' }}
      >
        {t('flows.validation.check')}
        {issues && issues.length > 0 && (
          <Chip
            size="small"
            color={errorCount > 0 ? 'error' : 'warning'}
            label={issues.length}
            sx={{ ml: 1, height: 20 }}
          />
        )}
      </Button>

      <Popper
        open={open}
        anchorEl={anchorEl}
        placement="bottom-end"
        sx={{ zIndex: (theme) => theme.zIndex.modal + 1 }}
        modifiers={[{ name: 'offset', options: { offset: [0, 10] } }]}
      >
        <ClickAwayListener onClickAway={handleClickAway}>
          <Paper
            ref={dialogRef}
            id={dialogId}
            role="dialog"
            aria-modal="false"
            aria-labelledby={dialogTitleId}
            aria-busy={loading}
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                closeAndRestoreFocus();
              }
            }}
            elevation={18}
            sx={{
              width: 'min(92vw, 440px)',
              maxHeight: 'min(68dvh, 560px)',
              overflow: 'hidden',
              border: 1,
              borderColor: 'divider',
              borderRadius: 3,
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2, py: 1.5 }}>
              <Typography id={dialogTitleId} variant="subtitle1" fontWeight={800}>{t('flows.validation.title')}</Typography>
              {issues && (
                <Box sx={{ display: 'flex', gap: 0.75, ml: 0.5 }}>
                  {errorCount > 0 && <Chip size="small" color="error" label={tp('flows.validation.error', errorCount)} />}
                  {warningCount > 0 && <Chip size="small" color="warning" label={tp('flows.validation.warning', warningCount)} />}
                </Box>
              )}
            </Box>
            <Divider />
            <Box sx={{ maxHeight: 'min(52dvh, 420px)', overflowY: 'auto', p: 1 }}>
              {loading ? (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 3, justifyContent: 'center' }}>
                  <CircularProgress size={22} />
                  <Typography color="text.secondary">{t('flows.validation.checking')}</Typography>
                </Box>
              ) : checkError ? (
                <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5, py: 2, px: 1 }}>
                  <ErrorOutlineIcon color="error" />
                  <Box>
                    <Typography fontWeight={700}>{t('flows.validation.unavailable')}</Typography>
                    <Typography variant="body2" color="text.secondary">{checkError}</Typography>
                  </Box>
                </Box>
              ) : issues && issues.length === 0 ? (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 3, px: 1, justifyContent: 'center' }}>
                  <CheckCircleIcon color="success" />
                  <Typography>{t('flows.validation.healthy')}</Typography>
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
                          primary={localizeFlowIssue(issue, t)}
                          secondary={clickable ? t('flows.validation.revealNode', { node: issue.nodeLabel ?? issue.nodeId ?? '' }) : undefined}
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
            </Box>
            <Divider />
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, p: 1 }}>
              <Button onClick={runCheck} disabled={loading}>{t('flows.validation.recheck')}</Button>
              <Button onClick={closeAndRestoreFocus} variant="contained">{t('flows.validation.done')}</Button>
            </Box>
          </Paper>
        </ClickAwayListener>
      </Popper>
    </>
  );
};

export default FlowValidationButton;
