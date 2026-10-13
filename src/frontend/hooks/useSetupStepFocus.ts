'use client';

import { useCallback, useId } from 'react';

/** Move focus during the step's DOM commit, before another Tab can reach the header. */
export function useSetupStepFocus(open: boolean) {
  const titleId = useId();
  const stepContentRef = useCallback((content: HTMLDivElement | null) => {
    if (!open || !content) return;
    const scroller = content.closest('.MuiDialogContent-root');
    if (scroller) scroller.scrollTop = 0;
    // The assisted app search deliberately autofocuses its question field.
    // Preserve that focus, and never steal focus on ordinary state updates.
    if (!content.contains(document.activeElement)) {
      content.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
    }
  }, [open]);

  return { titleId, stepContentRef };
}
