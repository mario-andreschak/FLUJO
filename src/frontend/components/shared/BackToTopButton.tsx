"use client";

import React from 'react';
import { Fab, Fade } from '@mui/material';
import type { SxProps, Theme } from '@mui/material/styles';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';

export interface BackToTopButtonProps {
  /** Whether the button is visible (typically driven by useScrollRestoration). */
  show: boolean;
  /** Scroll the active container/window back to the top. */
  onClick: () => void;
  /** Override/extend positioning. Defaults to fixed bottom-right. */
  sx?: SxProps<Theme>;
}

/**
 * Presentational "back to top" button (#185). Purely driven by props so it is
 * trivially testable; the scroll wiring lives in `useScrollRestoration`.
 *
 * Positioned `fixed` bottom-right by default so it stays pinned to the viewport
 * regardless of which element is doing the scrolling (these list pages scroll
 * the document, not an inner box).
 */
export default function BackToTopButton({ show, onClick, sx }: BackToTopButtonProps) {
  return (
    <Fade in={show} unmountOnExit>
      <Fab
        size="small"
        color="primary"
        aria-label="Back to top"
        onClick={onClick}
        sx={{ position: 'fixed', bottom: 24, right: 24, zIndex: 1200, ...sx }}
      >
        <KeyboardArrowUpIcon />
      </Fab>
    </Fade>
  );
}
