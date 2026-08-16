"use client";

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box } from '@mui/material';

export interface FloatingRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ResizeDirection =
  | 'top'
  | 'right'
  | 'bottom'
  | 'left'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right';

const clamp = (value: number, min: number, max: number): number => (
  Math.min(Math.max(value, min), Math.max(min, max))
);

const ZERO_OFFSET = { x: 0, y: 0 };

/**
 * #371: clamp a dragged panel so the WHOLE panel stays inside the viewport
 * whenever it fits. Keeping only a sliver on screen (the previous behaviour)
 * pushed the resize handles past the viewport edge, which left the app stuck:
 * it could no longer be resized and barely be moved.
 */
export function clampFloatingPosition(
  position: { x: number; y: number },
  size: { width: number; height: number },
  bounds: { width: number; height: number },
): { x: number; y: number } {
  return {
    x: clamp(position.x, 0, Math.max(0, bounds.width - size.width)),
    y: clamp(position.y, 0, Math.max(0, bounds.height - size.height)),
  };
}

export function resizeFloatingRect(
  start: FloatingRect,
  direction: ResizeDirection,
  deltaX: number,
  deltaY: number,
  bounds: { width: number; height: number },
  minimum: { width: number; height: number },
): FloatingRect {
  const movesLeft = direction.includes('left');
  const movesRight = direction.includes('right');
  const movesTop = direction.includes('top');
  const movesBottom = direction.includes('bottom');
  const startRight = start.x + start.width;
  const startBottom = start.y + start.height;

  let x = start.x;
  let y = start.y;
  let width = start.width;
  let height = start.height;

  if (movesLeft) {
    x = clamp(start.x + deltaX, 0, startRight - minimum.width);
    width = startRight - x;
  } else if (movesRight) {
    width = clamp(start.width + deltaX, minimum.width, bounds.width - start.x);
  }

  if (movesTop) {
    y = clamp(start.y + deltaY, 0, startBottom - minimum.height);
    height = startBottom - y;
  } else if (movesBottom) {
    height = clamp(start.height + deltaY, minimum.height, bounds.height - start.y);
  }

  return { x, y, width, height };
}

export function constrainFloatingRect(
  rect: FloatingRect,
  bounds: { width: number; height: number },
  minimum: { width: number; height: number },
): FloatingRect {
  const width = clamp(rect.width, minimum.width, bounds.width);
  const height = clamp(rect.height, minimum.height, bounds.height);
  return {
    x: clamp(rect.x, 0, bounds.width - width),
    y: clamp(rect.y, 0, bounds.height - height),
    width,
    height,
  };
}

/**
 * #371: a `position: fixed` box only resolves against the viewport while NO
 * ancestor establishes a containing block. `transform`, `filter`,
 * `backdrop-filter`, `will-change` and `contain: paint` all do - and MUI's
 * glass Dialog paper (plus several chat surfaces) use `backdrop-filter`.
 * Pointer events are always reported in viewport coordinates, so a panel that
 * stores viewport geometry and writes it straight back into `left`/`top` jumps
 * by the containing block's origin, which feels like "the drag restarts in the
 * middle of the screen".
 *
 * Measuring `boundingClientRect - computedStyle.left/top` yields that origin
 * without guessing which ancestor is responsible. It is `{0,0}` in the normal
 * case, so the correction is a no-op when the panel already anchors to the
 * viewport.
 */
export function fixedOriginOffset(element: HTMLElement | null | undefined): { x: number; y: number } {
  if (!element || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
    return ZERO_OFFSET;
  }
  const style = window.getComputedStyle(element);
  if (style.position !== 'fixed') return ZERO_OFFSET;
  const left = Number.parseFloat(style.left);
  const top = Number.parseFloat(style.top);
  if (!Number.isFinite(left) || !Number.isFinite(top)) return ZERO_OFFSET;
  const rect = element.getBoundingClientRect();
  const x = Math.round(rect.left - left);
  const y = Math.round(rect.top - top);
  // Sub-pixel noise from zoom/DPR must not resurrect a spurious offset.
  return { x: Math.abs(x) < 1 ? 0 : x, y: Math.abs(y) < 1 ? 0 : y };
}

/**
 * Keeps the containing-block origin of a floating panel up to date while it is
 * active, so viewport geometry can be rendered as correct `left`/`top` values.
 */
