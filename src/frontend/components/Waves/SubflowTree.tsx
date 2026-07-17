'use client';

import React from 'react';
import { Box, Typography } from '@mui/material';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import type { WaveSubflowRef } from '@/shared/types/waves/waves';

interface SubflowTreeProps {
  subflows: WaveSubflowRef[];
  depth?: number;
}

/**
 * Renders a nested subflow call tree under a chain node. Missing/truncated
 * references are annotated so the picture stays truthful.
 */
export default function SubflowTree({ subflows, depth = 0 }: SubflowTreeProps) {
  if (!subflows || subflows.length === 0) return null;
  return (
    <Box sx={{ pl: depth === 0 ? 0 : 1.5, mt: 0.25 }}>
      {subflows.map((ref, i) => (
        <Box key={`${ref.flowId}-${i}`} sx={{ borderLeft: depth > 0 ? '1px dashed rgba(0,0,0,0.2)' : 'none', pl: depth > 0 ? 1 : 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <AccountTreeIcon sx={{ fontSize: 12, opacity: 0.6 }} />
            <Typography variant="caption" sx={{ opacity: ref.missing ? 0.6 : 0.85, fontStyle: ref.missing ? 'italic' : 'normal' }}>
              {ref.flowName ?? ref.flowId}
              {ref.missing ? ' (missing)' : ''}
              {ref.truncated ? ' …' : ''}
            </Typography>
          </Box>
          {ref.children.length > 0 && <SubflowTree subflows={ref.children} depth={depth + 1} />}
        </Box>
      ))}
    </Box>
  );
}
