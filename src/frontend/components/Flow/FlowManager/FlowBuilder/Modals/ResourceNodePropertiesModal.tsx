"use client";

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Typography,
  Box,
  Radio,
  RadioGroup,
  FormControlLabel,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  CircularProgress,
  FormHelperText,
  Collapse,
  Link,
  Autocomplete,
} from '@mui/material';
import DescriptionIcon from '@mui/icons-material/Description';
import { FlowNode } from '@/frontend/types/flow/flow';
import { useServerStatus } from '@/frontend/hooks/useServerStatus';
import { mcpService } from '@/frontend/services/mcp';
import { isValidRunVarName } from '@/utils/shared/resolveRunVars';
import { extractResourceRefNames } from '@/utils/shared/promptRefs';
import { createLogger } from '@/utils/logger/index';
import { useI18n } from '@/frontend/contexts/I18nContext';

const log = createLogger('frontend/components/Flow/FlowManager/FlowBuilder/Modals/ResourceNodePropertiesModal');

// The default label createNode() gives a fresh resource node. Used to decide
// whether the (now hidden) Advanced section should auto-open on edit.
const DEFAULT_RESOURCE_LABEL = 'Resource Node';

interface ResourceNodePropertiesModalProps {
  open: boolean;
  node: FlowNode | null;
  onClose: () => void;
  onSave: (nodeId: string, data: any) => void;
  /** All nodes on the current canvas — used to auto-suggest `${res:NAME}` names
   *  already referenced elsewhere in this flow (issue #183 item 4). */
  flowNodes?: FlowNode[];
}

interface BrowsedResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

/**
 * Properties modal for the resource node (Tier 3).
 *
 * Two binding scopes:
 *  - 'run' (user-facing: "Temporary Data"): a RUN artifact — a named piece of
 *    data some step produces (process → resource edge, equivalent to
 *    captureResource) and other steps consume (resource → process edge, or
 *    `${res:NAME}`). This is the DEFAULT (issue #183) — it is the common case.
 *  - 'mcp' (user-facing: "MCP resource"): a STATIC resource on an MCP server
 *    (server + uri, with a browser over the server's published resources plus a
 *    free-text URI field for templates/unlisted URIs).
 *
 * NOTE: the internal scope values ('run' / 'mcp') are STABLE and part of the
 * persisted contract — only their human-facing labels changed in #183.
 */
