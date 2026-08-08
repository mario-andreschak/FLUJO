"use client";

import React, { useMemo } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  Divider,
} from '@mui/material';
import type { FlowNode, NodeType } from '@/frontend/types/flow/flow';
import { useI18n } from '@/frontend/contexts/I18nContext';
import DialogHeaderActions from '@/frontend/components/shared/DialogHeaderActions';
import { buildNodeInformation } from '../CustomNodes/nodeInformation';
import NodeTechnicalDetails from '../CustomNodes/NodeTechnicalDetails';

export interface NodeTechnicalDetailsModalProps {
  open: boolean;
  /** The node whose technical details are displayed; `null` renders nothing. */
  node: FlowNode | null;
  /** Flow id → flow name, so subflow targets resolve to readable names. */
  flowNames?: ReadonlyMap<string, string>;
  onClose: () => void;
}

const TITLE_ID = 'node-technical-details-title';

/**
 * Read-only technical-details dialog for the selected FlowBuilder node
 * (issue #412).
 *
 * The canvas nodes no longer carry an inline "Technical details" accordion —
 * the Inspector exposes this dialog as its last actionable option instead.
 * Content is produced exclusively by `buildNodeInformation()`, which is the
 * same sanitizing pipeline the canvas summary uses, so raw/unbounded/sensitive
 * node properties can never be rendered here.
 */
export const NodeTechnicalDetailsModal = ({
  open,
  node,
  flowNames,
  onClose,
}: NodeTechnicalDetailsModalProps) => {
  const { t, tp, formatList } = useI18n();

  const information = useMemo(() => {
    if (!node) return null;
    const nodeType = (node.data?.type ?? node.type ?? 'process') as NodeType;
    return buildNodeInformation(node.data, nodeType, { t, tp, formatList }, flowNames);
  }, [node, flowNames, t, tp, formatList]);

  return (
    <Dialog
      open={open && !!information}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      aria-labelledby={TITLE_ID}
      PaperProps={{
        sx: {
          m: { xs: 1, sm: 4 },
          width: { xs: 'calc(100% - 16px)', sm: '100%' },
          maxWidth: { xs: 'calc(100% - 16px)', sm: 600 },
          maxHeight: { xs: 'calc(100dvh - 16px)', sm: '85vh' },
        },
      }}
    >
      <DialogHeaderActions
        title={t('flows.nodeInfo.technicalTitle', { name: information?.label ?? '' })}
        onClose={onClose}
        titleProps={{ id: TITLE_ID, sx: { minWidth: 0, overflowWrap: 'anywhere' } }}
      />
      <Divider />
      <DialogContent sx={{ px: { xs: 2, sm: 3 }, py: 2 }}>
        {information && <NodeTechnicalDetails information={information} />}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('common.close')}</Button>
      </DialogActions>
    </Dialog>
  );
};

export default NodeTechnicalDetailsModal;
