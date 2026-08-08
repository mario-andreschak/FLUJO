"use client";

import React from 'react';
import { Box, Typography } from '@mui/material';
import { useI18n } from '@/frontend/contexts/I18nContext';
import type { NodeInformationViewModel } from './nodeInformation';

interface NodeTechnicalDetailsProps {
  /** Prepared, sanitized view model produced by `buildNodeInformation()`. */
  information: NodeInformationViewModel;
  /** Optional DOM id so hosts can wire `aria-describedby`/`aria-controls`. */
  id?: string;
}

/**
 * Read-only presentation of a node's technical details (issue #412).
 *
 * The technical view used to live inside every FlowBuilder canvas node; it is
 * now rendered by the Inspector's technical-details modal instead. The
 * rendering is intentionally dumb: it only prints the already sanitized
 * `technicalText` produced by `buildNodeInformation()` (500-char strings, 12
 * array entries, 20 object fields, depth 3, sensitive keys filtered), so no
 * raw node property can leak into the UI through this component.
 */
export const NodeTechnicalDetails = ({ information, id }: NodeTechnicalDetailsProps) => {
  const { t } = useI18n();
  const text = information.technicalText;

  if (!text.trim()) {
    return (
      <Typography id={id} variant="body2" color="text.secondary">
        {t('flows.nodeInfo.technicalEmpty')}
      </Typography>
    );
  }

  return (
    <Box
      id={id}
      component="pre"
      tabIndex={0}
      sx={{
        m: 0,
        p: 1.5,
        maxHeight: { xs: '50vh', sm: '60vh' },
        overflow: 'auto',
        // Long-but-valid values must wrap instead of widening the dialog.
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        fontSize: '0.75rem',
        lineHeight: 1.45,
        backgroundColor: 'action.hover',
        borderRadius: 1,
      }}
    >
      {text}
    </Box>
  );
};

export default NodeTechnicalDetails;