export const ResourceNodePropertiesModal = ({ open, node, onClose, onSave, flowNodes }: ResourceNodePropertiesModalProps) => {
  const { t } = useI18n();
  const [nodeData, setNodeData] = useState<{
    label: string;
    type: string;
    description?: string;
    properties: Record<string, any>;
  } | null>(null);

  const { servers, isLoading: isLoadingServers } = useServerStatus();

  const [browsed, setBrowsed] = useState<BrowsedResource[]>([]);
  const [isBrowsing, setIsBrowsing] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  // Name/Description are advanced (#183 item 1): hidden by default, revealed on
  // demand. Auto-open when the node already carries a custom label/description
  // so re-editing an existing node keeps them visible.
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    if (node) {
      setNodeData({
        ...node.data,
        // #183 item 2: new resource nodes default to the run-scoped ("Temporary
        // Data") type; an existing node's explicit scope is preserved by the spread.
        properties: { scope: 'run', ...node.data.properties },
      });
      const hasCustomLabel = !!node.data.label && node.data.label.trim() !== DEFAULT_RESOURCE_LABEL;
      const hasDescription = !!node.data.description && node.data.description.trim().length > 0;
      setShowAdvanced(hasCustomLabel || hasDescription);
    }
  }, [node, open]);

  const scope: 'mcp' | 'run' = nodeData?.properties?.scope === 'mcp' ? 'mcp' : 'run';
  const boundServer: string = nodeData?.properties?.boundServer || '';
  const uri: string = nodeData?.properties?.uri || '';
  const runName: string = nodeData?.properties?.runName || '';

  // Temporary Data names already referenced (`${res:NAME}`) elsewhere in this
  // flow, to auto-suggest as the artifact name (#183 item 4). Scan every OTHER
  // node's properties (promptTemplate, spawnBriefs, subflow inputs, …).
  const nameSuggestions = useMemo(() => {
    const texts = (flowNodes ?? [])
      .filter((n) => n.id !== node?.id)
      .map((n) => {
        try {
          return JSON.stringify(n.data?.properties ?? {});
        } catch {
          return '';
        }
      });
    return extractResourceRefNames(texts);
  }, [flowNodes, node?.id]);

  const setProperty = useCallback((key: string, value: unknown) => {
    setNodeData((prev) => prev ? { ...prev, properties: { ...prev.properties, [key]: value } } : prev);
  }, []);

  // Browse the selected server's published resources (static scope).
  useEffect(() => {
    if (!open || scope !== 'mcp' || !boundServer) {
      setBrowsed([]);
      setBrowseError(null);
      return;
    }
    let cancelled = false;
    setIsBrowsing(true);
    setBrowseError(null);
    mcpService.listServerResources(boundServer)
      .then((result) => {
        if (cancelled) return;
        if (result.error) {
          setBrowseError(result.error);
          setBrowsed([]);
        } else {
          const list: BrowsedResource[] = [
            ...(result.resources ?? []).map((r: any) => ({
              uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType,
            })),
            // Templates are offered too — picking one puts the raw uriTemplate
            // in the field for the user to fill in.
            ...(result.resourceTemplates ?? []).map((template: any) => ({
              uri: template.uriTemplate,
              name: template.name
                ? `${template.name} (${t('flows.resource.template')})`
                : `(${t('flows.resource.template')})`,
              description: template.description,
            })),
          ];
          setBrowsed(list);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          log.warn(`Failed to browse resources of ${boundServer}`, error);
          setBrowseError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => { if (!cancelled) setIsBrowsing(false); });
    return () => { cancelled = true; };
  }, [open, scope, boundServer, t]);

  const handleSave = () => {
    if (!node || !nodeData) return;
    // Persist only the fields of the active scope so a scope switch doesn't
    // leave stale bindings behind.
    const properties: Record<string, any> = { ...nodeData.properties };
    if (scope === 'run') {
      delete properties.boundServer;
      delete properties.uri;
      delete properties.mimeType;
      properties.scope = 'run';
      properties.runName = runName.trim();
    } else {
      delete properties.runName;
      properties.scope = 'mcp';
    }
    // Name is now optional/advanced (#183 item 1): fall back to a sensible
    // header so a name-less node still reads clearly on the canvas.
    const trimmedLabel = (nodeData.label ?? '').trim();
    const label = trimmedLabel
      || (scope === 'run' ? (runName.trim() || t('flows.resource.temporary')) : t('flows.resource.mcp'));
    onSave(node.id, { ...nodeData, label, properties });
  };

  const runNameInvalid = scope === 'run' && !!runName.trim() && !isValidRunVarName(runName.trim());

  if (!nodeData) return null;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{t('flows.resource.title')}</DialogTitle>
      <DialogContent>
        <Box display="flex" flexDirection="column" gap={2} mt={1}>
          <FormControl>
            <RadioGroup
              row
              value={scope}
              onChange={(e) => setProperty('scope', e.target.value === 'mcp' ? 'mcp' : 'run')}
            >
              <FormControlLabel value="run" control={<Radio />} label={t('flows.resource.temporary')} />
              <FormControlLabel value="mcp" control={<Radio />} label={t('flows.resource.mcp')} />
            </RadioGroup>
            <FormHelperText>
              {scope === 'mcp'
                ? t('flows.resource.mcpHelp')
                : t('flows.resource.temporaryHelp')}
            </FormHelperText>
          </FormControl>

          {scope === 'mcp' ? (
            <>
              <FormControl fullWidth>
                <InputLabel id="resource-server-label">{t('flows.resource.server')}</InputLabel>
                <Select
                  labelId="resource-server-label"
                  label={t('flows.resource.server')}
                  value={boundServer}
                  onChange={(e) => {
                    setProperty('boundServer', e.target.value);
                  }}
                >
                  {isLoadingServers && <MenuItem value="" disabled>{t('flows.resource.loadingServers')}</MenuItem>}
                  {servers.map((s: any) => (
                    <MenuItem key={s.name} value={s.name}>{s.name}</MenuItem>
                  ))}
                </Select>
              </FormControl>

              <TextField
                label={t('flows.resource.uri')}
                value={uri}
                onChange={(e) => setProperty('uri', e.target.value)}
                fullWidth
                placeholder={t('flows.resource.uriPlaceholder')}
                helperText={t('flows.resource.uriHelp')}
              />

              {isBrowsing && (
                <Box display="flex" alignItems="center" gap={1}>
                  <CircularProgress size={18} />
                  <Typography variant="body2" color="text.secondary">{t('flows.resource.loading')}</Typography>
                </Box>
              )}
              {browseError && (
                <Typography variant="body2" color="warning.main">
                  {t('flows.resource.loadFailed', { error: browseError })}
                </Typography>
              )}
              {!isBrowsing && !browseError && boundServer && browsed.length === 0 && (
                <Typography variant="body2" color="text.secondary">
                  {t('flows.resource.none')}
                </Typography>
              )}
              {browsed.length > 0 && (
                <List dense sx={{ maxHeight: 240, overflow: 'auto', border: 1, borderColor: 'divider', borderRadius: 1 }}>
                  {browsed.map((r) => (
                    <ListItemButton
                      key={r.uri}
                      selected={r.uri === uri}
                      onClick={() => setProperty('uri', r.uri)}
                    >
                      <ListItemIcon sx={{ minWidth: 34 }}>
                        <DescriptionIcon fontSize="small" sx={{ color: '#009688' }} />
                      </ListItemIcon>
                      <ListItemText
                        primary={r.name || r.uri}
                        secondary={r.name ? r.uri : r.description}
                        secondaryTypographyProps={{ sx: { wordBreak: 'break-all' } }}
                      />
                    </ListItemButton>
                  ))}
                </List>
              )}
            </>
          ) : (
            <>
              <Autocomplete
                freeSolo
                options={nameSuggestions}
                inputValue={runName}
                onInputChange={(_e, value) => setProperty('runName', value)}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label={t('flows.resource.temporaryName')}
                    fullWidth
                    error={runNameInvalid}
                    helperText={runNameInvalid
                      ? t('flows.resource.invalidName')
                      : nameSuggestions.length > 0
                        ? t('flows.resource.nameSuggestions')
                        : t('flows.resource.nameHelp')}
                  />
                )}
              />
              {runName.trim() && !runNameInvalid && (
                <Typography variant="caption" color="text.secondary">
                  {t('flows.resource.runtimeUri', { name: runName.trim() })}
                </Typography>
              )}
            </>
          )}

          <Link
            component="button"
            type="button"
            underline="hover"
            onClick={() => setShowAdvanced((v) => !v)}
            sx={{ alignSelf: 'flex-start' }}
          >
            {showAdvanced ? t('flows.resource.hideAdvanced') : t('flows.resource.showAdvanced')}
          </Link>
          <Collapse in={showAdvanced} unmountOnExit>
            <Box display="flex" flexDirection="column" gap={2}>
              <TextField
                label={t('flows.resource.label')}
                value={nodeData.label}
                onChange={(e) => setNodeData({ ...nodeData, label: e.target.value })}
                fullWidth
                helperText={t('flows.resource.labelHelp')}
              />
              <TextField
                label={t('flows.resource.description')}
                value={nodeData.description ?? ''}
                onChange={(e) => setNodeData({ ...nodeData, description: e.target.value })}
                fullWidth
                multiline
                minRows={2}
              />
            </Box>
          </Collapse>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('flows.modal.cancel')}</Button>
        <Button onClick={handleSave} variant="contained">{t('flows.modal.save')}</Button>
      </DialogActions>
    </Dialog>
  );
};

export default ResourceNodePropertiesModal;
