"use client";

import React, { useCallback, useEffect, useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Box,
  List,
  ListItemButton,
  ListItemText,
  Typography,
  CircularProgress,
  Divider,
  Chip,
} from '@mui/material';
import RestoreIcon from '@mui/icons-material/Restore';
import { Flow } from '@/shared/types/flow';
import { flowService, FlowVersionSummary } from '@/frontend/services/flow';
import { FlowPreview } from '../FlowPreview';
import { createLogger } from '@/utils/logger';

const log = createLogger('components/flow/FlowBuilder/Modals/FlowVersionHistoryDialog');

interface FlowVersionHistoryDialogProps {
  open: boolean;
  flowId?: string;
  onClose: () => void;
  /**
   * Stage the chosen version's definition onto the builder canvas as an
   * unsaved, undoable change. Nothing is persisted until the user hits Save.
   */
  onRestore: (flow: Flow) => void;
}

function formatSavedAt(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

const FlowVersionHistoryDialog: React.FC<FlowVersionHistoryDialogProps> = ({
  open,
  flowId,
  onClose,
  onRestore,
}) => {
  const [loadingList, setLoadingList] = useState(false);
  const [versions, setVersions] = useState<FlowVersionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewFlow, setPreviewFlow] = useState<Flow | null>(null);

  // Load the version list whenever the dialog opens for a saved flow.
  useEffect(() => {
    if (!open || !flowId) return;
    let cancelled = false;
    setLoadingList(true);
    setVersions([]);
    setSelectedId(null);
    setPreviewFlow(null);
    flowService
      .listFlowVersions(flowId)
      .then((list) => {
        if (cancelled) return;
        setVersions(list);
      })
      .finally(() => {
        if (!cancelled) setLoadingList(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, flowId]);

  // Load the full definition for the selected version to preview it.
  const handleSelect = useCallback(
    (versionId: string) => {
      if (!flowId) return;
      setSelectedId(versionId);
      setLoadingPreview(true);
      setPreviewFlow(null);
      flowService
        .getFlowVersion(flowId, versionId)
        .then((record) => {
          if (record) {
            setPreviewFlow(record.flow);
          } else {
            log.warn(`Version ${versionId} could not be loaded (pruned?)`);
          }
        })
        .finally(() => setLoadingPreview(false));
    },
    [flowId]
  );

  const handleRestore = useCallback(() => {
    if (previewFlow) {
      onRestore(previewFlow);
    }
  }, [previewFlow, onRestore]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle>Version History</DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
        <Box sx={{ display: 'flex', height: '65vh' }}>
          {/* Version list */}
          <Box sx={{ width: 300, borderRight: 1, borderColor: 'divider', overflowY: 'auto' }}>
            {loadingList ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
                <CircularProgress size={28} />
              </Box>
            ) : versions.length === 0 ? (
              <Box sx={{ p: 3 }}>
                <Typography variant="body2" color="text.secondary">
                  No saved versions yet. A version is archived automatically each time you save a
                  change to this flow.
                </Typography>
              </Box>
            ) : (
              <List disablePadding>
                {versions.map((v, index) => (
                  <React.Fragment key={v.versionId}>
                    <ListItemButton
                      selected={v.versionId === selectedId}
                      onClick={() => handleSelect(v.versionId)}
                    >
                      <ListItemText
                        primary={
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                            <Typography variant="body2">{formatSavedAt(v.savedAt)}</Typography>
                            {index === 0 && <Chip label="most recent" size="small" />}
                          </Box>
                        }
                        secondary={`${v.nodeCount} node${v.nodeCount === 1 ? '' : 's'} · ${v.edgeCount} edge${v.edgeCount === 1 ? '' : 's'}`}
                      />
                    </ListItemButton>
                    <Divider component="li" />
                  </React.Fragment>
                ))}
              </List>
            )}
          </Box>

          {/* Preview */}
          <Box sx={{ flex: 1, position: 'relative', minWidth: 0 }}>
            {loadingPreview ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
                <CircularProgress size={32} />
              </Box>
            ) : previewFlow ? (
              <FlowPreview flow={previewFlow} />
            ) : (
              <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', p: 4 }}>
                <Typography variant="body2" color="text.secondary" align="center">
                  {versions.length === 0
                    ? 'Versions appear here after you save changes.'
                    : 'Select a version on the left to preview it.'}
                </Typography>
              </Box>
            )}
          </Box>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        <Button
          variant="contained"
          color="primary"
          startIcon={<RestoreIcon />}
          onClick={handleRestore}
          disabled={!previewFlow}
        >
          Restore this version
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default FlowVersionHistoryDialog;