export function useFixedOriginOffset(
  ref: React.RefObject<HTMLElement | null>,
  active: boolean,
): { x: number; y: number } {
  const [offset, setOffset] = useState<{ x: number; y: number }>(ZERO_OFFSET);

  useEffect(() => {
    if (!active || typeof window === 'undefined') {
      setOffset((current) => (current.x === 0 && current.y === 0 ? current : ZERO_OFFSET));
      return undefined;
    }
    const measure = () => {
      const next = fixedOriginOffset(ref.current);
      setOffset((current) => (current.x === next.x && current.y === next.y ? current : next));
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [active, ref]);

  return offset;
}

const cursorForDirection = (direction: ResizeDirection): React.CSSProperties['cursor'] => {
  if (direction === 'top' || direction === 'bottom') return 'ns-resize';
  if (direction === 'left' || direction === 'right') return 'ew-resize';
  if (direction === 'top-left' || direction === 'bottom-right') return 'nwse-resize';
  return 'nesw-resize';
};

/**
 * Keeps a drag in the host document even while the pointer crosses an MCP App
 * iframe. The temporary shield is the fallback for browsers that drop pointer
 * capture at a cross-origin frame boundary.
 */
export function usePointerDrag(): {
  activeCursor: React.CSSProperties['cursor'] | null;
  startPointerDrag: (
    event: React.PointerEvent<Element>,
    cursor: React.CSSProperties['cursor'],
    onMove: (event: PointerEvent) => void,
  ) => void;
} {
  const [activeCursor, setActiveCursor] = useState<React.CSSProperties['cursor'] | null>(null);
  const cleanupRef = useRef<((updateState?: boolean) => void) | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      cleanupRef.current?.(false);
      cleanupRef.current = null;
    };
  }, []);

  const startPointerDrag = useCallback((
    event: React.PointerEvent<Element>,
    cursor: React.CSSProperties['cursor'],
    onMove: (event: PointerEvent) => void,
  ) => {
    cleanupRef.current?.();
    event.preventDefault();
    event.stopPropagation();

    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const ownerDocument = target.ownerDocument;
    const ownerWindow = ownerDocument.defaultView ?? window;
    const previousUserSelect = ownerDocument.body.style.userSelect;
    const previousCursor = ownerDocument.body.style.cursor;

    try { target.setPointerCapture?.(pointerId); } catch { /* shield fallback below */ }
    ownerDocument.body.style.userSelect = 'none';
    ownerDocument.body.style.cursor = cursor ?? '';
    setActiveCursor(cursor);

    const handleMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      move.preventDefault();
      onMove(move);
    };
    const finish = (updateState = true) => {
      ownerWindow.removeEventListener('pointermove', handleMove, true);
      ownerWindow.removeEventListener('pointerup', handleUp, true);
      ownerWindow.removeEventListener('pointercancel', handleUp, true);
      try {
        if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
      } catch { /* target may already have been removed */ }
      ownerDocument.body.style.userSelect = previousUserSelect;
      ownerDocument.body.style.cursor = previousCursor;
      if (updateState && aliveRef.current) setActiveCursor(null);
      if (cleanupRef.current === finish) cleanupRef.current = null;
    };
    const handleUp = (up: PointerEvent) => {
      if (up.pointerId !== pointerId) return;
      finish();
    };

    cleanupRef.current = finish;
    ownerWindow.addEventListener('pointermove', handleMove, true);
    ownerWindow.addEventListener('pointerup', handleUp, true);
    ownerWindow.addEventListener('pointercancel', handleUp, true);
  }, []);

  return { activeCursor, startPointerDrag };
}

export const PointerDragShield: React.FC<{
  cursor: React.CSSProperties['cursor'] | null;
}> = ({ cursor }) => cursor ? (
  <Box
    aria-hidden
    data-testid="pointer-drag-shield"
    sx={{
      position: 'fixed',
      inset: 0,
      zIndex: 2147483646,
      cursor,
      touchAction: 'none',
    }}
  />
) : null;

const HANDLE_STYLES: Record<ResizeDirection, Record<string, unknown>> = {
  top: { top: -3, left: 10, right: 10, height: 8 },
  right: { right: -3, top: 10, bottom: 10, width: 8 },
  bottom: { bottom: -3, left: 10, right: 10, height: 8 },
  left: { left: -3, top: 10, bottom: 10, width: 8 },
  'top-left': { top: -3, left: -3, width: 14, height: 14 },
  'top-right': { top: -3, right: -3, width: 14, height: 14 },
  'bottom-left': { bottom: -3, left: -3, width: 14, height: 14 },
  'bottom-right': { bottom: -3, right: -3, width: 14, height: 14 },
};

const RESIZE_DIRECTIONS = Object.keys(HANDLE_STYLES) as ResizeDirection[];

export const FloatingResizeHandles: React.FC<{
  label: string;
  onResizeStart: (
    event: React.PointerEvent<HTMLElement>,
    direction: ResizeDirection,
    cursor: React.CSSProperties['cursor'],
  ) => void;
}> = ({ label, onResizeStart }) => (
  <>
    {RESIZE_DIRECTIONS.map((direction) => {
      const cursor = cursorForDirection(direction);
      return (
        <Box
          key={direction}
          component="span"
          role="separator"
          aria-label={`${label} (${direction})`}
          onPointerDown={(event) => onResizeStart(event, direction, cursor)}
          sx={{
            position: 'absolute',
            zIndex: 8,
            cursor,
            touchAction: 'none',
            ...HANDLE_STYLES[direction],
            ...(direction === 'bottom-right' ? {
              '&::after': {
                content: '""',
                position: 'absolute',
                right: 3,
                bottom: 3,
                width: 7,
                height: 7,
                borderRight: 2,
                borderBottom: 2,
                borderColor: 'text.secondary',
                opacity: 0.7,
              },
            } : {}),
          }}
        />
      );
    })}
  </>
);
