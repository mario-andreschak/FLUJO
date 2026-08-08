"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMediaQuery, useTheme } from '@mui/material';

export function useAutoHideControls(idleMs = 2500) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const [visible, setVisible] = useState(true);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reveal = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setVisible(true);
    if (isMobile) {
      timeoutRef.current = setTimeout(() => setVisible(false), idleMs);
    }
  }, [idleMs, isMobile]);

  useEffect(() => {
    reveal();
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [reveal]);

  return { visible: !isMobile || visible, reveal };
}
