"use client";

import React from 'react';
import { Fab, Fade, Stack } from '@mui/material';
import type { SxProps, Theme } from '@mui/material/styles';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import SubdirectoryArrowLeftIcon from '@mui/icons-material/SubdirectoryArrowLeft';

export interface ScrollControlsStackProps {
  show?: boolean;
  onTop?: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  onBottom?: () => void;
  labels: { top: string; previous?: string; next?: string; bottom?: string };
  sx?: SxProps<Theme>;
}

export default function ScrollControlsStack({
  show = true, onTop, onPrevious, onNext, onBottom, labels, sx,
}: ScrollControlsStackProps) {
  if (!show) return null;
  return (
    <Fade in={show}>
      <Stack spacing={1} sx={{ position: 'fixed', right: 24, bottom: 24, zIndex: 1200, ...sx }}>
        {onTop && <Fab size="small" color="primary" aria-label={labels.top} onClick={onTop}><KeyboardArrowUpIcon /></Fab>}
        {onPrevious && <Fab size="small" aria-label={labels.previous} onClick={onPrevious}><SubdirectoryArrowLeftIcon /></Fab>}
        {onNext && <Fab size="small" aria-label={labels.next} onClick={onNext}><SubdirectoryArrowLeftIcon sx={{ transform: 'scaleY(-1)' }} /></Fab>}
        {onBottom && <Fab size="small" color="primary" aria-label={labels.bottom} onClick={onBottom}><KeyboardArrowDownIcon /></Fab>}
      </Stack>
    </Fade>
  );
}
