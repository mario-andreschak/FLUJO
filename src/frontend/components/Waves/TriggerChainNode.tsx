'use client';

import React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Box, Chip, Typography } from '@mui/material';
import type { WaveChainNode } from '@/shared/types/waves/waves';
import { triggerKindMeta, formatUntil } from './triggerKindMeta';
import SubflowTree from './SubflowTree';

export interface TriggerChainNodeData {
  chainNode: WaveChainNode;
  /** Current clock (ms) for the live "until next run" label. */
  now: number;
  [key: string]: unknown;
}

/**
 * A read-only React Flow custom node representing one planned execution in a
 * chain: trigger-kind badge, execution name, bound flow, timing, and the
 * statically-resolved subflow tree.
 */
export default function TriggerChainNode({ data }: NodeProps) {
  const { chainNode, now } = data as unknown as TriggerChainNodeData;
  const meta = triggerKindMeta(chainNode.triggerKind);

  let timingLabel = '';
  if (chainNode.timing.mode === 'timeline') {
    timingLabel = formatUntil(chainNode.timing.nextRun, now);
  } else if (chainNode.timing.mode === 'fixed') {
    timingLabel = 'fires when it happens';
  } else if (chainNode.timing.mode === 'event') {
    timingLabel =
      chainNode.timing.via === 'signal'
        ? `on signal "${chainNode.timing.topic ?? ''}"`
        : 'on upstream completion';
  }

  return (
    <Box
      sx={{
        minWidth: 220,
        maxWidth: 260,
        borderRadius: 1,
        border: '1px solid rgba(0,0,0,0.15)',
        borderTop: `4px solid ${meta.color}`,
        bgcolor: 'background.paper',
        boxShadow: 2,
        p: 1,
        opacity: chainNode.enabled ? 1 : 0.55,
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: meta.color }} />
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 0.5 }}>
        <Chip
          label={meta.label}
          size="small"
          sx={{ bgcolor: meta.color, color: '#fff', height: 18, fontSize: 10 }}
        />
        {chainNode.isRoot && (
          <Typography variant="caption" sx={{ opacity: 0.6 }}>
            root
          </Typography>
        )}
      </Box>
      <Typography variant="subtitle2" sx={{ mt: 0.5, fontWeight: 600, lineHeight: 1.2 }} noWrap title={chainNode.name}>
        {chainNode.name}
      </Typography>
      <Typography variant="caption" sx={{ display: 'block', opacity: 0.75 }} noWrap title={chainNode.flowName ?? chainNode.flowId}>
        {chainNode.flowName ?? chainNode.flowId}
      </Typography>
      <Typography variant="caption" sx={{ display: 'block', mt: 0.25, color: meta.color, fontWeight: 500 }}>
        {timingLabel}
      </Typography>
      <SubflowTree subflows={chainNode.subflows} />
      <Handle type="source" position={Position.Right} style={{ background: meta.color }} />
    </Box>
  );
}
