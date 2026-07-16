"use client";

import React, { useState, useEffect, useCallback } from 'react';
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
} from '@mui/material';
import DescriptionIcon from '@mui/icons-material/Description';
import { FlowNode } from '@/frontend/types/flow/flow';
import { useServerStatus } from '@/frontend/hooks/useServerStatus';
import { mcpService } from '@/frontend/services/mcp';
import { isValidRunVarName } from '@/utils/shared/resolveRunVars';
import { createLogger } from '@/utils/logger/index';

const log = createLogger('frontend/components/Flow/FlowManager/FlowBuilder/Modals/ResourceNodePropertiesModal');

interface ResourceNodePropertiesModalProps {
  open: boolean;
  node: FlowNode | null;
  onClose: () => void;
  onSave: (nodeId: string, data: any) => void;
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
 *  - 'mcp': a STATIC resource on an MCP server (server + uri, with a browser
 *    over the server's published resources plus a free-text URI field for
 *    templates/unlisted URIs);
 *  - 'run': a RUN artifact — a named piece of data some step produces
 *    (process → resource edge, equivalent to captureResource) and other steps
 *    consume (resource → process edge, or `${res:NAME}`).
 */
export const ResourceNodePropertiesModal = ({ open, node, onClose, onSave }: ResourceNodePropertiesModalProps) => {
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

  useEffect(() => {
    if (node) {
      setNodeData({
        ...node.data,
        properties: { scope: 'mcp', ...node.data.properties },
      });
    }
  }, [node, open]);

  const scope: 'mcp' | 'run' = nodeData?.properties?.scope === 'run' ? 'run' : 'mcp';
  const boundServer: string = nodeData?.properties?.boundServer || '';
  const uri: string = nodeData?.properties?.uri || '';
  const runName: string = nodeData?.properties?.runName || '';

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
            ...(result.resourceTemplates ?? []).map((t: any) => ({
              uri: t.uriTemplate, name: t.name ? `${t.name} (template)` : '(template)', description: t.description,
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
  }, [open, scope, boundServer]);

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
    onSave(node.id, { ...nodeData, properties });
  };

  const runNameInvalid = scope === 'run' && !!runName.trim() && !isValidRunVarName(runName.trim());

  if (!nodeData) return null;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Resource Node Properties</DialogTitle>
      <DialogContent>
        <Box display="flex" flexDirection="column" gap={2} mt={1}>
          <TextField
            label="Label"
            value={nodeData.label}
            onChange={(e) => setNodeData({ ...nodeData, label: e.target.value })}
            fullWidth
          />
          <TextField
            label="Description"
            value={nodeData.description ?? ''}
            onChange={(e) => setNodeData({ ...nodeData, description: e.target.value })}
            fullWidth
            multiline
            minRows={2}
          />

          <FormControl>
            <RadioGroup
              row
              value={scope}
              onChange={(e) => setProperty('scope', e.target.value === 'run' ? 'run' : 'mcp')}
            >
              <FormControlLabel value="mcp" control={<Radio />} label="MCP resource" />
              <FormControlLabel value="run" control={<Radio />} label="Run artifact" />
            </RadioGroup>
            <FormHelperText>
              {scope === 'mcp'
                ? 'A static resource published by an MCP server. Steps connected FROM this node receive its contents.'
                : 'A named piece of run data: a step writing INTO this node saves its output here; steps reading FROM it receive the latest value (also available as ${res:NAME}).'}
            </FormHelperText>
          </FormControl>

          {scope === 'mcp' ? (
            <>
              <FormControl fullWidth>
                <InputLabel id="resource-server-label">Server</InputLabel>
                <Select
                  labelId="resource-server-label"
                  label="Server"
                  value={boundServer}
                  onChange={(e) => {
                    setProperty('boundServer', e.target.value);
                  }}
                >
                  {isLoadingServers && <MenuItem value="" disabled>Loading servers…</MenuItem>}
                  {servers.map((s: any) => (
                    <MenuItem key={s.name} value={s.name}>{s.name}</MenuItem>
                  ))}
                </Select>
              </FormControl>

              <TextField
                label="Resource URI"
                value={uri}
                onChange={(e) => setProperty('uri', e.target.value)}
                fullWidth
                placeholder="e.g. file:///data/report.md"
                helperText="Pick from the list below or paste a URI / filled-in template."
              />

              {isBrowsing && (
                <Box display="flex" alignItems="center" gap={1}>
                  <CircularProgress size={18} />
                  <Typography variant="body2" color="text.secondary">Loading resources…</Typography>
                </Box>
              )}
              {browseError && (
                <Typography variant="body2" color="warning.main">
                  Could not list resources: {browseError}
                </Typography>
              )}
              {!isBrowsing && !browseError && boundServer && browsed.length === 0 && (
                <Typography variant="body2" color="text.secondary">
                  This server publishes no resources (you can still paste a URI above).
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
              <TextField
                label="Artifact name"
                value={runName}
                onChange={(e) => setProperty('runName', e.target.value)}
                fullWidth
                error={runNameInvalid}
                helperText={runNameInvalid
                  ? 'Letters, digits, _ and - only; must not start with a digit.'
                  : 'Steps reference it as ${res:NAME}; a producing edge saves the step output under this name.'}
              />
              {runName.trim() && !runNameInvalid && (
                <Typography variant="caption" color="text.secondary">
                  URI at run time: flujo://run/&lt;conversation&gt;/… (named "{runName.trim()}")
                </Typography>
              )}
            </>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button onClick={handleSave} variant="contained">Save</Button>
      </DialogActions>
    </Dialog>
  );
};

export default ResourceNodePropertiesModal;
