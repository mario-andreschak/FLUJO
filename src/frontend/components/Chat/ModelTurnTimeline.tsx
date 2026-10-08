"use client";

import React, { useEffect, useMemo, useRef } from 'react';
import { Box, Chip, Tooltip, Typography } from '@mui/material';
import type { ModelTurnIndexEntry } from '@/shared/types/modelTurn';

interface ModelTurnTimelineProps {
  turns: ModelTurnIndexEntry[];
  selectedId: string | null;
  followLive: boolean;
  unseenCount: number;
  onSelect: (turn: ModelTurnIndexEntry, atEnd: boolean) => void;
}

const outcomeColor = (outcome: ModelTurnIndexEntry['outcome']): string => {
  if (outcome === 'error') return 'error.main';
  if (outcome === 'cancelled') return 'warning.main';
  if (outcome === 'running') return 'info.main';
  return 'success.main';
};

export default function ModelTurnTimeline({
  turns,
  selectedId,
  followLive,
  unseenCount,
  onSelect,
}: ModelTurnTimelineProps) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const selectedIndex = useMemo(() => {
    const index = turns.findIndex(turn => turn.id === selectedId);
    return index >= 0 ? index : turns.length - 1;
  }, [selectedId, turns]);

  useEffect(() => {
    const selected = railRef.current?.querySelector<HTMLElement>('[aria-current="step"]');
    selected?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [selectedId, turns.length]);

  if (turns.length === 0) return null;

  const selectIndex = (index: number) => {
    const safeIndex = Math.max(0, Math.min(turns.length - 1, index));
    const turn = turns[safeIndex];
    if (turn) onSelect(turn, safeIndex === turns.length - 1);
  };

  return (
    <Box
      data-testid="model-turn-timeline"
      sx={{
        display: 'flex',
        alignItems: 'center',
        minWidth: 0,
        flex: { xs: '1 1 100%', md: '1 1 360px' },
        gap: 0.75,
      }}
    >
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: { xs: 'none', lg: 'block' }, whiteSpace: 'nowrap' }}
      >
        Model turns
      </Typography>
      <Box
        ref={railRef}
        role="listbox"
        aria-label="Model turn timeline"
        tabIndex={0}
        onWheel={event => {
          if (event.deltaY === 0 && event.deltaX === 0) return;
          event.preventDefault();
          selectIndex(selectedIndex + (event.deltaY + event.deltaX > 0 ? 1 : -1));
        }}
        onKeyDown={event => {
          if (event.key === 'ArrowRight') {
            event.preventDefault();
            selectIndex(selectedIndex + 1);
          } else if (event.key === 'ArrowLeft') {
            event.preventDefault();
            selectIndex(selectedIndex - 1);
          } else if (event.key === 'End') {
            event.preventDefault();
            selectIndex(turns.length - 1);
          } else if (event.key === 'Home') {
            event.preventDefault();
            selectIndex(0);
          }
        }}
        sx={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          gap: '5px',
          minWidth: 80,
          maxWidth: { xs: '100%', md: 360 },
          px: 1,
          py: 0.5,
          overflowX: 'auto',
          scrollbarWidth: 'none',
          borderRadius: 999,
          bgcolor: 'action.hover',
          '&::-webkit-scrollbar': { display: 'none' },
          '&::before': {
            content: '""',
            position: 'absolute',
            left: 12,
            right: 12,
            top: '50%',
            height: 1,
            bgcolor: 'divider',
          },
        }}
      >
        {turns.map((turn, index) => {
          const selected = turn.id === selectedId;
          const tooltip = `${index + 1}. ${turn.node.nodeName || turn.node.nodeId} · ${turn.modelName} · ${new Date(turn.timestamp).toLocaleTimeString()}`;
          return (
            <Tooltip key={turn.id} title={tooltip} arrow>
              <Box
                component="button"
                type="button"
                role="option"
                aria-selected={selected}
                aria-current={selected ? 'step' : undefined}
                aria-label={tooltip}
                onClick={() => selectIndex(index)}
                sx={{
                  position: 'relative',
                  zIndex: 1,
                  flex: '0 0 auto',
                  width: selected ? 10 : 7,
                  height: selected ? 22 : 14,
                  p: 0,
                  border: 0,
                  borderRadius: 999,
                  cursor: 'pointer',
                  bgcolor: outcomeColor(turn.outcome),
                  opacity: selected ? 1 : 0.62,
                  boxShadow: selected ? theme => `0 0 0 3px ${theme.palette.background.paper}` : 'none',
                  transition: 'height 120ms ease, width 120ms ease, opacity 120ms ease',
                  '&:hover, &:focus-visible': { opacity: 1, outline: 'none' },
                }}
              />
            </Tooltip>
          );
        })}
      </Box>
      <Chip
        size="small"
        color={followLive ? 'success' : unseenCount > 0 ? 'primary' : 'default'}
        variant={followLive ? 'filled' : 'outlined'}
        label={followLive ? 'Live' : unseenCount > 0 ? `${unseenCount} new` : 'History'}
        onClick={unseenCount > 0 ? () => selectIndex(turns.length - 1) : undefined}
        sx={{ flexShrink: 0, height: 22 }}
      />
    </Box>
  );
}

