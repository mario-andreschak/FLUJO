'use client';

import React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Box, Chip, Stack, Tooltip, Typography } from '@mui/material';
import BoltIcon from '@mui/icons-material/Bolt';
import UnfoldMoreIcon from '@mui/icons-material/UnfoldMore';
import type { WaveChainNode } from '@/shared/types/waves/waves';
import { triggerKindMeta } from './triggerKindMeta';
import { formatIn } from './waveTimeline';
import SubflowTree from './SubflowTree';

export interface TriggerChainNodeData {
  chainNode: WaveChainNode;
  /** Current clock (ms) for the live "until next run" label. */
  now: number;
  /** Fire time (ms) for a root instance on the timeline, when known. */
  runAt: number | null;
  isRoot: boolean;
  /** Downstream successors exist that can be revealed on hover. */
  hasSuccessors: boolean;
  /** Its next level is currently expanded. */
  expanded: boolean;
  [key: string]: unknown;
}

/**
 * A read-only React Flow custom node representing one planned execution in a
 * chain: trigger-kind badge, execution name, bound flow, timing, its emitted
 * signals (#144), and the statically-resolved subflow tree. Downstream links are
 * revealed by hovering (handled by the canvas).
 */
export default function TriggerChainNode({ data }: NodeProps) {
  const { chainNode, now, runAt, isRoot, hasSuccessors, expanded } =
    data as unknown as TriggerChainNodeData;
  const meta = triggerKindMeta(chainNode.triggerKind);

  let timingLabel = '';
  if (chainNode.timing.mode === 'timeline') {
    timingLabel = isRoot ? formatIn(runAt, now) : 'on schedule';
  } else if (chainNode.timing.mode === 'fixed') {
    timingLabel = 'fires when it happens';
  } else if (chainNode.timing.mode === 'event') {
    timingLabel =
      chainNode.timing.via === 'signal'
        ? `on signal "${chainNode.timing.topic ?? ''}"`
        : 'when its upstream runs';
  }

  const signals = chainNode.emittedSignals ?? [];

  return (
    <Box
      sx={{
        minWidth: 220,
        maxWidth: 260,
        borderRadius: 1,
        border: '1px solid rgba(0,0,0,0.15)',
        borderTop: `4px solid ${meta.color}`,
        outline: expanded ? `2px solid ${meta.color}` : 'none',
        bgcolor: 'background.paper',
        boxShadow: expanded ? 4 : 2,
        p: 1,
        opacity: chainNode.enabled ? 1 : 0.55,
        transition: 'box-shadow 120ms ease, outline-color 120ms ease',
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: meta.color }} />
      <Handle type="target" position={Position.Top} id="up" style={{ background: meta.color }} />
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 0.5 }}>
        <Chip
          label={meta.label}
          size="small"
          sx={{ bgcolor: meta.color, color: '#fff', height: 18, fontSize: 10 }}
        />
        {isRoot && (
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

      {signals.length > 0 && (
        <Box sx={{ mt: 0.5 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.25 }}>
            <BoltIcon sx={{ fontSize: 13, color: '#7b1fa2' }} />
            <Typography variant="caption" sx={{ opacity: 0.7 }}>
              Signals
            </Typography>
          </Box>
          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
            {signals.map((s) => (
              <Tooltip
                key={s.topic}
                title={s.direct ? 'Emitted by this flow' : 'Emitted via a subflow'}
                arrow
              >
                <Chip
                  label={s.topic}
                  size="small"
                  variant={s.direct ? 'filled' : 'outlined'}
                  sx={{
                    height: 18,
                    fontSize: 10,
                    bgcolor: s.direct ? 'rgba(123,31,162,0.12)' : 'transparent',
                    borderColor: 'rgba(123,31,162,0.4)',
                    color: '#7b1fa2',
                  }}
                />
              </Tooltip>
            ))}
          </Stack>
        </Box>
      )}

      <SubflowTree subflows={chainNode.subflows} />

      {hasSuccessors && !expanded && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25, mt: 0.5, opacity: 0.55 }}>
          <UnfoldMoreIcon sx={{ fontSize: 13, transform: 'rotate(90deg)' }} />
          <Typography variant="caption" sx={{ fontSize: 10 }}>
            hover to follow chain
          </Typography>
        </Box>
      )}

      <Handle type="source" position={Position.Right} style={{ background: meta.color }} />
      <Handle type="source" position={Position.Bottom} id="down" style={{ background: meta.color }} />
    </Box>
  );
}
